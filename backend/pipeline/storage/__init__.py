"""
PostgreSQL change-detection storage.

Split by responsibility:
    connection.py      -- opening read/write and read-only connections
    schema.py          -- table definition and additive migrations
    ingestion.py       -- new / updated / unchanged classification
    notifications.py   -- email lifecycle (pending, sent, failed, resend)
    analysis_store.py  -- persisting AI analysis + comparison results
    queries.py         -- dashboard read queries
    repository.py      -- PublicationStore protocol + PostgreSQL implementation

The names below are the package's public API; callers write
`from pipeline import storage; storage.ingest_publication(...)`.
"""
from .analysis_store import save_analysis_result
from .connection import get_connection, get_readonly_connection
from .ingestion import (
    REQUIRED_FIELDS,
    IngestOutcome,
    IngestSummary,
    compute_content_hash,
    ingest_batch,
    ingest_publication,
)
from .notifications import (
    get_all,
    get_failed_unsent,
    get_pending_notifications,
    mark_email_sent,
    mark_failed,
    mark_for_resend,
    mark_processed,
    update_document_hash,
)
from .queries import (
    get_publication_by_id,
    get_publication_counts_by_day,
    get_publications,
    get_summary_stats,
)
from .repository import PublicationStore, PostgresPublicationStore
from .schema import SCHEMA_SQL, init_db

__all__ = [
    "REQUIRED_FIELDS", "SCHEMA_SQL",
    "IngestOutcome", "IngestSummary", "PublicationStore", "PostgresPublicationStore",
    "compute_content_hash", "get_all", "get_connection",
    "get_failed_unsent", "get_pending_notifications", "get_publication_by_id",
    "get_publication_counts_by_day", "get_publications", "get_readonly_connection",
    "get_summary_stats", "ingest_batch", "ingest_publication", "init_db",
    "mark_email_sent", "mark_failed", "mark_for_resend", "mark_processed",
    "save_analysis_result", "update_document_hash",
]
