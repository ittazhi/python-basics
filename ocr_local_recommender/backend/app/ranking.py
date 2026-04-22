from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
from difflib import SequenceMatcher
from typing import Any, Optional

from .models import SampleSnapshotPayload, SearchRequest, SuggestionRequest
from .normalization import count_label_types, is_long_digit_like, normalize_text
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
        candidates = self.storage.fetch_candidate_bundles(include_weak=include_weak, query="")
        current_type = snapshot.target_label_type if snapshot else ""
        current_region = snapshot.target_region if snapshot else ""
        current_counts = Counter(snapshot.label_type_counts or count_label_types(snapshot.visible_labels)) if snapshot else Counter()
        current_label_types = {label.label_type for label in snapshot.visible_labels if label.label_type} if snapshot else set()
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
                    current_region=current_region,
                    current_counts=current_counts,
                    current_label_types=current_label_types,
                    current_label_values=current_label_values,
                    current_neighbors=current_neighbors,
                    source=source,
                )
                if source_score > best_source_score:
                    best_source_score = source_score
                    best_source = source
                    best_source_reasons = source_reasons

            score += best_source_score
            reasons.extend(best_source_reasons)
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

            if not normalized_query and best_source_score < 18.0 and not search_mode:
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
                ratio = SequenceMatcher(None, query, candidate_text[: max(len(query), 1)]).ratio()
                if ratio >= 0.78 and search_mode:
                    score += 7.0
                    reasons.append("fuzzy recall")

        return score, reasons

    def _score_source(
        self,
        current_type: str,
        current_region: str,
        current_counts: Counter[str],
        current_label_types: set[str],
        current_label_values: set[str],
        current_neighbors: set[str],
        source: dict[str, Any],
    ) -> tuple[float, list[str]]:
        score = 0.0
        reasons: list[str] = []
        if current_type and source.get("source_label_type"):
            if current_type == source["source_label_type"]:
                score += 18.0
                reasons.append("same target label type")
            else:
                score -= 2.0

        if current_region and source.get("source_region"):
            if current_region == source["source_region"]:
                score += 10.0
                reasons.append("same target region")

        sample_snapshot = source.get("sample_snapshot") or {}
        source_counts = Counter(sample_snapshot.get("label_type_counts") or {})
        if current_counts and source_counts:
            overlap = _overlap_ratio(current_counts, source_counts)
            if overlap > 0:
                score += overlap * 14.0
                reasons.append("similar label distribution")

        source_labels = sample_snapshot.get("visible_labels") or []
        source_label_types = {
            label.get("label_type", "")
            for label in source_labels
            if label.get("label_type")
        }
        if current_label_types and source_label_types:
            label_overlap = len(current_label_types & source_label_types) / max(
                len(current_label_types | source_label_types), 1
            )
            if label_overlap > 0:
                score += label_overlap * 10.0
                reasons.append("overlapping label types")

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
