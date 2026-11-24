"""Runs monitoring cycles on a timer. Safe to import: nothing starts until
run_scheduler() is called, and logging handlers are never configured here --
the entry point (scheduler/run_monitor.py or a notebook) does that once."""
import logging
import threading
import time
from typing import Optional

from ..config import load_config
from ..paths import DEFAULT_PATHS, ProjectPaths
from .cycle import run_once

logger = logging.getLogger(__name__)


def run_scheduler(
    check_interval_minutes: Optional[float] = None,
    max_cycles: Optional[int] = None,
    stop_event: Optional[threading.Event] = None,
    paths: ProjectPaths = DEFAULT_PATHS,
) -> None:
    """Runs monitoring cycles forever (or up to `max_cycles`, used for
    testing), `check_interval_minutes` apart. Blocks the calling thread.

    Stopped one of two ways:
      - KeyboardInterrupt (Ctrl+C) in a foreground terminal -- how
        scheduler/run_monitor.py stops it.
      - Passing a threading.Event as `stop_event` and calling `.set()` on it
        from another thread (used when the scheduler runs on a background
        thread, e.g. a notebook demonstrating a clean stop).

    `check_interval_minutes` overrides config.check_interval_minutes
    (CHECK_INTERVAL_MINUTES) -- used for short test intervals without
    touching the configured default.
    """
    config = load_config(paths.env_path)
    interval = check_interval_minutes if check_interval_minutes is not None else config.check_interval_minutes

    logger.info("=" * 70)
    logger.info("DGCA Automatic Monitoring Scheduler starting")
    logger.info(f"Check interval: {interval} minute(s)")
    logger.info("=" * 70)

    cycle_num = 0
    try:
        while True:
            cycle_num += 1
            logger.info(f"--- Monitoring cycle {cycle_num} ---")
            try:
                run_once(config=config, paths=paths)
            except Exception as exc:
                # run_once() already catches and returns errors as data, but
                # this is one more layer of defense: nothing a single cycle
                # does should ever be able to end the scheduler loop.
                logger.error(f"Monitoring cycle {cycle_num} crashed unexpectedly: {exc.__class__.__name__}: {exc}. Scheduler continuing.")

            if max_cycles is not None and cycle_num >= max_cycles:
                logger.info(f"Reached max_cycles={max_cycles}; stopping scheduler.")
                return

            logger.info(f"Next cycle in {interval} minute(s).")

            if _wait(interval, stop_event):
                logger.info("Stop requested; scheduler stopping cleanly.")
                return
    except KeyboardInterrupt:
        logger.info("KeyboardInterrupt received; scheduler stopping cleanly.")


def _wait(interval_minutes: float, stop_event: Optional[threading.Event]) -> bool:
    """Sleeps `interval_minutes` in one-second steps so a stop request is
    noticed promptly. Returns True if a stop was requested."""
    total_wait_seconds = max(interval_minutes, 0) * 60
    waited = 0.0
    step = 1.0
    while waited < total_wait_seconds:
        if stop_event is not None and stop_event.is_set():
            return True
        sleep_for = min(step, total_wait_seconds - waited)
        time.sleep(sleep_for)
        waited += sleep_for
    return False
