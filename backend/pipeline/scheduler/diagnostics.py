"""Configuration checks that report presence only -- never the values."""
from typing import Any, Dict, Optional

from ..config import PipelineConfig, load_config
from ..paths import DEFAULT_PATHS, ProjectPaths


def check_email_configuration(config: Optional[PipelineConfig] = None, paths: ProjectPaths = DEFAULT_PATHS) -> Dict[str, Any]:
    """Reports whether real-delivery configuration is
    present WITHOUT ever reading/printing the actual values -- only presence
    booleans, per the project's security discipline (see analysis.py /
    email_pipeline.py for the same pattern used with OPENAI_API_KEY)."""
    if config is None:
        config = load_config(paths.env_path)
    return {
        "email_provider": config.email_provider,
        "test_mode": config.test_mode,
        "smtp_configured": config.smtp_configured(),
        "graph_configured": config.graph_configured(),
        "sender_set": bool(config.outlook_sender_email) and config.outlook_sender_email != "sender@yourdomain.com",
        "recipient_set": bool(config.outlook_recipient_email) and config.outlook_recipient_email != "recipient@yourdomain.com",
    }
