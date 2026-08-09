"""Reusable HTTP handlers for ledger entries and installment schedules."""

from __future__ import annotations

import calendar
from datetime import date, datetime, timezone
import json
import re
import sqlite3
from typing import Any, Mapping

from .config import Config
from .db import Database
from .http import Request, Response, Router


_ENTRY_PATH = "/v1/entries"
_ENTRY_ITEM_PATH = "/v1/entries/{id}"
_INSTALLMENT_ITEM_PATH = "/v1/installments/{id}"
_MONTH_PATH = "/v1/months/{month}"
_KINDS = frozenset(("income", "expense"))
_STATUSES = frozenset(("paid", "pending"))
_ID_PATTERN = re.compile(r"[0-9]+")
_DATE_PATTERN = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
_MONTH_PATTERN = re.compile(r"[0-9]{4}-[0-9]{2}")
_BASE_FIELDS = frozenset(("kind", "category_id", "amount_minor", "currency", "occurred_on", "description"))
_SCHEDULE_FIELDS = frozenset(("installment_count", "first_due_on", "interval_months"))


class _LedgerError(Exception):
    def __init__(self, status: int, error: str):
        super().__init__(error)
        self.status = status
        self.error = error


def register(router: Router, db: Database, config: Config) -> None:
    """Register ledger routes and migrate R1/R2 installment plans if needed."""

    del config
    _ensure_plan_entry_id(db)
    router.register("GET", _ENTRY_PATH, lambda request: _invoke(lambda: _handle_list(db, request)))
    router.register("POST", _ENTRY_PATH, lambda request: _invoke(lambda: _handle_create(db, request)))
    router.register("GET", _ENTRY_ITEM_PATH, lambda request: _invoke(lambda: _handle_get(db, request)))
    router.register("PUT", _ENTRY_ITEM_PATH, lambda request: _invoke(lambda: _handle_put(db, request)))
    router.register("PATCH", _ENTRY_ITEM_PATH, lambda request: _invoke(lambda: _handle_patch(db, request)))
    router.register("DELETE", _ENTRY_ITEM_PATH, lambda request: _invoke(lambda: _handle_delete(db, request)))
    router.register("GET", _INSTALLMENT_ITEM_PATH, lambda request: _invoke(lambda: _handle_installment_get(db, request)))
    router.register("PATCH", _INSTALLMENT_ITEM_PATH, lambda request: _invoke(lambda: _handle_installment_patch(db, request)))
    router.register("GET", _MONTH_PATH, lambda request: _invoke(lambda: _handle_month(db, request)))


def _ensure_plan_entry_id(db: Database) -> None:
    with db.transaction() as connection:
        columns = {
            row["name"]
            for row in connection.execute("PRAGMA table_info(installment_plans)").fetchall()
        }
        if "entry_id" not in columns:
            connection.execute(
                "ALTER TABLE installment_plans ADD COLUMN "
                "entry_id INTEGER REFERENCES ledger_entries(id) ON DELETE RESTRICT"
            )
        connection.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS installment_plans_entry_id_uq "
            "ON installment_plans(entry_id) WHERE entry_id IS NOT NULL"
        )


def _handle_list(db: Database, request: Request) -> Response:
    del request
    with db.connection() as connection:
        rows = connection.execute(
            "SELECT id, kind, category_id, amount_minor, currency, occurred_on, description, voided_at "
            "FROM ledger_entries ORDER BY occurred_on, id"
        ).fetchall()
    return Response.json(200, {"items": [_entry_base(row) for row in rows]})


def _handle_get(db: Database, request: Request) -> Response:
    entry_id = _path_id(request, "entry")
    with db.connection() as connection:
        return Response.json(200, _entry_payload(connection, _require_entry(connection, entry_id)))


def _handle_create(db: Database, request: Request) -> Response:
    values = _parse_entry_payload(request.body, partial=False)
    with db.transaction() as connection:
        _validate_category(connection, values["category_id"], values["kind"])
        cursor = connection.execute(
            "INSERT INTO ledger_entries "
            "(kind, category_id, amount_minor, currency, occurred_on, description) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            tuple(values.get(field) for field in ("kind", "category_id", "amount_minor", "currency", "occurred_on", "description")),
        )
        entry_id = cursor.lastrowid
        count = values.get("installment_count", 1)
        if count > 1:
            _create_plan(
                connection,
                entry_id,
                values["amount_minor"],
                count,
                values["currency"],
                values.get("first_due_on", values["occurred_on"]),
                values.get("interval_months", 1),
            )
        return Response.json(201, _entry_payload(connection, _require_entry(connection, entry_id)))


