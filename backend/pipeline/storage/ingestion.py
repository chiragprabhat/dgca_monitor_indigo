"""Change detection: classifies each scraped record as new / updated /
unchanged / failed against what is already stored. This is also where
duplicate-email prevention starts -- an unchanged publication never moves
past this point."""
import hashlib
import logging
from psycopg import Connection
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List

logger = logging.getLogger(__name__)

REQUIRED_FIELDS = ("source_id", "title", "category")


class IngestOutcome(str, Enum):
    NEW = "new"
    UPDATED = "updated"
    UNCHANGED = "unchanged"
    FAILED = "failed"


def compute_content_hash(pub: Dict[str, Any]) -> str:
    parts = [
        str(pub.get("title", "")),
        str(pub.get("category", "")),
        str(pub.get("published_date", "")),
        str(pub.get("pdf_url", "")),
    ]
    joined = "|".join(parts)
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()


def ingest_publication(conn: Connection, pub: Dict[str, Any]) -> IngestOutcome:
    try:
        missing = [f for f in REQUIRED_FIELDS if not pub.get(f)]
        if missing:
            raise ValueError(f"missing required field(s): {missing}")

        publication_id = pub["source_id"]
        content_hash = compute_content_hash(pub)
        now = datetime.now(timezone.utc).isoformat()

        with conn.transaction():
            conn.execute("SELECT pg_advisory_xact_lock(13692, hashtext(%s))", (publication_id,))
            existing = conn.execute(
                "SELECT content_hash, email_sent FROM publications WHERE publication_id = %s",
                (publication_id,),
            ).fetchone()

            if existing is None:
                conn.execute(
                    """
                    INSERT INTO publications
                        (publication_id, title, category, published_date, publication_url,
                         pdf_url, content_hash, document_hash, first_seen_at, processed_at,
                         email_sent, email_sent_at, status)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, NULL, %s, NULL, 0, NULL, 'new')
                    """,
                    (
                        publication_id, pub["title"], pub["category"], pub.get("published_date"),
                        pub.get("publication_url"), pub.get("pdf_url"), content_hash, now,
                    ),
                )
                logger.info(f"[NEW] {publication_id} -- {pub['title'][:60]}")
                return IngestOutcome.NEW

            if existing["content_hash"] == content_hash:
                logger.info(f"[UNCHANGED] {publication_id}")
                return IngestOutcome.UNCHANGED

            conn.execute(
                """
                UPDATE publications
                SET title = %s, category = %s, published_date = %s, publication_url = %s,
                    pdf_url = %s, content_hash = %s, status = 'updated',
                    email_sent = 0, email_sent_at = NULL, processed_at = NULL
                WHERE publication_id = %s
                """,
                (
                    pub["title"], pub["category"], pub.get("published_date"),
                    pub.get("publication_url"), pub.get("pdf_url"), content_hash, publication_id,
                ),
            )
            logger.info(f"[UPDATED] {publication_id} -- content changed since last seen")
            return IngestOutcome.UPDATED

    except Exception as exc:
        logger.error(f"[FAILED] Could not ingest record ({exc.__class__.__name__}): {exc}")
        return IngestOutcome.FAILED


@dataclass
class IngestSummary:
    new: int = 0
    updated: int = 0
    unchanged: int = 0
    failed: int = 0
    failed_ids: List[str] = field(default_factory=list)
    total: int = 0


def ingest_batch(conn: Connection, publications: List[Dict[str, Any]]) -> IngestSummary:
    summary = IngestSummary(total=len(publications))
    for pub in publications:
        outcome = ingest_publication(conn, pub)
        if outcome == IngestOutcome.NEW:
            summary.new += 1
        elif outcome == IngestOutcome.UPDATED:
            summary.updated += 1
        elif outcome == IngestOutcome.UNCHANGED:
            summary.unchanged += 1
        else:
            summary.failed += 1
            summary.failed_ids.append(pub.get("source_id", "<unknown>"))

    logger.info(
        f"Batch ingest complete: {summary.total} total -- "
        f"new={summary.new}, updated={summary.updated}, "
        f"unchanged={summary.unchanged}, failed={summary.failed}"
    )
    return summary
