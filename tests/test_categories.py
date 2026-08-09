import json
from pathlib import Path
import tempfile
import unittest

from worker import Config, Database, Request, Response, Router, create_app
from worker.category_api import register


class CategoryApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = str(Path(self.temp_dir.name) / "categories.sqlite3")
        self.db = Database(self.db_path)
        self.app = create_app(Config(db_path=self.db_path), registrars=(register,))

    def tearDown(self):
        self.temp_dir.cleanup()

    def request(self, method, path, payload=None):
        body = b"" if payload is None else json.dumps(payload).encode("utf-8")
        return self.app.handle(Request(method, path, body=body))

    def create(self, name, kind, parent_id=None):
        response = self.request(
            "POST", "/v1/categories", {"name": name, "kind": kind, "parent_id": parent_id}
        )
        self.assertEqual(response.status, 201, response.json_body())
        return response.json_body()

    def test_income_expense_roots_and_parent_child_categories(self):
        expense = self.create("  饮食  ", "expense")
        income = self.create("工资", "income")
        detail = self.create("外卖", "expense", expense["id"])

        response = self.request("GET", "/v1/categories")
        self.assertEqual(response.status, 200)
        self.assertEqual(
            response.json_body()["items"],
            [
                {"id": detail["id"], "name": "外卖", "kind": "expense", "parent_id": expense["id"], "active": 1},
                {"id": expense["id"], "name": "饮食", "kind": "expense", "parent_id": None, "active": 1},
                {"id": income["id"], "name": "工资", "kind": "income", "parent_id": None, "active": 1},
            ],
        )
        response = self.request("GET", f"/v1/categories/{detail['id']}?unused=yes")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.json_body(), detail)

    def test_duplicate_parent_kind_and_field_validation(self):
        root = self.create("购物", "expense")
        duplicate = self.request("POST", "/v1/categories", {"name": "购物", "kind": "expense", "parent_id": None})
        self.assertEqual(duplicate.status, 409)
        wrong_parent = self.request(
            "POST", "/v1/categories", {"name": "错类", "kind": "income", "parent_id": root["id"]}
        )
        self.assertEqual(wrong_parent.status, 422)
        missing_parent = self.request(
            "POST", "/v1/categories", {"name": "孤儿", "kind": "expense", "parent_id": 999}
        )
        self.assertEqual(missing_parent.status, 404)
        invalid = self.request("POST", "/v1/categories", {"name": "  ", "kind": "other", "parent_id": True})
        self.assertEqual(invalid.status, 422)
        malformed = self.app.handle(Request("POST", "/v1/categories", body=b"{"))
        self.assertEqual(malformed.status, 400)
        too_long = self.request("POST", "/v1/categories", {"name": "x" * 101, "kind": "income", "parent_id": None})
        self.assertEqual(too_long.status, 422)

    def test_full_and_partial_updates_keep_complete_object(self):
        root = self.create("理财", "expense")
        other = self.create("储蓄", "expense")
        child = self.create("基金", "expense", root["id"])

        response = self.request(
            "PUT",
            f"/v1/categories/{child['id']}",
            {"name": "股票", "kind": "expense", "parent_id": other["id"]},
        )
        self.assertEqual(response.status, 200)
        self.assertEqual(response.json_body()["name"], "股票")
        self.assertEqual(response.json_body()["parent_id"], other["id"])

        response = self.request("PATCH", f"/v1/categories/{child['id']}", {"name": "  债券 "})
        self.assertEqual(response.status, 200)
        self.assertEqual(
            response.json_body(),
            {"id": child["id"], "name": "债券", "kind": "expense", "parent_id": other["id"], "active": 1},
        )
        missing = self.request("PUT", "/v1/categories/999", {"name": "未知", "kind": "income", "parent_id": None})
        self.assertEqual(missing.status, 404)

    def test_descendant_self_and_parent_changes_are_rejected(self):
        root = self.create("住房", "expense")
        child = self.create("水电费", "expense", root["id"])
        grandchild = self.create("电费", "expense", child["id"])

        self.assertEqual(
            self.request("PATCH", f"/v1/categories/{root['id']}", {"parent_id": grandchild["id"]}).status,
            422,
        )
        self.assertEqual(
            self.request("PATCH", f"/v1/categories/{root['id']}", {"parent_id": root["id"]}).status,
            422,
        )
        self.assertEqual(
            self.request("PATCH", f"/v1/categories/{root['id']}", {"kind": "income"}).status,
            409,
        )

    def test_soft_delete_preserves_referenced_category(self):
        category = self.create("话费", "expense")
        with self.db.transaction() as connection:
            connection.execute(
                "INSERT INTO ledger_entries(kind, category_id, amount_minor, currency, occurred_on) "
                "VALUES ('expense', ?, 100, 'CNY', '2026-08-09')",
                (category["id"],),
            )

        response = self.request("DELETE", f"/v1/categories/{category['id']}")
        self.assertEqual(response.status, 200)
        self.assertEqual(response.json_body()["active"], 0)
        with self.db.connection() as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM categories").fetchone()[0], 1)
            self.assertEqual(connection.execute("SELECT count(*) FROM ledger_entries").fetchone()[0], 1)
        self.assertEqual(self.request("DELETE", f"/v1/categories/{category['id']}").json_body()["active"], 0)

    def test_unknown_routes_and_dynamic_route_method_behavior(self):
        self.assertEqual(self.request("GET", "/v1/categories/999").status, 404)
        self.assertEqual(self.request("GET", "/v1/categories/not-an-id").status, 400)
        self.assertEqual(self.request("POST", "/v1/categories/1").json_body(), {"error": "method_not_allowed"})
        self.assertEqual(self.request("GET", "/v1/other").json_body(), {"error": "not_found"})


class RouterTemplateTests(unittest.TestCase):
    def test_exact_route_has_priority_over_parameter_route(self):
        router = Router()
        router.register("GET", "/v1/items/{id}", lambda request: Response.json(200, {"route": "item"}))
        router.register("GET", "/v1/items/special", lambda request: Response.json(200, {"route": "exact"}))
        self.assertEqual(
            router.dispatch(Request("GET", "/v1/items/special")).json_body(), {"route": "exact"}
        )
        self.assertEqual(router.dispatch(Request("GET", "/v1/items/7")).json_body(), {"route": "item"})
        self.assertEqual(router.dispatch(Request("POST", "/v1/items/7")).status, 405)
        self.assertEqual(router.dispatch(Request("GET", "/v1/items/7/extra")).status, 404)


if __name__ == "__main__":
    unittest.main()
