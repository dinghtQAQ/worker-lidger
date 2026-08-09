import http.client
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest

from worker import Config, ConfigError, Database, Request, Response, create_app, create_server


class FoundationTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.temp_dir.name) / "ledger.sqlite3")
        self.config = Config(db_path=self.db_path)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_defaults_and_non_loopback_token_gate(self):
        config = Config.from_env({})
        self.assertEqual(config.host, "127.0.0.1")
        self.assertEqual(config.port, 8080)
        self.assertEqual(config.db_path, "worker/data/ledger.sqlite3")
        self.assertEqual(config.max_body_bytes, 1_048_576)
        self.assertEqual(Config.from_env({"WORKER_MAX_BODY_BYTES": "4"}).max_body_bytes, 4)
        with self.assertRaises(ConfigError):
            Config.from_env({"WORKER_HOST": "0.0.0.0"})
        config = Config.from_env({"WORKER_HOST": "0.0.0.0", "WORKER_API_TOKEN": "secret"})
        self.assertEqual(config.api_token, "secret")

    def test_body_limit_rejects_invalid_and_unsafe_values(self):
        for raw_value in ("", "not-an-integer", "0", "-1", "16777217"):
            with self.subTest(raw_value=raw_value):
                with self.assertRaises(ConfigError):
                    Config.from_env({"WORKER_MAX_BODY_BYTES": raw_value})

        for value in (0, -1, 16 * 1024 * 1024 + 1, True):
            with self.subTest(value=value):
                with self.assertRaises(ConfigError):
                    Config(max_body_bytes=value)

        self.assertEqual(
            Config(max_body_bytes=16 * 1024 * 1024).max_body_bytes,
            16 * 1024 * 1024,
        )

    def test_health_and_token_authentication(self):
        app = create_app(Config(db_path=self.db_path, api_token="top-secret"))
        self.assertEqual(app.handle(Request("GET", "/healthz")).status, 200)
        unauthorized = app.handle(Request("GET", "/private"))
        self.assertEqual(unauthorized.status, 401)
        self.assertEqual(unauthorized.json_body(), {"error": "unauthorized"})
        self.assertNotIn("top-secret", unauthorized.body.decode())
        authorized = app.handle(
            Request("GET", "/private", {"authorization": "Bearer top-secret"})
        )
        self.assertEqual(authorized.status, 404)

    def test_router_registration_is_reusable(self):
        def register(router, db, config):
            self.assertIsInstance(db, Database)
            self.assertEqual(config.db_path, self.db_path)
            router.register("GET", "/extension", lambda request: Response.json(200, {"ok": True}))

        app = create_app(self.config, registrars=(register,))
        response = app.handle(Request("GET", "/extension"))
        self.assertEqual(response.status, 200)
        self.assertEqual(response.json_body(), {"ok": True})

    def test_database_pragmas_schema_and_constraints(self):
        db = Database(self.db_path)
        db.initialize()
        with db.connection() as connection:
            self.assertEqual(connection.execute("PRAGMA foreign_keys").fetchone()[0], 1)
            self.assertEqual(connection.execute("PRAGMA journal_mode").fetchone()[0].lower(), "wal")
            self.assertEqual(connection.execute("PRAGMA busy_timeout").fetchone()[0], 5000)
            tables = {
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                )
            }
            self.assertTrue({"categories", "ledger_entries", "installment_plans", "installments"} <= tables)
            connection.execute("INSERT INTO categories(name, kind) VALUES ('Salary', 'income')")
            category_id = connection.execute("SELECT id FROM categories").fetchone()[0]
            connection.execute(
                "INSERT INTO ledger_entries(kind, category_id, amount_minor, currency, occurred_on) "
                "VALUES ('income', ?, 100, 'CNY', '2026-01-02')",
                (category_id,),
            )
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO ledger_entries(kind, category_id, amount_minor, currency, occurred_on) "
                    "VALUES ('income', ?, -1, 'CNY', '2026-01-02')",
                    (category_id,),
                )
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO ledger_entries(kind, category_id, amount_minor, currency, occurred_on) "
                    "VALUES ('expense', ?, 1, 'CNY', '2026-01-02')",
                    (category_id,),
                )
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO ledger_entries(kind, category_id, amount_minor, currency, occurred_on) "
                    "VALUES ('income', ?, 1, 'CNY', '2026-99-99')",
                    (category_id,),
                )

    def test_transaction_rolls_back_all_writes(self):
        db = Database(self.db_path)
        db.initialize()
        with self.assertRaisesRegex(RuntimeError, "abort"):
            with db.transaction() as connection:
                connection.execute("INSERT INTO categories(name, kind) VALUES ('One', 'expense')")
                connection.execute("INSERT INTO categories(name, kind) VALUES ('Two', 'expense')")
                raise RuntimeError("abort")
        with db.connection() as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM categories").fetchone()[0], 0)

    def test_installment_total_and_sequence_constraints(self):
        db = Database(self.db_path)
        db.initialize()
        with db.transaction() as connection:
            plan_id = connection.execute(
                "INSERT INTO installment_plans(total_amount_minor, installment_count, currency) "
                "VALUES (100, 2, 'CNY') RETURNING id"
            ).fetchone()[0]
            connection.execute(
                "INSERT INTO installments(plan_id, sequence, amount_minor, due_on) "
                "VALUES (?, 1, 40, '2026-01-01')",
                (plan_id,),
            )
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO installments(plan_id, sequence, amount_minor, due_on) "
                    "VALUES (?, 2, 50, '2026-02-01')",
                    (plan_id,),
                )
            self.assertEqual(connection.execute("SELECT count(*) FROM installments").fetchone()[0], 1)
            connection.execute(
                "INSERT INTO installments(plan_id, sequence, amount_minor, due_on) "
                "VALUES (?, 2, 60, '2026-02-01')",
                (plan_id,),
            )
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO installments(plan_id, sequence, amount_minor, due_on) "
                    "VALUES (?, 2, 0, '2026-03-01')",
                    (plan_id,),
                )

    def test_json_errors_and_http_body_limit(self):
        app = create_app(Config(db_path=self.db_path, max_body_bytes=4))
        self.assertEqual(app.handle(Request("POST", "/healthz", body=b"12345")).status, 413)
        self.assertEqual(app.handle(Request("POST", "/healthz")).json_body(), {"error": "method_not_allowed"})

        server = create_server(app)
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        try:
            host, port = server.server_address[:2]
            connection = http.client.HTTPConnection(host, port, timeout=2)
            connection.request("GET", "/healthz")
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.getheader("Content-Type"), "application/json; charset=utf-8")
            self.assertEqual(response.read(), b'{"status":"ok"}')
            connection.close()

            connection = http.client.HTTPConnection(host, port, timeout=2)
            connection.request("POST", "/healthz", body=b"12345")
            response = connection.getresponse()
            self.assertEqual(response.status, 413)
            self.assertEqual(response.read(), b'{"error":"request_body_too_large"}')
            connection.close()
        finally:
            server.shutdown()
            server.server_close()
            server_thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
