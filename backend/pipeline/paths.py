"""
Where the backend keeps its files.

One place defines the on-disk layout (config, documents, previews,
logs) so no other module computes `Path(__file__).parent.parent...` on its
own. Everything that touches the filesystem takes a `ProjectPaths` (or one of
its directories) as a parameter, which keeps those modules independent of
where the project happens to be checked out and lets tests point them at a
temporary directory.
"""
from dataclasses import dataclass
from pathlib import Path

# backend/pipeline/paths.py -> backend/
BACKEND_ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class ProjectPaths:
    root: Path = BACKEND_ROOT

    @property
    def env_path(self) -> Path:
        return self.root / "config" / ".env"

    @property
    def documents_dir(self) -> Path:
        return self.root / "data" / "documents"

    @property
    def preview_dir(self) -> Path:
        return self.root / "data" / "processed" / "email_previews"

    @property
    def logs_dir(self) -> Path:
        return self.root / "logs"


DEFAULT_PATHS = ProjectPaths()
