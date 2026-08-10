PRAGMA foreign_keys = ON;

CREATE TABLE categories (
    id INTEGER PRIMARY KEY CHECK (id > 0),
    name TEXT NOT NULL CHECK (trim(name) <> '' AND length(name) <= 100),
    kind TEXT NOT NULL CHECK (kind IN ('income', 'expense')),
    parent_id INTEGER REFERENCES categories(id) ON DELETE RESTRICT,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        CHECK (datetime(created_at) IS NOT NULL),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        CHECK (datetime(updated_at) IS NOT NULL),
    inactive_at TEXT CHECK (inactive_at IS NULL OR datetime(inactive_at) IS NOT NULL),
    CHECK ((active = 1 AND inactive_at IS NULL) OR (active = 0 AND inactive_at IS NOT NULL))
);

CREATE UNIQUE INDEX categories_parent_kind_name_uq
    ON categories (ifnull(parent_id, 0), kind, name);
CREATE INDEX categories_kind_active_name_idx
    ON categories (kind, active, name, id);
CREATE INDEX categories_parent_id_idx ON categories (parent_id);

CREATE TRIGGER categories_parent_kind_insert
BEFORE INSERT ON categories
WHEN NEW.parent_id IS NOT NULL
 AND (NEW.parent_id = NEW.id
      OR NOT EXISTS (
          SELECT 1 FROM categories
          WHERE id = NEW.parent_id AND kind = NEW.kind
      ))
BEGIN
    SELECT RAISE(ABORT, 'category parent must exist and have matching kind');
END;

CREATE TRIGGER categories_parent_kind_update
BEFORE UPDATE OF parent_id, kind ON categories
WHEN NEW.parent_id IS NOT NULL
 AND NOT EXISTS (
     SELECT 1 FROM categories
     WHERE id = NEW.parent_id AND kind = NEW.kind
 )
BEGIN
    SELECT RAISE(ABORT, 'category parent must exist and have matching kind');
END;

CREATE TRIGGER categories_children_kind_update
BEFORE UPDATE OF kind ON categories
WHEN NEW.kind <> OLD.kind
 AND EXISTS (SELECT 1 FROM categories WHERE parent_id = OLD.id)
BEGIN
    SELECT RAISE(ABORT, 'category with children cannot change kind');
END;

CREATE TRIGGER categories_cycle_update
BEFORE UPDATE OF parent_id ON categories
WHEN NEW.parent_id = NEW.id
 OR EXISTS (
     WITH RECURSIVE ancestors(id, parent_id) AS (
         SELECT id, parent_id FROM categories WHERE id = NEW.parent_id
         UNION ALL
         SELECT category.id, category.parent_id
         FROM categories AS category
         JOIN ancestors ON category.id = ancestors.parent_id
         WHERE ancestors.parent_id IS NOT NULL
     )
     SELECT 1 FROM ancestors WHERE id = NEW.id
 )
BEGIN
    SELECT RAISE(ABORT, 'category cycle');
END;

CREATE TABLE ledger_entries (
    id INTEGER PRIMARY KEY CHECK (id > 0),
    kind TEXT NOT NULL CHECK (kind IN ('income', 'expense')),
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
    amount_minor INTEGER NOT NULL
        CHECK (typeof(amount_minor) = 'integer' AND amount_minor > 0),
    currency TEXT NOT NULL
        CHECK (length(currency) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]'),
    occurred_on TEXT NOT NULL
        CHECK (length(occurred_on) = 10
            AND date(occurred_on) IS NOT NULL
            AND date(occurred_on) = occurred_on),
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        CHECK (datetime(created_at) IS NOT NULL),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        CHECK (datetime(updated_at) IS NOT NULL),
    voided_at TEXT CHECK (voided_at IS NULL OR datetime(voided_at) IS NOT NULL)
);

CREATE INDEX ledger_entries_occurred_on_id_idx ON ledger_entries (occurred_on, id);
CREATE INDEX ledger_entries_category_id_idx ON ledger_entries (category_id);
CREATE INDEX ledger_entries_voided_at_idx ON ledger_entries (voided_at);

