"""Reusable HTTP handlers for configurable income and expense categories."""

from __future__ import annotations

import json
import re
import sqlite3
from typing import Any, Mapping, Optional

from .config import Config
from .db import Database
from .http import Request, Response, Router


_CATEGORY_PATH = "/v1/categories"
_CATEGORY_ITEM_PATH = "/v1/categories/{id}"
_KINDS = frozenset(("income", "expense"))
_FIELDS = frozenset(("name", "kind", "parent_id"))
_MAX_NAME_LENGTH = 100
_ID_PATTERN = re.compile(r"[0-9]+")
_CategorySeed = tuple[str, str, Optional[str]]
_DEFAULT_CATEGORY_SEEDS: tuple[_CategorySeed, ...] = (
    ("饮食", "expense", None),
    ("住房", "expense", None),
    ("交通", "expense", None),
    ("理财", "expense", None),
    ("购物", "expense", None),
    ("娱乐", "expense", None),
    ("通讯", "expense", None),
    ("游戏", "expense", "娱乐"),
    ("水电费", "expense", "住房"),
    ("话费", "expense", "通讯"),
    ("工资", "income", None),
    ("意外收入", "income", None),
)


class _CategoryError(Exception):
    def __init__(self, status: int, error: str):
        super().__init__(error)
        self.status = status
        self.error = error


def register(router: Router, db: Database, config: Config) -> None:
    """Register category collection and item routes on a standard Router."""

    del config
    router.register("GET", _CATEGORY_PATH, lambda request: _invoke(db, lambda: _handle_list(db, request)))
    router.register("POST", _CATEGORY_PATH, lambda request: _invoke(db, lambda: _handle_create(db, request)))
    router.register("GET", _CATEGORY_ITEM_PATH, lambda request: _invoke(db, lambda: _handle_get(db, request)))
    router.register("PUT", _CATEGORY_ITEM_PATH, lambda request: _invoke(db, lambda: _handle_put(db, request)))
    router.register("PATCH", _CATEGORY_ITEM_PATH, lambda request: _invoke(db, lambda: _handle_patch(db, request)))
    router.register("DELETE", _CATEGORY_ITEM_PATH, lambda request: _invoke(db, lambda: _handle_delete(db, request)))


def _seed_categories(
    connection: sqlite3.Connection, seeds: tuple[_CategorySeed, ...]
) -> None:
    """Insert configured category seeds without changing existing rows."""

    seeded_ids: dict[tuple[str, str], int] = {}
    for name, kind, parent_name in seeds:
        if parent_name is None:
            parent_id = None
        else:
            parent_id = seeded_ids.get((parent_name, kind))
            if parent_id is None:
                parent = connection.execute(
                    "SELECT id FROM categories "
                    "WHERE name = ? AND kind = ? AND parent_id IS NULL",
                    (parent_name, kind),
                ).fetchone()
                if parent is None:
                    continue
                parent_id = parent["id"]

        existing = connection.execute(
            "SELECT id FROM categories WHERE name = ? AND kind = ? AND parent_id IS ?",
            (name, kind, parent_id),
        ).fetchone()
        if existing is None:
            cursor = connection.execute(
                "INSERT INTO categories(name, kind, parent_id) VALUES (?, ?, ?)",
                (name, kind, parent_id),
            )
            category_id = cursor.lastrowid
        else:
            category_id = existing["id"]
        seeded_ids[(name, kind)] = category_id


def _ensure_default_categories(db: Database) -> None:
    with db.transaction() as connection:
        _seed_categories(connection, _DEFAULT_CATEGORY_SEEDS)


def _handle_list(db: Database, request: Request) -> Response:
    del request
    with db.connection() as connection:
        rows = connection.execute(
            "SELECT id, name, kind, parent_id, active "
            "FROM categories ORDER BY kind, name, id"
        ).fetchall()
    return Response.json(200, {"items": [_category_payload(row) for row in rows]})


def _handle_get(db: Database, request: Request) -> Response:
    category_id = _path_id(request)
    with db.connection() as connection:
        row = _find_category(connection, category_id)
    if row is None:
        raise _CategoryError(404, "category_not_found")
    return Response.json(200, _category_payload(row))


def _handle_create(db: Database, request: Request) -> Response:
    values = _parse_payload(request.body)
    try:
        with db.transaction() as connection:
            _validate_parent(connection, values["parent_id"], values["kind"])
            _ensure_unique(connection, values["name"], values["kind"], values["parent_id"])
            cursor = connection.execute(
                "INSERT INTO categories(name, kind, parent_id) VALUES (?, ?, ?)",
                (values["name"], values["kind"], values["parent_id"]),
            )
            row = _find_category(connection, cursor.lastrowid)
    except sqlite3.IntegrityError as error:
        raise _CategoryError(409, _integrity_error(error)) from None
    return Response.json(201, _category_payload(row))


def _handle_put(db: Database, request: Request) -> Response:
    category_id = _path_id(request)
    values = _parse_payload(request.body)
    return _update(db, category_id, values)


def _handle_patch(db: Database, request: Request) -> Response:
    category_id = _path_id(request)
    values = _parse_payload(request.body, partial=True)
    return _update(db, category_id, values)


