from abc import ABC, abstractmethod
from typing import Optional

from ...comparison import ComparisonResult
from ..models import AIAnalysisResult


class AnalysisProvider(ABC):
    """One way of producing an AIAnalysisResult.

    `analyze()` returns None (and logs why) when the provider cannot produce a
    result; the dispatcher then uses the deterministic analysis. Providers
    must never raise -- a failing LLM must not fail the pipeline."""

    name: str

    @abstractmethod
    def analyze(
        self, row, extracted_text: str, comparison: Optional[ComparisonResult], config
    ) -> Optional[AIAnalysisResult]:
        raise NotImplementedError
