const JSON_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
});

const MAX_BODY_BYTES = 1_048_576;
const MAX_INSTALLMENT_COUNT = 1200;
const MAX_SAFE_SQLITE_INTEGER = Number.MAX_SAFE_INTEGER;

const CATEGORY_FIELDS = new Set(["name", "kind", "parent_id"]);
const ENTRY_BASE_FIELDS = new Set([
  "kind",
  "category_id",
  "amount_minor",
  "currency",
  "occurred_on",
  "description",
]);
const ENTRY_SCHEDULE_FIELDS = new Set([
  "installment_count",
  "first_due_on",
  "interval_months",
]);
const ENTRY_ALLOWED_FIELDS = new Set([...ENTRY_BASE_FIELDS, ...ENTRY_SCHEDULE_FIELDS]);
const ENTRY_REQUIRED_FIELDS = new Set([
  "kind",
  "category_id",
  "amount_minor",
  "currency",
  "occurred_on",
]);
const KINDS = new Set(["income", "expense"]);
const INSTALLMENT_STATUSES = new Set(["paid", "pending"]);

const CATEGORY_SELECT =
  "SELECT id, name, kind, parent_id, active FROM categories";
const ENTRY_SELECT =
  "SELECT id, kind, category_id, amount_minor, currency, occurred_on, description, voided_at FROM ledger_entries";
const PLAN_SELECT =
  "SELECT id, entry_id, revision, total_amount_minor, installment_count, currency, status, void_reason FROM installment_plans";
const INSTALLMENT_SELECT =
  "SELECT id, plan_id, sequence, amount_minor, due_on, status, paid_at FROM installments";

class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

function constantTimeEqual(actual, expected) {
  const length = Math.max(actual.length, expected.length);
  let mismatch = actual.length ^ expected.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (actual.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

function prepared(db, sql, values = []) {
  const statement = db.prepare(sql);
  return values.length === 0 ? statement : statement.bind(...values);
}

async function queryFirst(db, sql, values = []) {
  return (await prepared(db, sql, values).first()) ?? null;
}

async function queryAll(db, sql, values = []) {
  const result = await prepared(db, sql, values).all();
  return Array.isArray(result) ? result : result.results ?? [];
}

function isConstraintError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /constraint|foreign key|unique|raise\(abort|category cycle|immutable|cannot|must/i.test(
    message,
  );
}

async function writeBatch(db, statements, conflictCode) {
  try {
    return await db.batch(statements);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/paid installment/i.test(message)) {
      throw new ApiError(409, "paid_installments_immutable");
    }
    if (isConstraintError(error)) {
      throw new ApiError(409, conflictCode);
    }
    throw error;
  }
}

function defaultIdGenerator() {
  const words = new Uint32Array(2);
  crypto.getRandomValues(words);
  const id = (words[0] & 0x1fffff) * 0x100000000 + words[1];
  return id || 1;
}

function nextId(generateId) {
  const id = generateId();
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("ID generator must return a positive safe integer");
  }
  return id;
}

function utcTimestamp(now) {
  const raw = now();
  const date = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Clock returned an invalid timestamp");
  }
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function assertDeclaredBodySize(request) {
  const rawLength = request.headers.get("content-length");
  if (rawLength === null) {
    return;
  }
  const normalized = rawLength.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new ApiError(400, "invalid_content_length");
  }
  if (BigInt(normalized) > BigInt(MAX_BODY_BYTES)) {
    throw new ApiError(413, "request_body_too_large");
  }
}

async function readJsonObject(request) {
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) {
    throw new ApiError(413, "request_body_too_large");
  }

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new ApiError(400, "invalid_json");
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json");
  }
  if (payload === null || Array.isArray(payload) || typeof payload !== "object") {
    throw new ApiError(400, "json_object_required");
  }
  return payload;
}

function hasUnknownFields(payload, allowed) {
  return Object.keys(payload).some((field) => !allowed.has(field));
}

function parsePositiveInteger(value, errorCode, maximum = MAX_SAFE_SQLITE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new ApiError(422, errorCode);
  }
  return value;
}

function parsePathId(segment, resource) {
  if (!/^\d+$/.test(segment)) {
    throw new ApiError(400, `invalid_${resource}_id`);
  }
  const value = BigInt(segment);
  if (value <= 0n || value > BigInt(MAX_SAFE_SQLITE_INTEGER)) {
    throw new ApiError(400, `invalid_${resource}_id`);
  }
  return Number(value);
}

function dateParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  return { year, month, day };
}

function daysInMonth(year, month) {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function formatDate(year, month, day) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseDate(value, errorCode) {
  if (typeof value !== "string" || dateParts(value) === null) {
    throw new ApiError(422, errorCode);
  }
  return value;
}

function parseMonth(value) {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (match === null) {
    throw new ApiError(400, "invalid_month");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 1 || month < 1 || month > 12) {
    throw new ApiError(400, "invalid_month");
  }
  return value;
}

export function addMonths(value, months) {
  const parts = typeof value === "string" ? dateParts(value) : null;
  if (parts === null || !Number.isSafeInteger(months) || months < 0) {
    throw new RangeError("invalid date or month offset");
  }
  const monthIndex = (parts.year - 1) * 12 + (parts.month - 1) + months;
  const year = Math.floor(monthIndex / 12) + 1;
  const month = (monthIndex % 12) + 1;
  if (year > 9999) {
    throw new RangeError("installment date exceeds supported range");
  }
  return formatDate(year, month, Math.min(parts.day, daysInMonth(year, month)));
}

export function allocateInstallments(totalAmountMinor, installmentCount) {
  if (
    !Number.isSafeInteger(totalAmountMinor) ||
    totalAmountMinor <= 0 ||
    !Number.isSafeInteger(installmentCount) ||
    installmentCount <= 0 ||
    installmentCount > MAX_INSTALLMENT_COUNT
  ) {
    throw new RangeError("invalid installment allocation");
  }
  const quotient = Math.floor(totalAmountMinor / installmentCount);
  const remainder = totalAmountMinor % installmentCount;
  return Array.from(
    { length: installmentCount },
    (_, index) => quotient + (index < remainder ? 1 : 0),
  );
}

function buildSchedule(total, count, firstDueOn, intervalMonths) {
  const amounts = allocateInstallments(total, count);
  try {
    return amounts.map((amountMinor, index) => ({
      sequence: index + 1,
      amount_minor: amountMinor,
      due_on: addMonths(firstDueOn, index * intervalMonths),
    }));
  } catch (error) {
    if (error instanceof RangeError) {
      throw new ApiError(422, "invalid_installment_schedule");
    }
    throw error;
  }
}

function categoryPayload(row) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    parent_id: row.parent_id,
    active: row.active,
  };
}

function entryBasePayload(row) {
  return {
    id: row.id,
    category_id: row.category_id,
    kind: row.kind,
    amount_minor: row.amount_minor,
    currency: row.currency,
    occurred_on: row.occurred_on,
    description: row.description,
    voided_at: row.voided_at,
  };
}

function planPayload(row) {
  return {
    id: row.id,
    entry_id: row.entry_id,
    total_amount_minor: row.total_amount_minor,
    installment_count: row.installment_count,
    currency: row.currency,
    status: row.status,
  };
}

function installmentPayload(row) {
  return {
    id: row.id,
    plan_id: row.plan_id,
    sequence: row.sequence,
    amount_minor: row.amount_minor,
    due_on: row.due_on,
    status: row.status,
    paid_at: row.paid_at,
  };
}

async function findCategory(db, categoryId) {
  return queryFirst(db, `${CATEGORY_SELECT} WHERE id = ?`, [categoryId]);
}

async function validateCategory(db, categoryId, kind) {
  const row = await findCategory(db, categoryId);
  if (row === null) {
    throw new ApiError(404, "category_not_found");
  }
  if (!row.active) {
    throw new ApiError(409, "category_inactive");
  }
  if (row.kind !== kind) {
    throw new ApiError(422, "category_kind_mismatch");
  }
  return row;
}

async function validateCategoryParent(db, parentId, kind, categoryId = null) {
  if (parentId === null) {
    return;
  }
  if (parentId === categoryId) {
    throw new ApiError(422, "category_cannot_parent_itself");
  }
  const parent = await findCategory(db, parentId);
  if (parent === null) {
    throw new ApiError(404, "parent_category_not_found");
  }
  if (parent.kind !== kind) {
    throw new ApiError(422, "parent_kind_mismatch");
  }
  if (categoryId === null) {
    return;
  }

  const seen = new Set();
  let cursor = parent;
  while (cursor !== null) {
    if (cursor.id === categoryId) {
      throw new ApiError(422, "category_cycle");
    }
    if (seen.has(cursor.id)) {
      throw new ApiError(409, "category_cycle");
    }
    seen.add(cursor.id);
    cursor = cursor.parent_id === null ? null : await findCategory(db, cursor.parent_id);
    if (cursor === null && parent.parent_id !== null && seen.size === 1) {
      throw new ApiError(404, "parent_category_not_found");
    }
  }
}

