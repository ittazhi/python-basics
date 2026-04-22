from __future__ import annotations

import re
import unicodedata
from collections import Counter
from datetime import datetime, timezone
from typing import Iterable

from .models import LabelFact, SampleSnapshotPayload

WHITESPACE_RE = re.compile(r"\s+")
SEPARATOR_RE = re.compile(r"[-_/,:;|()（）\[\]{}<>【】、，。；：'\"`~!@#$%^&*+=?]+")
DIGIT_RE = re.compile(r"\d+")


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def simplify_display_text(text: str) -> str:
    collapsed = WHITESPACE_RE.sub(" ", unicodedata.normalize("NFKC", str(text or "")).strip())
    return collapsed[:400]


def normalize_text(text: str) -> str:
    normalized = unicodedata.normalize("NFKC", str(text or "")).strip().lower()
    normalized = WHITESPACE_RE.sub("", normalized)
    normalized = SEPARATOR_RE.sub("", normalized)
    return normalized


def is_long_digit_like(text: str) -> bool:
    normalized = normalize_text(text)
    digits = "".join(DIGIT_RE.findall(normalized))
    return bool(normalized) and len(normalized) >= 8 and digits == normalized


def count_label_types(labels: Iterable[LabelFact]) -> dict[str, int]:
    counter: Counter[str] = Counter()
    for label in labels:
        if label.label_type:
            counter[label.label_type] += 1
    return dict(counter)


def build_context_terms(snapshot: SampleSnapshotPayload | None) -> list[str]:
    if snapshot is None:
        return []

    terms: list[str] = []
    for value in (
        snapshot.site_id,
        snapshot.page_identity,
        snapshot.target_label_type,
        snapshot.target_region,
    ):
        if value:
            terms.append(simplify_display_text(value))
            normalized = normalize_text(value)
            if normalized:
                terms.append(normalized)

    for label in snapshot.visible_labels:
        for value in (label.label_type, label.attr, label.region):
            if value:
                terms.append(simplify_display_text(value))
                normalized = normalize_text(value)
                if normalized:
                    terms.append(normalized)
        if label.value:
            clean = simplify_display_text(label.value)
            terms.append(clean)
            normalized_value = normalize_text(label.value)
            if normalized_value:
                terms.append(normalized_value)

    for text in snapshot.neighbor_texts:
        clean = simplify_display_text(text)
        if clean:
            terms.append(clean)
        normalized = normalize_text(text)
        if normalized:
            terms.append(normalized)

    deduped: list[str] = []
    seen: set[str] = set()
    for term in terms:
        compact = term.strip()
        if not compact or compact in seen:
            continue
        seen.add(compact)
        deduped.append(compact[:120])
    return deduped
