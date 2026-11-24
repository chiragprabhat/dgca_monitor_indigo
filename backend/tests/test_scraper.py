import unittest

from pipeline import scraper
from pipeline.scraper import CategorySource


class _FakeResponse:
    encoding = "utf-8"

    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


class _FakeSession:
    def __init__(self, payload):
        self.payload = payload

    def post(self, url, params=None, timeout=None):
        return _FakeResponse(self.payload)


class ParsingTests(unittest.TestCase):
    def test_dates_are_normalised(self):
        self.assertEqual(scraper.normalize_date("05/01/2026"), "2026-01-05")
        self.assertEqual(scraper.normalize_date("05.01.2026"), "2026-01-05")
        self.assertIsNone(scraper.normalize_date("junk"))

    def test_source_id_and_pdf_url(self):
        self.assertEqual(scraper.make_source_id("Regulation", "abc%2Fdef=="), "regulation-abcdef")
        self.assertIn("attachId=XYZ", scraper.build_pdf_url("XYZ"))


class SourceTests(unittest.TestCase):
    def test_ajax_category_parses_parallel_arrays(self):
        session = _FakeSession({"contents": [" Title A "], "startDate": ["05/01/2026"], "attachId": ["id1"]})
        pubs = scraper.fetch_ajax_category(session, "Regulation")
        self.assertEqual((pubs[0].title, pubs[0].published_date, pubs[0].source_id),
                         ("Title A", "2026-01-05", "regulation-id1"))

    def test_mismatched_arrays_are_truncated_not_crashed(self):
        session = _FakeSession({"contents": ["A", "B"], "startDate": ["05/01/2026"], "attachId": ["i1", "i2"]})
        self.assertEqual(len(scraper.fetch_ajax_category(session, "Guidance")), 1)

    def test_one_failing_source_does_not_stop_the_others(self):
        class Boom(CategorySource):
            category = "Boom"

            def fetch(self, session):
                raise RuntimeError("changed page")

        class Fine(CategorySource):
            category = "Fine"

            def fetch(self, session):
                return scraper.fetch_ajax_category(session, "Fine")

        session = _FakeSession({"contents": ["A"], "startDate": ["05/01/2026"], "attachId": ["i1"]})
        result = scraper.scrape_whats_new(session, sources=[Boom(), Fine()])
        self.assertEqual((result.failed_categories, result.category_counts), (["Boom"], {"Fine": 1}))

    def test_default_sources_cover_every_category(self):
        self.assertEqual([s.category for s in scraper.DEFAULT_SOURCES], scraper.ALL_CATEGORIES)


if __name__ == "__main__":
    unittest.main()
