"""
What the orchestrator needs from the rest of the system, as abstractions.

The processor sequences the stages but depends only on these protocols
(dependency inversion): persistence, PDF handling, version lookup, document
comparison, AI analysis and email delivery can each be swapped -- or faked in
a test -- without touching the orchestration code. The default, concrete
implementations live in `adapters.py`.
"""
from psycopg.rows import DictRow
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, List, Optional, Protocol, Tuple

from ..analysis import AIAnalysisResult
from ..comparison import ComparisonResult, DiffResult
from ..documents import DocumentProcessingResult
from ..email_pipeline import EmailSender
from ..storage import PublicationStore


class DocumentService(Protocol):
    def process(
        self,
        publication_id: str,
        pdf_url: Optional[str],
        documents_dir: Path,
        ocr_available: bool,
        raw_bytes_override: Optional[bytes] = None,
    ) -> DocumentProcessingResult: ...


class VersionFinder(Protocol):
    def find_previous(self, publication_id: str) -> Optional[DictRow]: ...


class DocumentComparer(Protocol):
    def compare(self, old_text: str, new_text: str, config) -> Tuple[DiffResult, ComparisonResult]: ...


class Analyzer(Protocol):
    def analyze(
        self, row, extracted_text: Optional[str], comparison: Optional[ComparisonResult], config
    ) -> AIAnalysisResult: ...


class PublicationSource(Protocol):
    """Where the list of current publications comes from (the live DGCA site
    by default). Raises on failure; the runner decides what that means."""

    def fetch(self) -> List[Dict]: ...


SenderFactory = Callable[[object, Path], EmailSender]


@dataclass
class PipelineServices:
    store: PublicationStore
    documents: DocumentService
    versions: VersionFinder
    comparer: DocumentComparer
    analyzer: Analyzer
    sender_factory: SenderFactory
