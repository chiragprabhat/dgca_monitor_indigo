"""Text extraction from a text-based PDF, and the scanned-document
heuristic (average characters per page)."""
from pathlib import Path

import pdfplumber
import pymupdf

SCANNED_CHARS_PER_PAGE_THRESHOLD = 20


def extract_text_pymupdf(doc: "pymupdf.Document") -> str:
    return "\n".join(page.get_text() for page in doc)


def extract_text_pdfplumber(path: Path) -> str:
    text_parts = []
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            text_parts.append(page.extract_text() or "")
    return "\n".join(text_parts)


def is_likely_scanned(text: str, page_count: int) -> bool:
    if page_count == 0:
        return False
    avg_chars_per_page = len(text.strip()) / page_count
    return avg_chars_per_page < SCANNED_CHARS_PER_PAGE_THRESHOLD
