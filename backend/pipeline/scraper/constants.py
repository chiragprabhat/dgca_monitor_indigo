"""DGCA portal endpoints and request settings."""
BASE_URL = "https://www.dgca.gov.in/digigov-portal/"
SCAN_URL = BASE_URL + "scan"
UPLOAD_URL = BASE_URL + "Upload"

REQUEST_TIMEOUT_SECONDS = 20
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120 Safari/537.36"
)

AJAX_CATEGORIES = ["Regulation", "Guidance", "Announcement"]
HTML_CATEGORIES = ["Tender"]
ALL_CATEGORIES = AJAX_CATEGORIES + HTML_CATEGORIES
