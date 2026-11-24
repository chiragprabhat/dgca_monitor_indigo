"""Fetching a publication's PDF over HTTP."""
import requests

from ..utils import retry_with_backoff
from .models import DownloadError

REQUEST_TIMEOUT_SECONDS = 30
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120 Safari/537.36"
)


def download_pdf(pdf_url: str) -> bytes:
    headers = {"User-Agent": USER_AGENT}

    def _do_get():
        resp = requests.get(pdf_url, headers=headers, timeout=REQUEST_TIMEOUT_SECONDS)
        resp.raise_for_status()
        return resp

    try:
        response = retry_with_backoff(_do_get, max_attempts=3)
    except requests.RequestException as exc:
        raise DownloadError(f"{exc.__class__.__name__}: {exc}") from exc
    return response.content
