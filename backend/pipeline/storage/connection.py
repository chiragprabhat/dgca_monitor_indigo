import os
from urllib.parse import parse_qs, urlsplit

import certifi
import psycopg
from psycopg.rows import dict_row


def get_connection(database_url: str | None = None) -> psycopg.Connection:
    url = database_url or os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is required")
    parsed = urlsplit(url)
    if parsed.scheme not in ("postgresql", "postgres") or not parsed.hostname:
        raise ValueError("DATABASE_URL must be a PostgreSQL URL")
    local = parsed.hostname in ("localhost", "127.0.0.1", "::1")
    options = parse_qs(parsed.query)
    if "host" in options or "hostaddr" in options:
        raise ValueError("Specify the PostgreSQL host in the DATABASE_URL authority")
    ssl = {"sslmode": "verify-full", "sslrootcert": certifi.where()}
    if local and options.get("sslmode") == ["disable"]:
        ssl = {"sslmode": "disable"}
    return psycopg.connect(url, row_factory=dict_row, autocommit=True,
                           prepare_threshold=None, connect_timeout=15, gssencmode="disable", **ssl)


def get_readonly_connection() -> psycopg.Connection:
    """Run every dashboard query in a PostgreSQL read-only transaction."""
    conn = get_connection()
    conn.autocommit = False
    conn.read_only = True
    return conn
