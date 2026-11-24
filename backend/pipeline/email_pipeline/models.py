import re
from typing import List, Optional

from pydantic import BaseModel, Field


class DGCAUpdate(BaseModel):
    """Structured representation of a single DGCA publication update."""

    title: str
    category: str
    published_date: str
    summary: str
    key_changes: List[str] = Field(default_factory=list)
    effective_date: str = "Not specified in the publication."
    impact_level: str = "MEDIUM"  # LOW | MEDIUM | HIGH | CRITICAL
    impacted_departments: List[str] = Field(default_factory=list)
    recommended_actions: List[str] = Field(default_factory=list)
    dgca_url: Optional[str] = None
    pdf_url: Optional[str] = None

    # Phase 11: populated only for genuinely UPDATED publications (outcome
    # == "updated" with a matched previous version) -- render_email_html()
    # shows the "UPDATED PUBLICATION" comparison block only when is_update
    # is True, so a NEW-publication email is completely unaffected.
    is_update: bool = False
    previous_title: Optional[str] = None
    overall_change_level: Optional[str] = None
    added_changes: List[str] = Field(default_factory=list)
    removed_changes: List[str] = Field(default_factory=list)
    modified_changes: List[str] = Field(default_factory=list)
    comparison_explanation: Optional[str] = None

    def slug(self) -> str:
        s = re.sub(r"[^a-z0-9]+", "-", self.title.lower()).strip("-")
        return s[:60] or "dgca-update"


IMPACT_COLORS = {
    "LOW": "#15803d",
    "MEDIUM": "#b45309",
    "HIGH": "#b91c1c",
    "CRITICAL": "#7f1d1d",
}
