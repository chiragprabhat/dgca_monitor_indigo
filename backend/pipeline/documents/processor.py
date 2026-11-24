"""The download -> validate -> save -> classify -> extract flow for one
publication. Each stage lives in its own module; this is the only place that
sequences them and maps outcomes to DocumentStatus values."""
import logging
from pathlib import Path
from typing import Optional

import pymupdf

from .download import download_pdf
from .extraction import extract_text_pdfplumber, extract_text_pymupdf, is_likely_scanned
from .models import DocumentProcessingResult, DocumentStatus, DownloadError, ValidationError
from .ocr import ocr_extract
from .validation import compute_document_hash, validate_pdf_bytes

logger = logging.getLogger(__name__)


def process_document(
    publication_id: str,
    pdf_url: Optional[str],
    documents_dir: Path,
    ocr_available: bool,
    raw_bytes_override: Optional[bytes] = None,
) -> DocumentProcessingResult:
    logger.info(f"Processing document for {publication_id}")

    if not pdf_url and raw_bytes_override is None:
        logger.error(f"[{publication_id}] No pdf_url provided -- nothing to process.")
        return DocumentProcessingResult(
            publication_id, pdf_url, DocumentStatus.DOWNLOAD_FAILED.value, error="No pdf_url provided."
        )

    try:
        raw_bytes = raw_bytes_override if raw_bytes_override is not None else download_pdf(pdf_url)
    except DownloadError as exc:
        logger.error(f"[{publication_id}] Download failed: {exc}")
        return DocumentProcessingResult(publication_id, pdf_url, DocumentStatus.DOWNLOAD_FAILED.value, error=str(exc))

    try:
        validate_pdf_bytes(raw_bytes)
    except ValidationError as exc:
        logger.error(f"[{publication_id}] Validation failed: {exc}")
        return DocumentProcessingResult(
            publication_id, pdf_url, DocumentStatus.CORRUPTED.value,
            file_size_bytes=len(raw_bytes), error=str(exc),
        )

    documents_dir.mkdir(parents=True, exist_ok=True)
    local_path = documents_dir / f"{publication_id}.pdf"
    local_path.write_bytes(raw_bytes)
    document_hash = compute_document_hash(raw_bytes)
    logger.info(f"[{publication_id}] Saved to {local_path} ({len(raw_bytes)} bytes).")

    doc = None
    try:
        doc = pymupdf.open(stream=raw_bytes, filetype="pdf")

        if doc.is_encrypted:
            logger.warning(f"[{publication_id}] PDF is password-protected -- cannot extract text.")
            return DocumentProcessingResult(
                publication_id, pdf_url, DocumentStatus.PASSWORD_PROTECTED.value,
                local_path=str(local_path), file_size_bytes=len(raw_bytes),
                page_count=doc.page_count, document_hash=document_hash,
            )

        if doc.page_count == 0:
            logger.warning(f"[{publication_id}] PDF has zero pages.")
            return DocumentProcessingResult(
                publication_id, pdf_url, DocumentStatus.EMPTY.value,
                local_path=str(local_path), file_size_bytes=len(raw_bytes),
                page_count=0, document_hash=document_hash,
            )

        text = extract_text_pymupdf(doc)
        method = "pymupdf"
        if not text.strip():
            try:
                text = extract_text_pdfplumber(local_path)
                method = "pdfplumber"
            except Exception as exc:
                logger.warning(f"[{publication_id}] pdfplumber fallback also failed: {exc}")

        has_images = any(page.get_images() for page in doc)

        if not text.strip() and not has_images:
            logger.warning(f"[{publication_id}] No text and no images on any page -- blank/empty document.")
            return DocumentProcessingResult(
                publication_id, pdf_url, DocumentStatus.EMPTY.value,
                local_path=str(local_path), file_size_bytes=len(raw_bytes),
                page_count=doc.page_count, document_hash=document_hash,
            )

        scanned = is_likely_scanned(text, doc.page_count)

        if scanned:
            if ocr_available:
                logger.info(f"[{publication_id}] Detected as scanned -- running OCR.")
                ocr_text = ocr_extract(doc)
                text_path = documents_dir / f"{publication_id}.txt"
                text_path.write_text(ocr_text, encoding="utf-8")
                logger.info(f"[{publication_id}] OCR complete: {len(ocr_text)} characters extracted.")
                return DocumentProcessingResult(
                    publication_id, pdf_url, DocumentStatus.OCR_SUCCESS.value,
                    local_path=str(local_path), file_size_bytes=len(raw_bytes), page_count=doc.page_count,
                    extraction_method="ocr", is_scanned=True, text_char_count=len(ocr_text),
                    text_path=str(text_path), document_hash=document_hash,
                )
            logger.warning(f"[{publication_id}] Detected as scanned, but OCR is unavailable in this environment.")
            return DocumentProcessingResult(
                publication_id, pdf_url, DocumentStatus.NEEDS_OCR.value,
                local_path=str(local_path), file_size_bytes=len(raw_bytes), page_count=doc.page_count,
                is_scanned=True, document_hash=document_hash,
                error="Scanned document; Tesseract OCR binary not available in this environment.",
            )

        text_path = documents_dir / f"{publication_id}.txt"
        text_path.write_text(text, encoding="utf-8")
        logger.info(f"[{publication_id}] Text extracted via {method}: {len(text)} characters.")
        return DocumentProcessingResult(
            publication_id, pdf_url, DocumentStatus.SUCCESS.value,
            local_path=str(local_path), file_size_bytes=len(raw_bytes), page_count=doc.page_count,
            extraction_method=method, is_scanned=False, text_char_count=len(text),
            text_path=str(text_path), document_hash=document_hash,
        )
    except Exception as exc:
        logger.error(f"[{publication_id}] Unexpected error during processing: {exc.__class__.__name__}: {exc}")
        return DocumentProcessingResult(
            publication_id, pdf_url, DocumentStatus.FAILED.value,
            local_path=str(local_path), file_size_bytes=len(raw_bytes),
            document_hash=document_hash, error=str(exc),
        )
    finally:
        if doc is not None:
            doc.close()
