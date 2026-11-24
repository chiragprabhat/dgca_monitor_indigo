"""
Notification emails: model, HTML rendering, validation and delivery.

    models.py      -- DGCAUpdate, IMPACT_COLORS
    template.py    -- the Jinja2 HTML template
    rendering.py   -- render_email_html()
    validation.py  -- validate_email_html()
    senders/       -- EmailSender implementations: preview, smtp, microsoft_graph
    factory.py     -- sender registry, get_email_sender(), TEST_MODE routing
    delivery_check.py -- one-off connectivity test email
"""
from .factory import get_email_sender, register_sender, route_for_test_mode
from .models import IMPACT_COLORS, DGCAUpdate
from .rendering import render_email_html
from .senders import (
    EmailSender,
    EmailSendResult,
    MicrosoftGraphEmailSender,
    PreviewEmailSender,
    SMTPEmailSender,
)
from .template import EMAIL_TEMPLATE
from .delivery_check import send_test_email
from .validation import EmailValidationResult, validate_email_html

__all__ = [
    "EMAIL_TEMPLATE", "IMPACT_COLORS", "DGCAUpdate", "EmailSender", "EmailSendResult",
    "EmailValidationResult", "MicrosoftGraphEmailSender", "PreviewEmailSender", "SMTPEmailSender",
    "get_email_sender", "register_sender", "render_email_html", "route_for_test_mode",
    "send_test_email", "validate_email_html",
]
