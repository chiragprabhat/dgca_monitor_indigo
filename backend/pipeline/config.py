"""
Unified pipeline configuration.

`PipelineConfig` stays one flat dataclass (notebooks and `.env` loading rely
on that), but components no longer have to depend on all of it: each one
declares the narrow `*Settings` protocol it actually reads (interface
segregation), and `PipelineConfig` satisfies all of them structurally. A
sender that only needs SMTP fields can be built from, or tested with, any
object that has those fields.
"""
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Protocol

from dotenv import load_dotenv

_PLACEHOLDER_PATTERNS = ("your-", "00000000-0000-0000-0000-000000000000", "sk-your-")


def _is_placeholder(value: Optional[str]) -> bool:
    if not value:
        return True
    return any(value.startswith(p) for p in _PLACEHOLDER_PATTERNS)


# -- Narrow views of the configuration, one per consumer ---------------------

class SMTPSettings(Protocol):
    smtp_host: Optional[str]
    smtp_port: int
    smtp_username: Optional[str]
    smtp_password: Optional[str]
    smtp_use_tls: bool
    outlook_sender_email: Optional[str]

    def smtp_configured(self) -> bool: ...


class GraphSettings(Protocol):
    azure_client_id: Optional[str]
    azure_tenant_id: Optional[str]
    azure_client_secret: Optional[str]
    outlook_sender_email: Optional[str]

    def graph_configured(self) -> bool: ...


class OllamaSettings(Protocol):
    ollama_base_url: str
    ollama_model: str


class OpenAISettings(Protocol):
    openai_api_key: Optional[str]
    llm_model: str

    def openai_configured(self) -> bool: ...


@dataclass
class PipelineConfig:
    email_provider: str = "preview"
    test_mode: bool = True

    azure_client_id: Optional[str] = None
    azure_tenant_id: Optional[str] = None
    azure_client_secret: Optional[str] = None

    outlook_sender_email: Optional[str] = None
    outlook_recipient_email: Optional[str] = None

    smtp_host: Optional[str] = None
    smtp_port: int = 587
    smtp_username: Optional[str] = None
    smtp_password: Optional[str] = None
    smtp_use_tls: bool = True

    openai_api_key: Optional[str] = None
    llm_model: str = "gpt-4o-mini"

    # Which AI analysis provider to use -- "local" (Ollama), "openai", or
    # "fallback" (deterministic, no LLM at all).
    llm_provider: str = "local"
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "llama3.1:8b"

    # How often (minutes) the scheduler runs a monitoring cycle. Environment
    # driven, not hardcoded in the scheduler -- lower it (e.g. 1) for local
    # testing, but don't commit a lowered default.
    check_interval_minutes: int = 60

    def graph_configured(self) -> bool:
        return not any(
            _is_placeholder(v)
            for v in (
                self.azure_client_id,
                self.azure_tenant_id,
                self.azure_client_secret,
                self.outlook_sender_email,
                self.outlook_recipient_email,
            )
        )

    def smtp_configured(self) -> bool:
        return bool(self.smtp_host) and not _is_placeholder(self.outlook_sender_email)

    def openai_configured(self) -> bool:
        return not _is_placeholder(self.openai_api_key)


def load_config(env_path: Optional[Path] = None) -> PipelineConfig:
    if env_path is not None:
        load_dotenv(dotenv_path=env_path)

    return PipelineConfig(
        email_provider=os.getenv("EMAIL_PROVIDER", "preview").strip().lower(),
        test_mode=os.getenv("TEST_MODE", "true").strip().lower() != "false",
        azure_client_id=os.getenv("AZURE_CLIENT_ID"),
        azure_tenant_id=os.getenv("AZURE_TENANT_ID"),
        azure_client_secret=os.getenv("AZURE_CLIENT_SECRET"),
        outlook_sender_email=os.getenv("OUTLOOK_SENDER_EMAIL"),
        outlook_recipient_email=os.getenv("OUTLOOK_RECIPIENT_EMAIL"),
        smtp_host=os.getenv("SMTP_HOST"),
        smtp_port=int(os.getenv("SMTP_PORT", "587") or "587"),
        smtp_username=os.getenv("SMTP_USERNAME"),
        smtp_password=os.getenv("SMTP_PASSWORD"),
        smtp_use_tls=os.getenv("SMTP_USE_TLS", "true").strip().lower() != "false",
        openai_api_key=os.getenv("OPENAI_API_KEY"),
        llm_model=os.getenv("LLM_MODEL", "gpt-4o-mini"),
        llm_provider=os.getenv("LLM_PROVIDER", "local").strip().lower(),
        ollama_base_url=os.getenv("OLLAMA_BASE_URL", "http://localhost:11434").rstrip("/"),
        ollama_model=os.getenv("OLLAMA_MODEL", "llama3.1:8b"),
        check_interval_minutes=_parse_positive_int(
            os.getenv("CHECK_INTERVAL_MINUTES"), default=60
        ),
    )


def _parse_positive_int(raw: Optional[str], default: int) -> int:
    """Falls back to `default` for a missing/blank/non-numeric/non-positive
    value rather than raising, so a typo'd .env value degrades safely instead
    of crashing config load."""
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw.strip())
    except ValueError:
        return default
    return value if value > 0 else default
