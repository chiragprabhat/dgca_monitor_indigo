import threading
import unittest
from unittest import mock

from pipeline import scheduler, storage
from pipeline.scheduler import loop

from .helpers import PostgresTestCase, make_config, make_pub, temp_paths


class RunOnceTests(PostgresTestCase):
    def test_empty_cycle_succeeds_and_creates_the_database(self):
        paths = temp_paths()
        result = scheduler.run_once(publications=[], config=make_config(), paths=paths)
        self.assertEqual((result["status"], result["discovered"], result["failed"]), ("success", 0, 0))
        with storage.get_connection() as conn:
            self.assertEqual(storage.get_all(conn), [])

    def test_malformed_record_is_reported_not_raised(self):
        paths = temp_paths()
        result = scheduler.run_once(publications=[{"category": "Regulation"}], config=make_config(), paths=paths)
        self.assertEqual((result["status"], result["failed"]), ("completed_with_errors", 1))
        self.assertEqual(result["errors"][0]["stage"], "detect")

    def test_cycle_failure_becomes_an_error_result(self):
        with mock.patch("pipeline.scheduler.cycle.storage.init_db", side_effect=RuntimeError("disk full")):
            result = scheduler.run_once(publications=[], config=make_config(), paths=temp_paths())
        self.assertEqual(result["status"], "error")
        self.assertIn("disk full", result["error"])


class RunSchedulerTests(unittest.TestCase):
    def test_runs_max_cycles_then_stops(self):
        with mock.patch.object(loop, "run_once") as fake:
            loop.run_scheduler(check_interval_minutes=0, max_cycles=3, paths=temp_paths())
        self.assertEqual(fake.call_count, 3)

    def test_a_crashing_cycle_does_not_end_the_loop(self):
        with mock.patch.object(loop, "run_once", side_effect=RuntimeError("x")) as fake:
            loop.run_scheduler(check_interval_minutes=0, max_cycles=2, paths=temp_paths())
        self.assertEqual(fake.call_count, 2)

    def test_stop_event_stops_the_loop_between_cycles(self):
        stop = threading.Event()
        calls = []

        def fake_run_once(**kw):
            calls.append(1)
            stop.set()

        with mock.patch.object(loop, "run_once", side_effect=fake_run_once):
            thread = threading.Thread(target=loop.run_scheduler,
                                      kwargs=dict(check_interval_minutes=5, stop_event=stop, paths=temp_paths()))
            thread.start()
            thread.join(timeout=10)
        self.assertFalse(thread.is_alive())
        self.assertEqual(len(calls), 1)


class RetryAndDiagnosticsTests(PostgresTestCase):
    def test_retry_with_nothing_failed_is_a_noop(self):
        result = scheduler.retry_failed_notifications(config=make_config(), paths=temp_paths())
        self.assertEqual((result["retried"], result["publication_ids"]), (0, []))

    def test_email_configuration_check_reports_presence_only(self):
        report = scheduler.check_email_configuration(make_config(smtp_password="super-secret"), paths=temp_paths())
        self.assertNotIn("super-secret", str(report))
        self.assertFalse(report["smtp_configured"])

    def test_retry_picks_up_failed_unsent_rows(self):
        paths = temp_paths()
        storage.init_db()
        conn = storage.get_connection()
        storage.ingest_publication(conn, make_pub(pdf=None))
        storage.mark_failed(conn, "regulation-A")
        conn.close()
        with mock.patch("pipeline.scheduler.retry.run_dgca_pipeline") as fake_run:
            fake_run.return_value = mock.Mock(failed=0, total=1, success=1)
            result = scheduler.retry_failed_notifications(config=make_config(), paths=paths)
        self.assertEqual(result["publication_ids"], ["regulation-A"])
        self.assertTrue(fake_run.call_args.kwargs["retry_failed"])


if __name__ == "__main__":
    unittest.main()
