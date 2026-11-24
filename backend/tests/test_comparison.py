import unittest

from pipeline import comparison, storage

from .helpers import PostgresTestCase, make_config, make_pub, open_store_conn

OLD = "Operators shall maintain duty records. Crew rest must be at least 10 hours between duties."
NEW = "Operators shall maintain duty records for 24 months. Crew rest must be at least 10 hours between duties."


class DiffTests(unittest.TestCase):
    def test_formatting_only_change_is_not_a_change(self):
        reflowed = "Operators shall maintain\n   duty records.   Crew rest must be\nat least 10 hours between duties."
        _diff, result = comparison.compare_documents(OLD, reflowed, make_config())
        self.assertEqual((result.total_changes, result.overall_change_level), (0, "NONE"))

    def test_real_change_is_reported(self):
        diff, result = comparison.compare_documents(OLD, NEW, make_config())
        self.assertEqual(len(diff.modified), 1)
        self.assertEqual(result.overall_change_level, "LOW")
        self.assertTrue(result.key_changes[0].startswith("Modified:"))


class VersioningTests(PostgresTestCase):
    def test_revision_suffix_is_ignored_when_matching_titles(self):
        self.assertTrue(comparison.titles_likely_same_document("CAR X Revision 1", "CAR X Revision 2"))
        self.assertFalse(comparison.titles_likely_same_document("CAR X", "Something else entirely"))

    def test_find_previous_version_stays_within_category(self):
        conn = open_store_conn()
        storage.ingest_publication(conn, make_pub("a", "CAR X Revision 1"))
        storage.ingest_publication(conn, make_pub("b", "CAR X Revision 2"))
        storage.ingest_publication(conn, make_pub("c", "CAR X Revision 3", category="Guidance"))
        self.assertEqual(comparison.find_previous_version(conn, "b")["publication_id"], "a")
        self.assertIsNone(comparison.find_previous_version(conn, "c"))
        conn.close()


if __name__ == "__main__":
    unittest.main()
