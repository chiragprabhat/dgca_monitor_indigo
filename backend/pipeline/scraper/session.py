"""Builds the HTTP session the portal needs (cookies + English locale)."""
import logging

import requests

from .constants import BASE_URL, REQUEST_TIMEOUT_SECONDS, SCAN_URL, USER_AGENT

logger = logging.getLogger(__name__)


def get_dgca_session() -> requests.Session:
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})

    resp = session.get(BASE_URL, timeout=REQUEST_TIMEOUT_SECONDS)
    resp.raise_for_status()
    logger.info(f"Homepage loaded (HTTP {resp.status_code}), session cookies established.")

    try:
        locale_params = {
            "baseLocale": "en_US",
            "requestType": "ApplicationRH",
            "actionVal": "localeChange",
            "screenId": "10000001",
        }
        locale_resp = session.post(SCAN_URL, params=locale_params, timeout=REQUEST_TIMEOUT_SECONDS)
        locale_resp.raise_for_status()
        logger.info("Locale switched to English (en_US) for this session.")
    except requests.RequestException as exc:
        logger.warning(f"Locale switch failed ({exc.__class__.__name__}); Tenders may come back in Hindi.")

    return session
