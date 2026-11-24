"""OpenAI provider. Available, but not the default and never executed unless
LLM_PROVIDER=openai is configured. Without a real key it returns the
deterministic analysis before any OpenAI client is constructed, so selecting
it never reaches the network layer by accident."""
import json
import logging
from typing import Optional

from ...comparison import ComparisonResult, normalize_for_diff
from ...config import OpenAISettings
from ..models import AIAnalysisResult
from ..prompt import (
    ANALYSIS_SYSTEM_PROMPT,
    MAX_TEXT_CHARS_FOR_PROMPT,
    build_analysis_prompt,
    build_comparison_block,
)
from .base import AnalysisProvider
from .fallback import deterministic_analysis

logger = logging.getLogger(__name__)


def _try_openai_analysis(row, extracted_text: str, comparison: Optional[ComparisonResult], config) -> AIAnalysisResult:
    pub_id = row["publication_id"]
    try:
        from openai import OpenAI
        openai_sdk_available = True
    except ImportError:
        openai_sdk_available = False

    if not (openai_sdk_available and config.openai_configured()):
        logger.warning(f"[{pub_id}] LLM_PROVIDER=openai but OPENAI_API_KEY not configured -- using deterministic fallback analysis.")
        return deterministic_analysis(row, extracted_text, comparison)

    normalized = normalize_for_diff(extracted_text)[:MAX_TEXT_CHARS_FOR_PROMPT]
    comparison_block = build_comparison_block(comparison)
    prompt = build_analysis_prompt(row, normalized, comparison_block)

    try:
        client = OpenAI(api_key=config.openai_api_key)
        response = client.chat.completions.create(
            model=config.llm_model,
            messages=[
                {"role": "system", "content": ANALYSIS_SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
            temperature=0.3,
            response_format={"type": "json_object"},
        )
        parsed = json.loads(response.choices[0].message.content)
        parsed["analysis_mode"] = "ai-openai"
        result = AIAnalysisResult(**parsed)
        logger.info(f"[{pub_id}] AI analysis generated via OpenAI model '{config.llm_model}'.")
        return result
    except Exception as exc:
        logger.error(f"[{pub_id}] OpenAI analysis generation failed ({exc.__class__.__name__}). Falling back to deterministic analysis.")
        return deterministic_analysis(row, extracted_text, comparison)


class OpenAIAnalysisProvider(AnalysisProvider):
    name = "openai"

    def analyze(self, row, extracted_text: str, comparison: Optional[ComparisonResult], config: OpenAISettings) -> Optional[AIAnalysisResult]:
        return _try_openai_analysis(row, extracted_text, comparison, config)
