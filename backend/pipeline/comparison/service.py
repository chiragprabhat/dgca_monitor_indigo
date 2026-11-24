"""Compares two versions of a document: diff first, then summarise it with an
LLM when one is configured, else deterministically."""
import logging
from typing import Tuple

from ..config import OpenAISettings
from .fallback import fallback_comparison
from .models import ComparisonResult
from .openai_comparison import try_openai_comparison
from .text_diff import DiffResult, diff_documents

logger = logging.getLogger(__name__)


def generate_ai_comparison(diff: DiffResult, config: OpenAISettings) -> ComparisonResult:
    result = try_openai_comparison(diff, config)
    return result if result is not None else fallback_comparison(diff)


def compare_documents(old_text: str, new_text: str, config: OpenAISettings) -> Tuple[DiffResult, ComparisonResult]:
    diff = diff_documents(old_text, new_text)
    logger.info(
        f"Diff computed: {len(diff.added)} added, {len(diff.removed)} removed, "
        f"{len(diff.modified)} modified, {diff.unchanged_count} unchanged units."
    )
    result = generate_ai_comparison(diff, config)
    return diff, result
