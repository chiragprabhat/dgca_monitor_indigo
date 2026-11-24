from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import List, Optional


@dataclass
class PublicationPipelineResult:
    publication_id: str
    title: str = ""
    category: str = ""
    published_date: str = ""
    status: str = "unknown"  # "success" | "skipped_unchanged" | "failed"
    outcome: str = "unknown"  # "new" | "updated" | "unchanged" | "failed" (Phase 10 addition)
    stage: str = "start"
    comparison_status: str = "not applicable"
    impact_level: str = ""
    analysis_mode: str = ""  # "ai-local" | "ai-openai" | "fallback" | "degraded" (Phase 10 addition)
    summary: str = ""
    email_provider: str = ""
    email_success: bool = False
    error: Optional[str] = None
    stages_completed: List[str] = field(default_factory=list)


@dataclass
class PipelineRunSummary:
    total: int = 0
    success: int = 0
    skipped_unchanged: int = 0
    failed: int = 0
    results: List[PublicationPipelineResult] = field(default_factory=list)
    started_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
