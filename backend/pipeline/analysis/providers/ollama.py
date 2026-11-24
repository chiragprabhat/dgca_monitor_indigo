"""Local LLM via Ollama (the default provider). Ollama's model runner
occasionally crashes mid-request under JSON-grammar-constrained decoding and
returns an empty body; the retry delay is sized to survive its respawn."""
import json
import logging
from typing import Optional

import requests

from ...comparison import ComparisonResult, normalize_for_diff
from ...config import OllamaSettings
from ...utils import retry_with_backoff
from ..models import AIAnalysisResult
from ..prompt import (
    ANALYSIS_SYSTEM_PROMPT,
    MAX_TEXT_CHARS_FOR_PROMPT,
    build_analysis_prompt,
    build_comparison_block,
)
from .base import AnalysisProvider

logger = logging.getLogger(__name__)

OLLAMA_TIMEOUT_SECONDS = 180


def check_ollama_available(base_url: str) -> bool:
    """True if the Ollama service is reachable at all. Never raises."""
    try:
        resp = requests.get(f"{base_url}/api/version", timeout=5)
        return resp.status_code == 200
    except requests.RequestException:
        return False


def _call_ollama_once(prompt: str, base_url: str, model: str) -> dict:
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": ANALYSIS_SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
        "format": "json",
        "stream": False,
        "options": {"temperature": 0.3},
    }
    resp = requests.post(f"{base_url}/api/chat", json=payload, timeout=OLLAMA_TIMEOUT_SECONDS)
    resp.raise_for_status()
    data = resp.json()
    content = data.get("message", {}).get("content", "")
    if not content.strip():
        # Observed occasionally: Ollama returns HTTP 200 with an empty/stub
        # message body (done: false, blank content) -- a transient hiccup,
        # not a real incompatibility (a retried call succeeds). Treat it as
        # a failure so retry_with_backoff retries it.
        raise ValueError("Ollama returned an empty response body.")
    return json.loads(content)


def _generate_via_ollama(prompt: str, base_url: str, model: str) -> dict:
    """Calls Ollama's /api/chat with JSON-mode enabled, retrying on the
    occasional transient empty-response/model-runner-crash hiccup observed
    in testing (Ollama respawns the crashed runner automatically, but that
    takes several seconds to reload the model -- base_delay is set high
    enough to give it that time). Raises on final failure -- the caller
    (_try_local_analysis) is responsible for catching it and falling back."""
    return retry_with_backoff(
        lambda: _call_ollama_once(prompt, base_url, model),
        max_attempts=3,
        base_delay=10.0,
    )


def _try_local_analysis(row, extracted_text: str, comparison: Optional[ComparisonResult], config) -> Optional[AIAnalysisResult]:
    """Returns None (never raises) on any failure, so the dispatcher can
    fall back to the deterministic analysis and log that it happened."""
    pub_id = row["publication_id"]
    base_url = config.ollama_base_url
    model = config.ollama_model

    if not check_ollama_available(base_url):
        logger.warning(f"[{pub_id}] Ollama service not reachable at {base_url}.")
        return None

    try:
        normalized = normalize_for_diff(extracted_text)[:MAX_TEXT_CHARS_FOR_PROMPT]
        comparison_block = build_comparison_block(comparison)
        prompt = build_analysis_prompt(row, normalized, comparison_block)

        parsed = _generate_via_ollama(prompt, base_url, model)
        parsed["analysis_mode"] = "ai-local"
        result = AIAnalysisResult(**parsed)
        logger.info(f"[{pub_id}] AI analysis generated via local Ollama model '{model}'.")
        return result
    except Exception as exc:
        logger.error(f"[{pub_id}] Local LLM analysis failed ({exc.__class__.__name__}): {exc}")
        return None


class OllamaAnalysisProvider(AnalysisProvider):
    name = "local"

    def analyze(self, row, extracted_text: str, comparison: Optional[ComparisonResult], config: OllamaSettings) -> Optional[AIAnalysisResult]:
        result = _try_local_analysis(row, extracted_text, comparison, config)
        if result is None:
            logger.warning(f"[{row['publication_id']}] Local LLM analysis unavailable or failed -- falling back to deterministic analysis.")
        return result
