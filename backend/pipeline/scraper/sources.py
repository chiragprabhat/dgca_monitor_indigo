"""
One source per kind of "What's New" category.

Regulation / Guidance / Announcement come from the portal's JSON API;
Tenders are server-rendered HTML on the homepage. `CategorySource` is the
extension point: supporting a new category or a changed page means adding a
subclass and listing it in `DEFAULT_SOURCES` -- `scrape_whats_new()` never
changes. See notebooks/02_DGCA_Website_Monitor.ipynb's "Website Inspection
Findings" for why no browser automation is needed.
"""
import logging
import re
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import List

import requests
from bs4 import BeautifulSoup

from .constants import AJAX_CATEGORIES, BASE_URL, REQUEST_TIMEOUT_SECONDS, SCAN_URL
from .models import DGCAPublication
from .parsing import build_pdf_url, make_source_id, normalize_date

logger = logging.getLogger(__name__)


def fetch_ajax_category(session: requests.Session, classification: str) -> List[DGCAPublication]:
    params = {
        "baseLocale": "en_US",
        "requestType": "ApplicationRH",
        "actionVal": "viewAllServiceForAJAX",
        "screenId": "10000001",
        "classification": classification,
    }
    try:
        resp = session.post(SCAN_URL, params=params, timeout=REQUEST_TIMEOUT_SECONDS)
        resp.raise_for_status()
        resp.encoding = "utf-8"
        data = resp.json()
    except requests.RequestException as exc:
        logger.error(f"[{classification}] Network/HTTP error while fetching: {exc.__class__.__name__}: {exc}")
        return []
    except ValueError as exc:
        logger.error(f"[{classification}] Response was not valid JSON (site may have changed): {exc}")
        return []

    contents = data.get("contents", [])
    dates = data.get("startDate", [])
    attach_ids = data.get("attachId", [])

    if not contents:
        logger.info(f"[{classification}] No publications returned (0 records).")
        return []

    lengths = {len(contents), len(dates), len(attach_ids)}
    if len(lengths) > 1:
        logger.warning(
            f"[{classification}] Parallel arrays have mismatched lengths "
            f"(contents={len(contents)}, startDate={len(dates)}, attachId={len(attach_ids)}); "
            "truncating to the shortest to stay safe."
        )
    n = min(lengths) if lengths else 0

    now = datetime.now(timezone.utc).isoformat()
    publications = []
    for i in range(n):
        attach_id = attach_ids[i]
        publications.append(
            DGCAPublication(
                source_id=make_source_id(classification, attach_id),
                title=contents[i].strip(),
                category=classification,
                published_date=normalize_date(dates[i]),
                published_date_raw=dates[i],
                publication_url=BASE_URL,
                pdf_url=build_pdf_url(attach_id),
                scraped_at=now,
            )
        )

    logger.info(f"[{classification}] {len(publications)} publication(s) parsed.")
    return publications


ATTACH_ID_RE = re.compile(r"pdfDownload\('([^']+)'")
DATE_SIZE_RE = re.compile(r"([0-9]{2}\.[0-9]{2}\.[0-9]{4})")


def fetch_tenders(session: requests.Session) -> List[DGCAPublication]:
    try:
        resp = session.get(BASE_URL, timeout=REQUEST_TIMEOUT_SECONDS)
        resp.raise_for_status()
    except requests.RequestException as exc:
        logger.error(f"[Tender] Network/HTTP error while fetching homepage: {exc.__class__.__name__}: {exc}")
        return []

    soup = BeautifulSoup(resp.text, "html.parser")
    container = soup.find(id="tenders")
    if container is None:
        logger.error("[Tender] Could not find #tenders section -- page structure may have changed.")
        return []

    blocks = container.select(".new-window-pdf")
    if not blocks:
        logger.info("[Tender] No tender entries found (0 records).")
        return []

    now = datetime.now(timezone.utc).isoformat()
    publications: List[DGCAPublication] = []
    for block in blocks:
        heading_link = block.select_one(".sub-heading a")
        content_p = block.select_one(".sub-content")
        if heading_link is None or content_p is None:
            logger.warning("[Tender] Skipping a block missing expected .sub-heading/.sub-content.")
            continue

        title = heading_link.get_text(strip=True)
        onclick = heading_link.get("onclick", "") or ""
        match = ATTACH_ID_RE.search(onclick)
        if not match:
            logger.warning(f"[Tender] Skipping '{title[:50]}...' -- could not extract attachId from onclick.")
            continue
        attach_id = match.group(1)

        content_text = content_p.get_text(" ", strip=True)
        date_match = DATE_SIZE_RE.search(content_text)
        date_raw = date_match.group(1) if date_match else ""
        if not date_match:
            logger.warning(f"[Tender] No date found for '{title[:50]}...'; leaving published_date unset.")

        publications.append(
            DGCAPublication(
                source_id=make_source_id("Tender", attach_id),
                title=title,
                category="Tender",
                published_date=normalize_date(date_raw) if date_raw else None,
                published_date_raw=date_raw,
                publication_url=BASE_URL,
                pdf_url=build_pdf_url(attach_id),
                scraped_at=now,
            )
        )

    logger.info(f"[Tender] {len(publications)} publication(s) parsed.")
    return publications


class CategorySource(ABC):
    """Fetches the current publications of one "What's New" category."""

    category: str

    @abstractmethod
    def fetch(self, session: requests.Session) -> List[DGCAPublication]:
        raise NotImplementedError


class AjaxCategorySource(CategorySource):
    def __init__(self, category: str):
        self.category = category

    def fetch(self, session: requests.Session) -> List[DGCAPublication]:
        return fetch_ajax_category(session, self.category)


class TenderSource(CategorySource):
    category = "Tender"

    def fetch(self, session: requests.Session) -> List[DGCAPublication]:
        return fetch_tenders(session)


DEFAULT_SOURCES: List[CategorySource] = (
    [AjaxCategorySource(c) for c in AJAX_CATEGORIES] + [TenderSource()]
)
