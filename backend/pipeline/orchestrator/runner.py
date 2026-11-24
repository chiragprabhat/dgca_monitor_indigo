"""Public entry points: process one publication, or a whole run."""
import logging
from psycopg import Connection
from pathlib import Path
from typing import Dict, List, Optional

from ..config import PipelineConfig
from .adapters import LiveDgcaSource, build_default_services
from .ports import PipelineServices, PublicationSource
from .processor import PublicationProcessor
from .results import PipelineRunSummary, PublicationPipelineResult

logger = logging.getLogger(__name__)


def process_single_publication(
    conn: Connection,
    pub: Dict,
    config: PipelineConfig,
    documents_dir: Path,
    preview_dir: Path,
    ocr_available: bool,
    raw_pdf_bytes_override: Optional[bytes] = None,
    retry_failed: bool = False,
    services: Optional[PipelineServices] = None,
) -> PublicationPipelineResult:
    """`services` replaces the default collaborators (PostgreSQL store, PyMuPDF
    documents, Ollama/OpenAI analysis, ...) -- used by tests and by anything
    that needs a different backend."""
    processor = PublicationProcessor(services or build_default_services(conn))
    return processor.process(
        pub, config, documents_dir, preview_dir, ocr_available,
        raw_pdf_bytes_override=raw_pdf_bytes_override, retry_failed=retry_failed,
    )


def run_dgca_pipeline(
    conn: Connection,
    config: PipelineConfig,
    documents_dir: Path,
    preview_dir: Path,
    ocr_available: bool,
    publications: Optional[List[Dict]] = None,
    retry_failed: bool = False,
    source: Optional[PublicationSource] = None,
    services: Optional[PipelineServices] = None,
) -> PipelineRunSummary:
    """Runs every publication through the pipeline. With `publications=None`
    the current list comes from `source` (the live DGCA site by default);
    otherwise the supplied list is used (controlled runs, tests, retries).
    `retry_failed` is propagated to the processor -- only the explicit retry
    function ever sets it."""
    logger.info("=== DGCA Pipeline Run Starting ===")

    if publications is None:
        try:
            publications = (source or LiveDgcaSource()).fetch()
            logger.info(f"[monitor] {len(publications)} publication(s) found on the live DGCA site.")
        except Exception as exc:
            logger.error(f"[monitor] Failed to scrape DGCA website: {exc.__class__.__name__}: {exc}")
            return PipelineRunSummary(total=0)
    else:
        logger.info(f"[monitor] Using {len(publications)} supplied publication(s) (controlled run).")

    services = services or build_default_services(conn)
    processor = PublicationProcessor(services)

    run_summary = PipelineRunSummary(total=len(publications))
    for pub in publications:
        result = processor.process(
            pub, config, documents_dir, preview_dir, ocr_available, retry_failed=retry_failed
        )
        run_summary.results.append(result)
        if result.status == "success":
            run_summary.success += 1
        elif result.status == "skipped_unchanged":
            run_summary.skipped_unchanged += 1
        else:
            run_summary.failed += 1

    logger.info(
        f"=== DGCA Pipeline Run Complete: {run_summary.total} total, {run_summary.success} success, "
        f"{run_summary.skipped_unchanged} skipped (unchanged), {run_summary.failed} failed ==="
    )
    return run_summary
