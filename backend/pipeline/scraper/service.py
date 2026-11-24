"""Runs every category source independently, so one failing or changed
category never aborts the run."""
import logging
from typing import List, Optional

import requests

from .models import ScrapeRunResult
from .sources import DEFAULT_SOURCES, CategorySource

logger = logging.getLogger(__name__)


def scrape_whats_new(session: requests.Session, sources: Optional[List[CategorySource]] = None) -> ScrapeRunResult:
    result = ScrapeRunResult()

    for source in (sources if sources is not None else DEFAULT_SOURCES):
        try:
            items = source.fetch(session)
            result.category_counts[source.category] = len(items)
            result.publications.extend(items)
        except Exception as exc:
            logger.error(f"[{source.category}] Unexpected error, skipping category: {exc.__class__.__name__}: {exc}")
            result.failed_categories.append(source.category)

    logger.info(
        f"Scrape complete: {len(result.publications)} total publication(s), "
        f"by category: {result.category_counts}, failed: {result.failed_categories or 'none'}"
    )
    return result
