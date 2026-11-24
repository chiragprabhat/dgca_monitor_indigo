import streamlit as st

from pipeline import storage

from ..context import DashboardContext
from .base import Page


class OverviewPage(Page):
    title = "📊 Overview"

    def render(self, ctx: DashboardContext) -> None:
        st.title("Overview")
        stats = storage.get_summary_stats(ctx.conn)

        row1 = st.columns(5)
        row1[0].metric("Total Publications", stats["total"])
        row1[1].metric("New", stats["new"])
        row1[2].metric("Updated", stats["updated"])
        row1[3].metric("Processed", stats["processed"])
        row1[4].metric("Failed", stats["failed"])

        st.markdown("##### By Category")
        cat_cols = st.columns(max(len(stats["by_category"]), 1))
        for i, (cat, count) in enumerate(sorted(stats["by_category"].items())):
            cat_cols[i].metric(cat, count)
        if not stats["by_category"]:
            st.caption("No publications on record yet.")

        st.markdown("##### By Impact Level")
        impact_cols = st.columns(4)
        for i, level in enumerate(["HIGH", "MEDIUM", "LOW", "CRITICAL"]):
            impact_cols[i].metric(level.title(), stats["by_impact"].get(level, 0))

        st.divider()
        info_cols = st.columns(2)
        with info_cols[0]:
            st.markdown("**Last successful DGCA check**")
            st.write(stats["last_check_at"] or "Not available")
        with info_cols[1]:
            st.markdown("**Last processed publication**")
            if stats["last_processed"]:
                st.write(f"{stats['last_processed']['title'][:80]}")
                st.caption(stats["last_processed"]["processed_at"])
            else:
                st.write("Not available")
