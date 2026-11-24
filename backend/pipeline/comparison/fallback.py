"""Deterministic comparison built straight from the diff: used whenever no
LLM is configured or an LLM call fails. Same ComparisonResult schema, never
invents requirements."""
from typing import List

from .models import ComparisonResult
from .text_diff import DiffResult


def fallback_comparison(diff: DiffResult) -> ComparisonResult:
    total = len(diff.added) + len(diff.removed) + len(diff.modified)
    if total == 0:
        level = "NONE"
    elif total <= 2:
        level = "LOW"
    elif total <= 6:
        level = "MEDIUM"
    else:
        level = "HIGH"

    key_changes: List[str] = []
    for item in diff.added[:5]:
        key_changes.append(f"Added: {item}")
    for item in diff.removed[:5]:
        key_changes.append(f"Removed: {item}")
    for old, new in diff.modified[:5]:
        key_changes.append(f"Modified: '{old}' -> '{new}'")

    operational_impact = (
        "Not specified in the publication." if total == 0
        else f"{total} textual change(s) detected between the two versions; manual review recommended to assess operational impact."
    )
    recommended_actions = [] if total == 0 else ["Review the highlighted changes above against current procedures."]

    return ComparisonResult(
        overall_change_level=level,
        total_changes=total,
        added=list(diff.added),
        removed=list(diff.removed),
        modified=[f"{o} -> {n}" for o, n in diff.modified],
        key_changes=key_changes,
        effective_date="Not specified in the publication.",
        operational_impact=operational_impact,
        impacted_departments=[],
        recommended_actions=recommended_actions,
    )
