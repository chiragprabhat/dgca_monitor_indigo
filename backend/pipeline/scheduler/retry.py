"""Explicit, operator-triggered retry for publications whose email delivery
previously failed (status='failed' AND email_sent=0 -- the columns
storage.mark_failed() sets and storage.mark_for_resend() clears; no extra
tracking table).

Deliberately NOT called by run_once()/run_scheduler(): retries must be a
controlled action, not an indefinite automatic resend (a permanently
misconfigured SMTP server must not generate a failed send attempt every
single cycle forever). Call it by hand, or from an operator-triggered
script/notebook cell."""
import logging
from typing import Any, Dict, Optional

from .. import documents, storage
from ..config import PipelineConfig, load_config
from ..orchestrator import run_dgca_pipeline
from ..paths import DEFAULT_PATHS, ProjectPaths

logger = logging.getLogger(__name__)


def retry_failed_notifications(
    config: Optional[PipelineConfig] = None,
    paths: ProjectPaths = DEFAULT_PATHS,
) -> Dict[str, Any]:
    """Reconstructs each eligible row into the scrape-shaped dict
    run_dgca_pipeline() already accepts via its `publications` parameter and
    reruns it with retry_failed=True, so the processor regenerates the email
    and re-attempts delivery instead of skipping on unchanged content."""
    if config is None:
        config = load_config(paths.env_path)

    storage.init_db()
    ocr_available = documents.check_ocr_availability()

    conn = storage.get_connection()
    try:
        failed_rows = storage.get_failed_unsent(conn)
        if not failed_rows:
            logger.info("No publications with a previously failed, unsent email notification -- nothing to retry.")
            return {"status": "success", "retried": 0, "processed": 0, "failed": 0, "publication_ids": []}

        pubs = [
            {
                "source_id": r["publication_id"],
                "title": r["title"],
                "category": r["category"],
                "published_date": r["published_date"],
                "publication_url": r["publication_url"],
                "pdf_url": r["pdf_url"],
            }
            for r in failed_rows
        ]
        logger.info(f"Explicit retry requested for {len(pubs)} publication(s) with a previously failed email: "
                    f"{[p['source_id'] for p in pubs]}")

        summary = run_dgca_pipeline(
            conn, config, paths.documents_dir, paths.preview_dir, ocr_available, publications=pubs, retry_failed=True
        )
    finally:
        conn.close()

    return {
        "status": "success" if summary.failed == 0 else "completed_with_errors",
        "retried": summary.total,
        "processed": summary.success,
        "failed": summary.failed,
        "publication_ids": [p["source_id"] for p in pubs],
    }
