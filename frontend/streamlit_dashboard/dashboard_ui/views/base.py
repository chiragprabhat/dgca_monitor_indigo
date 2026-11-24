from abc import ABC, abstractmethod

from ..context import DashboardContext


class Page(ABC):
    """One dashboard page. `title` is the sidebar label; `render()` draws the
    page from the context and never writes to the database."""

    title: str

    @abstractmethod
    def render(self, ctx: DashboardContext) -> None:
        raise NotImplementedError
