"""Read-only, dashboard-oriented queries. All filtering and grouping happens
in SQL -- callers (the dashboard) never re-implement it."""
import json
from psycopg import Connection
from psycopg.rows import DictRow
from typing import Any, Dict, List, Optional

# Synthetic fixtures created by tests/notebooks; hidden from real listings
# unless a caller explicitly asks for them.
_TEST_FIXTURE_FILTER = "publication_id NOT ILIKE 'e2e-test%%' AND publication_id NOT ILIKE 'test-%%'"


def _row_to_dict(row: DictRow) -> Dict[str, Any]:
    """Converts a raw row into a dashboard-friendly dict: JSON text columns
    become real lists/dicts, so the dashboard never parses JSON itself."""
    d = dict(row)
    for json_col, out_key in (
        ("key_changes_json", "key_changes"),
        ("impacted_departments_json", "impacted_departments"),
        ("recommended_actions_json", "recommended_actions"),
    ):
        raw = d.pop(json_col, None)
        d[out_key] = json.loads(raw) if raw else []
    comparison_raw = d.pop("comparison_summary_json", None)
    d["comparison_summary"] = json.loads(comparison_raw) if comparison_raw else None
    return d


def get_publication_by_id(conn: Connection, publication_id: str) -> Optional[Dict[str, Any]]:
    row = conn.execute("SELECT * FROM publications WHERE publication_id = %s", (publication_id,)).fetchone()
    return _row_to_dict(row) if row is not None else None


def get_publications(
    conn: Connection,
    category: Optional[str] = None,
    impact_level: Optional[str] = None,
    status: Optional[str] = None,
    keyword: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    include_test_fixtures: bool = False,
) -> List[Dict[str, Any]]:
    clauses: List[str] = []
    params: List[Any] = []

    if not include_test_fixtures:
        clauses.append(_TEST_FIXTURE_FILTER)
    if category:
        clauses.append("category = %s")
        params.append(category)
    if impact_level:
        clauses.append("impact_level = %s")
        params.append(impact_level)
    if status:
        clauses.append("status = %s")
        params.append(status)
    if keyword:
        ascii_lower = "translate({}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')"
        title = ascii_lower.format("title")
        summary = ascii_lower.format("ai_summary")
        clauses.append(f"({title} LIKE %s ESCAPE '' OR {summary} LIKE %s ESCAPE '')")
        keyword = keyword.translate(str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"))
        like = f"%{keyword}%"
        params.extend([like, like])
    if date_from:
        clauses.append("published_date >= %s")
        params.append(date_from)
    if date_to:
        clauses.append("published_date <= %s")
        params.append(date_to)

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    rows = conn.execute(
        f"SELECT * FROM publications {where} ORDER BY published_date DESC NULLS LAST, first_seen_at DESC NULLS LAST",
        params,
    ).fetchall()
    return [_row_to_dict(r) for r in rows]


def get_publication_counts_by_day(conn: Connection, include_test_fixtures: bool = False) -> List[Dict[str, Any]]:
    """One row per (day, category) with a count, derived from the existing
    first_seen_at timestamp -- no new column, no new table."""
    exclude = "" if include_test_fixtures else f"WHERE {_TEST_FIXTURE_FILTER}"
    joiner = "AND" if exclude else "WHERE"
    rows = conn.execute(
        f"SELECT substr(first_seen_at, 1, 10) AS day, category, COUNT(*) AS c "
        f"FROM publications {exclude} {joiner} first_seen_at IS NOT NULL "
        f"GROUP BY day, category ORDER BY day"
    ).fetchall()
    return [{"day": r["day"], "category": r["category"], "count": r["c"]} for r in rows]


def get_summary_stats(conn: Connection, include_test_fixtures: bool = False) -> Dict[str, Any]:
    """A handful of small, explicit COUNT queries -- no logic the dashboard
    would otherwise have to duplicate in Python."""
    exclude = "" if include_test_fixtures else f"WHERE {_TEST_FIXTURE_FILTER}"

    total = conn.execute(f"SELECT COUNT(*) AS c FROM publications {exclude}").fetchone()["c"]

    def _count(where_extra: str, params: tuple = ()) -> int:
        joiner = "AND" if exclude else "WHERE"
        return conn.execute(
            f"SELECT COUNT(*) AS c FROM publications {exclude} {joiner} {where_extra}", params
        ).fetchone()["c"]

    stats: Dict[str, Any] = {
        "total": total,
        "new": _count("status = 'new'"),
        "updated": _count("status = 'updated'"),
        "processed": _count("status = 'processed'"),
        "failed": _count("status = 'failed'"),
        "by_category": {},
        "by_impact": {"HIGH": 0, "MEDIUM": 0, "LOW": 0, "CRITICAL": 0},
    }

    joiner = "AND" if exclude else "WHERE"
    for row in conn.execute(f"SELECT category, COUNT(*) AS c FROM publications {exclude} GROUP BY category"):
        stats["by_category"][row["category"]] = row["c"]
    for row in conn.execute(
        f"SELECT impact_level, COUNT(*) AS c FROM publications {exclude} {joiner} impact_level IS NOT NULL GROUP BY impact_level"
    ):
        stats["by_impact"][row["impact_level"]] = row["c"]

    last_check_row = conn.execute(
        f"SELECT MAX(first_seen_at) AS ts FROM publications {exclude}"
    ).fetchone()
    stats["last_check_at"] = last_check_row["ts"] if last_check_row else None

    last_processed_row = conn.execute(
        f"SELECT publication_id, title, processed_at FROM publications {exclude} {joiner} processed_at IS NOT NULL "
        "ORDER BY processed_at DESC LIMIT 1"
    ).fetchone()
    stats["last_processed"] = dict(last_processed_row) if last_processed_row else None

    return stats