async function ensureUniqueCategory(db, name, kind, parentId, categoryId = null) {
  let sql =
    "SELECT id FROM categories WHERE name = ? AND kind = ? AND parent_id IS ?";
  const values = [name, kind, parentId];
  if (categoryId !== null) {
    sql += " AND id <> ?";
    values.push(categoryId);
  }
  if ((await queryFirst(db, sql, values)) !== null) {
    throw new ApiError(409, "category_already_exists");
  }
}

async function parseCategoryPayload(request, partial) {
  const payload = await readJsonObject(request);
  const fields = Object.keys(payload);
  if (hasUnknownFields(payload, CATEGORY_FIELDS)) {
    throw new ApiError(422, "unknown_field");
  }
  if (!partial && fields.length !== CATEGORY_FIELDS.size) {
    throw new ApiError(422, "required_fields");
  }
  if (partial && fields.length === 0) {
    throw new ApiError(422, "empty_update");
  }

  const values = {};
  if (Object.hasOwn(payload, "name")) {
    if (typeof payload.name !== "string") {
      throw new ApiError(422, "invalid_name");
    }
    const name = payload.name.trim();
    if (name.length === 0 || name.length > 100) {
      throw new ApiError(422, "invalid_name");
    }
    values.name = name;
  }
  if (Object.hasOwn(payload, "kind")) {
    if (typeof payload.kind !== "string" || !KINDS.has(payload.kind)) {
      throw new ApiError(422, "invalid_kind");
    }
    values.kind = payload.kind;
  }
  if (Object.hasOwn(payload, "parent_id")) {
    values.parent_id =
      payload.parent_id === null
        ? null
        : parsePositiveInteger(payload.parent_id, "invalid_parent_id");
  }
  return values;
}

async function listCategories(db) {
  const rows = await queryAll(
    db,
    `${CATEGORY_SELECT} ORDER BY kind, name, id`,
  );
  return jsonResponse(200, { items: rows.map(categoryPayload) });
}

async function getCategory(db, categoryId) {
  const row = await findCategory(db, categoryId);
  if (row === null) {
    throw new ApiError(404, "category_not_found");
  }
  return jsonResponse(200, categoryPayload(row));
}

async function createCategory(db, request, generateId, now) {
  const values = await parseCategoryPayload(request, false);
  await validateCategoryParent(db, values.parent_id, values.kind);
  await ensureUniqueCategory(db, values.name, values.kind, values.parent_id);
  const categoryId = nextId(generateId);
  const timestamp = utcTimestamp(now);
  await writeBatch(
    db,
    [
      prepared(
        db,
        "INSERT INTO categories(id, name, kind, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        [categoryId, values.name, values.kind, values.parent_id, timestamp, timestamp],
      ),
    ],
    "category_conflict",
  );
  return jsonResponse(201, categoryPayload(await findCategory(db, categoryId)));
}

async function updateCategory(db, request, categoryId, partial, now) {
  const values = await parseCategoryPayload(request, partial);
  const current = await findCategory(db, categoryId);
  if (current === null) {
    throw new ApiError(404, "category_not_found");
  }
  const desired = {
    name: values.name ?? current.name,
    kind: values.kind ?? current.kind,
    parent_id: Object.hasOwn(values, "parent_id") ? values.parent_id : current.parent_id,
  };
  await validateCategoryParent(db, desired.parent_id, desired.kind, categoryId);
  if (desired.kind !== current.kind) {
    const child = await queryFirst(
      db,
      "SELECT 1 AS found FROM categories WHERE parent_id = ? LIMIT 1",
      [categoryId],
    );
    if (child !== null) {
      throw new ApiError(409, "category_has_children");
    }
  }
  await ensureUniqueCategory(
    db,
    desired.name,
    desired.kind,
    desired.parent_id,
    categoryId,
  );
  await writeBatch(
    db,
    [
      prepared(
        db,
        "UPDATE categories SET name = ?, kind = ?, parent_id = ?, updated_at = ? WHERE id = ?",
        [desired.name, desired.kind, desired.parent_id, utcTimestamp(now), categoryId],
      ),
    ],
    "category_conflict",
  );
  return jsonResponse(200, categoryPayload(await findCategory(db, categoryId)));
}

