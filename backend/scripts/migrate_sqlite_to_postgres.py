"""Copy legacy DGCA SQLite databases to PostgreSQL using verified snapshots."""
import argparse
from contextlib import ExitStack, closing
from datetime import datetime, timezone
from pathlib import Path
import sqlite3
import sys
from uuid import uuid4

from psycopg import sql

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from pipeline.storage.connection import get_connection
from pipeline.storage.schema import SCHEMA_SQL as PUBLICATIONS_SCHEMA

NODE_SCHEMA = BACKEND / "node_api" / "src" / "config" / "schema.sql"
NODE_KEYS = {
    "updates": "id", "notifications": "id", "monitoring_logs": "id", "config": "key",
    "settings_log": "id", "review_log": "id", "car_documents": "id", "car_history": "id",
    "car_changes": "id", "uploaded_documents": "id",
}
PUBLICATION_KEYS = {"publications": "publication_id"}
FTS_TABLES = {
    "updates_fts", "updates_fts_data", "updates_fts_idx", "updates_fts_content",
    "updates_fts_docsize", "updates_fts_config",
}
IDENTITIES = {
    "notifications": "id", "monitoring_logs": "id", "settings_log": "id",
    "review_log": "id", "car_history": "id", "car_changes": "id",
    "uploaded_documents": "upload_order",
}


def snapshot(path, backup_dir, label):
    original = path.resolve(strict=True)
    backup_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = backup_dir / f"{label}-{timestamp}-{uuid4().hex[:8]}.sqlite3"
    # SQLite's backup API captures committed data in the WAL as well as the main file.
    with closing(sqlite3.connect(f"{original.as_uri()}?mode=ro", uri=True)) as source:
        with closing(sqlite3.connect(backup)) as target:
            source.backup(target)
    print(f"SQLite backup: {backup}", flush=True)
    return backup


def inspect_source(source, keys, derived_tables):
    if source.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
        raise ValueError("SQLite integrity check failed")
    if source.execute("PRAGMA foreign_key_check").fetchone():
        raise ValueError("SQLite has orphaned foreign keys; PostgreSQL would reject those rows")
    tables = {
        row[0] for row in source.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
        if not row[0].startswith("sqlite_")
    }
    unknown = tables.difference(keys, derived_tables)
    if unknown:
        raise ValueError(f"Unexpected SQLite tables: {', '.join(sorted(unknown))}")
    if not tables.intersection(keys):
        raise ValueError("The SQLite file contains none of the expected tables")
    return tables


def copy_table(source, pg, table, key, target_columns):
    # The table names come from the fixed manifests above.
    table_sql = sql.Identifier(table)
    columns = [row[1] for row in source.execute(f'PRAGMA table_info("{table}")')]
    if key not in columns:
        raise ValueError(f"{table} has no {key} column")
    select = f'SELECT * FROM "{table}"'
    if table == "uploaded_documents":
        columns.insert(0, "upload_order")
        select = f'SELECT rowid, * FROM "{table}"'

    unknown = set(columns) - target_columns
    if unknown:
        raise ValueError(f"Unexpected columns in {table}: {', '.join(sorted(unknown))}")

    names = sql.SQL(", ").join(map(sql.Identifier, columns))
    stage = sql.Identifier("dgca_import_" + table)
    pg.execute(sql.SQL("CREATE TEMP TABLE {} ON COMMIT DROP AS SELECT {} FROM {} WITH NO DATA")
               .format(stage, names, table_sql))
    count = 0
    with pg.cursor().copy(sql.SQL("COPY {} ({}) FROM STDIN").format(stage, names)) as copy:
        for row in source.execute(select):
            copy.write_row(row)
            count += 1

    # Apply and verify in one round trip. The second statement sees the inserted rows.
    result = pg.execute(sql.SQL("""
        INSERT INTO {target} ({columns})
        SELECT {columns} FROM {stage} ON CONFLICT ({key}) DO NOTHING;
        SELECT EXISTS (
          (SELECT {columns} FROM {stage} EXCEPT ALL SELECT {columns} FROM {target})
          UNION ALL
          (SELECT {columns} FROM {target} EXCEPT ALL SELECT {columns} FROM {stage})
        ) AS differs
        """).format(columns=names, stage=stage, target=table_sql, key=sql.Identifier(key)))
    result.nextset()
    if result.fetchone()["differs"]:
        raise ValueError(f"{table}: destination rows differ from the SQLite snapshot")
    return count


