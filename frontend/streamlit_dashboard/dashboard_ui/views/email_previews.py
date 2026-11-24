import glob
from pathlib import Path

import streamlit as st

from ..context import DashboardContext
from .base import Page


class EmailPreviewsPage(Page):
    title = "✉️ Email Previews"

    def render(self, ctx: DashboardContext) -> None:
        preview_dir = ctx.paths.preview_dir
        st.title("Email Previews")
        st.caption(
            "Browses the local .html files PreviewEmailSender writes -- "
            "these are exactly what would be sent for real once EMAIL_PROVIDER=smtp/TEST_MODE=false. "
            "No network call, no real send happens from this page."
        )

        files = sorted(glob.glob(str(preview_dir / "*.html")), key=lambda p: Path(p).stat().st_mtime, reverse=True)
        show_test_fixtures = st.checkbox("Include synthetic test fixtures (notebook 7/10/11 runs)", value=False)
        if not show_test_fixtures:
            # Preview filenames slug the email SUBJECT (the publication title), not
            # the publication_id -- every synthetic fixture's title contains
            # "synthetic" (e.g. "Phase 11 Synthetic New Publication"), so that
            # word, not an id-shaped prefix, is the reliable filter signal.
            files = [f for f in files if "synthetic" not in Path(f).name.lower()]

        st.caption(f"{len(files)} preview(s) found in `backend/data/processed/email_previews/`.")
        if not files:
            st.info("No email previews on record yet.")
            return

        labels = [Path(f).name for f in files]
        selected_label = st.selectbox("Select a preview", labels)
        html_content = (preview_dir / selected_label).read_text(encoding="utf-8")

        subject_hint = "UPDATED" if "updated" in selected_label.lower() else ("NEW" if "new" in selected_label.lower() else "")
        if subject_hint:
            st.caption(f"Inferred type from filename: **{subject_hint}**")

        st.components.v1.html(html_content, height=800, scrolling=True)
