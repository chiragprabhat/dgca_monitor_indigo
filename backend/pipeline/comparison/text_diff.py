"""Sentence-level diff engine. Whitespace is normalized away BEFORE
sentence-splitting, which is what keeps PDF line-wrap artifacts from ever
becoming a reported diff hunk -- don't reintroduce paragraph- or line-based
splitting without preserving that ordering."""
import difflib
import re
from dataclasses import dataclass, field
from typing import List, Tuple


def normalize_for_diff(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.;:])\s+")


def split_into_units(text: str, min_len: int = 8) -> List[str]:
    normalized = normalize_for_diff(text)
    raw_units = _SENTENCE_SPLIT_RE.split(normalized)
    return [u.strip() for u in raw_units if len(u.strip()) >= min_len]


@dataclass
class DiffResult:
    added: List[str] = field(default_factory=list)
    removed: List[str] = field(default_factory=list)
    modified: List[Tuple[str, str]] = field(default_factory=list)
    unchanged_count: int = 0


def diff_documents(old_text: str, new_text: str) -> DiffResult:
    old_units = split_into_units(old_text)
    new_units = split_into_units(new_text)

    matcher = difflib.SequenceMatcher(None, old_units, new_units, autojunk=False)
    result = DiffResult()

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            result.unchanged_count += (i2 - i1)
        elif tag == "insert":
            result.added.extend(new_units[j1:j2])
        elif tag == "delete":
            result.removed.extend(old_units[i1:i2])
        elif tag == "replace":
            old_chunk = old_units[i1:i2]
            new_chunk = new_units[j1:j2]
            paired = min(len(old_chunk), len(new_chunk))
            for k in range(paired):
                result.modified.append((old_chunk[k], new_chunk[k]))
            if len(old_chunk) > paired:
                result.removed.extend(old_chunk[paired:])
            if len(new_chunk) > paired:
                result.added.extend(new_chunk[paired:])

    return result
