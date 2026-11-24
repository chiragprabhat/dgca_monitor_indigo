from psycopg import Connection
from dataclasses import dataclass

from pipeline.config import PipelineConfig
from pipeline.paths import ProjectPaths


@dataclass
class DashboardContext:
    """Everything a view needs, handed in by app.py. Views never open their
    own connections or read configuration themselves, so they depend on
    this one small object rather than on how it was built."""

    config: PipelineConfig
    conn: Connection  # read-only: PostgreSQL rejects writes in the transaction
    paths: ProjectPaths
