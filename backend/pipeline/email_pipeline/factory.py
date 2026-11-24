"""
Picks the EmailSender for the configured EMAIL_PROVIDER.

Builders are looked up in a registry, so adding a provider means writing an
`EmailSender` subclass and calling `register_sender()` -- nothing here, and
neither render_email_html() nor validate_email_html(), has to change.

TEST_MODE is the master safety switch: `route_for_test_mode()` swaps any real
provider for the preview sender, so a real send only happens with
TEST_MODE=false *and* that provider's own configuration present.
"""
from pathlib import Path
from typing import Callable, Dict, Optional, Tuple

from .senders import EmailSender, MicrosoftGraphEmailSender, PreviewEmailSender, SMTPEmailSender

SenderBuilder = Callable[[object, Path], EmailSender]


def _reserved_api_sender(config, preview_dir: Path) -> EmailSender:
    raise NotImplementedError(
        "EMAIL_PROVIDER='api' is a reserved extension point for a future custom "
        "HTTP email API integration. Implement an EmailSender subclass and add it "
        "here when needed."
    )


_BUILDERS: Dict[str, SenderBuilder] = {
    "preview": lambda config, preview_dir: PreviewEmailSender(preview_dir),
    "microsoft_graph": lambda config, preview_dir: MicrosoftGraphEmailSender(config),
    "smtp": lambda config, preview_dir: SMTPEmailSender(config),
    "api": _reserved_api_sender,
}


def register_sender(provider: str, builder: SenderBuilder) -> None:
    _BUILDERS[provider.strip().lower()] = builder


def get_email_sender(config, preview_dir: Path) -> EmailSender:
    provider = config.email_provider.strip().lower()
    builder = _BUILDERS.get(provider)
    if builder is None:
        raise ValueError(f"Unknown EMAIL_PROVIDER '{provider}'. Expected one of: {', '.join(_BUILDERS)}.")
    return builder(config, preview_dir)


def route_for_test_mode(sender: EmailSender, config, preview_dir: Path) -> Tuple[EmailSender, Optional[str]]:
    """Returns (sender to use, name of the real provider that was replaced or
    None). Callers log the reroute in their own words."""
    if sender.provider_name != "preview" and config.test_mode:
        return PreviewEmailSender(preview_dir), sender.provider_name
    return sender, None
