"""
DGCA "What's New" scraper.

    constants.py  -- endpoints, request settings, category lists
    models.py     -- DGCAPublication, ScrapeRunResult
    parsing.py    -- date / id / PDF-url helpers (pure functions)
    session.py    -- HTTP session with cookies + English locale
    sources.py    -- CategorySource strategies (JSON API categories, Tenders HTML)
    service.py    -- scrape_whats_new(): runs every source, isolating failures
"""
from .constants import (
    AJAX_CATEGORIES,
    ALL_CATEGORIES,
    BASE_URL,
    HTML_CATEGORIES,
    REQUEST_TIMEOUT_SECONDS,
    SCAN_URL,
    UPLOAD_URL,
    USER_AGENT,
)
from .models import DGCAPublication, ScrapeRunResult
from .parsing import build_pdf_url, make_source_id, normalize_date
from .service import scrape_whats_new
from .session import get_dgca_session
from .sources import (
    DEFAULT_SOURCES,
    AjaxCategorySource,
    CategorySource,
    TenderSource,
    fetch_ajax_category,
    fetch_tenders,
)

__all__ = [
    "AJAX_CATEGORIES", "ALL_CATEGORIES", "BASE_URL", "DEFAULT_SOURCES", "HTML_CATEGORIES",
    "REQUEST_TIMEOUT_SECONDS", "SCAN_URL", "UPLOAD_URL", "USER_AGENT",
    "AjaxCategorySource", "CategorySource", "DGCAPublication", "ScrapeRunResult", "TenderSource",
    "build_pdf_url", "fetch_ajax_category", "fetch_tenders", "get_dgca_session",
    "make_source_id", "normalize_date", "scrape_whats_new",
]
