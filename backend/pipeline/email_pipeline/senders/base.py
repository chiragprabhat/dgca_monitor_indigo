from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional


@dataclass
class EmailSendResult:
    success: bool
    provider: str
    message: str
    detail: Optional[dict] = None


class EmailSender(ABC):
    provider_name: str = "unknown"

    @abstractmethod
    def is_configured(self) -> bool:
        raise NotImplementedError

    @abstractmethod
    def send(self, subject: str, html_body: str, recipient: str) -> EmailSendResult:
        raise NotImplementedError