async function deactivateCategory(db, categoryId, now) {
  const current = await findCategory(db, categoryId);
  if (current === null) {
    throw new ApiError(404, "category_not_found");
  }
  if (current.active) {
    const timestamp = utcTimestamp(now);
    await writeBatch(
      db,
      [
        prepared(
          db,
          "UPDATE categories SET active = 0, inactive_at = ?, updated_at = ? WHERE id = ? AND active = 1",
          [timestamp, timestamp, categoryId],
        ),
      ],
      "category_conflict",
    );
  }
  return jsonResponse(200, categoryPayload(await findCategory(db, categoryId)));
}

async function parseEntryPayload(request, partial, update = false) {
  const payload = await readJsonObject(request);
  const fields = Object.keys(payload);
  if (hasUnknownFields(payload, ENTRY_ALLOWED_FIELDS)) {
    throw new ApiError(422, "unknown_field");
  }
  if (!partial && [...ENTRY_REQUIRED_FIELDS].some((field) => !Object.hasOwn(payload, field))) {
    throw new ApiError(422, "required_fields");
  }
  if (partial && fields.length === 0) {
    throw new ApiError(422, "empty_update");
  }

  const values = {};
  if (Object.hasOwn(payload, "kind")) {
    if (typeof payload.kind !== "string" || !KINDS.has(payload.kind)) {
      throw new ApiError(422, "invalid_kind");
    }
    values.kind = payload.kind;
  }
  if (Object.hasOwn(payload, "category_id")) {
    values.category_id = parsePositiveInteger(payload.category_id, "invalid_category_id");
  }
  if (Object.hasOwn(payload, "amount_minor")) {
    values.amount_minor = parsePositiveInteger(payload.amount_minor, "invalid_amount_minor");
  }
  if (Object.hasOwn(payload, "currency")) {
    if (typeof payload.currency !== "string" || !/^[A-Z]{3}$/.test(payload.currency)) {
      throw new ApiError(422, "invalid_currency");
    }
    values.currency = payload.currency;
  }
  if (Object.hasOwn(payload, "occurred_on")) {
    values.occurred_on = parseDate(payload.occurred_on, "invalid_occurred_on");
  }
  if (Object.hasOwn(payload, "first_due_on")) {
    values.first_due_on = parseDate(payload.first_due_on, "invalid_first_due_on");
  }
  if (Object.hasOwn(payload, "description")) {
    if (payload.description !== null && typeof payload.description !== "string") {
      throw new ApiError(422, "invalid_description");
    }
    values.description = payload.description;
  }
  if (Object.hasOwn(payload, "installment_count")) {
    values.installment_count = parsePositiveInteger(
      payload.installment_count,
      "invalid_installment_count",
      MAX_INSTALLMENT_COUNT,
    );
  }
  if (Object.hasOwn(payload, "interval_months")) {
    if (
      !Number.isSafeInteger(payload.interval_months) ||
      payload.interval_months < 1 ||
      payload.interval_months > 12
    ) {
      throw new ApiError(422, "invalid_interval_months");
    }
    values.interval_months = payload.interval_months;
  }
  if (
    !update &&
    (Object.hasOwn(values, "first_due_on") || Object.hasOwn(values, "interval_months")) &&
    (values.installment_count ?? 1) <= 1
  ) {
    throw new ApiError(422, "installment_options_require_plan");
  }
  return values;
}

async function findEntry(db, entryId) {
  return queryFirst(db, `${ENTRY_SELECT} WHERE id = ?`, [entryId]);
}

async function requireEntry(db, entryId) {
  const entry = await findEntry(db, entryId);
  if (entry === null) {
    throw new ApiError(404, "entry_not_found");
  }
  return entry;
}

async function findCurrentPlan(db, entryId) {
  return queryFirst(
    db,
    `${PLAN_SELECT} WHERE entry_id = ? AND status <> 'voided' ORDER BY revision DESC LIMIT 1`,
    [entryId],
  );
}

async function findLatestPlan(db, entryId) {
  return queryFirst(
    db,
    `${PLAN_SELECT} WHERE entry_id = ? ORDER BY revision DESC LIMIT 1`,
    [entryId],
  );
}

async function findDisplayPlan(db, entry) {
  if (entry.voided_at === null) {
    return findCurrentPlan(db, entry.id);
  }
  return queryFirst(
    db,
    `${PLAN_SELECT} WHERE entry_id = ? AND void_reason = 'entry_voided' ORDER BY revision DESC LIMIT 1`,
    [entry.id],
  );
}

