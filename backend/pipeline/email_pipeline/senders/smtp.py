"""Generic SMTP sender (stdlib smtplib): a local catcher such as
MailHog/Mailpit, or a real SMTP endpoint (Gmail app password, Office 365)."""
import logging
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from ...config import SMTPSettings
from ...utils import retry_with_backoff
from .base import EmailSender, EmailSendResult

logger = logging.getLogger(__name__)


class SMTPEmailSender(EmailSender):
    provider_name = "smtp"

    def __init__(self, config: SMTPSettings):
        self.config = config

    def is_configured(self) -> bool:
        return self.config.smtp_configured()

    def send(self, subject: str, html_body: str, recipient: str) -> EmailSendResult:
        if not self.is_configured():
            return EmailSendResult(False, self.provider_name, "SMTP configuration is incomplete (SMTP_HOST / sender email).")

        message = MIMEMultipart("alternative")
        message["Subject"] = subject
        message["From"] = self.config.outlook_sender_email
        message["To"] = recipient
        message.attach(MIMEText(html_body, "html", "utf-8"))

        def _do_send() -> None:
            with smtplib.SMTP(self.config.smtp_host, self.config.smtp_port, timeout=20) as server:
                if self.config.smtp_use_tls:
                    server.starttls()
                if self.config.smtp_username:
                    server.login(self.config.smtp_username, self.config.smtp_password or "")
                server.sendmail(self.config.outlook_sender_email, [recipient], message.as_string())

        try:
            retry_with_backoff(_do_send, max_attempts=2)
        except Exception as exc:
            logger.error(f"[smtp] Send failed: {exc.__class__.__name__}: {exc}")
            return EmailSendResult(False, self.provider_name, f"SMTP send failed: {exc}")

        logger.info(f"[smtp] SUCCESS: email sent via {self.config.smtp_host}:{self.config.smtp_port}.")
        return EmailSendResult(True, self.provider_name, "Email sent successfully via SMTP.")
