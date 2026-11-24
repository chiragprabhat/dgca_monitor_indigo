import logging
from datetime import datetime, timezone
from pathlib import Path


def configure_logging(log_dir: Path, log_name: str) -> logging.Logger:
    """Configure the 'pipeline' parent logger with console + file handlers.
    Every pipeline.* module's `logging.getLogger(__name__)` call returns a
    child of this logger and propagates up to these handlers automatically --
    call this once, from the entry point (CLI script or notebook), not from
    library modules."""
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / f"{log_name}_{datetime.now(timezone.utc).strftime('%Y%m%d')}.log"

    root = logging.getLogger("pipeline")
    root.setLevel(logging.INFO)
    root.handlers.clear()
    root.propagate = False

    formatter = logging.Formatter("[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s", datefmt="%Y-%m-%d %H:%M:%S")

    console_handler = logging.StreamHandler()
    console_handler.setFormatter(formatter)
    root.addHandler(console_handler)

    file_handler = logging.FileHandler(log_file, encoding="utf-8")
    file_handler.setFormatter(formatter)
    root.addHandler(file_handler)

    root.info(f"Logging configured. Log file: {log_file}")
    return root
