"""Data shapes produced by a scrape."""
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import List, Optional

from pydantic import BaseModel

from .constants import BASE_URL


class DGCAPublication(BaseModel):
    source_id: str
    title: str
    category: str
    published_date: Optional[str] = None
    published_date_raw: str = ""
    publication_url: str = BASE_URL
    pdf_url: Optional[str] = None
    file_size_bytes: Optional[int] = None
    file_type: Optional[str] = None
    scraped_at: str = ""


@dataclass
class ScrapeRunResult:
    publications: List[DGCAPublication] = field(default_factory=list)
    category_counts: dict = field(default_factory=dict)
    failed_categories: List[str] = field(default_factory=list)
    started_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
