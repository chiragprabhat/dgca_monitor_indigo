"""OCR for scanned PDFs. Availability-gated, not assumed: pytesseract may be
installed without the separate Tesseract binary, and callers must be able to
tell the difference (scanned documents are classified 'needs_ocr' instead of
being silently dropped or faked as successful)."""
import io
import logging

import pymupdf

logger = logging.getLogger(__name__)

try:
    import pytesseract
    from PIL import Image
    _PYTESSERACT_SDK_AVAILABLE = True
except ImportError:
    _PYTESSERACT_SDK_AVAILABLE = False


def check_ocr_availability() -> bool:
    if not _PYTESSERACT_SDK_AVAILABLE:
        logger.info("pytesseract package not installed -- OCR unavailable.")
        return False
    try:
        version = pytesseract.get_tesseract_version()
        logger.info(f"Tesseract OCR binary found: version {version}")
        return True
    except Exception as exc:
        logger.warning(
            f"pytesseract is installed, but the Tesseract OCR binary is NOT available "
            f"({exc.__class__.__name__}). Scanned documents will be classified 'needs_ocr'."
        )
        return False


def ocr_extract(doc: "pymupdf.Document", dpi: int = 200) -> str:
    text_parts = []
    zoom = dpi / 72
    matrix = pymupdf.Matrix(zoom, zoom)
    for page in doc:
        pix = page.get_pixmap(matrix=matrix)
        img = Image.open(io.BytesIO(pix.tobytes("png")))
        text_parts.append(pytesseract.image_to_string(img))
    return "\n".join(text_parts)
