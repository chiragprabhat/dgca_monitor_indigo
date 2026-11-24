from psycopg.errors import ReadOnlySqlTransaction
import unittest

from pipeline import storage

from .helpers import PostgresTestCase, make_pub, open_store_conn


class IngestionTests(PostgresTestCase):
    def setUp(self):
        super().setUp()
        self.conn = open_store_conn()

    def tearDown(self):
        self.conn.close()

    def test_new_unchanged_updated(self):
        pub = make_pub()
        self.assertEqual(storage.ingest_publication(self.conn, pub), storage.IngestOutcome.NEW)
        self.assertEqual(storage.ingest_publication(self.conn, pub), storage.IngestOutcome.UNCHANGED)
        changed = dict(pub, pdf_url="https://example.test/b.pdf")
        self.assertEqual(storage.ingest_publication(self.conn, changed), storage.IngestOutcome.UPDATED)

    def test_malformed_record_fails_without_raising(self):
        self.assertEqual(storage.ingest_publication(self.conn, {"source_id": "x"}), storage.IngestOutcome.FAILED)
        self.assertEqual(storage.get_all(self.conn), [])

    def test_batch_isolates_bad_record(self):
        summary = storage.ingest_batch(self.conn, [make_pub("a"), {"category": "Regulation"}, make_pub("b")])
        self.assertEqual((summary.new, summary.failed, summary.total), (2, 1, 3))

    def test_pending_and_resend_lifecycle(self):
        storage.ingest_publication(self.conn, make_pub())
        self.assertEqual(len(storage.get_pending_notifications(self.conn)), 1)
        storage.mark_email_sent(self.conn, "regulation-A")
        self.assertEqual(storage.get_pending_notifications(self.conn), [])
        storage.mark_failed(self.conn, "regulation-A")
        storage.mark_for_resend(self.conn, "regulation-A")
        self.assertEqual([r["publication_id"] for r in storage.get_failed_unsent(self.conn)], ["regulation-A"])

    def test_queries_hide_test_fixtures_by_default(self):
        storage.ingest_publication(self.conn, make_pub("regulation-A"))
        storage.ingest_publication(self.conn, make_pub("e2e-test-1"))
        self.assertEqual([p["publication_id"] for p in storage.get_publications(self.conn)], ["regulation-A"])
        self.assertEqual(len(storage.get_publications(self.conn, include_test_fixtures=True)), 2)
        self.assertEqual(storage.get_summary_stats(self.conn)["total"], 1)

    def test_readonly_connection_rejects_writes(self):
        ro = storage.get_readonly_connection()
        with self.assertRaises(ReadOnlySqlTransaction):
            ro.execute("DELETE FROM publications")
        ro.close()

    def test_migration_adds_missing_columns(self):
        self.conn.execute("ALTER TABLE publications DROP COLUMN ai_summary")
        storage.ingest_publication(self.conn, make_pub())
        storage.init_db()
        row = storage.get_all(self.conn)[0]
        self.assertIn("ai_summary", row)
        self.assertEqual(row["publication_id"], "regulation-A")


if __name__ == "__main__":
    unittest.main()