async function entryPayload(db, entry) {
  const plan = await findDisplayPlan(db, entry);
  const installments =
    plan === null
      ? []
      : await queryAll(
          db,
          `${INSTALLMENT_SELECT} WHERE plan_id = ? ORDER BY sequence, id`,
          [plan.id],
        );
  return {
    ...entryBasePayload(entry),
    installment_plan: plan === null ? null : planPayload(plan),
    installments: installments.map(installmentPayload),
  };
}

function scheduleInsertStatement(db, planId, schedule) {
  return prepared(
    db,
    "INSERT INTO installments(plan_id, sequence, amount_minor, due_on) " +
      "SELECT ?, CAST(json_extract(value, '$.sequence') AS INTEGER), " +
      "CAST(json_extract(value, '$.amount_minor') AS INTEGER), json_extract(value, '$.due_on') " +
      "FROM json_each(?) ORDER BY CAST(json_extract(value, '$.sequence') AS INTEGER)",
    [planId, JSON.stringify(schedule)],
  );
}

function planInsertStatement(db, planId, entryId, revision, values, timestamp) {
  return prepared(
    db,
    "INSERT INTO installment_plans" +
      "(id, entry_id, revision, total_amount_minor, installment_count, currency, status, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)",
    [
      planId,
      entryId,
      revision,
      values.amount_minor,
      values.installment_count,
      values.currency,
      timestamp,
      timestamp,
    ],
  );
}

function appendPlanCreation(statements, db, planId, entryId, revision, values, timestamp) {
  const schedule = buildSchedule(
    values.amount_minor,
    values.installment_count,
    values.first_due_on,
    values.interval_months,
  );
  statements.push(planInsertStatement(db, planId, entryId, revision, values, timestamp));
  statements.push(scheduleInsertStatement(db, planId, schedule));
}

async function listEntries(db) {
  const rows = await queryAll(db, `${ENTRY_SELECT} ORDER BY occurred_on, id`);
  return jsonResponse(200, { items: rows.map(entryBasePayload) });
}

async function getEntry(db, entryId) {
  return jsonResponse(200, await entryPayload(db, await requireEntry(db, entryId)));
}

async function createEntry(db, request, generateId, now) {
  const values = await parseEntryPayload(request, false, false);
  await validateCategory(db, values.category_id, values.kind);
  const timestamp = utcTimestamp(now);
  const entryId = nextId(generateId);
  const statements = [
    prepared(
      db,
      "INSERT INTO ledger_entries" +
        "(id, kind, category_id, amount_minor, currency, occurred_on, description, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        entryId,
        values.kind,
        values.category_id,
        values.amount_minor,
        values.currency,
        values.occurred_on,
        values.description ?? null,
        timestamp,
        timestamp,
      ],
    ),
  ];
  const count = values.installment_count ?? 1;
  if (count > 1) {
    appendPlanCreation(
      statements,
      db,
      nextId(generateId),
      entryId,
      1,
      {
        ...values,
        installment_count: count,
        first_due_on: values.first_due_on ?? values.occurred_on,
        interval_months: values.interval_months ?? 1,
      },
      timestamp,
    );
  }
  await writeBatch(db, statements, "ledger_conflict");
  return jsonResponse(201, await entryPayload(db, await requireEntry(db, entryId)));
}

async function planScheduleDefaults(db, plan) {
  const rows = await queryAll(
    db,
    "SELECT due_on FROM installments WHERE plan_id = ? ORDER BY sequence LIMIT 2",
    [plan.id],
  );
  if (rows.length === 0) {
    throw new ApiError(500, "installment_schedule_missing");
  }
  let intervalMonths = 1;
  if (rows.length > 1) {
    const first = dateParts(rows[0].due_on);
    const second = dateParts(rows[1].due_on);
    intervalMonths =
      (second.year - first.year) * 12 + (second.month - first.month);
    if (intervalMonths < 1 || intervalMonths > 12) {
      intervalMonths = 1;
    }
  }
  return { first_due_on: rows[0].due_on, interval_months: intervalMonths };
}

function appendPlanVoid(statements, db, plan, reason, timestamp) {
  statements.push(
    prepared(
      db,
      "UPDATE installments SET status = 'voided', paid_at = NULL, updated_at = ? " +
        "WHERE plan_id = ? AND status = 'pending'",
      [timestamp, plan.id],
    ),
  );
  statements.push(
    prepared(
      db,
      "UPDATE installment_plans SET status = 'voided', void_reason = ?, updated_at = ? " +
        "WHERE id = ? AND status <> 'voided'",
      [reason, timestamp, plan.id],
    ),
  );
}

