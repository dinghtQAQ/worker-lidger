"""Small standard-library HTTP request, response, and routing contracts."""

from __future__ import annotations

from dataclasses import dataclass, field
import json
from typing import Any, Callable, Mapping


Handler = Callable[["Request"], "Response"]


@dataclass(frozen=True)
class Request:
    method: str
    path: str
    headers: Mapping[str, str] = field(default_factory=dict)
    body: bytes = b""

    def header(self, name: str, default: str | None = None) -> str | None:
        wanted = name.casefold()
        for key, value in self.headers.items():
            if key.casefold() == wanted:
                return value
        return default


@dataclass(frozen=True)
class Response:
    status: int
    body: bytes
    headers: Mapping[str, str] = field(default_factory=dict)

    @classmethod
    def json(cls, status: int, payload: Any) -> "Response":
        return cls(
            status=status,
            body=json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode("utf-8"),
            headers={"Content-Type": "application/json; charset=utf-8"},
        )

    def json_body(self) -> Any:
        return json.loads(self.body.decode("utf-8"))


class Router:
    """Exact-method/path router with an explicit registration point."""

    def __init__(self) -> None:
        self._routes: dict[tuple[str, str], Handler] = {}

    def register(self, method: str, path: str, handler: Handler) -> None:
        method = method.upper()
        if not method or not path.startswith("/"):
            raise ValueError("routes require an HTTP method and absolute path")
        key = (method, path)
        if key in self._routes:
            raise ValueError(f"route already registered: {method} {path}")
        self._routes[key] = handler

    def dispatch(self, request: Request) -> Response:
        path = request.path.split("?", 1)[0]
        handler = self._routes.get((request.method.upper(), path))
        if handler is None:
            if any(route_path == path for _, route_path in self._routes):
                return Response.json(405, {"error": "method_not_allowed"})
            return Response.json(404, {"error": "not_found"})
        try:
            response = handler(request)
            if not isinstance(response, Response):
                raise TypeError("route handler must return Response")
            return response
        except Exception:
            return Response.json(500, {"error": "internal_server_error"})
