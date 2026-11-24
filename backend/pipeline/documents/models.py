"""Document processing result types and the status vocabulary. Every
brief-required failure mode has its own status rather than one generic
"failed"."""
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Optional


class DocumentStatus(str, Enum):
    SUCCESS = "success"
    OCR_SUCCESS = "ocr_success"
    NEEDS_OCR = "needs_ocr"
    EMPTY = "empty"
    PASSWORD_PROTECTED = "password_protected"
    CORRUPTED = "corrupted"
    DOWNLOAD_FAILED = "download_failed"
    FAILED = "failed"


@dataclass
class DocumentProcessingResult:
    publication_id: str
    pdf_url: Optional[str]
    status: str
    local_path: Optional[str] = None
    file_size_bytes: Optional[int] = None
    page_count: Optional[int] = None
    extraction_method: Optional[str] = None
    is_scanned: bool = False
    text_char_count: int = 0
    text_path: Optional[str] = None
    document_hash: Optional[str] = None
    error: Optional[str] = None
    processed_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class DownloadError(Exception):
    pass


class ValidationError(Exception):
    pass
