"""Best-effort regex heuristics used by the deterministic analysis (the LLM
providers extract these properly)."""
import re

_EFFECTIVE_DATE_RE = re.compile(r"effective[:\s]+([^.\n]{2,40})", re.IGNORECASE)


def extract_effective_date_hint(normalized_text: str) -> str:
    match = _EFFECTIVE_DATE_RE.search(normalized_text)
    if match:
        candidate = match.group(1).strip().rstrip(".,;: ")
        if candidate:
            return candidate[:60]
    return "Not specified in the publication."
