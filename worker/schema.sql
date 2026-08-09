PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL CHECK (trim(name) <> ''),
    kind TEXT NOT NULL CHECK (kind IN ('income', 'expense')),
    parent_id INTEGER REFERENCES categories(id) ON DELETE RESTRICT,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE UNIQUE INDEX IF NOT EXISTS categories_parent_kind_name_uq
    ON categories (ifnull(parent_id, 0), kind, name);

CREATE TRIGGER IF NOT EXISTS categories_parent_kind_insert
BEFORE INSERT ON categories
WHEN NEW.parent_id IS NOT NULL
 AND (SELECT kind FROM categories WHERE id = NEW.parent_id) <> NEW.kind
BEGIN
    SELECT RAISE(ABORT, 'category parent kind must match');
END;

CREATE TRIGGER IF NOT EXISTS categories_parent_kind_update
BEFORE UPDATE OF parent_id, kind ON categories
WHEN NEW.parent_id IS NOT NULL
 AND (SELECT kind FROM categories WHERE id = NEW.parent_id) <> NEW.kind
BEGIN
    SELECT RAISE(ABORT, 'category parent kind must match');
END;

CREATE TABLE IF NOT EXISTS ledger_entries (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('income', 'expense')),
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
    amount_minor INTEGER NOT NULL
        CHECK (typeof(amount_minor) = 'integer' AND amount_minor >= 0),
    currency TEXT NOT NULL
        CHECK (length(currency) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]'),
    occurred_on TEXT NOT NULL
        CHECK (length(occurred_on) = 10
            AND date(occurred_on) IS NOT NULL
            AND date(occurred_on) = occurred_on),
    description TEXT,
    voided_at TEXT
        CHECK (voided_at IS NULL OR datetime(voided_at) IS NOT NULL)
);

CREATE TRIGGER IF NOT EXISTS ledger_category_kind_insert
BEFORE INSERT ON ledger_entries
WHEN (SELECT kind FROM categories WHERE id = NEW.category_id) <> NEW.kind
BEGIN
    SELECT RAISE(ABORT, 'ledger category kind must match');
END;

CREATE TRIGGER IF NOT EXISTS ledger_category_kind_update
BEFORE UPDATE OF category_id, kind ON ledger_entries
WHEN (SELECT kind FROM categories WHERE id = NEW.category_id) <> NEW.kind
BEGIN
    SELECT RAISE(ABORT, 'ledger category kind must match');
END;

CREATE TABLE IF NOT EXISTS installment_plans (
    id INTEGER PRIMARY KEY,
    total_amount_minor INTEGER NOT NULL
        CHECK (typeof(total_amount_minor) = 'integer' AND total_amount_minor >= 0),
    installment_count INTEGER NOT NULL CHECK (installment_count > 0),
    currency TEXT NOT NULL
        CHECK (length(currency) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]'),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'completed', 'voided'))
);

CREATE TABLE IF NOT EXISTS installments (
    id INTEGER PRIMARY KEY,
    plan_id INTEGER NOT NULL REFERENCES installment_plans(id) ON DELETE RESTRICT,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    amount_minor INTEGER NOT NULL
        CHECK (typeof(amount_minor) = 'integer' AND amount_minor >= 0),
    due_on TEXT NOT NULL
        CHECK (length(due_on) = 10
            AND date(due_on) IS NOT NULL
            AND date(due_on) = due_on),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'paid', 'voided')),
    paid_at TEXT,
    UNIQUE (plan_id, sequence),
    CHECK ((status = 'paid' AND paid_at IS NOT NULL)
        OR (status <> 'paid' AND paid_at IS NULL)),
    CHECK (paid_at IS NULL OR datetime(paid_at) IS NOT NULL)
);

CREATE TRIGGER IF NOT EXISTS installments_validate_insert
BEFORE INSERT ON installments
WHEN NEW.sequence > (SELECT installment_count FROM installment_plans WHERE id = NEW.plan_id)
  OR (SELECT count(*) FROM installments WHERE plan_id = NEW.plan_id)
       >= (SELECT installment_count FROM installment_plans WHERE id = NEW.plan_id)
BEGIN
    SELECT RAISE(ABORT, 'installment count or sequence exceeds plan');
END;

CREATE TRIGGER IF NOT EXISTS installments_validate_update
BEFORE UPDATE OF plan_id, sequence ON installments
WHEN NEW.sequence > (SELECT installment_count FROM installment_plans WHERE id = NEW.plan_id)
BEGIN
    SELECT RAISE(ABORT, 'installment sequence exceeds plan');
END;

CREATE TRIGGER IF NOT EXISTS installments_exact_total_insert
AFTER INSERT ON installments
WHEN (SELECT count(*) FROM installments WHERE plan_id = NEW.plan_id)
       = (SELECT installment_count FROM installment_plans WHERE id = NEW.plan_id)
 AND (SELECT coalesce(sum(amount_minor), 0) FROM installments WHERE plan_id = NEW.plan_id)
       <> (SELECT total_amount_minor FROM installment_plans WHERE id = NEW.plan_id)
BEGIN
    SELECT RAISE(ABORT, 'installment amounts must equal plan total');
END;

CREATE TRIGGER IF NOT EXISTS installments_exact_total_update
AFTER UPDATE OF plan_id, amount_minor ON installments
WHEN (SELECT count(*) FROM installments WHERE plan_id = NEW.plan_id)
       = (SELECT installment_count FROM installment_plans WHERE id = NEW.plan_id)
 AND (SELECT coalesce(sum(amount_minor), 0) FROM installments WHERE plan_id = NEW.plan_id)
       <> (SELECT total_amount_minor FROM installment_plans WHERE id = NEW.plan_id)
BEGIN
    SELECT RAISE(ABORT, 'installment amounts must equal plan total');
END;

CREATE TRIGGER IF NOT EXISTS installment_plan_total_update
AFTER UPDATE OF total_amount_minor, installment_count ON installment_plans
WHEN EXISTS (
    SELECT 1 FROM installments
    WHERE plan_id = NEW.id
)
 AND (SELECT count(*) FROM installments WHERE plan_id = NEW.id)
       = NEW.installment_count
 AND (SELECT coalesce(sum(amount_minor), 0) FROM installments WHERE plan_id = NEW.id)
       <> NEW.total_amount_minor
BEGIN
    SELECT RAISE(ABORT, 'installment amounts must equal plan total');
END;

CREATE TRIGGER IF NOT EXISTS installment_plan_count_update
BEFORE UPDATE OF installment_count ON installment_plans
WHEN (SELECT count(*) FROM installments WHERE plan_id = NEW.id)
       > NEW.installment_count
BEGIN
    SELECT RAISE(ABORT, 'installment count cannot be below existing installments');
END;
