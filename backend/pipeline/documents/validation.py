"""Cheap-then-thorough PDF validation (size, magic bytes, then an actual
PyMuPDF open -- catches truncated/corrupted files that pass the cheap
checks) and content hashing."""
import hashlib

import pymupdf

from .models import ValidationError

MIN_VALID_PDF_SIZE_BYTES = 100


def validate_pdf_bytes(raw_bytes: bytes) -> None:
    if len(raw_bytes) < MIN_VALID_PDF_SIZE_BYTES:
        raise ValidationError(f"File too small to be a valid PDF ({len(raw_bytes)} bytes).")
    if not raw_bytes.startswith(b"%PDF-"):
        raise ValidationError("File does not start with the %PDF- magic bytes.")
    try:
        doc = pymupdf.open(stream=raw_bytes, filetype="pdf")
        doc.close()
    except Exception as exc:
        raise ValidationError(f"PyMuPDF could not open the file ({exc.__class__.__name__}): {exc}") from exc


def compute_document_hash(raw_bytes: bytes) -> str:
    return hashlib.sha256(raw_bytes).hexdigest()
