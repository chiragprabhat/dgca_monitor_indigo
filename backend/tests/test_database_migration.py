import hashlib
from contextlib import closing
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory

from pipeline.storage import get_connection
from scripts.migrate_sqlite_to_postgres import migrate

from .helpers import PostgresTestCase


class SQLiteMigrationTests(PostgresTestCase):
    def test_dry_run_repeat_and_conflicting_data(self):
        with TemporaryDirectory() as directory:
            source = Path(directory) / "original.sqlite"
            backups = Path(directory) / "backups"
            with closing(sqlite3.connect(source)) as db:
                db.execute("PRAGMA journal_mode = WAL")
                db.execute("""
                    CREATE TABLE publications (
                      publication_id TEXT PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL,
                      published_date TEXT, content_hash TEXT NOT NULL, first_seen_at TEXT NOT NULL,
                      email_sent INTEGER, key_changes_json TEXT
                    )
                """)
                db.execute("INSERT INTO publications VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                           ("pub-1", "DGCA café", "Guidance", None, "hash", "2026-01-01T00:00:00+00:00",
                            1, '["crew rest"]'))
                db.commit()
                original_checksum = hashlib.sha256(source.read_bytes()).digest()
                self.assertEqual(migrate(None, source, backups, dry_run=True), {"publications": 1})
                with get_connection() as pg:
                    self.assertIsNone(pg.execute("SELECT to_regclass('publications') AS name").fetchone()["name"])

                for _ in range(2):
                    self.assertEqual(migrate(None, source, backups), {"publications": 1})
                self.assertEqual(original_checksum, hashlib.sha256(source.read_bytes()).digest())
                self.assertEqual(len(list(backups.glob("*.sqlite3"))), 3)
                with get_connection() as pg:
                    row = pg.execute("SELECT * FROM publications").fetchone()
                    self.assertEqual(row["key_changes_json"], '["crew rest"]')
                    self.assertEqual(row["email_sent"], 1)
                    self.assertEqual(row["title"], "DGCA café")
                    self.assertIsNone(row["published_date"])

                db.execute("UPDATE publications SET title = 'changed' WHERE publication_id = 'pub-1'")
                db.commit()
                with self.assertRaisesRegex(ValueError, "destination rows differ"):
                    migrate(None, source, backups)
                with get_connection() as pg:
                    self.assertEqual(pg.execute("SELECT title FROM publications").fetchone()["title"], "DGCA café")