CREATE TRIGGER ledger_category_insert
BEFORE INSERT ON ledger_entries
WHEN NOT EXISTS (
    SELECT 1 FROM categories
    WHERE id = NEW.category_id AND kind = NEW.kind AND active = 1
)
BEGIN
    SELECT RAISE(ABORT, 'ledger category must be active and match kind');
END;

CREATE TRIGGER ledger_category_update
BEFORE UPDATE OF category_id, kind ON ledger_entries
WHEN NOT EXISTS (
    SELECT 1 FROM categories
    WHERE id = NEW.category_id AND kind = NEW.kind AND active = 1
)
BEGIN
    SELECT RAISE(ABORT, 'ledger category must be active and match kind');
END;

CREATE TABLE installment_plans (
    id INTEGER PRIMARY KEY CHECK (id > 0),
    entry_id INTEGER NOT NULL REFERENCES ledger_entries(id) ON DELETE RESTRICT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    total_amount_minor INTEGER NOT NULL
        CHECK (typeof(total_amount_minor) = 'integer' AND total_amount_minor > 0),
    installment_count INTEGER NOT NULL
        CHECK (typeof(installment_count) = 'integer'
            AND installment_count > 1 AND installment_count <= 1200),
    currency TEXT NOT NULL
        CHECK (length(currency) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]'),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'completed', 'voided')),
    void_reason TEXT CHECK (void_reason IN ('superseded', 'entry_voided')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        CHECK (datetime(created_at) IS NOT NULL),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        CHECK (datetime(updated_at) IS NOT NULL),
    UNIQUE (entry_id, revision),
    CHECK ((status = 'voided' AND void_reason IS NOT NULL)
        OR (status <> 'voided' AND void_reason IS NULL))
);

CREATE UNIQUE INDEX installment_plans_current_entry_uq
    ON installment_plans (entry_id) WHERE status <> 'voided';
CREATE INDEX installment_plans_entry_revision_idx
    ON installment_plans (entry_id, revision DESC);
CREATE INDEX installment_plans_status_idx ON installment_plans (status);

CREATE TRIGGER installment_plan_matches_entry_insert
BEFORE INSERT ON installment_plans
WHEN NOT EXISTS (
    SELECT 1 FROM ledger_entries
    WHERE id = NEW.entry_id
      AND voided_at IS NULL
      AND amount_minor = NEW.total_amount_minor
      AND currency = NEW.currency
)
BEGIN
    SELECT RAISE(ABORT, 'installment plan must match an active ledger entry');
END;

CREATE TABLE installments (
    id INTEGER PRIMARY KEY CHECK (id > 0),
    plan_id INTEGER NOT NULL REFERENCES installment_plans(id) ON DELETE RESTRICT,
    sequence INTEGER NOT NULL CHECK (typeof(sequence) = 'integer' AND sequence > 0),
    amount_minor INTEGER NOT NULL
        CHECK (typeof(amount_minor) = 'integer' AND amount_minor >= 0),
    due_on TEXT NOT NULL
        CHECK (length(due_on) = 10
            AND date(due_on) IS NOT NULL
            AND date(due_on) = due_on),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'paid', 'voided')),
    paid_at TEXT CHECK (paid_at IS NULL OR datetime(paid_at) IS NOT NULL),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        CHECK (datetime(created_at) IS NOT NULL),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        CHECK (datetime(updated_at) IS NOT NULL),
    UNIQUE (plan_id, sequence),
    CHECK ((status = 'paid' AND paid_at IS NOT NULL)
        OR (status <> 'paid' AND paid_at IS NULL))
);

CREATE INDEX installments_plan_sequence_idx ON installments (plan_id, sequence, id);
CREATE INDEX installments_due_status_idx ON installments (due_on, status, plan_id);

