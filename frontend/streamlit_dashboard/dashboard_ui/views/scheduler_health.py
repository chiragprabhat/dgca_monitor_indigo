import glob
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import streamlit as st

from ..context import DashboardContext
from .base import Page

_TS_RE = re.compile(r"^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]")


def _parse_ts(text: str) -> datetime:
    return datetime.strptime(text, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)


def _newest(pattern: str):
    matches = sorted(glob.glob(pattern), key=lambda p: Path(p).stat().st_mtime)
    return Path(matches[-1]) if matches else None


class SchedulerHealthPage(Page):
    title = "⏰ Scheduler Health"

    def render(self, ctx: DashboardContext) -> None:
        st.title("Scheduler Health")
        st.caption(
            "Inferred from the scheduler's own log file timestamps -- this dashboard does not "
            "inspect running processes, so status below is a best-effort read of recent log activity, not a live process check."
        )

        # scheduler/run_monitor.py writes logs/scheduler_*.log in production; if
        # that doesn't exist yet, fall back to the dev/test log left by
        # notebooks/10_Automatic_Monitoring.ipynb so this page is still useful
        # before the scheduler has ever been run unattended.
        logs_dir = ctx.paths.logs_dir
        scheduler_log = _newest(str(logs_dir / "scheduler_*.log"))
        fallback_log = _newest(str(logs_dir / "phase10_automatic_monitoring_*.log"))
        log_path = scheduler_log or fallback_log
        is_fallback = scheduler_log is None and fallback_log is not None

        if log_path is None:
            st.warning("No scheduler log found yet. Start it from the backend folder with:\n\n`python scheduler/run_monitor.py`")
            return
        if is_fallback:
            st.info(f"No production scheduler log (`logs/scheduler_*.log`) found yet -- showing the most recent development/test log instead: `{log_path.name}`")

        lines = log_path.read_text(encoding="utf-8", errors="ignore").splitlines()
        cycle_starts = [l for l in lines if "Starting DGCA monitoring cycle" in l or "Monitoring cycle" in l and "---" in l]
        next_cycle_lines = [l for l in lines if "Next cycle in" in l]
        error_lines = [l for l in lines if "[ERROR]" in l]

        last_ts = None
        for l in reversed(lines):
            m = _TS_RE.match(l)
            if m:
                last_ts = _parse_ts(m.group(1))
                break

        expected_next = None
        if next_cycle_lines:
            last_next_line = next_cycle_lines[-1]
            m_ts = _TS_RE.match(last_next_line)
            m_min = re.search(r"Next cycle in ([\d.]+) minute", last_next_line)
            if m_ts and m_min:
                expected_next = _parse_ts(m_ts.group(1)) + timedelta(minutes=float(m_min.group(1)))

        interval = ctx.config.check_interval_minutes
        now = datetime.now(timezone.utc)
        if expected_next is not None:
            grace = timedelta(minutes=max(interval * 0.5, 2))
            likely_running = now <= expected_next + grace
        elif last_ts is not None:
            likely_running = (now - last_ts) < timedelta(minutes=max(interval * 2, 5))
        else:
            likely_running = False

        status_cols = st.columns(4)
        status_cols[0].metric("Status (inferred)", "🟢 Likely running" if likely_running else "🔴 Likely stopped")
        status_cols[1].metric("Monitoring cycles logged", len(cycle_starts))
        status_cols[2].metric("Errors logged", len(error_lines))
        status_cols[3].metric("Last log activity", last_ts.strftime("%Y-%m-%d %H:%M UTC") if last_ts else "—")

        if expected_next is not None:
            st.caption(f"Expected next cycle around: {expected_next.strftime('%Y-%m-%d %H:%M:%S UTC')}")

        if error_lines:
            with st.expander(f"⚠️ {len(error_lines)} error line(s) in this log", expanded=False):
                st.code("\n".join(error_lines[-40:]), language="text")

        with st.expander("Raw log tail (last 60 lines)", expanded=False):
            st.code("\n".join(lines[-60:]), language="text")
