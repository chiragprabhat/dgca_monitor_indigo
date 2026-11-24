from typing import List

from pydantic import BaseModel, Field


class AIAnalysisResult(BaseModel):
    summary: str
    key_changes: List[str] = Field(default_factory=list)
    effective_date: str = "Not specified in the publication."
    impact_level: str = "MEDIUM"  # LOW | MEDIUM | HIGH | CRITICAL
    impacted_departments: List[str] = Field(default_factory=list)
    recommended_actions: List[str] = Field(default_factory=list)
    analysis_mode: str = "fallback"  # "ai-local" | "ai-openai" | "fallback" | "degraded"
