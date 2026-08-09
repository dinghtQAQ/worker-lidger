import json
from pathlib import Path
import tempfile
import unittest

from worker import Config, Database, Request, create_app
from worker.ledger_api import register


class LedgerApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.temp_dir.name) / "ledger.sqlite3")
        self.db = Database(self.db_path)
        self.app = create_app(Config(db_path=self.db_path), registrars=(register,))
        with self.db.transaction() as connection:
            self.income_category = connection.execute(
                "INSERT INTO categories(name, kind) VALUES ('工资', 'income') RETURNING id"
            ).fetchone()[0]
            self.expense_category = connection.execute(
                "INSERT INTO categories(name, kind) VALUES ('购物', 'expense') RETURNING id"
            ).fetchone()[0]
            self.inactive_category = connection.execute(
                "INSERT INTO categories(name, kind, active) VALUES ('停用', 'expense', 0) RETURNING id"
            ).fetchone()[0]

    def tearDown(self):
        self.temp_dir.cleanup()

    def request(self, method, path, payload=None):
        body = b"" if payload is None else json.dumps(payload).encode("utf-8")
        return self.app.handle(Request(method, path, body=body))

    def entry(self, kind="expense", category_id=None, amount_minor=100, **extra):
        payload = {
            "kind": kind,
            "category_id": category_id or self.expense_category,
            "amount_minor": amount_minor,
            "currency": "CNY",
            "occurred_on": "2026-01-15",
        }
        payload.update(extra)
        response = self.request("POST", "/v1/entries", payload)
        self.assertEqual(response.status, 201, response.json_body())
        return response.json_body()

    def test_income_expense_list_and_single_entry_crud(self):
        income = self.entry("income", self.income_category, 250, description="工资")
        expense = self.entry(description="书")
        listed = self.request("GET", "/v1/entries")
        self.assertEqual(listed.status, 200)
        self.assertEqual([item["id"] for item in listed.json_body()["items"]], [income["id"], expense["id"]])

        updated = self.request(
            "PATCH", f"/v1/entries/{expense['id']}", {"description": "书和文具"}
        )
        self.assertEqual(updated.status, 200)
        self.assertEqual(updated.json_body()["description"], "书和文具")
        replaced = self.request(
            "PUT",
            f"/v1/entries/{income['id']}",
            {
                "kind": "income",
                "category_id": self.income_category,
                "amount_minor": 300,
                "currency": "CNY",
                "occurred_on": "2026-02-01",
                "description": None,
            },
        )
        self.assertEqual(replaced.status, 200)
        self.assertEqual(replaced.json_body()["amount_minor"], 300)
        self.assertEqual(self.request("GET", "/v1/entries/999").status, 404)

    def test_category_must_be_active_and_match_kind(self):
        wrong_kind = self.request(
            "POST",
            "/v1/entries",
            {
                "kind": "income",
                "category_id": self.expense_category,
                "amount_minor": 1,
                "currency": "CNY",
                "occurred_on": "2026-01-01",
            },
        )
        self.assertEqual(wrong_kind.status, 422)
        inactive = self.request(
            "POST",
            "/v1/entries",
            {
                "kind": "expense",
                "category_id": self.inactive_category,
                "amount_minor": 1,
                "currency": "CNY",
                "occurred_on": "2026-01-01",
            },
        )
        self.assertEqual(inactive.status, 409)

    def test_installment_allocation_month_end_and_future_month(self):
        entry = self.entry(
            amount_minor=10000,
            occurred_on="2026-01-31",
            installment_count=3,
            first_due_on="2026-01-31",
            interval_months=1,
        )
        self.assertEqual([item["amount_minor"] for item in entry["installments"]], [3334, 3333, 3333])
        self.assertEqual([item["due_on"] for item in entry["installments"]], ["2026-01-31", "2026-02-28", "2026-03-31"])
        self.assertEqual(sum(item["amount_minor"] for item in entry["installments"]), 10000)
        future = self.request("GET", "/v1/months/2026-03")
        self.assertEqual(future.status, 200)
        self.assertEqual(len(future.json_body()["items"]), 1)
        self.assertEqual(future.json_body()["items"][0]["status"], "pending")
        self.assertEqual(future.json_body()["totals"]["pending_minor"], 3333)

    def test_payment_toggle_updates_plan_and_preserves_audit(self):
        entry = self.entry(amount_minor=101, installment_count=2)
        installment = entry["installments"][0]
        paid = self.request("PATCH", f"/v1/installments/{installment['id']}", {"status": "paid"})
        self.assertEqual(paid.status, 200)
        self.assertEqual(paid.json_body()["status"], "paid")
        self.assertTrue(paid.json_body()["paid_at"].endswith("Z"))
        detail = self.request("GET", f"/v1/entries/{entry['id']}").json_body()
        self.assertEqual(detail["installment_plan"]["status"], "active")
        pending = self.request("PATCH", f"/v1/installments/{installment['id']}", {"status": "pending"})
        self.assertEqual(pending.status, 200)
        self.assertIsNone(pending.json_body()["paid_at"])

    def test_soft_delete_is_idempotent_and_retains_paid_history(self):
        entry = self.entry(amount_minor=101, installment_count=2)
        paid_id = entry["installments"][0]["id"]
        self.assertEqual(self.request("PATCH", f"/v1/installments/{paid_id}", {"status": "paid"}).status, 200)
        deleted = self.request("DELETE", f"/v1/entries/{entry['id']}")
        self.assertEqual(deleted.status, 200)
        payload = deleted.json_body()
        self.assertIsNotNone(payload["voided_at"])
        self.assertEqual(payload["installments"][0]["status"], "paid")
        self.assertEqual(payload["installments"][1]["status"], "voided")
        self.assertEqual(self.request("DELETE", f"/v1/entries/{entry['id']}").json_body(), payload)
        self.assertEqual(
            self.request("PATCH", f"/v1/installments/{entry['installments'][1]['id']}", {"status": "paid"}).status,
            409,
        )
        self.assertEqual(self.request("GET", "/v1/months/2026-01").json_body()["items"], [])

    def test_paid_installment_blocks_schedule_sensitive_updates(self):
        entry = self.entry(amount_minor=100, installment_count=2)
        installment_id = entry["installments"][0]["id"]
        self.assertEqual(self.request("PATCH", f"/v1/installments/{installment_id}", {"status": "paid"}).status, 200)
        safe = self.request("PATCH", f"/v1/entries/{entry['id']}", {"description": "已付一期"})
        self.assertEqual(safe.status, 200)
        blocked = self.request("PATCH", f"/v1/entries/{entry['id']}", {"amount_minor": 101})
        self.assertEqual(blocked.status, 409)
        self.assertEqual(blocked.json_body(), {"error": "paid_installments_immutable"})
        blocked_count = self.request("PATCH", f"/v1/entries/{entry['id']}", {"installment_count": 3})
        self.assertEqual(blocked_count.status, 409)

    def test_invalid_input_and_failed_schedule_transaction_leave_no_half_write(self):
        invalid = self.request(
            "POST",
            "/v1/entries",
            {
                "kind": "expense",
                "category_id": self.expense_category,
                "amount_minor": 0,
                "currency": "cnY",
                "occurred_on": "2026-02-30",
                "installment_count": 2,
            },
        )
        self.assertEqual(invalid.status, 422)
        self.assertEqual(self.request("GET", "/v1/entries").json_body()["items"], [])

        original = self.entry(amount_minor=100, description="原始")
        bad_update = self.request(
            "PATCH", f"/v1/entries/{original['id']}", {"installment_count": 2, "interval_months": 13}
        )
        self.assertEqual(bad_update.status, 422)
        detail = self.request("GET", f"/v1/entries/{original['id']}").json_body()
        self.assertEqual(detail["description"], "原始")
        self.assertIsNone(detail["installment_plan"])


if __name__ == "__main__":
    unittest.main()
