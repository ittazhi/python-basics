from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
from difflib import SequenceMatcher
from typing import Any, Optional

from .models import SampleSnapshotPayload, SearchRequest, SuggestionRequest
from .normalization import (
    canonical_label_type,
    classify_value,
    count_label_types,
    is_long_digit_like,
    normalize_text,
    same_value_family,
    value_family,
)
from .storage import Storage


def _parse_iso(ts: str) -> Optional[datetime]:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


def _overlap_ratio(left: Counter[str], right: Counter[str]) -> float:
    if not left or not right:
        return 0.0
    common = 0
    total = 0
    keys = set(left) | set(right)
    for key in keys:
        common += min(left.get(key, 0), right.get(key, 0))
        total += max(left.get(key, 0), right.get(key, 0))
    if total == 0:
        return 0.0
    return common / total


def _canonical_counts(counts: dict[str, int]) -> Counter[str]:
    canonical: Counter[str] = Counter()
    for label_type, count in counts.items():
        normalized_type = canonical_label_type(label_type)
        if normalized_type:
            canonical[normalized_type] += count
    return canonical


def _label_sequence(labels: list[Any]) -> list[str]:
    sequence: list[str] = []
    for label in labels:
        if isinstance(label, dict):
            label_type = label.get("label_type", "")
        else:
            label_type = getattr(label, "label_type", "")
        canonical = canonical_label_type(label_type)
        if canonical:
            sequence.append(canonical)
    return sequence


def _sequence_similarity(left: list[str], right: list[str]) -> float:
    if not left or not right:
        return 0.0
    return SequenceMatcher(None, left, right).ratio()


def _label_similarity(left: str, right: str) -> float:
    left_normalized = canonical_label_type(left)
    right_normalized = canonical_label_type(right)
    if not left_normalized or not right_normalized:
        return 0.0
    if left_normalized == right_normalized:
        return 1.0
    return SequenceMatcher(None, left_normalized, right_normalized).ratio()


def _field_count_similarity(left: list[str], right: list[str]) -> float:
    if not left or not right:
        return 0.0
    smaller = min(len(left), len(right))
    larger = max(len(left), len(right))
    if larger == 0:
        return 0.0
    return smaller / larger


def _field_position_similarity(
    current_type: str,
    current_sequence: list[str],
    source_type: str,
    source_sequence: list[str],
) -> float:
    if len(current_sequence) < 2 or len(source_sequence) < 2:
        return 0.0
    current_key = canonical_label_type(current_type)
    source_key = canonical_label_type(source_type)
    if not current_key or not source_key:
        return 0.0
    if current_key not in current_sequence or source_key not in source_sequence:
        return 0.0
    current_index = current_sequence.index(current_key)
    source_index = source_sequence.index(source_key)
    current_ratio = current_index / max(len(current_sequence) - 1, 1)
    source_ratio = source_index / max(len(source_sequence) - 1, 1)
    return max(0.0, 1.0 - abs(current_ratio - source_ratio))


def _char_coverage(query: str, candidate: str) -> float:
    if not query or not candidate:
        return 0.0
    query_counts = Counter(query)
    candidate_counts = Counter(candidate)
    matched = sum(min(count, candidate_counts.get(char, 0)) for char, count in query_counts.items())
    return matched / max(len(query), 1)


def _best_window_similarity(query: str, candidate: str) -> float:
    if not query or not candidate:
        return 0.0
    if len(candidate) <= len(query):
        return SequenceMatcher(None, query, candidate).ratio()
    window_size = min(len(candidate), max(len(query) + 2, 4))
    best = 0.0
    for start in range(0, len(candidate) - window_size + 1):
        ratio = SequenceMatcher(None, query, candidate[start : start + window_size]).ratio()
        if ratio > best:
            best = ratio
    return best


def _bounded_edit_distance(left: str, right: str, limit: int = 1) -> int:
    if abs(len(left) - len(right)) > limit:
        return limit + 1
    previous = list(range(len(right) + 1))
    for i, left_char in enumerate(left, start=1):
        current = [i]
        row_min = current[0]
        for j, right_char in enumerate(right, start=1):
            cost = 0 if left_char == right_char else 1
            current.append(
                min(
                    previous[j] + 1,
                    current[j - 1] + 1,
                    previous[j - 1] + cost,
                )
            )
            row_min = min(row_min, current[-1])
        if row_min > limit:
            return limit + 1
        previous = current
    return previous[-1]


