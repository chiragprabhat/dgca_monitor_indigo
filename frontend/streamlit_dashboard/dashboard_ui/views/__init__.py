"""
Page registry. app.py builds the sidebar and dispatches from this list, so
adding a page means writing a `Page` subclass and appending it here -- app.py
does not change.
"""
from typing import List

from .base import Page
from .comparison_demo import ComparisonDemoPage
from .email_previews import EmailPreviewsPage
from .overview import OverviewPage
from .publications import PublicationsPage
from .scheduler_health import SchedulerHealthPage
from .trends import TrendsPage

PAGES: List[Page] = [
    OverviewPage(),
    PublicationsPage(),
    TrendsPage(),
    SchedulerHealthPage(),
    EmailPreviewsPage(),
    ComparisonDemoPage(),
]

__all__ = ["PAGES", "Page"]
