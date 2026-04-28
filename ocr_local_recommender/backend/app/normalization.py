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
DATE_LIKE_RE = re.compile(r"^\d{4}(?:\d{2}){0,2}$")
CJK_RE = re.compile(r"[\u3400-\u9fff]")
LATIN_RE = re.compile(r"[a-z]")


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def simplify_display_text(text: str) -> str:
    cleaned = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    cleaned = re.sub(r"[ \t\f\v]+", " ", cleaned)
    cleaned = re.sub(r" *\n *", "\n", cleaned).strip()
    return cleaned[:400]


def normalize_text(text: str) -> str:
    normalized = unicodedata.normalize("NFKC", str(text or "")).strip().lower()
    normalized = WHITESPACE_RE.sub("", normalized)
    normalized = SEPARATOR_RE.sub("", normalized)
    return normalized


def canonical_label_type(label_type: str) -> str:
    normalized = normalize_text(label_type)
    return normalized[:80]


def classify_value(text: str) -> str:
    normalized = normalize_text(text)
    if not normalized:
        return "empty"
    digits = "".join(DIGIT_RE.findall(normalized))
    has_digit = any(char.isdigit() for char in normalized)
    has_cjk = bool(CJK_RE.search(normalized))
    has_latin = bool(LATIN_RE.search(normalized))

    if digits == normalized:
        if DATE_LIKE_RE.match(normalized) and len(normalized) in {6, 8}:
            return "date_like"
        if len(normalized) <= 4:
            return "numeric_short"
        if len(normalized) <= 10:
            return "numeric_medium"
        return "numeric_long"
    if has_digit and (has_latin or has_cjk):
        return "mixed_alphanumeric"
    if has_digit:
        return "mixed_numeric"
    if has_cjk and not has_latin:
        return "cjk_text_short" if len(normalized) <= 6 else "cjk_text_long"
    if has_latin and not has_cjk:
        return "latin_text_short" if len(normalized) <= 12 else "latin_text_long"
    return "text"


def same_value_family(left: str, right: str) -> bool:
    left_family = value_family(left)
    right_family = value_family(right)
    return bool(left_family and left_family == right_family)


def value_family(kind: str) -> str:
    if kind.startswith("numeric_") or kind == "date_like":
        return "numeric"
    if kind.startswith("cjk_text") or kind.startswith("latin_text") or kind == "text":
        return "text"
    if kind.startswith("mixed_"):
        return "mixed"
    return kind


def is_long_digit_like(text: str) -> bool:
    normalized = normalize_text(text)
    digits = "".join(DIGIT_RE.findall(normalized))
    return bool(normalized) and len(normalized) >= 8 and digits == normalized


def count_label_types(labels: Iterable[LabelFact]) -> dict[str, int]:
    counter: Counter[str] = Counter()
    for label in labels:
        label_type = canonical_label_type(label.label_type)
        if label_type:
            counter[label_type] += 1
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
        canonical_type = canonical_label_type(label.label_type)
        if canonical_type:
            terms.append(canonical_type)
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