class SuggestionEngine:
    def __init__(self, storage: Storage) -> None:
        self.storage = storage

    def suggest(self, request: SuggestionRequest) -> list[dict[str, Any]]:
        return self._rank(
            snapshot=request.sample_snapshot,
            query=request.sample_snapshot.current_input,
            limit=request.limit,
            search_mode=False,
        )

    def search(self, request: SearchRequest) -> list[dict[str, Any]]:
        return self._rank(
            snapshot=request.sample_snapshot,
            query=request.query,
            limit=request.limit,
            search_mode=True,
        )

    def _rank(
        self,
        snapshot: Optional[SampleSnapshotPayload],
        query: str,
        limit: int,
        search_mode: bool,
    ) -> list[dict[str, Any]]:
        normalized_query = normalize_text(query)
        include_weak = search_mode or bool(normalized_query)
        # Fetch broadly, then rank in Python. This keeps light typo/missing-char
        # tolerance from being defeated by a strict SQL substring prefilter.
        candidate_limit = 700 if search_mode else 350
        candidates = self.storage.fetch_candidate_bundles(
            include_weak=include_weak,
            query="",
            limit=candidate_limit,
            sources_per_candidate=6,
        )
        current_type = snapshot.target_label_type if snapshot else ""
        current_canonical_type = canonical_label_type(current_type)
        current_region = snapshot.target_region if snapshot else ""
        current_counts = (
            _canonical_counts(snapshot.label_type_counts or count_label_types(snapshot.visible_labels))
            if snapshot
            else Counter()
        )
        current_label_types = set()
        for label in (snapshot.visible_labels if snapshot else []):
            label_type = canonical_label_type(label.label_type)
            if label_type:
                current_label_types.add(label_type)
        current_sequence = _label_sequence(snapshot.visible_labels) if snapshot else []
        current_label_values = {
            normalize_text(label.value)
            for label in (snapshot.visible_labels if snapshot else [])
            if label.value
        }
        current_neighbors = {
            normalize_text(text)
            for text in (snapshot.neighbor_texts if snapshot else [])
            if normalize_text(text)
        }
        results: list[dict[str, Any]] = []

        for candidate in candidates:
            if candidate["blacklisted"]:
                continue
            score = 24.0 if candidate["tier"] == "strong" else 8.0
            reasons: list[str] = []
            input_score, input_reasons = self._score_input_match(
                query=normalized_query,
                candidate_text=candidate["normalized_text"],
                raw_text=candidate["text"],
                search_mode=search_mode,
            )
            if normalized_query:
                score += input_score
                reasons.extend(input_reasons)
                if is_long_digit_like(query) and is_long_digit_like(candidate["text"]) and input_score <= 0:
                    continue
                if input_score <= 0 and candidate["tier"] == "weak":
                    continue
            elif candidate["tier"] != "strong" and not search_mode:
                continue

            best_source_score = 0.0
            best_source: dict[str, Any] | None = None
            best_source_reasons: list[str] = []
            for source in candidate["sources"]:
                source_score, source_reasons = self._score_source(
                    current_type=current_type,
                    current_canonical_type=current_canonical_type,
                    current_region=current_region,
                    current_counts=current_counts,
                    current_label_types=current_label_types,
                    current_sequence=current_sequence,
                    current_label_values=current_label_values,
                    current_neighbors=current_neighbors,
                    source=source,
                )
                if source_score > best_source_score:
                    best_source_score = source_score
                    best_source = source
                    best_source_reasons = source_reasons

            compatibility_score, compatibility_reasons = self._score_value_shape_support(
                current_type=current_type,
                current_input=query,
                snapshot=snapshot,
                candidate_text=candidate["text"],
                best_source=best_source,
            )

            score += best_source_score
            score += compatibility_score
            reasons.extend(best_source_reasons)
            reasons.extend(compatibility_reasons)
            score += min(candidate["accept_count"] * 2.5, 12.0)
            if candidate["accept_count"]:
                reasons.append("frequently accepted")
            score -= candidate["edit_after_accept_count"] * 4.0
            score -= candidate["dismiss_count"] * 1.0

            last_used = _parse_iso(candidate["last_used_at"])
            if last_used:
                age_days = max((datetime.now(timezone.utc) - last_used).days, 0)
                if age_days <= 3:
                    score += 6.0
                    reasons.append("recently reused")
                elif age_days <= 14:
                    score += 2.0

            if not normalized_query and best_source_score < self._empty_input_context_threshold(current_sequence) and not search_mode:
                continue
            if normalized_query and input_score < 6.0 and best_source_score < 14.0 and not search_mode:
                continue
            if search_mode and normalized_query and input_score <= 0 and best_source_score <= 6.0:
                continue

            results.append(
                {
                    "candidate_id": candidate["candidate_id"],
                    "text": candidate["text"],
                    "tier": candidate["tier"],
                    "score": round(score, 2),
                    "reasons": self._dedupe_reasons(reasons),
                    "source_preview": self._source_preview(best_source),
                    "source_details": self._source_details(candidate["sources"][:4]),
                    "label_types": candidate["label_types"],
                    "accept_count": candidate["accept_count"],
                    "last_used_at": candidate["last_used_at"],
                }
            )

        results.sort(key=lambda item: (-item["score"], item["text"]))
        return results[: max(1, min(limit, 20))]

    def _score_input_match(
        self,
        query: str,
        candidate_text: str,
        raw_text: str,
        search_mode: bool,
    ) -> tuple[float, list[str]]:
        if not query:
            return 0.0, []
        if not candidate_text:
            return 0.0, []

        reasons: list[str] = []
        score = 0.0

        if candidate_text.startswith(query):
            score += 30.0
            reasons.append("prefix match")
        elif query in candidate_text:
            score += 22.0
            reasons.append("substring match")

        if is_long_digit_like(raw_text):
            return score, reasons

        if len(query) >= 3:
            distance = _bounded_edit_distance(query, candidate_text[: len(query)], limit=1)
            if distance <= 1:
                score += 8.0 if not search_mode else 10.0
                reasons.append("light typo tolerance")
            else:
                ratio = _best_window_similarity(query, candidate_text)
                if ratio >= 0.78:
                    score += 9.0 if search_mode else 7.0
                    reasons.append("near text match")

            coverage = _char_coverage(query, candidate_text)
            if coverage >= 0.86 and len(query) >= 4:
                score += 8.0 if search_mode else 5.0
                reasons.append("character overlap")
            elif coverage >= 0.72 and search_mode and len(query) >= 4:
                score += 4.0
                reasons.append("loose character overlap")

        return score, reasons

    def _score_source(
        self,
        current_type: str,
        current_canonical_type: str,
        current_region: str,
        current_counts: Counter[str],
        current_label_types: set[str],
        current_sequence: list[str],
        current_label_values: set[str],
        current_neighbors: set[str],
        source: dict[str, Any],
    ) -> tuple[float, list[str]]:
        score = 0.0
        reasons: list[str] = []
        source_canonical_type = canonical_label_type(source.get("source_label_type", ""))
        if current_canonical_type and source_canonical_type:
            if current_canonical_type == source_canonical_type:
                score += 22.0
                reasons.append("same label key")
            else:
                similarity = _label_similarity(current_type, source.get("source_label_type", ""))
                if similarity >= 0.82:
                    score += similarity * 10.0
                    reasons.append("similar label text")
                else:
                    score -= 4.0

        if current_region and source.get("source_region"):
            if current_region == source["source_region"]:
                score += 10.0
                reasons.append("same target region")

        sample_snapshot = source.get("sample_snapshot") or {}
        source_counts = _canonical_counts(sample_snapshot.get("label_type_counts") or {})
        if current_counts and source_counts:
            overlap = _overlap_ratio(current_counts, source_counts)
            if overlap > 0:
                score += overlap * 14.0
                reasons.append("similar label distribution")

        source_labels = sample_snapshot.get("visible_labels") or []
        source_label_types = set()
        for label in source_labels:
            label_type = canonical_label_type(label.get("label_type", ""))
            if label_type:
                source_label_types.add(label_type)
        if current_label_types and source_label_types:
            label_overlap = len(current_label_types & source_label_types) / max(
                len(current_label_types | source_label_types), 1
            )
            if label_overlap > 0:
                score += label_overlap * 10.0
                reasons.append("overlapping label types")

        source_sequence = _label_sequence(source_labels)
        count_similarity = _field_count_similarity(current_sequence, source_sequence)
        if count_similarity >= 0.8:
            score += count_similarity * 4.0
            reasons.append("similar field count")

        sequence_similarity = _sequence_similarity(current_sequence, source_sequence)
        if sequence_similarity >= 0.72:
            score += sequence_similarity * 12.0
            reasons.append("similar task structure")

        position_similarity = _field_position_similarity(
            current_type=current_type,
            current_sequence=current_sequence,
            source_type=source.get("source_label_type", ""),
            source_sequence=source_sequence,
        )
        if position_similarity >= 0.8:
            score += position_similarity * 12.0
            reasons.append("similar field position")

        source_values = {
            normalize_text(label.get("value", ""))
            for label in source_labels
            if normalize_text(label.get("value", ""))
        }
        shared_values = current_label_values & source_values
        if shared_values:
            score += min(len(shared_values) * 4.0, 12.0)
            reasons.append("matching label contents")

        source_neighbor_terms = {
            normalize_text(text)
            for text in (sample_snapshot.get("neighbor_texts") or [])
            if normalize_text(text)
        }
        neighbor_overlap = current_neighbors & source_neighbor_terms
        if neighbor_overlap:
            score += min(len(neighbor_overlap) * 3.0, 9.0)
            reasons.append("neighbor text overlap")

        if sample_snapshot.get("page_identity") and source.get("page_identity"):
            if sample_snapshot["page_identity"] == source["page_identity"]:
                score += 4.0
                reasons.append("same page identity")

        return score, reasons

    def _empty_input_context_threshold(self, current_sequence: list[str]) -> float:
        if len(current_sequence) >= 2:
            return 12.0
        return 18.0

    def _score_value_shape_support(
        self,
        current_type: str,
        current_input: str,
        snapshot: Optional[SampleSnapshotPayload],
        candidate_text: str,
        best_source: Optional[dict[str, Any]],
    ) -> tuple[float, list[str]]:
        candidate_kind = classify_value(candidate_text)
        input_kind = classify_value(current_input)
        score = 0.0
        reasons: list[str] = []

        if current_input and input_kind != "empty":
            if candidate_kind == input_kind:
                score += 6.0
                reasons.append("same input shape")
            elif same_value_family(candidate_kind, input_kind):
                score += 3.0
                reasons.append("same input family")
            else:
                score -= 6.0
                reasons.append("different input shape")

        current_label_key = canonical_label_type(current_type)
        same_label_values = []
        if current_label_key:
            for label in (snapshot.visible_labels if snapshot else []):
                if canonical_label_type(label.label_type) == current_label_key and label.value:
                    same_label_values.append(label.value)
        same_label_kinds = {classify_value(value) for value in same_label_values}
        if same_label_kinds:
            if candidate_kind in same_label_kinds:
                score += 6.0
                reasons.append("same label value shape")
            elif value_family(candidate_kind) in {value_family(kind) for kind in same_label_kinds}:
                score += 2.0
                reasons.append("same label value family")
            else:
                score -= 5.0
                reasons.append("different label value shape")

        if best_source and _label_similarity(current_type, best_source.get("source_label_type", "")) >= 0.82:
            score += 3.0
            reasons.append("shape backed by similar label")

        return score, reasons

    def _source_preview(self, source: Optional[dict[str, Any]]) -> str:
        if not source:
            return ""
        parts = [source.get("source_label_type", ""), source.get("source_region", ""), source.get("page_identity", "")]
        return " | ".join(part for part in parts if part)

    def _source_details(self, sources: list[dict[str, Any]]) -> list[dict[str, Any]]:
        details: list[dict[str, Any]] = []
        for source in sources:
            sample_snapshot = source.get("sample_snapshot") or {}
            details.append(
                {
                    "source_kind": source.get("source_kind", ""),
                    "source_label_type": source.get("source_label_type", ""),
                    "source_region": source.get("source_region", ""),
                    "page_identity": source.get("page_identity", ""),
                    "captured_at": source.get("created_at", ""),
                    "neighbor_texts": sample_snapshot.get("neighbor_texts", [])[:5],
                    "label_type_counts": sample_snapshot.get("label_type_counts", {}),
                }
            )
        return details

    def _dedupe_reasons(self, reasons: list[str]) -> list[str]:
        seen: set[str] = set()
        deduped: list[str] = []
        for reason in reasons:
            if not reason or reason in seen:
                continue
            seen.add(reason)
            deduped.append(reason)
        return deduped[:5]
