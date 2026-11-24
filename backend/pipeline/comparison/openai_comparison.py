"""Optional OpenAI-backed comparison. Only ever reached when an API key is
configured; returns None (never raises) when it can't produce a result so the
caller falls back to the deterministic comparison."""
import json
import logging
from typing import Optional

from ..config import OpenAISettings
from .models import ComparisonResult
from .text_diff import DiffResult

logger = logging.getLogger(__name__)


def try_openai_comparison(diff: DiffResult, config: OpenAISettings) -> Optional[ComparisonResult]:
    try:
        from openai import OpenAI
        openai_sdk_available = True
    except ImportError:
        openai_sdk_available = False

    if not (openai_sdk_available and config.openai_configured()):
        logger.warning("OPENAI_API_KEY not configured -- using deterministic fallback comparison.")
        return None

    diff_summary = json.dumps(
        {
            "added": diff.added[:30],
            "removed": diff.removed[:30],
            "modified": [{"old": o, "new": n} for o, n in diff.modified[:30]],
        },
        indent=2,
    )
    prompt = (
        "You are a regulatory-change analyst comparing two versions of a DGCA publication.\n"
        "Below is a pre-computed textual diff (added/removed/modified sentences) between the OLD\n"
        "and NEW versions. Using ONLY this diff, produce a JSON object with EXACTLY these keys:\n"
        "overall_change_level (NONE|LOW|MEDIUM|HIGH), total_changes (integer), added (list of strings),\n"
        "removed (list of strings), modified (list of strings), key_changes (list of strings),\n"
        "effective_date (string), operational_impact (string), impacted_departments (list of strings),\n"
        "recommended_actions (list of strings).\n\n"
        "Rules:\n"
        "- Prioritize substantive regulatory/operational changes over formatting differences.\n"
        "- Never invent requirements not present in the diff.\n"
        "- If information is not available, use exactly: \"Not specified in the publication.\"\n\n"
        f"DIFF:\n{diff_summary}\n"
    )
    try:
        client = OpenAI(api_key=config.openai_api_key)
        response = client.chat.completions.create(
            model=config.llm_model,
            messages=[
                {"role": "system", "content": "You produce accurate, structured JSON regulatory change analyses. Output valid JSON only."},
                {"role": "user", "content": prompt},
            ],
            temperature=0.2,
            response_format={"type": "json_object"},
        )
        parsed = json.loads(response.choices[0].message.content)
        result = ComparisonResult(**parsed)
        logger.info(f"AI comparison generated via OpenAI model '{config.llm_model}'.")
        return result
    except Exception as exc:
        logger.error(f"AI comparison generation failed ({exc.__class__.__name__}). Falling back to deterministic comparison.")
        return None
