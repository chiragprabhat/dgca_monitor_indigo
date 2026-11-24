import unittest

from pipeline import storage
from pipeline.orchestrator import PipelineServices, build_default_services, run_dgca_pipeline
from pipeline.orchestrator.adapters import ProviderAnalyzer

from .helpers import PostgresTestCase, FakeDocuments, RecordingSender, make_config, make_pub, open_store_conn, temp_paths

V1 = "Operators shall maintain duty records. Crew rest must be at least 10 hours between duties."
V2 = "Operators shall maintain duty records for 24 months. Crew rest must be at least 10 hours between duties."


class OrchestratorTests(PostgresTestCase):
    def setUp(self):
        super().setUp()
        self.paths = temp_paths()
        self.conn = open_store_conn()
        self.sender = RecordingSender()
        self.docs = FakeDocuments({"https://example.test/a.pdf": V1, "https://example.test/b.pdf": V2})
        self.cfg = make_config()

    def tearDown(self):
        self.conn.close()

    def services(self, **overrides):
        svc = build_default_services(self.conn)
        svc.documents = self.docs
        svc.sender_factory = lambda cfg, d: self.sender
        for key, value in overrides.items():
            setattr(svc, key, value)
        return svc

    def run_pipeline(self, pubs, services=None, **kw):
        return run_dgca_pipeline(self.conn, self.cfg, self.paths.documents_dir, self.paths.preview_dir, False,
                                 publications=pubs, services=services or self.services(), **kw)

    def test_new_publication_is_analysed_emailed_and_persisted(self):
        summary = self.run_pipeline([make_pub()])
        self.assertEqual((summary.total, summary.success, summary.failed), (1, 1, 0))
        self.assertEqual(len(self.sender.sent), 1)
        self.assertTrue(self.sender.sent[0][0].startswith("[DGCA][NEW][REGULATION]"))
        row = storage.get_publication_by_id(self.conn, "regulation-A")
        self.assertEqual((row["status"], row["email_sent"], row["analysis_mode"]), ("processed", 1, "fallback"))
        self.assertEqual(row["document_hash"], "hash-of-https://example.test/a.pdf")

    def test_unchanged_publication_never_sends_a_second_email(self):
        self.run_pipeline([make_pub()])
        summary = self.run_pipeline([make_pub()])
        self.assertEqual((summary.skipped_unchanged, summary.success), (1, 0))
        self.assertEqual(len(self.sender.sent), 1)
        self.assertEqual(self.docs.calls, ["regulation-A"])

    def test_in_place_update_compares_against_prior_text(self):
        self.run_pipeline([make_pub()])
        summary = self.run_pipeline([make_pub(pdf="https://example.test/b.pdf")])
        result = summary.results[0]
        self.assertEqual(result.outcome, "updated")
        self.assertIn("in-place update", result.comparison_status)
        self.assertTrue(self.sender.sent[1][0].startswith("[DGCA][UPDATED][REGULATION]"))
        self.assertIn("VERSION COMPARISON", self.sender.sent[1][1])

    def test_one_failing_publication_does_not_abort_the_batch(self):
        class FlakyAnalyzer(ProviderAnalyzer):
            def analyze(self, row, extracted_text, comparison_result, config):
                if row["publication_id"] == "regulation-A":
                    raise RuntimeError("boom")
                return super().analyze(row, extracted_text, comparison_result, config)

        pubs = [make_pub("regulation-A"), {"category": "Regulation"}, make_pub("regulation-B")]
        summary = self.run_pipeline(pubs, services=self.services(analyzer=FlakyAnalyzer()))
        by_id = {r.publication_id: r for r in summary.results}
        self.assertEqual((by_id["regulation-A"].status, by_id["regulation-A"].stage), ("failed", "ai_analysis"))
        self.assertEqual(by_id["<unknown>"].stage, "detect")
        self.assertEqual(by_id["regulation-B"].status, "success")

    def test_failed_delivery_is_only_retried_when_explicitly_requested(self):
        self.sender.succeed = False
        first = self.run_pipeline([make_pub()])
        self.assertEqual(first.failed, 1)
        self.assertEqual(storage.get_publication_by_id(self.conn, "regulation-A")["status"], "failed")

        self.sender.succeed = True
        automatic = self.run_pipeline([make_pub()])
        self.assertEqual(automatic.skipped_unchanged, 1)
        self.assertEqual(len(self.sender.sent), 1)

        retried = self.run_pipeline([make_pub()], retry_failed=True)
        self.assertEqual(retried.success, 1)
        self.assertEqual(storage.get_publication_by_id(self.conn, "regulation-A")["email_sent"], 1)

    def test_test_mode_never_reaches_a_real_sender(self):
        self.cfg = make_config(test_mode=True)
        self.run_pipeline([make_pub()])
        self.assertEqual(self.sender.sent, [])
        self.assertEqual(len(list(self.paths.preview_dir.glob("*.html"))), 1)

    def test_failing_source_returns_empty_summary(self):
        class Broken:
            def fetch(self):
                raise ConnectionError("site down")

        summary = run_dgca_pipeline(self.conn, self.cfg, self.paths.documents_dir, self.paths.preview_dir, False,
                                    source=Broken())
        self.assertEqual(summary.total, 0)

    def test_custom_services_are_used_instead_of_defaults(self):
        svc = self.services()
        self.assertIsInstance(svc, PipelineServices)
        self.assertIs(svc.documents, self.docs)


if __name__ == "__main__":
    unittest.main()
