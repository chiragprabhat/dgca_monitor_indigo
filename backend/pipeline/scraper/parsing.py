"""Pure parsing helpers: no network, no state."""
import logging
import re
from datetime import datetime
from typing import Optional
from urllib.parse import unquote

from .constants import UPLOAD_URL

logger = logging.getLogger(__name__)

_DATE_FORMATS = ("%d/%m/%Y", "%d.%m.%Y")


def normalize_date(raw_date: str) -> Optional[str]:
    cleaned = raw_date.strip()
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(cleaned, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    logger.warning(f"Could not parse date '{raw_date}' with known formats {_DATE_FORMATS}.")
    return None


def make_source_id(category: str, attach_id_encoded: str) -> str:
    decoded = unquote(attach_id_encoded)
    safe = re.sub(r"[^A-Za-z0-9]+", "", decoded)[:24]
    return f"{category.lower()}-{safe}"


def build_pdf_url(attach_id_encoded: str) -> str:
    return f"{UPLOAD_URL}?flag=iframeAttachView&attachId={attach_id_encoded}&baseLocale=en_US"
