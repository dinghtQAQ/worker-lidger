"""SQLite persistence primitives used by worker modules."""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
import sqlite3
from typing import Iterator


class Database:
    """Open configured SQLite connections and provide atomic transactions."""

    BUSY_TIMEOUT_MS = 5_000

    def __init__(self, path: str | Path):
        self.path = str(path)

    def _configure(self, connection: sqlite3.Connection) -> sqlite3.Connection:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute(f"PRAGMA busy_timeout = {self.BUSY_TIMEOUT_MS}")
        return connection

    def connect(self) -> sqlite3.Connection:
        """Return a configured connection; the caller owns its lifetime."""

        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        return self._configure(sqlite3.connect(self.path))

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        connection = self.connect()
        try:
            yield connection
        finally:
            connection.close()

    def initialize(self) -> None:
        """Create the foundation schema in one SQLite operation."""

        schema_path = Path(__file__).with_name("schema.sql")
        with self.connection() as connection:
            connection.executescript(schema_path.read_text(encoding="utf-8"))
            connection.commit()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        """Yield an atomic write transaction and roll it back on any error."""

        with self.connection() as connection:
            try:
                connection.execute("BEGIN")
                yield connection
            except BaseException:
                connection.rollback()
                raise
            else:
                connection.commit()