CREATE TRIGGER installments_validate_insert
BEFORE INSERT ON installments
WHEN NEW.sequence > (
        SELECT installment_count FROM installment_plans WHERE id = NEW.plan_id
     )
  OR (SELECT count(*) FROM installments WHERE plan_id = NEW.plan_id)
       >= (SELECT installment_count FROM installment_plans WHERE id = NEW.plan_id)
  OR NOT EXISTS (
      SELECT 1 FROM installment_plans
      WHERE id = NEW.plan_id AND status = 'active'
  )
BEGIN
    SELECT RAISE(ABORT, 'invalid installment for plan');
END;

CREATE TRIGGER installments_exact_total_insert
AFTER INSERT ON installments
WHEN (SELECT count(*) FROM installments WHERE plan_id = NEW.plan_id)
       = (SELECT installment_count FROM installment_plans WHERE id = NEW.plan_id)
 AND (SELECT coalesce(sum(amount_minor), 0) FROM installments WHERE plan_id = NEW.plan_id)
       <> (SELECT total_amount_minor FROM installment_plans WHERE id = NEW.plan_id)
BEGIN
    SELECT RAISE(ABORT, 'installment amounts must equal plan total');
END;

CREATE TABLE category_status_history (
    id INTEGER PRIMARY KEY,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
    old_active INTEGER CHECK (old_active IS NULL OR old_active IN (0, 1)),
    new_active INTEGER NOT NULL CHECK (new_active IN (0, 1)),
    changed_at TEXT NOT NULL CHECK (datetime(changed_at) IS NOT NULL)
);

CREATE TABLE ledger_entry_status_history (
    id INTEGER PRIMARY KEY,
    entry_id INTEGER NOT NULL REFERENCES ledger_entries(id) ON DELETE RESTRICT,
    old_status TEXT CHECK (old_status IS NULL OR old_status IN ('active', 'voided')),
    new_status TEXT NOT NULL CHECK (new_status IN ('active', 'voided')),
    changed_at TEXT NOT NULL CHECK (datetime(changed_at) IS NOT NULL)
);

CREATE TABLE installment_plan_status_history (
    id INTEGER PRIMARY KEY,
    plan_id INTEGER NOT NULL REFERENCES installment_plans(id) ON DELETE RESTRICT,
    old_status TEXT CHECK (old_status IS NULL OR old_status IN ('active', 'completed', 'voided')),
    new_status TEXT NOT NULL CHECK (new_status IN ('active', 'completed', 'voided')),
    changed_at TEXT NOT NULL CHECK (datetime(changed_at) IS NOT NULL)
);

CREATE TABLE installment_status_history (
    id INTEGER PRIMARY KEY,
    installment_id INTEGER NOT NULL REFERENCES installments(id) ON DELETE RESTRICT,
    old_status TEXT CHECK (old_status IS NULL OR old_status IN ('pending', 'paid', 'voided')),
    new_status TEXT NOT NULL CHECK (new_status IN ('pending', 'paid', 'voided')),
    changed_at TEXT NOT NULL CHECK (datetime(changed_at) IS NOT NULL)
);

CREATE INDEX category_status_history_resource_idx
    ON category_status_history (category_id, id);
CREATE INDEX ledger_entry_status_history_resource_idx
    ON ledger_entry_status_history (entry_id, id);
CREATE INDEX installment_plan_status_history_resource_idx
    ON installment_plan_status_history (plan_id, id);
CREATE INDEX installment_status_history_resource_idx
    ON installment_status_history (installment_id, id);

CREATE TRIGGER category_status_history_insert
AFTER INSERT ON categories
BEGIN
    INSERT INTO category_status_history(category_id, old_active, new_active, changed_at)
    VALUES (NEW.id, NULL, NEW.active, NEW.created_at);
END;

CREATE TRIGGER category_status_history_update
AFTER UPDATE OF active ON categories
WHEN NEW.active <> OLD.active
BEGIN
    INSERT INTO category_status_history(category_id, old_active, new_active, changed_at)
    VALUES (NEW.id, OLD.active, NEW.active, NEW.updated_at);
