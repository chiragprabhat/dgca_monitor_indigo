"""
CLI entry point for unattended, long-running monitoring.

A notebook kernel is a poor home for a persistent process, so this is a plain
script. It contains no pipeline logic of its own: it configures logging and
calls pipeline.scheduler.run_scheduler().

Usage (from the backend/ folder):
    python scheduler/run_monitor.py

Stop with Ctrl+C -- run_scheduler() catches KeyboardInterrupt and returns
cleanly (each monitoring cycle either completes or is caught and logged as a
failed publication, never a half-committed one).

Importing this module starts nothing; only running it as `__main__` (or
calling main()) starts the scheduler loop.
"""
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from pipeline.paths import DEFAULT_PATHS  # noqa: E402
from pipeline.scheduler import run_scheduler  # noqa: E402
from pipeline.utils import configure_logging  # noqa: E402


def main() -> None:
    configure_logging(DEFAULT_PATHS.logs_dir, "scheduler")
    print(f"DGCA Automatic Monitoring -- reading config from {DEFAULT_PATHS.env_path}")
    print("Press Ctrl+C to stop.")
    run_scheduler()


if __name__ == "__main__":
    main()
