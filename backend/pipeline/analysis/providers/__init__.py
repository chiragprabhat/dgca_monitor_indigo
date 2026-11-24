"""
Analysis providers and their registry.

Providers are looked up by name (`LLM_PROVIDER`). Adding one means writing an
`AnalysisProvider` subclass and calling `register_provider()` -- the dispatcher
in analysis/service.py never changes.
"""
from typing import Dict, Optional

from .base import AnalysisProvider
from .fallback import FallbackAnalysisProvider, deterministic_analysis
from .ollama import OLLAMA_TIMEOUT_SECONDS, OllamaAnalysisProvider, check_ollama_available
from .openai_provider import OpenAIAnalysisProvider

_REGISTRY: Dict[str, AnalysisProvider] = {}


def register_provider(provider: AnalysisProvider) -> None:
    _REGISTRY[provider.name] = provider


def get_provider(name: str) -> Optional[AnalysisProvider]:
    return _REGISTRY.get(name)


for _provider in (OllamaAnalysisProvider(), OpenAIAnalysisProvider(), FallbackAnalysisProvider()):
    register_provider(_provider)

__all__ = [
    "OLLAMA_TIMEOUT_SECONDS", "AnalysisProvider", "FallbackAnalysisProvider", "OllamaAnalysisProvider",
    "OpenAIAnalysisProvider", "check_ollama_available", "deterministic_analysis", "get_provider",
    "register_provider",
]
