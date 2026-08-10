import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { D1Mock } from "./d1-mock.mjs";

const schema = await readFile(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8");

test("migration creates deterministic defaults, audit tables, and integer money constraints", (t) => {
  const db = new D1Mock(schema);
  t.after(() => db.close());

  assert.deepEqual(
    db.all("SELECT id, name, kind, parent_id FROM categories ORDER BY id"),
    [
      { id: 1, name: "饮食", kind: "expense", parent_id: null },
      { id: 2, name: "住房", kind: "expense", parent_id: null },
      { id: 3, name: "交通", kind: "expense", parent_id: null },
      { id: 4, name: "理财", kind: "expense", parent_id: null },
      { id: 5, name: "购物", kind: "expense", parent_id: null },
      { id: 6, name: "娱乐", kind: "expense", parent_id: null },
      { id: 7, name: "通讯", kind: "expense", parent_id: null },
      { id: 8, name: "游戏", kind: "expense", parent_id: 6 },
      { id: 9, name: "水电费", kind: "expense", parent_id: 2 },
      { id: 10, name: "话费", kind: "expense", parent_id: 7 },
      { id: 11, name: "工资", kind: "income", parent_id: null },
      { id: 12, name: "意外收入", kind: "income", parent_id: null },
    ],
  );
  const tables = new Set(
    db.all("SELECT name FROM sqlite_schema WHERE type = 'table'").map((row) => row.name),
  );
  for (const table of [
    "category_status_history",
    "ledger_entry_status_history",
    "installment_plan_status_history",
    "installment_status_history",
  ]) {
    assert.ok(tables.has(table));
  }
  assert.throws(
    () => db.sqlite.prepare(
      "INSERT INTO ledger_entries(id, kind, category_id, amount_minor, currency, occurred_on) VALUES (100, 'expense', 5, 1.5, 'CNY', '2026-01-01')",
    ).run(),
    /constraint/i,
  );
});