def reset_identity(source, pg, table):
    column = IDENTITIES.get(table)
    if not column:
        return
    if source.execute("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").fetchone():
        old_sequence = source.execute("SELECT seq FROM sqlite_sequence WHERE name = ?", (table,)).fetchone()
    else:
        old_sequence = None
    # RESTART WITH is transactional, unlike setval().
    pg.execute(sql.SQL("""
        DO $restart$
        DECLARE
          identity_sequence regclass := pg_get_serial_sequence({table_name}, {column_name})::regclass;
          sequence_next bigint;
          next_id bigint;
        BEGIN
          EXECUTE format('SELECT last_value + is_called::integer FROM %s', identity_sequence)
            INTO sequence_next;
          SELECT greatest({legacy_next}, coalesce(max({column}), 0) + 1, sequence_next)
            INTO next_id FROM {table};
          EXECUTE format('ALTER TABLE %s ALTER COLUMN %I RESTART WITH %s',
                         {table_name}::regclass, {column_name}, next_id);
        END
        $restart$;
        """).format(table=sql.Identifier(table), column=sql.Identifier(column),
                    table_name=sql.Literal(table), column_name=sql.Literal(column),
                    legacy_next=sql.Literal((old_sequence[0] if old_sequence else 0) + 1)))


def migrate(node_sqlite, python_sqlite, backup_dir, dry_run=False):
    sources = []
    with ExitStack() as stack:
        for label, path, keys, derived in (
            ("node", node_sqlite, NODE_KEYS, FTS_TABLES),
            ("python", python_sqlite, PUBLICATION_KEYS, set()),
        ):
            if path is None:
                continue
            backup = snapshot(path, backup_dir, label)
            source = stack.enter_context(closing(sqlite3.connect(f"{backup.as_uri()}?mode=ro", uri=True)))
            sources.append((label, source, keys, inspect_source(source, keys, derived)))

        counts = {}
        with get_connection() as pg, pg.transaction(force_rollback=dry_run):
            for label, source, keys, tables in sources:
                pg.execute("SELECT pg_advisory_xact_lock(13691, %s)", (1 if label == "node" else 2,))
                pg.execute(NODE_SCHEMA.read_text(encoding="utf-8") if label == "node" else PUBLICATIONS_SCHEMA)
                pg.execute(sql.SQL("LOCK TABLE {} IN SHARE ROW EXCLUSIVE MODE")
                           .format(sql.SQL(", ").join(map(sql.Identifier, keys))))
                columns_by_table = {}
                for row in pg.execute(
                    "SELECT table_name, column_name FROM information_schema.columns "
                    "WHERE table_schema = current_schema() AND table_name = ANY(%s)", (list(keys),)
                ):
                    columns_by_table.setdefault(row["table_name"], set()).add(row["column_name"])
                for table, key in keys.items():
                    if table in tables:
                        counts[table] = copy_table(source, pg, table, key, columns_by_table[table])
                        reset_identity(source, pg, table)
        return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node-sqlite", type=Path)
    parser.add_argument("--python-sqlite", type=Path)
    parser.add_argument("--backup-dir", type=Path, required=True)
    parser.add_argument("--dry-run", action="store_true", help="Verify the copy and roll back PostgreSQL changes")
    args = parser.parse_args()
    if not (args.node_sqlite or args.python_sqlite):
        parser.error("provide --node-sqlite, --python-sqlite, or both")

    try:
        counts = migrate(args.node_sqlite, args.python_sqlite, args.backup_dir.resolve(), args.dry_run)
    except Exception as error:
        parser.exit(1, f"Migration failed: {error}\n")
    for table, count in counts.items():
        print(f"{table}: {count} verified rows")
    print("Dry run verified and rolled back." if args.dry_run else "Migration committed.")


if __name__ == "__main__":
    main()
