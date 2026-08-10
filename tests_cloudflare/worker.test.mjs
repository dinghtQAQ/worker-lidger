import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  allocateInstallments,
  createWorker,
} from "../src/index.mjs";
import { D1Mock } from "./d1-mock.mjs";

const schema = await readFile(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8");
const TOKEN = "cf1-test-token";

function context(options = {}) {
  const db = new D1Mock(schema);
  let id = options.startId ?? 1000;
  const worker = createWorker({
    generateId: () => ++id,
    now: options.now ?? (() => "2026-08-10T12:00:00Z"),
  });
  return {
    db,
    worker,
    env: { DB: db, WORKER_API_TOKEN: TOKEN },
    all: (...values) => db.all(...values),
    get: (...values) => db.get(...values),
    sqlite: db.sqlite,
    close: () => db.close(),
  };
}

async function request(contextValue, method, path, payload, options = {}) {
  const init = {
    method,
    headers: {
      authorization: options.token === undefined ? `Bearer ${TOKEN}` : options.token,
    },
  };
  if (payload !== undefined) {
    init.body = typeof payload === "string" ? payload : JSON.stringify(payload);
  }
  const response = await contextValue.worker.fetch(
    new Request(`https://worker.test${path}`, init),
    options.env ?? contextValue.env,
  );
  const text = await response.text();
  return { response, body: text === "" ? null : JSON.parse(text) };
}

function entryPayload(categoryId, overrides = {}) {
  return {
    kind: "expense",
    category_id: categoryId,
    amount_minor: 100,
    currency: "CNY",
    occurred_on: "2026-01-15",
    ...overrides,
  };
}

test("health is public, data routes fail closed without a secret, and bearer auth is exact", async (t) => {
  const ctx = context();
  t.after(ctx.close);

  const health = await request(ctx, "GET", "/healthz");
  assert.equal(health.response.status, 200);
  assert.deepEqual(health.body, { status: "ok" });

  const missing = await request(ctx, "GET", "/v1/categories", undefined, {
    env: { DB: ctx.db },
  });
  assert.equal(missing.response.status, 503);
  assert.deepEqual(missing.body, { error: "worker_api_token_missing" });

  const wrong = await request(ctx, "GET", "/v1/categories", undefined, {
    token: "Bearer wrong",
  });
  assert.equal(wrong.response.status, 401);
  assert.deepEqual(wrong.body, { error: "unauthorized" });

  const authorized = await request(ctx, "GET", "/v1/categories");
  assert.equal(authorized.response.status, 200);
});

test("category defaults and CRUD preserve parent/kind and soft-delete semantics", async (t) => {
  const ctx = context();
  t.after(ctx.close);

  const defaults = await request(ctx, "GET", "/v1/categories");
  assert.equal(defaults.response.status, 200);
  assert.equal(defaults.body.items.length, 12);
  assert.deepEqual(
    defaults.body.items.filter((item) => item.parent_id !== null).map((item) => [item.name, item.parent_id]),
    [["水电费", 2], ["游戏", 6], ["话费", 7]],
  );
  assert.deepEqual(
    defaults.body.items.filter((item) => item.kind === "income").map((item) => item.name),
    ["工资", "意外收入"],
  );

  const created = await request(ctx, "POST", "/v1/categories", {
    name: "  自定义  ",
    kind: "expense",
    parent_id: null,
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.name, "自定义");
  const child = await request(ctx, "POST", "/v1/categories", {
    name: "子类",
    kind: "expense",
    parent_id: created.body.id,
  });
  assert.equal(child.response.status, 201);

  const duplicate = await request(ctx, "POST", "/v1/categories", {
    name: "自定义",
    kind: "expense",
    parent_id: null,
  });
  assert.deepEqual([duplicate.response.status, duplicate.body], [409, { error: "category_already_exists" }]);

  const patched = await request(ctx, "PATCH", `/v1/categories/${child.body.id}`, { name: "改名" });
  assert.deepEqual(
    patched.body,
    { id: child.body.id, name: "改名", kind: "expense", parent_id: created.body.id, active: 1 },
  );
  const replaced = await request(ctx, "PUT", `/v1/categories/${child.body.id}`, {
    name: "新名称",
    kind: "expense",
    parent_id: created.body.id,
  });
  assert.equal(replaced.response.status, 200);
  const deleted = await request(ctx, "DELETE", `/v1/categories/${child.body.id}`);
  assert.equal(deleted.body.active, 0);
  assert.equal((await request(ctx, "DELETE", `/v1/categories/${child.body.id}`)).body.active, 0);
  assert.equal(
    ctx.get("SELECT new_active FROM category_status_history WHERE category_id = ? ORDER BY id DESC LIMIT 1", child.body.id).new_active,
    0,
  );
});

test("ledger entries support CRUD and reject malformed JSON before writes", async (t) => {
  const ctx = context();
  t.after(ctx.close);

  const created = await request(ctx, "POST", "/v1/entries", entryPayload(5, { description: "book" }));
  assert.equal(created.response.status, 201);
  assert.equal(created.body.description, "book");
  const listed = await request(ctx, "GET", "/v1/entries");
  assert.deepEqual(listed.body.items.map((item) => item.id), [created.body.id]);

  const patched = await request(ctx, "PATCH", `/v1/entries/${created.body.id}`, { description: "books" });
  assert.equal(patched.body.description, "books");
  const replaced = await request(ctx, "PUT", `/v1/entries/${created.body.id}`, entryPayload(5, {
    amount_minor: 300,
    occurred_on: "2026-02-01",
    description: null,
  }));
  assert.deepEqual([replaced.response.status, replaced.body.amount_minor, replaced.body.description], [200, 300, null]);

  const malformed = await request(ctx, "POST", "/v1/entries", "{");
  assert.deepEqual([malformed.response.status, malformed.body], [400, { error: "invalid_json" }]);
  assert.equal((await request(ctx, "GET", "/v1/entries")).body.items.length, 1);
});

test("integer bounds reject before any ledger, plan, or installment write", async (t) => {
  const ctx = context();
  t.after(ctx.close);
  const baseline = await request(ctx, "POST", "/v1/entries", entryPayload(5));
  assert.equal(baseline.response.status, 201);
  const before = ctx.get(
    "SELECT (SELECT count(*) FROM ledger_entries) AS entries, (SELECT count(*) FROM installment_plans) AS plans, (SELECT count(*) FROM installments) AS installments",
  );

  const invalid = [
    [0, "invalid_amount_minor"],
    [1.5, "invalid_amount_minor"],
    [Number.MAX_SAFE_INTEGER + 1, "invalid_amount_minor"],
  ];
  for (const [amount, error] of invalid) {
    const result = await request(ctx, "POST", "/v1/entries", entryPayload(5, { amount_minor: amount }));
    assert.deepEqual([result.response.status, result.body], [422, { error }]);
  }
  const badCategory = await request(ctx, "POST", "/v1/entries", entryPayload(Number.MAX_SAFE_INTEGER + 1));
  assert.deepEqual([badCategory.response.status, badCategory.body], [422, { error: "invalid_category_id" }]);
  const badCount = await request(ctx, "POST", "/v1/entries", entryPayload(5, { installment_count: 1201 }));
  assert.deepEqual([badCount.response.status, badCount.body], [422, { error: "invalid_installment_count" }]);
  assert.deepEqual(
    ctx.get(
      "SELECT (SELECT count(*) FROM ledger_entries) AS entries, (SELECT count(*) FROM installment_plans) AS plans, (SELECT count(*) FROM installments) AS installments",
    ),
    before,
  );
});

test("10000/3 installments allocate exactly and preserve month-end dates", async (t) => {
  const ctx = context();
  t.after(ctx.close);
  assert.deepEqual(allocateInstallments(10000, 3), [3334, 3333, 3333]);
  const created = await request(ctx, "POST", "/v1/entries", entryPayload(5, {
    amount_minor: 10000,
    occurred_on: "2026-01-31",
    installment_count: 3,
    first_due_on: "2026-01-31",
    interval_months: 1,
  }));
  assert.equal(created.response.status, 201);
  assert.deepEqual(created.body.installments.map((item) => item.amount_minor), [3334, 3333, 3333]);
  assert.deepEqual(created.body.installments.map((item) => item.due_on), [
    "2026-01-31",
    "2026-02-28",
    "2026-03-31",
  ]);
  const march = await request(ctx, "GET", "/v1/months/2026-03");
  assert.equal(march.response.status, 200);
  assert.equal(march.body.items[0].status, "pending");
  assert.equal(march.body.totals.pending_minor, 3333);

  const paid = await request(ctx, "PATCH", `/v1/installments/${created.body.installments[0].id}`, { status: "paid" });
  assert.equal(paid.response.status, 200);
  assert.equal(paid.body.status, "paid");
  assert.match(paid.body.paid_at, /Z$/);
  assert.equal((await request(ctx, "GET", `/v1/entries/${created.body.id}`)).body.installment_plan.status, "active");
  const pending = await request(ctx, "PATCH", `/v1/installments/${created.body.installments[0].id}`, { status: "pending" });
  assert.deepEqual([pending.response.status, pending.body.paid_at], [200, null]);
});

test("the 1200-installment boundary is accepted in one atomic D1 batch", async (t) => {
  const ctx = context();
  t.after(ctx.close);
  const created = await request(ctx, "POST", "/v1/entries", entryPayload(5, {
    amount_minor: 1200,
    occurred_on: "2026-01-01",
    installment_count: 1200,
    first_due_on: "2026-01-01",
  }));
  assert.equal(created.response.status, 201);
  assert.equal(created.body.installments.length, 1200);
  assert.equal(created.body.installments.at(-1).amount_minor, 1);
  assert.equal(ctx.db.batchCalls.at(-1).length, 3);
});

test("schedule replacement retains audit rows and paid schedules are immutable", async (t) => {
  const ctx = context();
  t.after(ctx.close);
  const created = await request(ctx, "POST", "/v1/entries", entryPayload(5, {
    amount_minor: 100,
    installment_count: 2,
  }));
  const updated = await request(ctx, "PATCH", `/v1/entries/${created.body.id}`, {
    amount_minor: 101,
  });
  assert.equal(updated.response.status, 200);
  assert.notEqual(updated.body.installment_plan.id, created.body.installment_plan.id);
  assert.deepEqual(
    ctx.all("SELECT status, void_reason FROM installment_plans WHERE entry_id = ? ORDER BY revision", created.body.id),
    [
      { status: "voided", void_reason: "superseded" },
      { status: "active", void_reason: null },
    ],
  );
  assert.equal(ctx.get("SELECT count(*) AS count FROM installments").count, 4);

  const installmentId = updated.body.installments[0].id;
  assert.equal((await request(ctx, "PATCH", `/v1/installments/${installmentId}`, { status: "paid" })).response.status, 200);
  assert.equal(
    (await request(ctx, "PATCH", `/v1/entries/${created.body.id}`, { description: "paid one" })).response.status,
    200,
  );
  const blocked = await request(ctx, "PATCH", `/v1/entries/${created.body.id}`, { amount_minor: 102 });
  assert.deepEqual([blocked.response.status, blocked.body], [409, { error: "paid_installments_immutable" }]);
});

test("D1 batch rollback leaves no half-created ledger schedule", async (t) => {
  const ctx = context();
  t.after(ctx.close);
  ctx.db.failBatchAt = 2;
  const result = await request(ctx, "POST", "/v1/entries", entryPayload(5, {
    amount_minor: 10000,
    installment_count: 2,
  }));
  assert.deepEqual([result.response.status, result.body], [500, { error: "internal_server_error" }]);
  assert.deepEqual(
    ctx.get(
      "SELECT (SELECT count(*) FROM ledger_entries) AS entries, (SELECT count(*) FROM installment_plans) AS plans, (SELECT count(*) FROM installments) AS installments",
    ),
    { entries: 0, plans: 0, installments: 0 },
  );
});

test("voiding is idempotent, retains paid history, and removes active month items", async (t) => {
  const ctx = context();
  t.after(ctx.close);
  const created = await request(ctx, "POST", "/v1/entries", entryPayload(5, {
    amount_minor: 101,
    installment_count: 2,
    first_due_on: "2026-01-31",
  }));
  const first = created.body.installments[0];
  const second = created.body.installments[1];
  assert.equal((await request(ctx, "PATCH", `/v1/installments/${first.id}`, { status: "paid" })).response.status, 200);
  const deleted = await request(ctx, "DELETE", `/v1/entries/${created.body.id}`);
  assert.equal(deleted.response.status, 200);
  assert.ok(deleted.body.voided_at);
  assert.equal(deleted.body.installment_plan.status, "voided");
  assert.deepEqual(deleted.body.installments.map((item) => item.status), ["paid", "voided"]);
  const repeated = await request(ctx, "DELETE", `/v1/entries/${created.body.id}`);
  assert.deepEqual(repeated.body, deleted.body);
  const blocked = await request(ctx, "PATCH", `/v1/installments/${second.id}`, { status: "paid" });
  assert.deepEqual([blocked.response.status, blocked.body], [409, { error: "entry_voided" }]);
  assert.deepEqual((await request(ctx, "GET", "/v1/months/2026-01")).body.items, []);

  assert.equal(
    ctx.get("SELECT count(*) AS count FROM ledger_entry_status_history WHERE entry_id = ? AND new_status = 'voided'", created.body.id).count,
    1,
  );
  assert.equal(
    ctx.get("SELECT count(*) AS count FROM installment_status_history WHERE installment_id = ?", second.id).count,
    2,
  );
  assert.equal(
    ctx.get("SELECT count(*) AS count FROM installment_plan_status_history WHERE plan_id = ? AND new_status = 'voided'", deleted.body.installment_plan.id).count,
    1,
  );
  assert.throws(
    () => ctx.sqlite.exec("DELETE FROM ledger_entries WHERE id = " + created.body.id),
    /must be voided|constraint/i,
  );
});

test("oversized bodies are rejected before JSON parsing", async (t) => {
  const ctx = context();
  t.after(ctx.close);
  const result = await request(ctx, "POST", "/v1/categories", "x".repeat(1_048_577));
  assert.deepEqual([result.response.status, result.body], [413, { error: "request_body_too_large" }]);
});
