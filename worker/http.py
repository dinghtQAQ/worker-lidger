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
    """Method/path router with exact routes and one-segment templates."""

    def __init__(self) -> None:
        self._routes: dict[tuple[str, str], Handler] = {}
        self._parameter_routes: list[tuple[str, str, Handler]] = []

    def register(self, method: str, path: str, handler: Handler) -> None:
        method = method.upper()
        if not method or not path.startswith("/"):
            raise ValueError("routes require an HTTP method and absolute path")
        key = (method, path)
        if key in self._routes or any(
            route_method == method and route_path == path
            for route_method, route_path, _ in self._parameter_routes
        ):
            raise ValueError(f"route already registered: {method} {path}")
        parts = path.split("/")
        parameter_parts = [part for part in parts if part.startswith("{") or part.endswith("}")]
        if parameter_parts:
            if len(parameter_parts) != 1 or not (
                parameter_parts[0].startswith("{") and parameter_parts[0].endswith("}")
            ):
                raise ValueError("routes support at most one complete path parameter")
            self._parameter_routes.append((method, path, handler))
        else:
            self._routes[key] = handler

    @staticmethod
    def _matches(template: str, path: str) -> bool:
        template_parts = template.split("/")
        path_parts = path.split("/")
        if len(template_parts) != len(path_parts):
            return False
        return all(
            template_part == path_part
            or (
                template_part.startswith("{")
                and template_part.endswith("}")
                and bool(path_part)
                and "/" not in path_part
            )
            for template_part, path_part in zip(template_parts, path_parts)
        )

    def dispatch(self, request: Request) -> Response:
        path = request.path.split("?", 1)[0]
        handler = self._routes.get((request.method.upper(), path))
        if handler is None:
            for method, template, candidate in self._parameter_routes:
                if method == request.method.upper() and self._matches(template, path):
                    handler = candidate
                    break
        if handler is None:
            if any(route_path == path for _, route_path in self._routes) or any(
                self._matches(template, path) for _, template, _ in self._parameter_routes
            ):
                return Response.json(405, {"error": "method_not_allowed"})
            return Response.json(404, {"error": "not_found"})
        try:
            response = handler(request)
            if not isinstance(response, Response):
                raise TypeError("route handler must return Response")
            return response
        except Exception:
            return Response.json(500, {"error": "internal_server_error"})
