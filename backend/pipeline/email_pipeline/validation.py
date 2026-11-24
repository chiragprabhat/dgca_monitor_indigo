"""Confirms every element that should be in the email actually landed in the
rendered HTML before anything is sent."""
import logging
from dataclasses import dataclass, field
from typing import List

from .models import DGCAUpdate

logger = logging.getLogger(__name__)


@dataclass
class EmailValidationResult:
    is_valid: bool
    checked: List[str] = field(default_factory=list)
    missing: List[str] = field(default_factory=list)


def validate_email_html(html_body: str, update: DGCAUpdate, ai_summary: str) -> EmailValidationResult:
    checks = {
        "Publication title": update.title in html_body,
        "Category": update.category in html_body,
        "Published date": update.published_date in html_body,
        "Executive summary": bool(ai_summary.strip()) and ai_summary in html_body,
        "Impact level": update.impact_level in html_body,
        "DGCA publication link": bool(update.dgca_url) and update.dgca_url in html_body,
        "PDF link": bool(update.pdf_url) and update.pdf_url in html_body,
    }
    for i, change in enumerate(update.key_changes, start=1):
        checks[f"Key change #{i}"] = change in html_body
    for i, dept in enumerate(update.impacted_departments, start=1):
        checks[f"Impacted department #{i}"] = dept in html_body
    for i, action in enumerate(update.recommended_actions, start=1):
        checks[f"Recommended action #{i}"] = action in html_body

    # Phase 11: for an UPDATED publication, confirm the comparison block
    # actually rendered -- these fields are meaningless (and correctly
    # absent) for a NEW publication, so only checked when update.is_update.
    if update.is_update:
        checks["Overall change level"] = bool(update.overall_change_level) and update.overall_change_level in html_body
        if update.previous_title:
            checks["Previous version title"] = update.previous_title in html_body
        for i, item in enumerate(update.added_changes, start=1):
            checks[f"Added change #{i}"] = item in html_body
        for i, item in enumerate(update.removed_changes, start=1):
            checks[f"Removed change #{i}"] = item in html_body
        for i, item in enumerate(update.modified_changes, start=1):
            checks[f"Modified change #{i}"] = item in html_body
        if update.comparison_explanation:
            checks["Comparison AI explanation"] = update.comparison_explanation in html_body

    checked = list(checks.keys())
    missing = [name for name, present in checks.items() if not present]
    result = EmailValidationResult(is_valid=(len(missing) == 0), checked=checked, missing=missing)

    if result.is_valid:
        logger.info(f"Email validation PASSED: all {len(checked)} required elements present.")
    else:
        logger.error(f"Email validation FAILED: missing {missing}")
    return result
