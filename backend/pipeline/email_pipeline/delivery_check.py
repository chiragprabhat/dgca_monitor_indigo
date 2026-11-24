import logging
from datetime import datetime, timezone
from pathlib import Path

from .factory import get_email_sender, route_for_test_mode
from .senders import EmailSendResult

logger = logging.getLogger(__name__)


def send_test_email(config, preview_dir: Path) -> EmailSendResult:
    """Phase 11: sends exactly ONE clearly-labeled connectivity test email
    via the currently configured provider -- used to verify real delivery
    works before trusting it with genuine DGCA notifications. Subject is
    fixed and unambiguous so it can never be confused with a real
    regulatory update. Respects TEST_MODE exactly like every other send in
    this pipeline: if TEST_MODE is still true, this safely routes to the
    preview provider instead of attempting a real send, so calling this
    function is never itself a way to accidentally bypass the safety
    switch."""
    subject = "[DGCA TEST] Regulatory Intelligence Email Test"
    sent_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    body = (
        "<!DOCTYPE html><html><body style=\"font-family:Segoe UI,Arial,sans-serif;"
        "padding:24px;color:#101828;\">"
        "<h2 style=\"color:#0b2a4a;\">DGCA Regulatory Intelligence -- Email Delivery Test</h2>"
        "<p>This is a one-time connectivity test sent by the DGCA Regulatory Intelligence "
        "system to confirm real email delivery is correctly configured.</p>"
        f"<p><b>Provider:</b> {config.email_provider}<br/><b>Sent at:</b> {sent_at}</p>"
        "<p>If you received this message, real email delivery is working. No action is "
        "required -- this is not a regulatory notification.</p>"
        "</body></html>"
    )
    sender, rerouted_from = route_for_test_mode(get_email_sender(config, preview_dir), config, preview_dir)
    if rerouted_from:
        logger.info("[test-email] TEST_MODE active -- routing to preview instead of a real send.")
    recipient = config.outlook_recipient_email or "unset-recipient@example.com"
    result = sender.send(subject, body, recipient)
    logger.info(f"[test-email] provider={result.provider} success={result.success}")
    return result
