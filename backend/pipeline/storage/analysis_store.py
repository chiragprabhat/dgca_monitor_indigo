"""Persists AI analysis + comparison results onto a publication's row so the
dashboard can read them instantly (a local LLM call takes 60-90s -- far too
slow to run per page view)."""
import json
import logging
from psycopg import Connection
from datetime import datetime, timezone
from typing import Any, Optional

logger = logging.getLogger(__name__)


def save_analysis_result(
    conn: Connection,
    publication_id: str,
    analysis: Any,
    previous_publication_id: Optional[str] = None,
    comparison: Optional[Any] = None,
) -> None:
    """Takes duck-typed objects (an AIAnalysisResult and, if available, a
    ComparisonResult -- both pydantic models) rather than importing those
    types, so storage never depends on the analysis or comparison packages."""
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        """
        UPDATE publications
        SET ai_summary = %s, key_changes_json = %s, effective_date = %s, impact_level = %s,
            impacted_departments_json = %s, recommended_actions_json = %s, analysis_mode = %s,
            previous_publication_id = %s, comparison_summary_json = %s, analyzed_at = %s
        WHERE publication_id = %s
        """,
        (
            analysis.summary,
            json.dumps(analysis.key_changes),
            analysis.effective_date,
            analysis.impact_level,
            json.dumps(analysis.impacted_departments),
            json.dumps(analysis.recommended_actions),
            analysis.analysis_mode,
            previous_publication_id,
            comparison.model_dump_json() if comparison is not None else None,
            now,
            publication_id,
        ),
    )
    logger.info(f"[analysis-saved] {publication_id} (mode={analysis.analysis_mode})")
