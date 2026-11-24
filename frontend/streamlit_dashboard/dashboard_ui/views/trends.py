import pandas as pd
import streamlit as st

from pipeline import storage

from ..context import DashboardContext
from .base import Page


class TrendsPage(Page):
    title = "📈 Trends"

    def render(self, ctx: DashboardContext) -> None:
        st.title("Trends")
        st.caption("Publications discovered per day, by category -- derived from the existing first_seen_at timestamp (no new column).")

        daily = storage.get_publication_counts_by_day(ctx.conn)
        if not daily:
            st.info("Not enough data yet to show a trend.")
            return

        df = pd.DataFrame(daily)
        pivot = df.pivot_table(index="day", columns="category", values="count", aggfunc="sum", fill_value=0)
        st.bar_chart(pivot)
        st.markdown("##### Raw counts")
        st.dataframe(pivot, use_container_width=True)
