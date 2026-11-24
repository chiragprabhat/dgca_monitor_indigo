"""
Old-vs-new comparison.

    text_diff.py          -- normalize + sentence-level diff
    versioning.py         -- previous-version matching by title similarity
    models.py             -- ComparisonResult
    fallback.py           -- deterministic ComparisonResult from a diff
    openai_comparison.py  -- optional OpenAI summary of a diff
    service.py            -- compare_documents(): diff + summary
"""
from .fallback import fallback_comparison
from .models import ComparisonResult
from .service import compare_documents, generate_ai_comparison
from .text_diff import DiffResult, diff_documents, normalize_for_diff, split_into_units
from .versioning import find_previous_version, normalize_title_for_matching, titles_likely_same_document

__all__ = [
    "ComparisonResult", "DiffResult", "compare_documents", "diff_documents", "fallback_comparison",
    "find_previous_version", "generate_ai_comparison", "normalize_for_diff",
    "normalize_title_for_matching", "split_into_units", "titles_likely_same_document",
]