def _handle_put(db: Database, request: Request) -> Response:
    entry_id = _path_id(request, "entry")
    values = _parse_entry_payload(request.body, partial=False, update=True)
    return _update_entry(db, entry_id, values, complete=True)


def _handle_patch(db: Database, request: Request) -> Response:
    entry_id = _path_id(request, "entry")
    values = _parse_entry_payload(request.body, partial=True, update=True)
    return _update_entry(db, entry_id, values, complete=False)


def _update_entry(
    db: Database, entry_id: int, values: Mapping[str, Any], complete: bool
) -> Response:
    with db.transaction() as connection:
        current = _require_entry(connection, entry_id)
        if current["voided_at"] is not None:
            raise _LedgerError(409, "entry_voided")
        current_plan = _find_plan(connection, entry_id)
        current_count = current_plan["installment_count"] if current_plan is not None else 1
        paid_exists = bool(
            current_plan
            and connection.execute(
                "SELECT 1 FROM installments WHERE plan_id = ? AND status = 'paid' LIMIT 1",
                (current_plan["id"],),
            ).fetchone()
        )
        desired = {
            "kind": values.get("kind", current["kind"]),
            "category_id": values.get("category_id", current["category_id"]),
            "amount_minor": values.get("amount_minor", current["amount_minor"]),
            "currency": values.get("currency", current["currency"]),
            "occurred_on": values.get("occurred_on", current["occurred_on"]),
            "description": values["description"] if "description" in values else (None if complete else current["description"]),
        }
        _validate_category(connection, desired["category_id"], desired["kind"])

        desired_count = values.get("installment_count", current_count)
        if paid_exists and (
            desired["kind"] != current["kind"]
            or desired["category_id"] != current["category_id"]
            or desired["amount_minor"] != current["amount_minor"]
            or desired["currency"] != current["currency"]
            or desired_count != current_count
            or "first_due_on" in values
            or "interval_months" in values
        ):
            raise _LedgerError(409, "paid_installments_immutable")

        connection.execute(
            "UPDATE ledger_entries SET kind = ?, category_id = ?, amount_minor = ?, currency = ?, "
            "occurred_on = ?, description = ? WHERE id = ?",
            (
                desired["kind"],
                desired["category_id"],
                desired["amount_minor"],
                desired["currency"],
                desired["occurred_on"],
                desired["description"],
                entry_id,
            ),
        )

        if current_plan is None:
            if desired_count > 1:
                _create_plan(
                    connection,
                    entry_id,
                    desired["amount_minor"],
                    desired_count,
                    desired["currency"],
                    values.get("first_due_on", desired["occurred_on"]),
                    values.get("interval_months", 1),
                )
            elif "first_due_on" in values or "interval_months" in values:
                raise _LedgerError(422, "installment_options_require_plan")
        elif desired_count <= 1:
            if "first_due_on" in values or "interval_months" in values:
                raise _LedgerError(422, "installment_options_require_plan")
            _remove_plan(connection, current_plan["id"])
        else:
            schedule_changed = (
                desired_count != current_count
                or desired["amount_minor"] != current["amount_minor"]
                or desired["currency"] != current["currency"]
                or "first_due_on" in values
                or "interval_months" in values
            )
            if schedule_changed:
                first_due = values.get("first_due_on")
                if first_due is None:
                    first_due = _first_due(connection, current_plan["id"])
                interval = values.get("interval_months")
                if interval is None:
                    interval = _infer_interval(connection, current_plan["id"])
                _rebuild_plan(
                    connection,
                    current_plan["id"],
                    desired["amount_minor"],
                    desired_count,
                    desired["currency"],
                    first_due,
                    interval,
                )
        return Response.json(200, _entry_payload(connection, _require_entry(connection, entry_id)))


def _handle_delete(db: Database, request: Request) -> Response:
    entry_id = _path_id(request, "entry")
    with db.transaction() as connection:
        entry = _require_entry(connection, entry_id)
        if entry["voided_at"] is None:
            connection.execute(
                "UPDATE ledger_entries SET voided_at = ? WHERE id = ?",
                (_utc_now(), entry_id),
            )
            plan = _find_plan(connection, entry_id)
            if plan is not None:
                connection.execute(
                    "UPDATE installments SET status = 'voided', paid_at = NULL "
                    "WHERE plan_id = ? AND status <> 'paid'",
                    (plan["id"],),
                )
                connection.execute(
                    "UPDATE installment_plans SET status = 'voided' WHERE id = ?",
                    (plan["id"],),
                )
        return Response.json(200, _entry_payload(connection, _require_entry(connection, entry_id)))


