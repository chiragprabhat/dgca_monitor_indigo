"""Shared fixtures for the backend tests: a temp project layout, fake
collaborators for the orchestrator, and a recording email sender."""
import os
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit
from uuid import uuid4

from psycopg import sql
from pathlib import Path

from pipeline import storage
from pipeline.config import PipelineConfig
from pipeline.documents import DocumentProcessingResult
from pipeline.email_pipeline import EmailSender, EmailSendResult
from pipeline.paths import ProjectPaths

DGCA_URL = "https://www.dgca.gov.in/digigov-portal/"


def temp_paths() -> ProjectPaths:
    return ProjectPaths(root=Path(tempfile.mkdtemp(prefix="dgca_test_")))


def make_config(**overrides) -> PipelineConfig:
    base = dict(llm_provider="fallback", email_provider="preview", test_mode=False)
    base.update(overrides)
    return PipelineConfig(**base)


def make_pub(source_id="regulation-A", title="CAR Section 7 Series J Part III", pdf="https://example.test/a.pdf",
             category="Regulation", date="2026-01-05"):
    return {"source_id": source_id, "title": title, "category": category, "published_date": date,
            "publication_url": DGCA_URL, "pdf_url": pdf}


class PostgresTestCase(unittest.TestCase):
    def setUp(self):
        url = os.environ.get("TEST_DATABASE_URL")
        if not url:
            self.skipTest("Set TEST_DATABASE_URL to a disposable direct PostgreSQL connection")
        schema = "dgca_test_" + uuid4().hex
        with storage.get_connection(url) as conn:
            conn.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))

        def drop_schema():
            with storage.get_connection(url) as conn:
                conn.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))

        self.addCleanup(drop_schema)
        parts = urlsplit(url)
        query = dict(parse_qsl(parts.query))
        query["options"] = f"-c search_path={schema}"
        self.enterContext(patch.dict(os.environ, DATABASE_URL=urlunsplit(parts._replace(query=urlencode(query, quote_via=quote)))))


def open_store_conn():
    storage.init_db()
    return storage.get_connection()


class FakeDocuments:
    """Writes `texts[pdf_url]` as the extracted text instead of downloading."""

    def __init__(self, texts):
        self.texts = texts
        self.calls = []

    def process(self, publication_id, pdf_url, documents_dir, ocr_available, raw_bytes_override=None):
        self.calls.append(publication_id)
        documents_dir.mkdir(parents=True, exist_ok=True)
        text_path = documents_dir / f"{publication_id}.txt"
        text_path.write_text(self.texts[pdf_url], encoding="utf-8")
        return DocumentProcessingResult(publication_id, pdf_url, "success", text_path=str(text_path),
                                        document_hash=f"hash-of-{pdf_url}")


class RecordingSender(EmailSender):
    provider_name = "recording"

    def __init__(self, succeed=True):
        self.succeed = succeed
        self.sent = []

    def is_configured(self):
        return True

    def send(self, subject, html_body, recipient):
        self.sent.append((subject, html_body, recipient))
        return EmailSendResult(self.succeed, self.provider_name, "ok" if self.succeed else "simulated failure")
