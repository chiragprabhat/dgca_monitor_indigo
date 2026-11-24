import streamlit as st

from pipeline import storage

from ..context import DashboardContext
from ..widgets import render_publication_detail
from .base import Page

DEMO_PUBLICATION_ID = "e2e-test-car-x-rev2"


class ComparisonDemoPage(Page):
    title = "🔍 Comparison (Demo)"

    def render(self, ctx: DashboardContext) -> None:
        st.title("Old vs New Comparison")
        st.warning(
            "⚠️ **Development / Demo section.** Real DGCA \"What's New\" listings show only "
            "the current state of each publication -- no genuine revision pair has been observed "
            "in real scraped data yet. The example below uses a synthetic test fixture (built with "
            "real diff/comparison logic, tested in notebook 7) to demonstrate this view. It is never "
            "mixed with real DGCA publications elsewhere in this dashboard.",
            icon="⚠️",
        )

        demo_pub = storage.get_publication_by_id(ctx.conn, DEMO_PUBLICATION_ID)
        if demo_pub is None or not demo_pub.get("comparison_summary"):
            st.info(
                "The synthetic demo fixture isn't populated in this database yet. "
                "Run backend/notebooks/07_End_to_End_Workflow.ipynb and 09_DGCA_Dashboard_Design.ipynb first."
            )
            return
        render_publication_detail(demo_pub, ctx.conn)
