"""Worker application assembly and standard-library HTTP server."""

from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hmac
from typing import Callable, Iterable
from urllib.parse import urlsplit

from .config import Config
from .db import Database
from .http import Request, Response, Router


RouteRegistrar = Callable[[Router, Database, Config], None]


class WorkerApp:
    """Foundation application with health and reusable route registration."""

    def __init__(self, config: Config, db: Database):
        self.config = config
        self.db = db
        self.router = Router()
        self.router.register("GET", "/healthz", self._healthz)

    def register(self, registrar: RouteRegistrar) -> None:
        """Let a future module register routes without changing this server."""

        registrar(self.router, self.db, self.config)

    def _healthz(self, request: Request) -> Response:
        return Response.json(200, {"status": "ok"})

    def handle(self, request: Request) -> Response:
        if len(request.body) > self.config.max_body_bytes:
            return Response.json(413, {"error": "request_body_too_large"})
        if request.path.split("?", 1)[0] != "/healthz" and self.config.api_token:
            expected = f"Bearer {self.config.api_token}"
            actual = request.header("Authorization", "") or ""
            if not hmac.compare_digest(actual, expected):
                return Response.json(401, {"error": "unauthorized"},)
        return self.router.dispatch(request)


class _RequestHandler(BaseHTTPRequestHandler):
    server_version = "worker-lidger"
    sys_version = ""

    def _write_response(self, response: Response, include_body: bool = True) -> None:
        self.send_response(response.status)
        headers = dict(response.headers)
        headers.setdefault("Content-Type", "application/json; charset=utf-8")
        headers["Content-Length"] = str(len(response.body))
        for name, value in headers.items():
            self.send_header(name, value)
        self.end_headers()
        if include_body:
            self.wfile.write(response.body)

    def send_error(self, code: int, message: str | None = None, explain: str | None = None) -> None:
        del message, explain
        self._write_response(Response.json(code, {"error": "bad_request"}))

    def _handle(self, include_body: bool = True) -> None:
        app: WorkerApp = self.server.worker_app  # type: ignore[attr-defined]
        if self.headers.get("Transfer-Encoding"):
            self.close_connection = True
            self._write_response(
                Response.json(400, {"error": "unsupported_transfer_encoding"}), include_body
            )
            return
        raw_length = self.headers.get("Content-Length", "0")
        try:
            content_length = int(raw_length)
        except ValueError:
            self._write_response(Response.json(400, {"error": "invalid_content_length"}), include_body)
            return
        if content_length < 0:
            self._write_response(Response.json(400, {"error": "invalid_content_length"}), include_body)
            return
        if content_length > app.config.max_body_bytes:
            self.close_connection = True
            self._write_response(Response.json(413, {"error": "request_body_too_large"}), include_body)
            return
        body = self.rfile.read(content_length)
        request = Request(
            method=self.command,
            path=urlsplit(self.path).path,
            headers={key: value for key, value in self.headers.items()},
            body=body,
        )
        self._write_response(app.handle(request), include_body)

    def do_GET(self) -> None:
        self._handle()

    def do_HEAD(self) -> None:
        self._handle(include_body=False)

    def do_POST(self) -> None:
        self._handle()

    def do_PUT(self) -> None:
        self._handle()

    def do_PATCH(self) -> None:
        self._handle()

    def do_DELETE(self) -> None:
        self._handle()

    def log_message(self, format: str, *args: object) -> None:
        return


def create_app(
    config: Config | None = None,
    db: Database | None = None,
    registrars: Iterable[RouteRegistrar] = (),
) -> WorkerApp:
    config = config or Config.from_env()
    app = WorkerApp(config, db or Database(config.db_path))
    app.db.initialize()
    for registrar in registrars:
        app.register(registrar)
    return app


def create_server(app: WorkerApp) -> ThreadingHTTPServer:
    """Create a server separately so callers can manage its lifecycle in tests."""

    server = ThreadingHTTPServer((app.config.host, app.config.port), _RequestHandler)
    server.worker_app = app  # type: ignore[attr-defined]
    return server


def run_server(config: Config | None = None) -> None:
    app = create_app(config)
    server = create_server(app)
    try:
        server.serve_forever()
    finally:
        server.server_close()
