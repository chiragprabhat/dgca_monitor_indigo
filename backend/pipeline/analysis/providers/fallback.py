"""Deterministic analysis: no LLM, never raises, never invents data. The last
resort for every other provider."""
import logging
from typing import Optional

from ...comparison import ComparisonResult, normalize_for_diff
from ..models import AIAnalysisResult
from ..text_hints import extract_effective_date_hint
from .base import AnalysisProvider

logger = logging.getLogger(__name__)


def deterministic_analysis(row, extracted_text: Optional[str], comparison: Optional[ComparisonResult]) -> AIAnalysisResult:
    title, category = row["title"], row["category"]
    has_text = bool(extracted_text and extracted_text.strip())

    if not has_text:
        return AIAnalysisResult(
            summary=(
                f"{title} ({category}). Automated text extraction was not available for this "
                "document (see Phase 4 processing status); manual review of the PDF is required "
                "before an executive summary can be generated."
            ),
            key_changes=[],
            effective_date="Not specified in the publication.",
            impact_level="MEDIUM",
            impacted_departments=[],
            recommended_actions=["Manually review the source PDF -- automated text extraction was unavailable."],
            analysis_mode="degraded",
        )

    normalized = normalize_for_diff(extracted_text)
    preview = normalized[:400]
    effective_date = extract_effective_date_hint(normalized)

    if comparison is not None and comparison.total_changes > 0:
        what_changed = (
            f"{comparison.total_changes} change(s) identified relative to the previous version "
            f"(change level: {comparison.overall_change_level})."
        )
        key_changes = comparison.key_changes
        impact_level = comparison.overall_change_level if comparison.overall_change_level in ("LOW", "MEDIUM", "HIGH") else "MEDIUM"
        recommended_actions = ["Review the specific changes identified above against current procedures."]
    elif comparison is not None:
        what_changed = "No substantive changes detected relative to the previous version."
        key_changes = []
        impact_level = "LOW"
        recommended_actions = []
    else:
        what_changed = "No previous version is on record; this appears to be a first-time publication."
        key_changes = []
        impact_level = "MEDIUM"
        recommended_actions = ["Review full document content for detailed compliance requirements."]

    summary = f"{title} ({category}). {what_changed} Content preview: {preview}..."

    return AIAnalysisResult(
        summary=summary,
        key_changes=key_changes,
        effective_date=effective_date,
        impact_level=impact_level,
        impacted_departments=[],
        recommended_actions=recommended_actions,
        analysis_mode="fallback",
    )


class FallbackAnalysisProvider(AnalysisProvider):
    name = "fallback"

    def analyze(self, row, extracted_text, comparison, config) -> Optional[AIAnalysisResult]:
        logger.info(f"[{row['publication_id']}] LLM_PROVIDER=fallback -- using deterministic analysis by configuration.")
        return deterministic_analysis(row, extracted_text, comparison)
