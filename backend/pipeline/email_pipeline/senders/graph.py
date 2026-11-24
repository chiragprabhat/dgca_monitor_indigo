"""Microsoft Graph sender (msal client-credentials, Mail.Send application
permission). Fully implemented but inert without Azure configuration."""
import logging
from typing import Optional

import requests

from ...config import GraphSettings
from ...utils import retry_with_backoff
from .base import EmailSender, EmailSendResult

logger = logging.getLogger(__name__)

try:
    import msal
    _MSAL_AVAILABLE = True
except ImportError:
    _MSAL_AVAILABLE = False


class MicrosoftGraphEmailSender(EmailSender):
    provider_name = "microsoft_graph"
    GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0"

    def __init__(self, config: GraphSettings):
        self.config = config

    def is_configured(self) -> bool:
        return _MSAL_AVAILABLE and self.config.graph_configured()

    def _get_access_token(self) -> Optional[str]:
        try:
            app = msal.ConfidentialClientApplication(
                client_id=self.config.azure_client_id,
                authority=f"https://login.microsoftonline.com/{self.config.azure_tenant_id}",
                client_credential=self.config.azure_client_secret,
            )
            result = retry_with_backoff(
                lambda: app.acquire_token_for_client(scopes=["https://graph.microsoft.com/.default"])
            )
            if result and "access_token" in result:
                logger.info("[microsoft_graph] Authentication successful (token acquired -- value not displayed).")
                return result["access_token"]
            error = (result or {}).get("error", "unknown_error")
            description = (result or {}).get("error_description", "No description provided.")
            logger.error(f"[microsoft_graph] Authentication failed: {error} -- {description}")
            return None
        except Exception as exc:
            logger.error(f"[microsoft_graph] Exception during authentication: {exc.__class__.__name__}: {exc}")
            return None

    def send(self, subject: str, html_body: str, recipient: str) -> EmailSendResult:
        if not self.is_configured():
            return EmailSendResult(False, self.provider_name, "Azure/Outlook configuration is incomplete.")

        access_token = self._get_access_token()
        if not access_token:
            return EmailSendResult(False, self.provider_name, "Microsoft Graph authentication failed. See log for details.")

        url = f"{self.GRAPH_BASE_URL}/users/{self.config.outlook_sender_email}/sendMail"
        headers = {"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"}
        payload = {
            "message": {
                "subject": subject,
                "body": {"contentType": "HTML", "content": html_body},
                "toRecipients": [{"emailAddress": {"address": recipient}}],
            },
            "saveToSentItems": "true",
        }
        try:
            response = retry_with_backoff(lambda: requests.post(url, headers=headers, json=payload, timeout=30))
        except Exception as exc:
            logger.error(f"[microsoft_graph] Exception while sending: {exc.__class__.__name__}: {exc}")
            return EmailSendResult(False, self.provider_name, f"Exception during send: {exc}")

        if response.status_code == 202:
            logger.info("[microsoft_graph] SUCCESS: email sent (HTTP 202 Accepted).")
            return EmailSendResult(True, self.provider_name, "Email sent successfully (HTTP 202 Accepted).")
        logger.error(f"[microsoft_graph] sendMail failed: HTTP {response.status_code} -- {response.text[:300]}")
        return EmailSendResult(False, self.provider_name, f"Graph API returned HTTP {response.status_code}.")
