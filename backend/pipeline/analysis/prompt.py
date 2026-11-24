"""The one prompt every LLM-backed provider (local and OpenAI) shares, so
their instructions -- and therefore their output schema and ground rules --
never drift apart."""
from typing import Optional

from ..comparison import ComparisonResult

MAX_TEXT_CHARS_FOR_PROMPT = 12000

ANALYSIS_SYSTEM_PROMPT = (
    "You produce accurate, structured JSON regulatory analyses for an airline. Output valid JSON only."
)


def build_comparison_block(comparison: Optional[ComparisonResult]) -> str:
    if comparison is not None:
        return comparison.model_dump_json(indent=2)
    return "No previous version on record -- this is a first-time publication."


def build_analysis_prompt(row, normalized_text: str, comparison_block: str) -> str:
    """Shared by every LLM-backed provider (local and OpenAI) so their
    instructions -- and therefore their output schema and ground rules --
    never drift apart."""
    return (
        "You are a regulatory intelligence analyst for an airline. Read the DGCA publication\n"
        "metadata, its extracted text, and (if present) a summary of changes versus its previous\n"
        "version. Answer six questions and return them as a single JSON object with EXACTLY these\n"
        "keys: summary (string -- combine what this publication is about and why it matters),\n"
        "key_changes (list of strings -- what changed), effective_date (string -- when it takes\n"
        "effect), impact_level (one of LOW|MEDIUM|HIGH|CRITICAL), impacted_departments (list of\n"
        "strings -- who is impacted), recommended_actions (list of strings -- what action to\n"
        "consider).\n\n"
        "Rules:\n"
        "- Never invent requirements, dates, departments, or facts that are not present in the\n"
        "  DOCUMENT TEXT or COMPARISON SUMMARY below.\n"
        "- If a specific field (effective date, impacted department, compliance requirement, etc.)\n"
        "  is not stated in the source material, use exactly: \"Not specified in the publication.\"\n"
        "  for string fields, or leave the list empty -- do not guess or infer beyond what is written.\n"
        "- Prioritize substantive regulatory/operational content over formatting differences.\n"
        "- For each entry in key_changes, include a short supporting quote or close paraphrase from\n"
        "  the DOCUMENT TEXT or COMPARISON SUMMARY in parentheses, so the claim is traceable back to\n"
        "  its source -- e.g. \"Duty time record retention extended ('shall maintain records for a\n"
        "  minimum of 24 months').\"\n"
        "- If COMPARISON SUMMARY below states this is a first-time publication (no previous version\n"
        "  on record), do not describe any 'changes' -- describe what the document itself\n"
        "  establishes instead, still grounded in quotes/paraphrases from DOCUMENT TEXT.\n"
        "- Respond with ONLY the JSON object -- no markdown fences, no commentary before or after it.\n\n"
        f"Title: {row['title']}\n"
        f"Category: {row['category']}\n"
        f"Published: {row['published_date']}\n\n"
        f"COMPARISON SUMMARY:\n{comparison_block}\n\n"
        f"DOCUMENT TEXT (may be truncated):\n{normalized_text}\n"
    )
