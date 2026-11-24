"""
Read-only Streamlit dashboard over the backend's database.

The dashboard lives in frontend/ but reads the backend's PostgreSQL database through
`pipeline.storage`, so the backend package has to be importable. This module
puts backend/ on sys.path (the dashboard is started from the repo root with
`streamlit run frontend/streamlit_dashboard/app.py`).

Layout:
    context.py   DashboardContext: what every view receives
    styles.py    page CSS
    widgets.py   badges and the shared publication-detail layout
    views/       one class per page, registered in views/__init__.py
"""
import sys
from pathlib import Path

# dashboard_ui -> streamlit_dashboard -> frontend -> <repo root>
BACKEND_ROOT = Path(__file__).resolve().parents[3] / "backend"
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))