async function updateEntry(db, request, entryId, partial, generateId, now) {
  const values = await parseEntryPayload(request, partial, true);
  const current = await requireEntry(db, entryId);
  if (current.voided_at !== null) {
    throw new ApiError(409, "entry_voided");
  }
  const currentPlan = await findCurrentPlan(db, entryId);
  const currentCount = currentPlan?.installment_count ?? 1;
  const paidExists =
    currentPlan !== null &&
    (await queryFirst(
      db,
      "SELECT 1 AS found FROM installments WHERE plan_id = ? AND status = 'paid' LIMIT 1",
      [currentPlan.id],
    )) !== null;
  const desired = {
    kind: values.kind ?? current.kind,
    category_id: values.category_id ?? current.category_id,
    amount_minor: values.amount_minor ?? current.amount_minor,
    currency: values.currency ?? current.currency,
    occurred_on: values.occurred_on ?? current.occurred_on,
    description: Object.hasOwn(values, "description")
      ? values.description
      : partial
        ? current.description
        : null,
  };
  const desiredCount = values.installment_count ?? currentCount;
  await validateCategory(db, desired.category_id, desired.kind);

  const changesPaidSchedule =
    desired.kind !== current.kind ||
    desired.category_id !== current.category_id ||
    desired.amount_minor !== current.amount_minor ||
    desired.currency !== current.currency ||
    desiredCount !== currentCount ||
    Object.hasOwn(values, "first_due_on") ||
    Object.hasOwn(values, "interval_months");
  if (paidExists && changesPaidSchedule) {
    throw new ApiError(409, "paid_installments_immutable");
  }
  if (
    desiredCount <= 1 &&
    (Object.hasOwn(values, "first_due_on") || Object.hasOwn(values, "interval_months"))
  ) {
    throw new ApiError(422, "installment_options_require_plan");
  }

  const timestamp = utcTimestamp(now);
  const statements = [
    prepared(
      db,
      "UPDATE ledger_entries SET kind = ?, category_id = ?, amount_minor = ?, currency = ?, " +
        "occurred_on = ?, description = ?, updated_at = ? WHERE id = ? AND voided_at IS NULL",
      [
        desired.kind,
        desired.category_id,
        desired.amount_minor,
        desired.currency,
        desired.occurred_on,
        desired.description,
        timestamp,
        entryId,
      ],
    ),
  ];

  if (currentPlan === null && desiredCount > 1) {
    const latestPlan = await findLatestPlan(db, entryId);
    appendPlanCreation(
      statements,
      db,
      nextId(generateId),
      entryId,
      (latestPlan?.revision ?? 0) + 1,
      {
        ...desired,
        installment_count: desiredCount,
        first_due_on: values.first_due_on ?? desired.occurred_on,
        interval_months: values.interval_months ?? 1,
      },
      timestamp,
    );
  } else if (currentPlan !== null && desiredCount <= 1) {
    appendPlanVoid(statements, db, currentPlan, "superseded", timestamp);
  } else if (currentPlan !== null && desiredCount > 1) {
    const scheduleChanged =
      desiredCount !== currentCount ||
      desired.amount_minor !== current.amount_minor ||
      desired.currency !== current.currency ||
      Object.hasOwn(values, "first_due_on") ||
      Object.hasOwn(values, "interval_months");
    if (scheduleChanged) {
      const defaults = await planScheduleDefaults(db, currentPlan);
      appendPlanVoid(statements, db, currentPlan, "superseded", timestamp);
      appendPlanCreation(
        statements,
        db,
        nextId(generateId),
        entryId,
        currentPlan.revision + 1,
        {
          ...desired,
          installment_count: desiredCount,
          first_due_on: values.first_due_on ?? defaults.first_due_on,
          interval_months: values.interval_months ?? defaults.interval_months,
        },
        timestamp,
      );
    }
  }

  await writeBatch(db, statements, "ledger_conflict");
  return jsonResponse(200, await entryPayload(db, await requireEntry(db, entryId)));
}

