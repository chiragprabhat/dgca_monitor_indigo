"""One monitoring cycle: scrape -> process -> structured result. Never
raises -- any unexpected failure becomes a `{"status": "error", ...}` result,
so a scheduler loop calling this repeatedly can't be crashed by one bad
cycle."""
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from .. import documents, scraper, storage
from ..config import PipelineConfig, load_config
from ..orchestrator import PipelineRunSummary, run_dgca_pipeline
from ..paths import DEFAULT_PATHS, ProjectPaths

logger = logging.getLogger(__name__)


def run_once(
    publications: Optional[List[Dict[str, Any]]] = None,
    config: Optional[PipelineConfig] = None,
    paths: ProjectPaths = DEFAULT_PATHS,
) -> Dict[str, Any]:
    """Executes exactly one monitoring cycle and returns a structured result.

    `publications` lets callers (tests, notebook demonstrations) supply a
    controlled publication list instead of scraping the live DGCA site. Leave
    it None for real, unattended monitoring."""
    cycle_started = datetime.now(timezone.utc)
    logger.info("Starting DGCA monitoring cycle")

    try:
        if config is None:
            config = load_config(paths.env_path)

        # Idempotent: creates the schema on a first run, additively migrates
        # an older database on every later run.
        storage.init_db()
        ocr_available = documents.check_ocr_availability()

        logger.info("Checking DGCA What's New")
        logger.info(f"Categories checked: {', '.join(scraper.ALL_CATEGORIES)}")

        conn = storage.get_connection()
        try:
            summary = run_dgca_pipeline(
                conn, config, paths.documents_dir, paths.preview_dir, ocr_available, publications=publications
            )
        finally:
            conn.close()

    except Exception as exc:
        logger.error(f"Monitoring cycle failed before processing could start: {exc.__class__.__name__}: {exc}")
        return {
            "status": "error",
            "error": f"{exc.__class__.__name__}: {exc}",
            "new_publications": 0,
            "updated_publications": 0,
            "processed": 0,
            "skipped": 0,
            "failed": 0,
            "cycle_started_at": cycle_started.isoformat(),
            "cycle_completed_at": datetime.now(timezone.utc).isoformat(),
        }

    return _summarise_cycle(summary, cycle_started)


def _summarise_cycle(summary: PipelineRunSummary, cycle_started: datetime) -> Dict[str, Any]:
    new_count = sum(1 for r in summary.results if r.outcome == "new")
    updated_count = sum(1 for r in summary.results if r.outcome == "updated")
    analysis_modes: Dict[str, int] = {}
    errors: List[Dict[str, Optional[str]]] = []

    logger.info(f"Publications discovered: {summary.total}")
    logger.info(f"New publications: {new_count}")
    logger.info(f"Updated publications: {updated_count}")
    logger.info(f"Skipped unchanged publications: {summary.skipped_unchanged}")

    for r in summary.results:
        if r.outcome in ("new", "updated"):
            logger.info(f"Processing:\n      Title: {r.title}\n      Category: {r.category}")
            if "document" in r.stages_completed:
                logger.info("PDF downloaded")
                logger.info("Text extraction completed")
            logger.info(f"Previous version: {r.comparison_status}")
            if r.analysis_mode:
                logger.info(f"AI analysis: {r.analysis_mode}")
                analysis_modes[r.analysis_mode] = analysis_modes.get(r.analysis_mode, 0) + 1
            if "generate_email" in r.stages_completed:
                logger.info("Email preview generated")
            if "persist_status" in r.stages_completed:
                logger.info("Database status updated")

        if r.status == "failed":
            logger.error(
                f"\nPublication: {r.title or r.publication_id}"
                f"\nStage: {r.stage}"
                f"\nReason: {r.error}"
                "\nAction: publication marked failed; scheduler continuing"
            )
            errors.append({"publication": r.title or r.publication_id, "stage": r.stage, "reason": r.error})

    cycle_completed = datetime.now(timezone.utc)
    logger.info("Monitoring cycle completed")

    return {
        "status": "success" if summary.failed == 0 else "completed_with_errors",
        "categories_checked": list(scraper.ALL_CATEGORIES),
        "discovered": summary.total,
        "new_publications": new_count,
        "updated_publications": updated_count,
        "processed": summary.success,
        "skipped": summary.skipped_unchanged,
        "failed": summary.failed,
        "analysis_modes": analysis_modes,
        "errors": errors,
        "cycle_started_at": cycle_started.isoformat(),
        "cycle_completed_at": cycle_completed.isoformat(),
        "duration_seconds": round((cycle_completed - cycle_started).total_seconds(), 2),
    }
