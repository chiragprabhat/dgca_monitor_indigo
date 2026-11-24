"""Turns stored/analysed data into the email: the DGCAUpdate the template
consumes, and the subject line."""
from psycopg.rows import DictRow
from typing import Optional

from ..analysis import AIAnalysisResult
from ..comparison import ComparisonResult
from ..email_pipeline import DGCAUpdate


def build_dgca_update(
    row: DictRow,
    result: AIAnalysisResult,
    previous_title: Optional[str] = None,
    comparison_result: Optional[ComparisonResult] = None,
) -> DGCAUpdate:
    """Builds the DGCAUpdate that email_pipeline.render_email_html() consumes.
    Phase 11 addition: when a previous version's title + a real comparison
    are supplied (i.e. this publication is a genuine content update, not a
    first-time publication -- covers both an in-place same-ID update and a
    cross-ID title-matched revision, see process_single_publication()), the
    UPDATED-publication comparison fields are populated too --
    render_email_html() only shows that block when is_update is True, so a
    NEW publication's email is completely unaffected."""
    is_update = previous_title is not None and comparison_result is not None
    return DGCAUpdate(
        title=row["title"],
        category=row["category"],
        published_date=row["published_date"] or "Not specified in the publication.",
        summary=result.summary,
        key_changes=result.key_changes,
        effective_date=result.effective_date,
        impact_level=result.impact_level,
        impacted_departments=result.impacted_departments,
        recommended_actions=result.recommended_actions,
        dgca_url=row["publication_url"],
        pdf_url=row["pdf_url"],
        is_update=is_update,
        previous_title=previous_title,
        overall_change_level=comparison_result.overall_change_level if comparison_result is not None else None,
        added_changes=comparison_result.added if comparison_result is not None else [],
        removed_changes=comparison_result.removed if comparison_result is not None else [],
        modified_changes=comparison_result.modified if comparison_result is not None else [],
        comparison_explanation=comparison_result.operational_impact if comparison_result is not None else None,
    )


def build_email_subject(update: DGCAUpdate) -> str:
    """[DGCA][NEW][<CATEGORY>] New <Category> Published -- <title>, or
    [DGCA][UPDATED][<CATEGORY>] <Category> Updated -- <title>. Driven by
    update.is_update (set in build_dgca_update() -- True exactly when a
    previous version + real comparison were found) so the subject line and
    the email body's UPDATED-publication block always agree: never a "NEW"
    subject on an email that shows a version comparison, or vice versa.
    Category is always the publication's real category -- never hardcoded."""
    category_tag = (update.category or "General").upper()
    if update.is_update:
        return f"[DGCA][UPDATED][{category_tag}] {update.category} Updated — {update.title}"
    return f"[DGCA][NEW][{category_tag}] New {update.category} Published — {update.title}"