END;

CREATE TRIGGER ledger_entry_status_history_insert
AFTER INSERT ON ledger_entries
BEGIN
    INSERT INTO ledger_entry_status_history(entry_id, old_status, new_status, changed_at)
    VALUES (NEW.id, NULL, 'active', NEW.created_at);
END;

CREATE TRIGGER ledger_entry_status_history_void
AFTER UPDATE OF voided_at ON ledger_entries
WHEN OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL
BEGIN
    INSERT INTO ledger_entry_status_history(entry_id, old_status, new_status, changed_at)
    VALUES (NEW.id, 'active', 'voided', NEW.voided_at);
END;

CREATE TRIGGER installment_plan_status_history_insert
AFTER INSERT ON installment_plans
BEGIN
    INSERT INTO installment_plan_status_history(plan_id, old_status, new_status, changed_at)
    VALUES (NEW.id, NULL, NEW.status, NEW.created_at);
END;

CREATE TRIGGER installment_plan_status_history_update
AFTER UPDATE OF status ON installment_plans
WHEN NEW.status <> OLD.status
BEGIN
    INSERT INTO installment_plan_status_history(plan_id, old_status, new_status, changed_at)
    VALUES (NEW.id, OLD.status, NEW.status, NEW.updated_at);
END;

CREATE TRIGGER installment_status_history_insert
AFTER INSERT ON installments
BEGIN
    INSERT INTO installment_status_history(installment_id, old_status, new_status, changed_at)
    VALUES (NEW.id, NULL, NEW.status, NEW.created_at);
END;

CREATE TRIGGER installment_status_history_update
AFTER UPDATE OF status ON installments
WHEN NEW.status <> OLD.status
BEGIN
    INSERT INTO installment_status_history(installment_id, old_status, new_status, changed_at)
    VALUES (NEW.id, OLD.status, NEW.status, NEW.updated_at);
END;

CREATE TRIGGER ledger_entry_immutable_after_void
BEFORE UPDATE OF kind, category_id, amount_minor, currency, occurred_on, description ON ledger_entries
WHEN OLD.voided_at IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'voided ledger entry is immutable');
END;

CREATE TRIGGER ledger_entry_void_is_final
BEFORE UPDATE OF voided_at ON ledger_entries
WHEN OLD.voided_at IS NOT NULL AND NEW.voided_at IS NOT OLD.voided_at
BEGIN
    SELECT RAISE(ABORT, 'ledger entry void is final');
END;

CREATE TRIGGER ledger_entry_paid_schedule_immutable
BEFORE UPDATE OF kind, category_id, amount_minor, currency ON ledger_entries
WHEN (NEW.kind <> OLD.kind
      OR NEW.category_id <> OLD.category_id
      OR NEW.amount_minor <> OLD.amount_minor
      OR NEW.currency <> OLD.currency)
 AND EXISTS (
     SELECT 1
     FROM installment_plans AS plan
     JOIN installments AS installment ON installment.plan_id = plan.id
     WHERE plan.entry_id = OLD.id
       AND plan.status <> 'voided'
       AND installment.status = 'paid'
 )
BEGIN
    SELECT RAISE(ABORT, 'paid installments are immutable');
END;

CREATE TRIGGER installment_status_blocked_after_entry_void
BEFORE UPDATE OF status ON installments
WHEN NEW.status <> 'voided'
 AND EXISTS (
     SELECT 1
     FROM installment_plans AS plan
     JOIN ledger_entries AS entry ON entry.id = plan.entry_id
     WHERE plan.id = OLD.plan_id AND entry.voided_at IS NOT NULL
 )
BEGIN
    SELECT RAISE(ABORT, 'voided entry installments are immutable');
END;

CREATE TRIGGER installment_plan_paid_void_block
BEFORE UPDATE OF status ON installment_plans
WHEN NEW.status = 'voided'
 AND EXISTS (SELECT 1 FROM installments WHERE plan_id = OLD.id AND status = 'paid')
 AND EXISTS (
     SELECT 1 FROM ledger_entries
     WHERE id = OLD.entry_id AND voided_at IS NULL
 )
