"""Database schema and additive migrations for publications."""
import logging
from pathlib import Path

from .connection import get_connection

logger = logging.getLogger(__name__)

SCHEMA_SQL = (Path(__file__).resolve().parents[2] / "database" / "publications_schema.sql").read_text(encoding="utf-8")


def init_db() -> None:
    with get_connection() as conn, conn.transaction():
        conn.execute("SELECT pg_advisory_xact_lock(13691, 2)")
        conn.execute(SCHEMA_SQL)
    logger.info("Publications database schema ready")
