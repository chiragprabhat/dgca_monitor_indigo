import logging
import re
from datetime import datetime, timezone
from pathlib import Path

from .base import EmailSender, EmailSendResult

logger = logging.getLogger(__name__)


class PreviewEmailSender(EmailSender):
    provider_name = "preview"

    def __init__(self, preview_dir: Path):
        self.preview_dir = preview_dir

    def is_configured(self) -> bool:
        return True

    def send(self, subject: str, html_body: str, recipient: str) -> EmailSendResult:
        self.preview_dir.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        slug = re.sub(r"[^a-z0-9]+", "-", subject.lower()).strip("-")[:60] or "email"
        path = self.preview_dir / f"{timestamp}_{slug}.html"
        path.write_text(html_body, encoding="utf-8")
        logger.info(f"[preview] Saved local HTML preview (no network call made): {path}")
        return EmailSendResult(
            success=True,
            provider=self.provider_name,
            message=f"Saved local preview. Would have gone to: {recipient}",
            detail={"path": str(path)},
        )
