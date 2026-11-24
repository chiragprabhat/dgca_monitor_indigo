from typing import List

from pydantic import BaseModel, Field


class ComparisonResult(BaseModel):
    overall_change_level: str = "NONE"  # NONE | LOW | MEDIUM | HIGH
    total_changes: int = 0
    added: List[str] = Field(default_factory=list)
    removed: List[str] = Field(default_factory=list)
    modified: List[str] = Field(default_factory=list)
    key_changes: List[str] = Field(default_factory=list)
    effective_date: str = "Not specified in the publication."
    operational_impact: str = "Not specified in the publication."
    impacted_departments: List[str] = Field(default_factory=list)
    recommended_actions: List[str] = Field(default_factory=list)
