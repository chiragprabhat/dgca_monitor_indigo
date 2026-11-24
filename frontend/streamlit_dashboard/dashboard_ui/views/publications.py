from datetime import datetime, timezone

import pandas as pd
import streamlit as st

from pipeline import storage

from ..context import DashboardContext
from ..widgets import render_publication_detail
from .base import Page


class PublicationsPage(Page):
    title = "📰 Publications & Search"

    def render(self, ctx: DashboardContext) -> None:
        conn = ctx.conn
        st.title("Latest Publications")

        with st.expander("Filters", expanded=True):
            f_cols = st.columns(5)
            all_pubs_unfiltered = storage.get_publications(conn)
            categories = sorted({p["category"] for p in all_pubs_unfiltered})
            statuses = sorted({p["status"] for p in all_pubs_unfiltered})

            category_filter = f_cols[0].selectbox("Category", ["All"] + categories)
            impact_filter = f_cols[1].selectbox("Impact Level", ["All", "HIGH", "MEDIUM", "LOW", "CRITICAL"])
            status_filter = f_cols[2].selectbox("Status", ["All"] + statuses)
            date_from = f_cols[3].text_input("From date (YYYY-MM-DD)", "")
            date_to = f_cols[4].text_input("To date (YYYY-MM-DD)", "")
            keyword = st.text_input("Keyword search (title or summary)", "")

        pubs = storage.get_publications(
            conn,
            category=None if category_filter == "All" else category_filter,
            impact_level=None if impact_filter == "All" else impact_filter,
            status=None if status_filter == "All" else status_filter,
            keyword=keyword or None,
            date_from=date_from or None,
            date_to=date_to or None,
        )

        st.caption(f"{len(pubs)} publication(s) match the current filters.")

        if not pubs:
            st.info("No publications match these filters.")
            return

        table_rows = [
            {
                "Title": p["title"][:90],
                "Category": p["category"],
                "Published": p["published_date"] or "—",
                "Status": p["status"],
                "Impact": p["impact_level"] or "—",
                "Analysis": p["analysis_mode"] or "not analyzed",
            }
            for p in pubs
        ]
        st.dataframe(table_rows, use_container_width=True, hide_index=True)

        export_df = pd.DataFrame(table_rows)
        st.download_button(
            "⬇️ Export filtered results as CSV",
            data=export_df.to_csv(index=False).encode("utf-8"),
            file_name=f"dgca_publications_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}.csv",
            mime="text/csv",
        )

        titles = [f"{p['title'][:90]}  —  {p['publication_id']}" for p in pubs]
        selected = st.selectbox("Select a publication for full detail", titles)
        selected_id = selected.split("—")[-1].strip()
        selected_pub = storage.get_publication_by_id(conn, selected_id)

        st.divider()
        render_publication_detail(selected_pub, conn)
