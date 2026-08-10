"""Run the complete worker application with environment-backed configuration."""

from __future__ import annotations

from .app import create_app, create_server
from .category_api import register as register_categories
from .config import Config
from .ledger_api import register as register_ledger


def main() -> None:
    app = create_app(Config.from_env(), registrars=(register_categories, register_ledger))
    server = create_server(app)
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