BEGIN
    SELECT RAISE(ABORT, 'paid installment plan cannot be superseded');
END;

CREATE TRIGGER installment_plan_completed_consistency
BEFORE UPDATE OF status ON installment_plans
WHEN NEW.status = 'completed'
 AND EXISTS (SELECT 1 FROM installments WHERE plan_id = OLD.id AND status <> 'paid')
BEGIN
    SELECT RAISE(ABORT, 'completed plan cannot contain unpaid installments');
END;

CREATE TRIGGER installment_plan_active_consistency
BEFORE UPDATE OF status ON installment_plans
WHEN NEW.status = 'active'
 AND NOT EXISTS (SELECT 1 FROM installments WHERE plan_id = OLD.id AND status = 'pending')
BEGIN
    SELECT RAISE(ABORT, 'active plan requires pending installments');
END;

CREATE TRIGGER categories_no_delete
BEFORE DELETE ON categories
BEGIN
    SELECT RAISE(ABORT, 'categories must be deactivated, not deleted');
END;

CREATE TRIGGER ledger_entries_no_delete
BEFORE DELETE ON ledger_entries
BEGIN
    SELECT RAISE(ABORT, 'ledger entries must be voided, not deleted');
END;

CREATE TRIGGER installment_plans_no_delete
BEFORE DELETE ON installment_plans
BEGIN
    SELECT RAISE(ABORT, 'installment plans must be voided, not deleted');
END;

CREATE TRIGGER installments_no_delete
BEFORE DELETE ON installments
BEGIN
    SELECT RAISE(ABORT, 'installments must be voided, not deleted');
END;

CREATE TRIGGER category_status_history_no_update
BEFORE UPDATE ON category_status_history
BEGIN
    SELECT RAISE(ABORT, 'category status history is immutable');
END;
CREATE TRIGGER category_status_history_no_delete
BEFORE DELETE ON category_status_history
BEGIN
    SELECT RAISE(ABORT, 'category status history is immutable');
END;
CREATE TRIGGER ledger_entry_status_history_no_update
BEFORE UPDATE ON ledger_entry_status_history
BEGIN
    SELECT RAISE(ABORT, 'ledger entry status history is immutable');
END;
CREATE TRIGGER ledger_entry_status_history_no_delete
BEFORE DELETE ON ledger_entry_status_history
BEGIN
    SELECT RAISE(ABORT, 'ledger entry status history is immutable');
END;
CREATE TRIGGER installment_plan_status_history_no_update
BEFORE UPDATE ON installment_plan_status_history
BEGIN
    SELECT RAISE(ABORT, 'installment plan status history is immutable');
END;
CREATE TRIGGER installment_plan_status_history_no_delete
BEFORE DELETE ON installment_plan_status_history
BEGIN
    SELECT RAISE(ABORT, 'installment plan status history is immutable');
END;
CREATE TRIGGER installment_status_history_no_update
BEFORE UPDATE ON installment_status_history
BEGIN
    SELECT RAISE(ABORT, 'installment status history is immutable');
END;
CREATE TRIGGER installment_status_history_no_delete
BEFORE DELETE ON installment_status_history
BEGIN
    SELECT RAISE(ABORT, 'installment status history is immutable');
END;

INSERT INTO categories(id, name, kind, parent_id) VALUES
    (1, '饮食', 'expense', NULL),
    (2, '住房', 'expense', NULL),
    (3, '交通', 'expense', NULL),
    (4, '理财', 'expense', NULL),
    (5, '购物', 'expense', NULL),
    (6, '娱乐', 'expense', NULL),
    (7, '通讯', 'expense', NULL),
    (8, '游戏', 'expense', 6),
    (9, '水电费', 'expense', 2),
    (10, '话费', 'expense', 7),
    (11, '工资', 'income', NULL),
    (12, '意外收入', 'income', NULL);
