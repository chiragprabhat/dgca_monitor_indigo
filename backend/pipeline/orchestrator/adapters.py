"""Default implementations of the orchestrator's ports, each a thin adapter
over the existing, tested package function -- no logic of their own."""
import logging
from psycopg import Connection
from psycopg.rows import DictRow
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from .. import analysis, comparison, documents, email_pipeline, scraper
from ..storage import PostgresPublicationStore
from .ports import PipelineServices

logger = logging.getLogger(__name__)


class PdfDocumentService:
    def process(
        self,
        publication_id: str,
        pdf_url: Optional[str],
        documents_dir: Path,
        ocr_available: bool,
        raw_bytes_override: Optional[bytes] = None,
    ):
        return documents.process_document(
            publication_id, pdf_url, documents_dir, ocr_available, raw_bytes_override=raw_bytes_override
        )


class PostgresVersionFinder:
    def __init__(self, conn: Connection):
        self._conn = conn

    def find_previous(self, publication_id: str) -> Optional[DictRow]:
        return comparison.find_previous_version(self._conn, publication_id)


class TextDocumentComparer:
    def compare(self, old_text: str, new_text: str, config) -> Tuple[comparison.DiffResult, comparison.ComparisonResult]:
        return comparison.compare_documents(old_text, new_text, config)


class ProviderAnalyzer:
    def analyze(self, row, extracted_text, comparison_result, config):
        return analysis.generate_ai_analysis(row, extracted_text, comparison_result, config)


class LiveDgcaSource:
    """Scrapes the live DGCA "What's New" section."""

    def fetch(self) -> List[Dict]:
        session = scraper.get_dgca_session()
        scrape_result = scraper.scrape_whats_new(session)
        return [p.model_dump() for p in scrape_result.publications]


def build_default_services(conn: Connection) -> PipelineServices:
    return PipelineServices(
        store=PostgresPublicationStore(conn),
        documents=PdfDocumentService(),
        versions=PostgresVersionFinder(conn),
        comparer=TextDocumentComparer(),
        analyzer=ProviderAnalyzer(),
        sender_factory=email_pipeline.get_email_sender,
    )