async function voidEntry(db, entryId, now) {
  const entry = await requireEntry(db, entryId);
  if (entry.voided_at !== null) {
    return jsonResponse(200, await entryPayload(db, entry));
  }
  const currentPlan = await findCurrentPlan(db, entryId);
  const timestamp = utcTimestamp(now);
  const statements = [
    prepared(
      db,
      "UPDATE ledger_entries SET voided_at = ?, updated_at = ? WHERE id = ? AND voided_at IS NULL",
      [timestamp, timestamp, entryId],
    ),
  ];
  if (currentPlan !== null) {
    appendPlanVoid(statements, db, currentPlan, "entry_voided", timestamp);
  }
  await writeBatch(db, statements, "ledger_conflict");
  return jsonResponse(200, await entryPayload(db, await requireEntry(db, entryId)));
}

async function findInstallment(db, installmentId) {
  return queryFirst(
    db,
    "SELECT i.id, i.plan_id, i.sequence, i.amount_minor, i.due_on, i.status, i.paid_at, " +
      "p.entry_id, e.voided_at AS entry_voided_at " +
      "FROM installments AS i " +
      "JOIN installment_plans AS p ON p.id = i.plan_id " +
      "JOIN ledger_entries AS e ON e.id = p.entry_id WHERE i.id = ?",
    [installmentId],
  );
}

async function getInstallment(db, installmentId) {
  const row = await findInstallment(db, installmentId);
  if (row === null) {
    throw new ApiError(404, "installment_not_found");
  }
  return jsonResponse(200, installmentPayload(row));
}

async function updateInstallment(db, request, installmentId, now) {
  const payload = await readJsonObject(request);
  if (Object.keys(payload).length !== 1 || !Object.hasOwn(payload, "status")) {
    throw new ApiError(422, "invalid_installment_update");
  }
  if (typeof payload.status !== "string" || !INSTALLMENT_STATUSES.has(payload.status)) {
    throw new ApiError(422, "invalid_installment_status");
  }
  const current = await findInstallment(db, installmentId);
  if (current === null) {
    throw new ApiError(404, "installment_not_found");
  }
  if (current.entry_voided_at !== null) {
    throw new ApiError(409, "entry_voided");
  }
  if (current.status === "voided") {
    throw new ApiError(409, "installment_voided");
  }
  const timestamp = utcTimestamp(now);
  const paidAt = payload.status === "paid" ? timestamp : null;
  await writeBatch(
    db,
    [
      prepared(
        db,
        "UPDATE installments SET status = ?, paid_at = ?, updated_at = ? WHERE id = ?",
        [payload.status, paidAt, timestamp, installmentId],
      ),
      prepared(
        db,
        "UPDATE installment_plans SET status = CASE " +
          "WHEN EXISTS (SELECT 1 FROM installments WHERE plan_id = ? AND status = 'pending') " +
          "THEN 'active' ELSE 'completed' END, updated_at = ? " +
          "WHERE id = ? AND status <> 'voided'",
        [current.plan_id, timestamp, current.plan_id],
      ),
    ],
    "ledger_conflict",
  );
  return jsonResponse(200, installmentPayload(await findInstallment(db, installmentId)));
}

function monthEntry(entry) {
  return {
    entry_id: entry.id,
    installment_id: null,
    sequence: null,
    due_on: entry.occurred_on,
    kind: entry.kind,
    category_id: entry.category_id,
    allocated_amount_minor: entry.amount_minor,
    currency: entry.currency,
    status: "paid",
    paid_at: null,
    description: entry.description,
  };
}

function monthInstallment(entry, installment) {
  return {
    entry_id: entry.id,
    installment_id: installment.id,
    sequence: installment.sequence,
    due_on: installment.due_on,
    kind: entry.kind,
    category_id: entry.category_id,
    allocated_amount_minor: installment.amount_minor,
    currency: entry.currency,
    status: installment.status,
    paid_at: installment.paid_at,
    description: entry.description,
  };
}

function safeMinorTotal(items, predicate) {
  let total = 0n;
  for (const item of items) {
    if (predicate(item)) {
      total += BigInt(item.allocated_amount_minor);
    }
  }
  if (total > BigInt(MAX_SAFE_SQLITE_INTEGER)) {
    throw new ApiError(409, "amount_total_out_of_range");
  }
  return Number(total);
}

