"""
Object-oriented face of the storage layer.

`PublicationStore` is the abstraction the orchestrator depends on (dependency
inversion): it states what the pipeline needs from persistence without saying
PostgreSQL. `PostgresPublicationStore` is the concrete implementation, a thin
adapter over the function-based API in this package, so there is still exactly
one implementation of every query.
"""
from psycopg import Connection
from psycopg.rows import DictRow
from typing import Any, Dict, List, Optional, Protocol

from .analysis_store import save_analysis_result
from .ingestion import IngestOutcome, ingest_publication
from .notifications import get_failed_unsent, mark_email_sent, mark_failed, update_document_hash


class PublicationStore(Protocol):
    def ingest(self, pub: Dict[str, Any]) -> IngestOutcome: ...

    def get_row(self, publication_id: str) -> Optional[DictRow]: ...

    def get_delivery_state(self, publication_id: str) -> Optional[DictRow]: ...

    def update_document_hash(self, publication_id: str, document_hash: str) -> None: ...

    def save_analysis(
        self,
        publication_id: str,
        analysis: Any,
        previous_publication_id: Optional[str] = None,
        comparison: Optional[Any] = None,
    ) -> None: ...

    def mark_email_sent(self, publication_id: str) -> None: ...

    def mark_failed(self, publication_id: str) -> None: ...

    def get_failed_unsent(self) -> List[DictRow]: ...


class PostgresPublicationStore:
    def __init__(self, conn: Connection):
        self._conn = conn

    def ingest(self, pub: Dict[str, Any]) -> IngestOutcome:
        return ingest_publication(self._conn, pub)

    def get_row(self, publication_id: str) -> Optional[DictRow]:
        return self._conn.execute(
            "SELECT * FROM publications WHERE publication_id = %s", (publication_id,)
        ).fetchone()

    def get_delivery_state(self, publication_id: str) -> Optional[DictRow]:
        return self._conn.execute(
            "SELECT status, email_sent FROM publications WHERE publication_id = %s", (publication_id,)
        ).fetchone()

    def update_document_hash(self, publication_id: str, document_hash: str) -> None:
        update_document_hash(self._conn, publication_id, document_hash)

    def save_analysis(
        self,
        publication_id: str,
        analysis: Any,
        previous_publication_id: Optional[str] = None,
        comparison: Optional[Any] = None,
    ) -> None:
        save_analysis_result(
            self._conn, publication_id, analysis,
            previous_publication_id=previous_publication_id, comparison=comparison,
        )

    def mark_email_sent(self, publication_id: str) -> None:
        mark_email_sent(self._conn, publication_id)

    def mark_failed(self, publication_id: str) -> None:
        mark_failed(self._conn, publication_id)

    def get_failed_unsent(self) -> List[DictRow]:
        return get_failed_unsent(self._conn)
