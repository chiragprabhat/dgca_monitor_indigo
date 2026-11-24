"""
The one function every other stage calls: pick the configured provider, and
end up at the deterministic analysis whenever that provider can't deliver --
never raises, never silently invents data.
"""
import logging
from typing import Optional

from ..comparison import ComparisonResult
from .models import AIAnalysisResult
from .providers import deterministic_analysis, get_provider

logger = logging.getLogger(__name__)


def generate_ai_analysis(row, extracted_text: Optional[str], comparison: Optional[ComparisonResult], config) -> AIAnalysisResult:
    pub_id = row["publication_id"]
    has_text = bool(extracted_text and extracted_text.strip())

    if not has_text:
        logger.warning(f"[{pub_id}] No extracted text available -- using degraded fallback.")
        return deterministic_analysis(row, extracted_text, comparison)

    provider_name = getattr(config, "llm_provider", "local").strip().lower()
    provider = get_provider(provider_name)

    if provider is None:
        logger.warning(f"[{pub_id}] Unknown LLM_PROVIDER '{provider_name}' -- using deterministic fallback analysis.")
        return deterministic_analysis(row, extracted_text, comparison)

    result = provider.analyze(row, extracted_text, comparison, config)
    if result is not None:
        return result
    return deterministic_analysis(row, extracted_text, comparison)
