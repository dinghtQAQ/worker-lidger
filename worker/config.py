"""Environment-backed worker configuration."""

from __future__ import annotations

from dataclasses import dataclass
import ipaddress
import os
from typing import Mapping


class ConfigError(ValueError):
    """Raised when worker configuration is invalid or unsafe."""


def _is_loopback(host: str) -> bool:
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


@dataclass(frozen=True)
class Config:
    """Runtime settings with safe local-development defaults."""

    host: str = "127.0.0.1"
    port: int = 8080
    db_path: str = "worker/data/ledger.sqlite3"
    api_token: str | None = None
    max_body_bytes: int = 1_048_576

    def __post_init__(self) -> None:
        if not self.host or not self.host.strip():
            raise ConfigError("WORKER_HOST must not be empty")
        if not isinstance(self.port, int) or isinstance(self.port, bool) or not 0 <= self.port <= 65535:
            raise ConfigError("WORKER_PORT must be between 0 and 65535")
        if not self.db_path or not self.db_path.strip():
            raise ConfigError("WORKER_DB_PATH must not be empty")
        if not isinstance(self.max_body_bytes, int) or self.max_body_bytes <= 0:
            raise ConfigError("max_body_bytes must be positive")
        if self.api_token is not None and not self.api_token:
            raise ConfigError("WORKER_API_TOKEN must not be empty")
        if not _is_loopback(self.host) and not self.api_token:
            raise ConfigError("WORKER_API_TOKEN is required for non-loopback hosts")

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> "Config":
        """Build configuration from environment variables without logging secrets."""

        values = os.environ if environ is None else environ
        host = values.get("WORKER_HOST", "127.0.0.1").strip()
        raw_port = values.get("WORKER_PORT", "8080").strip()
        try:
            port = int(raw_port)
        except ValueError as exc:
            raise ConfigError("WORKER_PORT must be an integer") from exc
        db_path = values.get("WORKER_DB_PATH", "worker/data/ledger.sqlite3").strip()
        token = values.get("WORKER_API_TOKEN")
        if token == "":
            token = None
        return cls(host=host, port=port, db_path=db_path, api_token=token)