def _handle_installment_get(db: Database, request: Request) -> Response:
    installment_id = _path_id(request, "installment")
    with db.connection() as connection:
        row = _find_installment(connection, installment_id)
    if row is None:
        raise _LedgerError(404, "installment_not_found")
    return Response.json(200, _installment_payload(row))


def _handle_installment_patch(db: Database, request: Request) -> Response:
    installment_id = _path_id(request, "installment")
    try:
        payload = json.loads(request.body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise _LedgerError(400, "invalid_json") from None
    if not isinstance(payload, dict) or set(payload) != {"status"}:
        raise _LedgerError(422, "invalid_installment_update")
    status = payload["status"]
    if not isinstance(status, str) or status not in _STATUSES:
        raise _LedgerError(422, "invalid_installment_status")

    with db.transaction() as connection:
        row = _find_installment(connection, installment_id)
        if row is None:
            raise _LedgerError(404, "installment_not_found")
        if row["entry_voided_at"] is not None:
            raise _LedgerError(409, "entry_voided")
        if row["status"] == "voided":
            raise _LedgerError(409, "installment_voided")
        paid_at = _utc_now() if status == "paid" else None
        connection.execute(
            "UPDATE installments SET status = ?, paid_at = ? WHERE id = ?",
            (status, paid_at, installment_id),
        )
        _refresh_plan_status(connection, row["plan_id"])
        return Response.json(200, _installment_payload(_find_installment(connection, installment_id)))


def _handle_month(db: Database, request: Request) -> Response:
    month = request.path.split("?", 1)[0].rsplit("/", 1)[-1]
    _parse_month(month)
    with db.connection() as connection:
        entries = connection.execute(
            "SELECT id, kind, category_id, amount_minor, currency, occurred_on, description "
            "FROM ledger_entries WHERE voided_at IS NULL ORDER BY occurred_on, id"
        ).fetchall()
        items: list[dict[str, Any]] = []
        for entry in entries:
            plan = _find_plan(connection, entry["id"])
            if plan is None:
                if entry["occurred_on"][:7] == month:
                    items.append(_month_entry(entry))
                continue
            installments = connection.execute(
                "SELECT id, plan_id, sequence, amount_minor, due_on, status, paid_at "
                "FROM installments WHERE plan_id = ? AND due_on LIKE ? AND status <> 'voided' "
                "ORDER BY due_on, sequence, id",
                (plan["id"], month + "%"),
            ).fetchall()
            items.extend(_month_installment(entry, row) for row in installments)
    totals = {
        "income_minor": sum(item["allocated_amount_minor"] for item in items if item["kind"] == "income"),
        "expense_minor": sum(item["allocated_amount_minor"] for item in items if item["kind"] == "expense"),
        "pending_minor": sum(item["allocated_amount_minor"] for item in items if item["status"] == "pending"),
        "paid_minor": sum(item["allocated_amount_minor"] for item in items if item["status"] == "paid"),
    }
    return Response.json(200, {"month": month, "items": items, "totals": totals})


def _create_plan(
    connection: sqlite3.Connection,
    entry_id: int,
    total: int,
    count: int,
    currency: str,
    first_due_on: str,
    interval_months: int,
) -> None:
    cursor = connection.execute(
        "INSERT INTO installment_plans "
        "(entry_id, total_amount_minor, installment_count, currency) VALUES (?, ?, ?, ?)",
        (entry_id, total, count, currency),
    )
    _insert_schedule(connection, cursor.lastrowid, total, count, first_due_on, interval_months)


def _rebuild_plan(
    connection: sqlite3.Connection,
    plan_id: int,
    total: int,
    count: int,
    currency: str,
    first_due_on: str,
    interval_months: int,
) -> None:
    connection.execute("DELETE FROM installments WHERE plan_id = ?", (plan_id,))
    connection.execute(
        "UPDATE installment_plans SET total_amount_minor = ?, installment_count = ?, currency = ?, status = 'active' "
        "WHERE id = ?",
        (total, count, currency, plan_id),
    )
    _insert_schedule(connection, plan_id, total, count, first_due_on, interval_months)


def _remove_plan(connection: sqlite3.Connection, plan_id: int) -> None:
    connection.execute("DELETE FROM installments WHERE plan_id = ?", (plan_id,))
    connection.execute("DELETE FROM installment_plans WHERE id = ?", (plan_id,))


def _insert_schedule(
    connection: sqlite3.Connection, plan_id: int, total: int, count: int, first_due_on: str, interval_months: int
) -> None:
    quotient, remainder = divmod(total, count)
    first = date.fromisoformat(first_due_on)
    for sequence in range(1, count + 1):
        amount = quotient + (1 if sequence <= remainder else 0)
        due_on = _add_months(first, (sequence - 1) * interval_months).isoformat()
        connection.execute(
            "INSERT INTO installments(plan_id, sequence, amount_minor, due_on) VALUES (?, ?, ?, ?)",
            (plan_id, sequence, amount, due_on),
        )


def _find_plan(connection: sqlite3.Connection, entry_id: int):
    return connection.execute(
        "SELECT id, entry_id, total_amount_minor, installment_count, currency, status "
        "FROM installment_plans WHERE entry_id = ?",
        (entry_id,),
    ).fetchone()


def _find_installment(connection: sqlite3.Connection, installment_id: int):
    return connection.execute(
        "SELECT i.id, i.plan_id, i.sequence, i.amount_minor, i.due_on, i.status, i.paid_at, "
        "p.entry_id, e.voided_at AS entry_voided_at "
        "FROM installments i JOIN installment_plans p ON p.id = i.plan_id "
        "JOIN ledger_entries e ON e.id = p.entry_id WHERE i.id = ?",
        (installment_id,),
    ).fetchone()


def _entry_payload(connection: sqlite3.Connection, entry) -> dict[str, Any]:
    plan = _find_plan(connection, entry["id"])
    installments = []
    if plan is not None:
        rows = connection.execute(
            "SELECT id, plan_id, sequence, amount_minor, due_on, status, paid_at "
            "FROM installments WHERE plan_id = ? ORDER BY sequence, id",
            (plan["id"],),
        ).fetchall()
        installments = [_installment_payload(row) for row in rows]
    return {
        **_entry_base(entry),
        "installment_plan": _plan_payload(plan) if plan is not None else None,
        "installments": installments,
    }


def _entry_base(row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "category_id": row["category_id"],
        "kind": row["kind"],
        "amount_minor": row["amount_minor"],
        "currency": row["currency"],
        "occurred_on": row["occurred_on"],
        "description": row["description"],
        "voided_at": row["voided_at"],
    }


def _plan_payload(row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "entry_id": row["entry_id"],
        "total_amount_minor": row["total_amount_minor"],
        "installment_count": row["installment_count"],
        "currency": row["currency"],
        "status": row["status"],
    }


def _installment_payload(row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "plan_id": row["plan_id"],
        "sequence": row["sequence"],
        "amount_minor": row["amount_minor"],
        "due_on": row["due_on"],
        "status": row["status"],
        "paid_at": row["paid_at"],
    }


def _month_entry(row) -> dict[str, Any]:
    return {
        "entry_id": row["id"],
        "installment_id": None,
        "sequence": None,
        "due_on": row["occurred_on"],
        "kind": row["kind"],
        "category_id": row["category_id"],
        "allocated_amount_minor": row["amount_minor"],
        "currency": row["currency"],
        "status": "paid",
        "paid_at": None,
        "description": row["description"],
    }


def _month_installment(entry, row) -> dict[str, Any]:
    return {
        "entry_id": entry["id"],
        "installment_id": row["id"],
        "sequence": row["sequence"],
        "due_on": row["due_on"],
        "kind": entry["kind"],
        "category_id": entry["category_id"],
        "allocated_amount_minor": row["amount_minor"],
        "currency": entry["currency"],
        "status": row["status"],
        "paid_at": row["paid_at"],
        "description": entry["description"],
    }


def _parse_entry_payload(body: bytes, partial: bool, update: bool = False) -> dict[str, Any]:
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise _LedgerError(400, "invalid_json") from None
    if not isinstance(payload, dict):
        raise _LedgerError(400, "json_object_required")
    allowed = _BASE_FIELDS | _SCHEDULE_FIELDS
    if set(payload) - allowed:
        raise _LedgerError(422, "unknown_field")
    required = {"kind", "category_id", "amount_minor", "currency", "occurred_on"}
    if not partial and not required <= set(payload):
        raise _LedgerError(422, "required_fields")
    if partial and not payload:
        raise _LedgerError(422, "empty_update")

    values: dict[str, Any] = {}
    if "kind" in payload:
        if not isinstance(payload["kind"], str) or payload["kind"] not in _KINDS:
            raise _LedgerError(422, "invalid_kind")
        values["kind"] = payload["kind"]
    if "category_id" in payload:
        values["category_id"] = _positive_int(payload["category_id"], "invalid_category_id")
    if "amount_minor" in payload:
        values["amount_minor"] = _positive_int(payload["amount_minor"], "invalid_amount_minor")
    if "currency" in payload:
        currency = payload["currency"]
        if not isinstance(currency, str) or not re.fullmatch(r"[A-Z]{3}", currency):
            raise _LedgerError(422, "invalid_currency")
        values["currency"] = currency
    for field in ("occurred_on", "first_due_on"):
        if field in payload:
            values[field] = _parse_date(payload[field], "invalid_" + field)
    if "description" in payload:
        description = payload["description"]
        if description is not None and not isinstance(description, str):
            raise _LedgerError(422, "invalid_description")
        values["description"] = description
    if "installment_count" in payload:
        values["installment_count"] = _positive_int(payload["installment_count"], "invalid_installment_count")
    if "interval_months" in payload:
        interval = payload["interval_months"]
        if type(interval) is not int or not 1 <= interval <= 12:
            raise _LedgerError(422, "invalid_interval_months")
        values["interval_months"] = interval
    if not update and ("first_due_on" in values or "interval_months" in values) and values.get("installment_count", 1) <= 1:
        raise _LedgerError(422, "installment_options_require_plan")
    if update and not partial and "description" not in payload:
        values.pop("description", None)
    return values


def _validate_category(connection: sqlite3.Connection, category_id: int, kind: str) -> None:
    row = connection.execute(
        "SELECT active, kind FROM categories WHERE id = ?", (category_id,)
    ).fetchone()
    if row is None:
        raise _LedgerError(404, "category_not_found")
    if not row["active"]:
        raise _LedgerError(409, "category_inactive")
    if row["kind"] != kind:
        raise _LedgerError(422, "category_kind_mismatch")


def _require_entry(connection: sqlite3.Connection, entry_id: int):
    row = connection.execute(
        "SELECT id, kind, category_id, amount_minor, currency, occurred_on, description, voided_at "
        "FROM ledger_entries WHERE id = ?",
        (entry_id,),
    ).fetchone()
    if row is None:
        raise _LedgerError(404, "entry_not_found")
    return row


def _path_id(request: Request, resource: str) -> int:
    segment = request.path.split("?", 1)[0].rsplit("/", 1)[-1]
    if not _ID_PATTERN.fullmatch(segment) or int(segment) <= 0:
        raise _LedgerError(400, "invalid_" + resource + "_id")
    return int(segment)


def _positive_int(value: Any, error: str) -> int:
    if type(value) is not int or value <= 0:
        raise _LedgerError(422, error)
    return value


def _parse_date(value: Any, error: str) -> str:
    if not isinstance(value, str) or not _DATE_PATTERN.fullmatch(value):
        raise _LedgerError(422, error)
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        raise _LedgerError(422, error) from None
    if parsed.isoformat() != value:
        raise _LedgerError(422, error)
    return value


def _parse_month(value: str) -> None:
    if not _MONTH_PATTERN.fullmatch(value):
        raise _LedgerError(400, "invalid_month")
    try:
        date.fromisoformat(value + "-01")
    except ValueError:
        raise _LedgerError(400, "invalid_month") from None


def _first_due(connection: sqlite3.Connection, plan_id: int) -> str:
    row = connection.execute(
        "SELECT due_on FROM installments WHERE plan_id = ? ORDER BY sequence LIMIT 1", (plan_id,)
    ).fetchone()
    if row is None:
        raise _LedgerError(500, "installment_schedule_missing")
    return row["due_on"]


def _infer_interval(connection: sqlite3.Connection, plan_id: int) -> int:
    rows = connection.execute(
        "SELECT due_on FROM installments WHERE plan_id = ? ORDER BY sequence", (plan_id,)
    ).fetchall()
    if len(rows) < 2:
        return 1
    dates = [date.fromisoformat(row["due_on"]) for row in rows]
    interval = (dates[1].year - dates[0].year) * 12 + dates[1].month - dates[0].month
    if interval < 1:
        return 1
    return interval


def _add_months(value: date, months: int) -> date:
    month_index = value.year * 12 + value.month - 1 + months
    year, month_index = divmod(month_index, 12)
    month = month_index + 1
    return date(year, month, min(value.day, calendar.monthrange(year, month)[1]))


def _refresh_plan_status(connection: sqlite3.Connection, plan_id: int) -> None:
    pending = connection.execute(
        "SELECT 1 FROM installments WHERE plan_id = ? AND status = 'pending' LIMIT 1", (plan_id,)
    ).fetchone()
    status = "active" if pending else "completed"
    connection.execute("UPDATE installment_plans SET status = ? WHERE id = ?", (status, plan_id))


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _invoke(handler):
    try:
        return handler()
    except _LedgerError as error:
        return Response.json(error.status, {"error": error.error})
    except sqlite3.IntegrityError:
        return Response.json(409, {"error": "ledger_conflict"})
