"""Notification lifecycle: what still needs an email, and recording how the
send went."""
import logging
from psycopg import Connection
from psycopg.rows import DictRow
from datetime import datetime, timezone
from typing import List

logger = logging.getLogger(__name__)


def get_pending_notifications(conn: Connection) -> List[DictRow]:
    return conn.execute(
        "SELECT * FROM publications WHERE status IN ('new', 'updated') AND email_sent = 0 "
        "ORDER BY first_seen_at"
    ).fetchall()


def get_failed_unsent(conn: Connection) -> List[DictRow]:
    """Publications whose email delivery previously failed -- the rows an
    explicit, operator-triggered retry picks up."""
    return conn.execute(
        "SELECT * FROM publications WHERE status = 'failed' AND email_sent = 0"
    ).fetchall()


def mark_email_sent(conn: Connection, publication_id: str) -> None:
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "UPDATE publications SET email_sent = 1, email_sent_at = %s, status = 'processed', "
        "processed_at = %s WHERE publication_id = %s",
        (now, now, publication_id),
    )
    logger.info(f"[email-sent] {publication_id}")


def mark_processed(conn: Connection, publication_id: str) -> None:
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "UPDATE publications SET status = 'processed', processed_at = %s WHERE publication_id = %s",
        (now, publication_id),
    )


def mark_failed(conn: Connection, publication_id: str) -> None:
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "UPDATE publications SET status = 'failed', processed_at = %s WHERE publication_id = %s",
        (now, publication_id),
    )
    logger.info(f"[status-failed] {publication_id}")


def mark_for_resend(conn: Connection, publication_id: str) -> None:
    """Explicit, operator-triggered retry: clears email_sent without touching
    content_hash, so the next notification pass re-sends even though content
    hasn't changed."""
    conn.execute(
        "UPDATE publications SET email_sent = 0, email_sent_at = NULL WHERE publication_id = %s",
        (publication_id,),
    )
    logger.info(f"[resend-requested] {publication_id}")


def update_document_hash(conn: Connection, publication_id: str, document_hash: str) -> None:
    conn.execute(
        "UPDATE publications SET document_hash = %s WHERE publication_id = %s",
        (document_hash, publication_id),
    )


def get_all(conn: Connection) -> List[DictRow]:
    return conn.execute("SELECT * FROM publications ORDER BY first_seen_at").fetchall()
