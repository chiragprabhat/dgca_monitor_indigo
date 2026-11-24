"""
DGCA Regulatory Intelligence -- Streamlit dashboard entry point.

A read-only view over the backend's database. It contains no database or
business logic: every query comes from `pipeline.storage`, every AI-analysis
and comparison field was computed and persisted by the backend, and the
connection uses a read-only PostgreSQL transaction. It never calls an LLM and never sends email.

Run from the repository root:
    streamlit run frontend/streamlit_dashboard/app.py
"""
from datetime import datetime, timezone

from psycopg.errors import UndefinedTable

import streamlit as st

import dashboard_ui  # noqa: F401  (puts backend/ on sys.path -- must precede pipeline imports)
from dashboard_ui.context import DashboardContext
from dashboard_ui.styles import PAGE_CSS
from dashboard_ui.views import PAGES
from pipeline import storage
from pipeline.config import load_config
from pipeline.paths import DEFAULT_PATHS

st.set_page_config(
    page_title="DGCA Regulatory Intelligence",
    page_icon="✈️",
    layout="wide",
    initial_sidebar_state="expanded",
)
st.markdown(PAGE_CSS, unsafe_allow_html=True)


@st.cache_resource
def get_config():
    return load_config(DEFAULT_PATHS.env_path)


# -- Sidebar -------------------------------------------------------------------
st.sidebar.title("✈️ DGCA Regulatory Intelligence")
st.sidebar.caption("Read-only intelligence dashboard")
choice = st.sidebar.radio("Navigate", [page.title for page in PAGES])
if st.sidebar.button("🔄 Refresh data", use_container_width=True):
    st.rerun()
st.sidebar.caption(f"Page loaded: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}")

config = get_config()
st.sidebar.divider()
st.sidebar.markdown("**System configuration**")
st.sidebar.caption(f"AI provider: `{config.llm_provider}`")
st.sidebar.caption(f"Email provider: `{config.email_provider}` (TEST_MODE={config.test_mode})")
st.sidebar.caption(f"Check interval: `{config.check_interval_minutes}` minute(s)")
st.sidebar.caption("This dashboard makes no LLM or email calls itself.")

# -- Page ----------------------------------------------------------------------
conn = storage.get_readonly_connection()
try:
    conn.execute("SELECT 1 FROM publications LIMIT 0")
except UndefinedTable:
    conn.close()
    st.info(
        "No database yet. The backend creates it on its first monitoring cycle -- from the "
        "`backend/` folder run `python scheduler/run_monitor.py`, then refresh this page."
    )
    st.stop()

# A fresh read-only connection per run: data volume is small (dozens of rows),
# and it guarantees the page always reflects the latest persisted state.
try:
    page = next(p for p in PAGES if p.title == choice)
    page.render(DashboardContext(config=config, conn=conn, paths=DEFAULT_PATHS))
finally:
    conn.close()
