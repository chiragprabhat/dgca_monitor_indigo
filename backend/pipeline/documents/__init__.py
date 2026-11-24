"""
PDF download, validation, text extraction and OCR gating.

    models.py      -- DocumentStatus, DocumentProcessingResult, error types
    download.py    -- HTTP download with retry
    validation.py  -- magic-byte / PyMuPDF validation, content hash
    extraction.py  -- text extraction and scanned-document heuristic
    ocr.py         -- availability check + OCR extraction
    processor.py   -- process_document(): sequences the stages above
"""
from .download import REQUEST_TIMEOUT_SECONDS, USER_AGENT, download_pdf
from .extraction import (
    SCANNED_CHARS_PER_PAGE_THRESHOLD,
    extract_text_pdfplumber,
    extract_text_pymupdf,
    is_likely_scanned,
)
from .models import DocumentProcessingResult, DocumentStatus, DownloadError, ValidationError
from .ocr import check_ocr_availability, ocr_extract
from .processor import process_document
from .validation import MIN_VALID_PDF_SIZE_BYTES, compute_document_hash, validate_pdf_bytes

__all__ = [
    "MIN_VALID_PDF_SIZE_BYTES", "REQUEST_TIMEOUT_SECONDS", "SCANNED_CHARS_PER_PAGE_THRESHOLD", "USER_AGENT",
    "DocumentProcessingResult", "DocumentStatus", "DownloadError", "ValidationError",
    "check_ocr_availability", "compute_document_hash", "download_pdf", "extract_text_pdfplumber",
    "extract_text_pymupdf", "is_likely_scanned", "ocr_extract", "process_document", "validate_pdf_bytes",
]