async function getMonth(db, month) {
  parseMonth(month);
  const entries = await queryAll(
    db,
    `${ENTRY_SELECT} WHERE voided_at IS NULL ORDER BY occurred_on, id`,
  );
  const items = [];
  for (const entry of entries) {
    const plan = await findCurrentPlan(db, entry.id);
    if (plan === null) {
      if (entry.occurred_on.slice(0, 7) === month) {
        items.push(monthEntry(entry));
      }
      continue;
    }
    const installments = await queryAll(
      db,
      `${INSTALLMENT_SELECT} WHERE plan_id = ? AND due_on LIKE ? AND status <> 'voided' ` +
        "ORDER BY due_on, sequence, id",
      [plan.id, `${month}-%`],
    );
    items.push(...installments.map((row) => monthInstallment(entry, row)));
  }
  const totals = {
    income_minor: safeMinorTotal(items, (item) => item.kind === "income"),
    expense_minor: safeMinorTotal(items, (item) => item.kind === "expense"),
    pending_minor: safeMinorTotal(items, (item) => item.status === "pending"),
    paid_minor: safeMinorTotal(items, (item) => item.status === "paid"),
  };
  return jsonResponse(200, { month, items, totals });
}

function methodNotAllowed() {
  return jsonResponse(405, { error: "method_not_allowed" });
}

async function dispatchDataRequest(request, db, generateId, now) {
  const { pathname } = new URL(request.url);
  const method = request.method.toUpperCase();

  if (pathname === "/v1/categories") {
    if (method === "GET") return listCategories(db);
    if (method === "POST") return createCategory(db, request, generateId, now);
    return methodNotAllowed();
  }
  let match = /^\/v1\/categories\/([^/]+)$/.exec(pathname);
  if (match !== null) {
    if (!["GET", "PUT", "PATCH", "DELETE"].includes(method)) return methodNotAllowed();
    const categoryId = parsePathId(match[1], "category");
    if (method === "GET") return getCategory(db, categoryId);
    if (method === "PUT") return updateCategory(db, request, categoryId, false, now);
    if (method === "PATCH") return updateCategory(db, request, categoryId, true, now);
    return deactivateCategory(db, categoryId, now);
  }

  if (pathname === "/v1/entries") {
    if (method === "GET") return listEntries(db);
    if (method === "POST") return createEntry(db, request, generateId, now);
    return methodNotAllowed();
  }
  match = /^\/v1\/entries\/([^/]+)$/.exec(pathname);
  if (match !== null) {
    if (!["GET", "PUT", "PATCH", "DELETE"].includes(method)) return methodNotAllowed();
    const entryId = parsePathId(match[1], "entry");
    if (method === "GET") return getEntry(db, entryId);
    if (method === "PUT") return updateEntry(db, request, entryId, false, generateId, now);
    if (method === "PATCH") return updateEntry(db, request, entryId, true, generateId, now);
    return voidEntry(db, entryId, now);
  }

  match = /^\/v1\/installments\/([^/]+)$/.exec(pathname);
  if (match !== null) {
    if (!["GET", "PATCH"].includes(method)) return methodNotAllowed();
    const installmentId = parsePathId(match[1], "installment");
    if (method === "GET") return getInstallment(db, installmentId);
    return updateInstallment(db, request, installmentId, now);
  }

  match = /^\/v1\/months\/([^/]+)$/.exec(pathname);
  if (match !== null) {
    if (method !== "GET") return methodNotAllowed();
    return getMonth(db, match[1]);
  }
  return jsonResponse(404, { error: "not_found" });
}

export function createWorker(options = {}) {
  const generateId = options.generateId ?? defaultIdGenerator;
  const now = options.now ?? (() => new Date());
  const onError = options.onError ?? (() => {});
  return {
    async fetch(request, env = {}) {
      try {
        assertDeclaredBodySize(request);
        const { pathname } = new URL(request.url);
        if (pathname === "/healthz") {
          return request.method.toUpperCase() === "GET"
            ? jsonResponse(200, { status: "ok" })
            : methodNotAllowed();
        }
        if (typeof env.WORKER_API_TOKEN !== "string" || env.WORKER_API_TOKEN.length === 0) {
          throw new ApiError(503, "worker_api_token_missing");
        }
        const expected = `Bearer ${env.WORKER_API_TOKEN}`;
        const actual = request.headers.get("authorization") ?? "";
        if (!constantTimeEqual(actual, expected)) {
          throw new ApiError(401, "unauthorized");
        }
        if (env.DB === null || typeof env.DB?.prepare !== "function" || typeof env.DB?.batch !== "function") {
          throw new ApiError(503, "database_binding_missing");
        }
        return await dispatchDataRequest(request, env.DB, generateId, now);
      } catch (error) {
        if (error instanceof ApiError) {
          return jsonResponse(error.status, { error: error.code });
        }
        onError(error);
        return jsonResponse(500, { error: "internal_server_error" });
      }
    },
  };
}

export default createWorker();
