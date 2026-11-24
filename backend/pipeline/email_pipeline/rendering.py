from datetime import datetime, timezone

from .models import IMPACT_COLORS, DGCAUpdate
from .template import EMAIL_TEMPLATE


def render_email_html(update: DGCAUpdate, ai_summary: str, test_mode: bool) -> str:
    return EMAIL_TEMPLATE.render(
        update=update,
        ai_summary=ai_summary,
        impact_color=IMPACT_COLORS.get(update.impact_level.upper(), "#475467"),
        test_mode=test_mode,
        generated_at=datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
    )
