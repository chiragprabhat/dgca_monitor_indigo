"""Previous-version identification: within the same category, after
stripping revision-style suffixes ("Revision N" / "Amendment N" / "Issue N"),
titles that are similar enough are treated as the same document. Read-only
against the publications table."""
import difflib
import re


_REVISION_SUFFIX_RE = re.compile(r"\b(revision|rev\.?|amendment|issue)\s*\d+\b", re.IGNORECASE)


def normalize_title_for_matching(title: str) -> str:
    stripped = _REVISION_SUFFIX_RE.sub("", title)
    return re.sub(r"\s+", " ", stripped).strip().lower()


def titles_likely_same_document(title_a: str, title_b: str, threshold: float = 0.85) -> bool:
    norm_a = normalize_title_for_matching(title_a)
    norm_b = normalize_title_for_matching(title_b)
    if not norm_a or not norm_b:
        return False
    ratio = difflib.SequenceMatcher(None, norm_a, norm_b).ratio()
    return ratio >= threshold


def find_previous_version(conn, publication_id: str):
    current = conn.execute(
        "SELECT * FROM publications WHERE publication_id = %s", (publication_id,)
    ).fetchone()
    if current is None:
        return None

    candidates = conn.execute(
        "SELECT * FROM publications WHERE category = %s AND publication_id != %s ORDER BY first_seen_at",
        (current["category"], publication_id),
    ).fetchall()

    for candidate in candidates:
        if titles_likely_same_document(current["title"], candidate["title"]):
            return candidate
    return None
