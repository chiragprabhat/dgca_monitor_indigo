"""
AI executive analysis.

    models.py      -- AIAnalysisResult
    text_hints.py  -- regex heuristics for the deterministic path
    prompt.py      -- the shared LLM prompt
    providers/     -- AnalysisProvider strategies: local (Ollama), openai, fallback
    service.py     -- generate_ai_analysis(): provider lookup + fallback
"""
from .models import AIAnalysisResult
from .providers import (
    OLLAMA_TIMEOUT_SECONDS,
    AnalysisProvider,
    check_ollama_available,
    deterministic_analysis,
    get_provider,
    register_provider,
)
from .prompt import MAX_TEXT_CHARS_FOR_PROMPT
from .service import generate_ai_analysis
from .text_hints import extract_effective_date_hint

__all__ = [
    "MAX_TEXT_CHARS_FOR_PROMPT", "OLLAMA_TIMEOUT_SECONDS", "AIAnalysisResult", "AnalysisProvider",
    "check_ollama_available", "deterministic_analysis", "extract_effective_date_hint",
    "generate_ai_analysis", "get_provider", "register_provider",
]
