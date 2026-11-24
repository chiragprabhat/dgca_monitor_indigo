import unittest

from pipeline import analysis
from pipeline.analysis import AIAnalysisResult, AnalysisProvider, register_provider

from .helpers import make_config

ROW = {"publication_id": "p1", "title": "T", "category": "Regulation", "published_date": "2026-01-01"}
TEXT = "EFFECTIVE: 01 January 2026 for all operators. Operators shall keep records."


class _Canned(AnalysisProvider):
    name = "canned"

    def analyze(self, row, extracted_text, comparison, config):
        return AIAnalysisResult(summary="canned", analysis_mode="ai-canned")


class _Declines(AnalysisProvider):
    name = "declines"

    def analyze(self, row, extracted_text, comparison, config):
        return None


class DispatchTests(unittest.TestCase):
    def test_no_text_is_degraded(self):
        result = analysis.generate_ai_analysis(ROW, "", None, make_config())
        self.assertEqual(result.analysis_mode, "degraded")

    def test_fallback_provider_extracts_effective_date(self):
        result = analysis.generate_ai_analysis(ROW, TEXT, None, make_config(llm_provider="fallback"))
        self.assertEqual(result.analysis_mode, "fallback")
        self.assertTrue(result.effective_date.startswith("01 January 2026"))

    def test_unknown_provider_falls_back(self):
        result = analysis.generate_ai_analysis(ROW, TEXT, None, make_config(llm_provider="nonsense"))
        self.assertEqual(result.analysis_mode, "fallback")

    def test_unreachable_ollama_falls_back(self):
        cfg = make_config(llm_provider="local", ollama_base_url="http://127.0.0.1:9")
        self.assertEqual(analysis.generate_ai_analysis(ROW, TEXT, None, cfg).analysis_mode, "fallback")

    def test_openai_without_key_falls_back(self):
        cfg = make_config(llm_provider="openai")
        self.assertEqual(analysis.generate_ai_analysis(ROW, TEXT, None, cfg).analysis_mode, "fallback")

    def test_new_provider_needs_no_dispatcher_change(self):
        register_provider(_Canned())
        result = analysis.generate_ai_analysis(ROW, TEXT, None, make_config(llm_provider="canned"))
        self.assertEqual((result.summary, result.analysis_mode), ("canned", "ai-canned"))

    def test_provider_returning_none_falls_back(self):
        register_provider(_Declines())
        result = analysis.generate_ai_analysis(ROW, TEXT, None, make_config(llm_provider="declines"))
        self.assertEqual(result.analysis_mode, "fallback")


if __name__ == "__main__":
    unittest.main()
