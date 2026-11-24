import logging
import time
from typing import Callable, Optional, TypeVar

T = TypeVar("T")


def retry_with_backoff(fn: Callable[[], T], max_attempts: int = 3, base_delay: float = 1.0) -> T:
    """Retry a zero-arg callable on exception, with exponential backoff.
    Raises the last exception if every attempt fails."""
    logger = logging.getLogger(__name__)
    last_exc: Optional[Exception] = None
    for attempt in range(1, max_attempts + 1):
        try:
            return fn()
        except Exception as exc:
            last_exc = exc
            if attempt == max_attempts:
                break
            delay = base_delay * (2 ** (attempt - 1))
            logger.warning(f"Attempt {attempt}/{max_attempts} failed ({exc.__class__.__name__}). Retrying in {delay:.1f}s...")
            time.sleep(delay)
    assert last_exc is not None
    raise last_exc