def _update(db: Database, category_id: int, values: Mapping[str, Any]) -> Response:
    try:
        with db.transaction() as connection:
            current = _find_category(connection, category_id)
            if current is None:
                raise _CategoryError(404, "category_not_found")
            desired = {
                "name": values.get("name", current["name"]),
                "kind": values.get("kind", current["kind"]),
                "parent_id": values.get("parent_id", current["parent_id"]),
            }
            _validate_parent(connection, desired["parent_id"], desired["kind"], category_id)
            _ensure_no_descendant_parent(connection, category_id, desired["parent_id"])
            _ensure_children_keep_kind(connection, category_id, current["kind"], desired["kind"])
            _ensure_unique(
                connection,
                desired["name"],
                desired["kind"],
                desired["parent_id"],
                category_id,
            )
            connection.execute(
                "UPDATE categories SET name = ?, kind = ?, parent_id = ? WHERE id = ?",
                (desired["name"], desired["kind"], desired["parent_id"], category_id),
            )
            row = _find_category(connection, category_id)
    except sqlite3.IntegrityError as error:
        raise _CategoryError(409, _integrity_error(error)) from None
    return Response.json(200, _category_payload(row))


def _handle_delete(db: Database, request: Request) -> Response:
    category_id = _path_id(request)
    with db.transaction() as connection:
        row = _find_category(connection, category_id)
        if row is None:
            raise _CategoryError(404, "category_not_found")
        connection.execute("UPDATE categories SET active = 0 WHERE id = ?", (category_id,))
        row = _find_category(connection, category_id)
    return Response.json(200, _category_payload(row))


def _parse_payload(body: bytes, partial: bool = False) -> dict[str, Any]:
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise _CategoryError(400, "invalid_json") from None
    if not isinstance(payload, dict):
        raise _CategoryError(400, "json_object_required")
    unknown = set(payload) - _FIELDS
    if unknown:
        raise _CategoryError(422, "unknown_field")
    if not partial and set(payload) != _FIELDS:
        raise _CategoryError(422, "required_fields")
    if partial and not payload:
        raise _CategoryError(422, "empty_update")

    values: dict[str, Any] = {}
    if "name" in payload:
        name = payload["name"]
        if not isinstance(name, str):
            raise _CategoryError(422, "invalid_name")
        name = name.strip()
        if not name or len(name) > _MAX_NAME_LENGTH:
            raise _CategoryError(422, "invalid_name")
        values["name"] = name
    if "kind" in payload:
        kind = payload["kind"]
        if not isinstance(kind, str) or kind not in _KINDS:
            raise _CategoryError(422, "invalid_kind")
        values["kind"] = kind
    if "parent_id" in payload:
        parent_id = payload["parent_id"]
        if parent_id is not None and (type(parent_id) is not int or parent_id <= 0):
            raise _CategoryError(422, "invalid_parent_id")
        values["parent_id"] = parent_id
    return values


def _path_id(request: Request) -> int:
    path = request.path.split("?", 1)[0]
    segment = path.rsplit("/", 1)[-1]
    if not _ID_PATTERN.fullmatch(segment):
        raise _CategoryError(400, "invalid_category_id")
    category_id = int(segment)
    if category_id <= 0:
        raise _CategoryError(400, "invalid_category_id")
    return category_id


def _find_category(connection: sqlite3.Connection, category_id: int):
    return connection.execute(
        "SELECT id, name, kind, parent_id, active FROM categories WHERE id = ?",
        (category_id,),
    ).fetchone()


def _validate_parent(
    connection: sqlite3.Connection,
    parent_id: int | None,
    kind: str,
    category_id: int | None = None,
) -> None:
    if parent_id is None:
        return
    if category_id is not None and parent_id == category_id:
        raise _CategoryError(422, "category_cannot_parent_itself")
    parent = _find_category(connection, parent_id)
    if parent is None:
        raise _CategoryError(404, "parent_category_not_found")
    if parent["kind"] != kind:
        raise _CategoryError(422, "parent_kind_mismatch")


def _ensure_no_descendant_parent(
    connection: sqlite3.Connection, category_id: int, parent_id: int | None
) -> None:
    if parent_id is None:
        return
    seen: set[int] = set()
    cursor = parent_id
    while cursor is not None:
        if cursor == category_id:
            raise _CategoryError(422, "category_cycle")
        if cursor in seen:
            raise _CategoryError(409, "category_cycle")
        seen.add(cursor)
        row = _find_category(connection, cursor)
        if row is None:
            raise _CategoryError(404, "parent_category_not_found")
        cursor = row["parent_id"]


def _ensure_children_keep_kind(
    connection: sqlite3.Connection, category_id: int, current_kind: str, desired_kind: str
) -> None:
    if current_kind == desired_kind:
        return
    child = connection.execute(
        "SELECT 1 FROM categories WHERE parent_id = ? LIMIT 1", (category_id,)
    ).fetchone()
    if child is not None:
        raise _CategoryError(409, "category_has_children")


def _ensure_unique(
    connection: sqlite3.Connection,
    name: str,
    kind: str,
    parent_id: int | None,
    category_id: int | None = None,
) -> None:
    query = (
        "SELECT id FROM categories "
        "WHERE name = ? AND kind = ? AND parent_id IS ?"
    )
    parameters: list[Any] = [name, kind, parent_id]
    if category_id is not None:
        query += " AND id <> ?"
        parameters.append(category_id)
    if connection.execute(query, parameters).fetchone() is not None:
        raise _CategoryError(409, "category_already_exists")


def _category_payload(row: sqlite3.Row | None) -> dict[str, Any]:
    if row is None:
        raise _CategoryError(500, "category_write_failed")
    return {
        "id": row["id"],
        "name": row["name"],
        "kind": row["kind"],
        "parent_id": row["parent_id"],
        "active": row["active"],
    }


def _integrity_error(error: sqlite3.IntegrityError) -> str:
    message = str(error).lower()
    if "unique" in message:
        return "category_already_exists"
    if "parent kind" in message:
        return "parent_kind_mismatch"
    return "category_conflict"


def _invoke(db: Database, handler):
    try:
        _ensure_default_categories(db)
        return handler()
    except _CategoryError as error:
        return Response.json(error.status, {"error": error.error})
