from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from pathlib import Path
from typing import Any, Optional

from .models import FeedbackRequest, SampleSnapshotPayload
from .normalization import (
    build_context_terms,
    count_label_types,
    normalize_text,
    simplify_display_text,
    utc_now_iso,
)


def _json_dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _json_load(text: str | None, default: Any) -> Any:
    if not text:
        return default
    return json.loads(text)


class Storage:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.memory_path = self.data_dir / "memory.db"
        self.history_path = self.data_dir / "history.db"
        self._lock = threading.RLock()
        self.memory_conn = sqlite3.connect(self.memory_path, check_same_thread=False)
        self.history_conn = sqlite3.connect(self.history_path, check_same_thread=False)
        self.memory_conn.row_factory = sqlite3.Row
        self.history_conn.row_factory = sqlite3.Row

    def initialize(self) -> None:
        with self._lock:
            for conn in (self.memory_conn, self.history_conn):
                conn.execute("PRAGMA journal_mode=WAL")
                conn.execute("PRAGMA synchronous=NORMAL")
                conn.execute("PRAGMA foreign_keys=ON")
            self._setup_memory_db()
            self._setup_history_db()

    def close(self) -> None:
        with self._lock:
            self.memory_conn.close()
            self.history_conn.close()

    def _setup_memory_db(self) -> None:
        self.memory_conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS candidate_value (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              normalized_text TEXT NOT NULL UNIQUE,
              display_text TEXT NOT NULL,
              tier TEXT NOT NULL CHECK (tier IN ('weak', 'strong')),
              first_seen_at TEXT NOT NULL,
              last_seen_at TEXT NOT NULL,
              repeat_count INTEGER NOT NULL DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS candidate_source (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              candidate_id INTEGER NOT NULL REFERENCES candidate_value(id) ON DELETE CASCADE,
              source_kind TEXT NOT NULL,
              source_label_type TEXT DEFAULT '',
              source_region TEXT DEFAULT '',
              source_attr TEXT DEFAULT '',
              sample_snapshot_id TEXT DEFAULT '',
              page_identity TEXT DEFAULT '',
              context_terms_json TEXT NOT NULL DEFAULT '[]',
              created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS candidate_stats (
              candidate_id INTEGER PRIMARY KEY REFERENCES candidate_value(id) ON DELETE CASCADE,
              source_count INTEGER NOT NULL DEFAULT 0,
              accept_count INTEGER NOT NULL DEFAULT 0,
              dismiss_count INTEGER NOT NULL DEFAULT 0,
              edit_after_accept_count INTEGER NOT NULL DEFAULT 0,
              blacklisted INTEGER NOT NULL DEFAULT 0,
              last_shown_at TEXT DEFAULT '',
              last_used_at TEXT DEFAULT ''
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS candidate_search USING fts5(
              candidate_id UNINDEXED,
              text,
              normalized_text,
              label_types,
              context_terms
            );
            """
        )
        self.memory_conn.commit()

    def _setup_history_db(self) -> None:
        self.history_conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS sample_snapshot (
              id TEXT PRIMARY KEY,
              site_id TEXT NOT NULL,
              page_identity TEXT NOT NULL,
              target_label_type TEXT NOT NULL,
              target_region TEXT NOT NULL,
              current_input TEXT NOT NULL,
              visible_labels_json TEXT NOT NULL,
              label_type_counts_json TEXT NOT NULL,
              neighbor_texts_json TEXT NOT NULL,
              unreadable_frames_json TEXT NOT NULL,
              context_terms_json TEXT NOT NULL,
              captured_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS raw_capture (
              id TEXT PRIMARY KEY,
              source_kind TEXT NOT NULL,
              text TEXT NOT NULL,
              normalized_text TEXT NOT NULL,
              sample_snapshot_id TEXT DEFAULT '',
              metadata_json TEXT NOT NULL,
              created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS event_log (
              id TEXT PRIMARY KEY,
              event_type TEXT NOT NULL,
              candidate_id INTEGER,
              sample_snapshot_id TEXT DEFAULT '',
              payload_json TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            """
        )
        self.history_conn.commit()

    def store_snapshot(self, snapshot: SampleSnapshotPayload) -> str:
        with self._lock:
            snapshot_id = str(uuid.uuid4())
            captured_at = snapshot.captured_at or utc_now_iso()
            label_counts = snapshot.label_type_counts or count_label_types(snapshot.visible_labels)
            visible_labels = [label.as_dict() for label in snapshot.visible_labels]
            context_terms = build_context_terms(snapshot)

            self.history_conn.execute(
                """
                INSERT INTO sample_snapshot (
                  id, site_id, page_identity, target_label_type, target_region, current_input,
                  visible_labels_json, label_type_counts_json, neighbor_texts_json,
                  unreadable_frames_json, context_terms_json, captured_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    snapshot_id,
                    snapshot.site_id,
                    snapshot.page_identity,
                    snapshot.target_label_type,
                    snapshot.target_region,
                    snapshot.current_input,
                    _json_dump(visible_labels),
                    _json_dump(label_counts),
                    _json_dump(snapshot.neighbor_texts),
                    _json_dump(snapshot.unreadable_frames),
                    _json_dump(context_terms),
                    captured_at,
                ),
            )
            self.history_conn.commit()
            return snapshot_id

    def capture_sample_snapshot(self, snapshot: SampleSnapshotPayload) -> str:
        return self.store_snapshot(snapshot)

    def capture_clipboard(
        self,
        text: str,
        sample_snapshot: Optional[SampleSnapshotPayload] = None,
        metadata: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        snapshot_id = self.store_snapshot(sample_snapshot) if sample_snapshot else ""
        candidate = self._capture_value(
            text=text,
            source_kind="clipboard",
            tier="weak",
            sample_snapshot=sample_snapshot,
            sample_snapshot_id=snapshot_id,
            metadata=metadata or {},
        )
        if candidate["source_count"] >= 2 and candidate["tier"] != "strong":
            self.promote_candidate(candidate["candidate_id"], reason="repeated_capture")
            candidate["tier"] = "strong"
        return candidate

    def capture_value_commit(
        self,
        text: str,
        sample_snapshot: SampleSnapshotPayload,
        source_kind: str = "page_commit",
    ) -> dict[str, Any]:
        snapshot_id = self.store_snapshot(sample_snapshot)
        return self._capture_value(
            text=text,
            source_kind=source_kind,
            tier="strong",
            sample_snapshot=sample_snapshot,
            sample_snapshot_id=snapshot_id,
            metadata={"source_kind": source_kind},
        )

    def _capture_value(
        self,
        text: str,
        source_kind: str,
        tier: str,
        sample_snapshot: Optional[SampleSnapshotPayload],
        sample_snapshot_id: str,
        metadata: dict[str, Any],
    ) -> dict[str, Any]:
        normalized = normalize_text(text)
        display_text = simplify_display_text(text)
        if not normalized or not display_text:
            return {
                "candidate_id": None,
                "normalized_text": "",
                "tier": tier,
                "source_count": 0,
            }

        now = utc_now_iso()
        metadata = dict(metadata)
        metadata.setdefault("display_text", display_text)

        with self._lock:
            raw_capture_id = str(uuid.uuid4())
            self.history_conn.execute(
                """
                INSERT INTO raw_capture (
                  id, source_kind, text, normalized_text, sample_snapshot_id, metadata_json, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    raw_capture_id,
                    source_kind,
                    display_text,
                    normalized,
                    sample_snapshot_id,
                    _json_dump(metadata),
                    now,
                ),
            )

            row = self.memory_conn.execute(
                "SELECT * FROM candidate_value WHERE normalized_text = ?",
                (normalized,),
            ).fetchone()
            if row is None:
                self.memory_conn.execute(
                    """
                    INSERT INTO candidate_value (
                      normalized_text, display_text, tier, first_seen_at, last_seen_at, repeat_count
                    )
                    VALUES (?, ?, ?, ?, ?, 1)
                    """,
                    (normalized, display_text, tier, now, now),
                )
                candidate_id = int(self.memory_conn.execute("SELECT last_insert_rowid()").fetchone()[0])
                self.memory_conn.execute(
                    "INSERT INTO candidate_stats (candidate_id, source_count) VALUES (?, 0)",
                    (candidate_id,),
                )
            else:
                candidate_id = int(row["id"])
                next_tier = "strong" if row["tier"] == "strong" or tier == "strong" else "weak"
                next_display = display_text if len(display_text) >= len(row["display_text"]) else row["display_text"]
                self.memory_conn.execute(
                    """
                    UPDATE candidate_value
                    SET display_text = ?, tier = ?, last_seen_at = ?, repeat_count = repeat_count + 1
                    WHERE id = ?
                    """,
                    (next_display, next_tier, now, candidate_id),
                )

            context_terms = build_context_terms(sample_snapshot)
            source_label_type = sample_snapshot.target_label_type if sample_snapshot else ""
            source_region = sample_snapshot.target_region if sample_snapshot else ""
            source_attr = ""
            page_identity = sample_snapshot.page_identity if sample_snapshot else ""
            self.memory_conn.execute(
                """
                INSERT INTO candidate_source (
                  candidate_id, source_kind, source_label_type, source_region, source_attr,
                  sample_snapshot_id, page_identity, context_terms_json, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    candidate_id,
                    source_kind,
                    source_label_type,
                    source_region,
                    source_attr,
                    sample_snapshot_id,
                    page_identity,
                    _json_dump(context_terms),
                    now,
                ),
            )
            self.memory_conn.execute(
                """
                UPDATE candidate_stats
                SET source_count = source_count + 1
                WHERE candidate_id = ?
                """,
                (candidate_id,),
            )
            self._rebuild_search_index(candidate_id)
            self.history_conn.commit()
            self.memory_conn.commit()
            return self.get_candidate_summary(candidate_id)

    def promote_candidate(self, candidate_id: int, reason: str = "manual") -> None:
        with self._lock:
            self.memory_conn.execute(
                "UPDATE candidate_value SET tier = 'strong' WHERE id = ?",
                (candidate_id,),
            )
            self.history_conn.execute(
                """
                INSERT INTO event_log (id, event_type, candidate_id, sample_snapshot_id, payload_json, created_at)
                VALUES (?, 'promote', ?, '', ?, ?)
                """,
                (str(uuid.uuid4()), candidate_id, _json_dump({"reason": reason}), utc_now_iso()),
            )
            self.memory_conn.commit()
            self.history_conn.commit()

    def record_feedback(self, request: FeedbackRequest) -> dict[str, Any]:
        snapshot_id = self.store_snapshot(request.sample_snapshot) if request.sample_snapshot else ""
        now = utc_now_iso()
        payload = dict(request.payload)
        if request.candidate_ids:
            payload.setdefault("candidate_ids", request.candidate_ids)

        with self._lock:
            self.history_conn.execute(
                """
                INSERT INTO event_log (id, event_type, candidate_id, sample_snapshot_id, payload_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    str(uuid.uuid4()),
                    request.event_type,
                    request.candidate_id,
                    snapshot_id,
                    _json_dump(payload),
                    now,
                ),
            )

            if request.event_type == "show" and request.candidate_ids:
                self.memory_conn.executemany(
                    """
                    UPDATE candidate_stats
                    SET last_shown_at = ?
                    WHERE candidate_id = ?
                    """,
                    [(now, candidate_id) for candidate_id in request.candidate_ids],
                )
            elif request.candidate_id is not None:
                if request.event_type == "accept":
                    self.memory_conn.execute(
                        """
                        UPDATE candidate_stats
                        SET accept_count = accept_count + 1, last_used_at = ?
                        WHERE candidate_id = ?
                        """,
                        (now, request.candidate_id),
                    )
                    self.promote_candidate(request.candidate_id, reason="accepted")
                elif request.event_type == "dismiss":
                    self.memory_conn.execute(
                        """
                        UPDATE candidate_stats
                        SET dismiss_count = dismiss_count + 1
                        WHERE candidate_id = ?
                        """,
                        (request.candidate_id,),
                    )
                elif request.event_type == "accept_then_edit":
                    self.memory_conn.execute(
                        """
                        UPDATE candidate_stats
                        SET edit_after_accept_count = edit_after_accept_count + 1
                        WHERE candidate_id = ?
                        """,
                        (request.candidate_id,),
                    )
                    edited_text = str(payload.get("edited_text", "")).strip()
                    if edited_text and request.sample_snapshot:
                        self._capture_value(
                            text=edited_text,
                            source_kind="edited_commit",
                            tier="strong",
                            sample_snapshot=request.sample_snapshot,
                            sample_snapshot_id=snapshot_id,
                            metadata={"derived_from_candidate_id": request.candidate_id},
                        )

            self.memory_conn.commit()
            self.history_conn.commit()
        return {"ok": True}

    def blacklist_candidate(self, candidate_id: int, blacklisted: bool) -> None:
        with self._lock:
            self.memory_conn.execute(
                """
                UPDATE candidate_stats
                SET blacklisted = ?
                WHERE candidate_id = ?
                """,
                (1 if blacklisted else 0, candidate_id),
            )
            self.history_conn.execute(
                """
                INSERT INTO event_log (id, event_type, candidate_id, sample_snapshot_id, payload_json, created_at)
                VALUES (?, ?, ?, '', ?, ?)
                """,
                (
                    str(uuid.uuid4()),
                    "blacklist" if blacklisted else "restore",
                    candidate_id,
                    _json_dump({}),
                    utc_now_iso(),
                ),
            )
            self.memory_conn.commit()
            self.history_conn.commit()

    def get_candidate_summary(self, candidate_id: int) -> dict[str, Any]:
        with self._lock:
            row = self.memory_conn.execute(
                """
                SELECT
                  cv.id,
                  cv.display_text,
                  cv.normalized_text,
                  cv.tier,
                  cv.first_seen_at,
                  cv.last_seen_at,
                  cv.repeat_count,
                  cs.source_count,
                  cs.accept_count,
                  cs.dismiss_count,
                  cs.edit_after_accept_count,
                  cs.blacklisted,
                  cs.last_shown_at,
                  cs.last_used_at
                FROM candidate_value cv
                JOIN candidate_stats cs ON cs.candidate_id = cv.id
                WHERE cv.id = ?
                """,
                (candidate_id,),
            ).fetchone()
            if row is None:
                raise KeyError(candidate_id)
            sources = self._fetch_sources([candidate_id]).get(candidate_id, [])
            return {
                "candidate_id": int(row["id"]),
                "text": row["display_text"],
                "normalized_text": row["normalized_text"],
                "tier": row["tier"],
                "first_seen_at": row["first_seen_at"],
                "last_seen_at": row["last_seen_at"],
                "repeat_count": int(row["repeat_count"]),
                "source_count": int(row["source_count"]),
                "accept_count": int(row["accept_count"]),
                "dismiss_count": int(row["dismiss_count"]),
                "edit_after_accept_count": int(row["edit_after_accept_count"]),
                "blacklisted": bool(row["blacklisted"]),
                "last_shown_at": row["last_shown_at"] or "",
                "last_used_at": row["last_used_at"] or "",
                "sources": sources,
                "label_types": sorted(
                    {
                        source["source_label_type"]
                        for source in sources
                        if source.get("source_label_type")
                    }
                ),
            }

    def fetch_candidate_bundles(
        self,
        include_weak: bool = True,
        query: str = "",
        include_blacklisted: bool = False,
    ) -> list[dict[str, Any]]:
        with self._lock:
            params: list[Any] = []
            clauses = []
            if not include_blacklisted:
                clauses.append("cs.blacklisted = 0")
            if not include_weak:
                clauses.append("cv.tier = 'strong'")
            normalized_query = normalize_text(query)
            if normalized_query:
                clauses.append("(cv.normalized_text LIKE ? OR cv.display_text LIKE ?)")
                params.extend([f"%{normalized_query}%", f"%{query.strip()}%"])
            where_clause = "WHERE " + " AND ".join(clauses) if clauses else ""

            rows = self.memory_conn.execute(
                f"""
                SELECT
                  cv.id,
                  cv.display_text,
                  cv.normalized_text,
                  cv.tier,
                  cv.first_seen_at,
                  cv.last_seen_at,
                  cv.repeat_count,
                  cs.source_count,
                  cs.accept_count,
                  cs.dismiss_count,
                  cs.edit_after_accept_count,
                  cs.blacklisted,
                  cs.last_shown_at,
                  cs.last_used_at
                FROM candidate_value cv
                JOIN candidate_stats cs ON cs.candidate_id = cv.id
                {where_clause}
                ORDER BY cs.accept_count DESC, cv.last_seen_at DESC
                """,
                tuple(params),
            ).fetchall()
            candidate_ids = [int(row["id"]) for row in rows]
            source_map = self._fetch_sources(candidate_ids)
            bundles: list[dict[str, Any]] = []
            for row in rows:
                candidate_id = int(row["id"])
                sources = source_map.get(candidate_id, [])
                bundles.append(
                    {
                        "candidate_id": candidate_id,
                        "text": row["display_text"],
                        "normalized_text": row["normalized_text"],
                        "tier": row["tier"],
                        "first_seen_at": row["first_seen_at"],
                        "last_seen_at": row["last_seen_at"],
                        "repeat_count": int(row["repeat_count"]),
                        "source_count": int(row["source_count"]),
                        "accept_count": int(row["accept_count"]),
                        "dismiss_count": int(row["dismiss_count"]),
                        "edit_after_accept_count": int(row["edit_after_accept_count"]),
                        "blacklisted": bool(row["blacklisted"]),
                        "last_shown_at": row["last_shown_at"] or "",
                        "last_used_at": row["last_used_at"] or "",
                        "sources": sources,
                        "label_types": sorted(
                            {
                                source["source_label_type"]
                                for source in sources
                                if source.get("source_label_type")
                            }
                        ),
                    }
                )
            return bundles

    def list_entries(self, query: str = "", limit: int = 100) -> list[dict[str, Any]]:
        return self.fetch_candidate_bundles(include_weak=True, query=query, include_blacklisted=True)[:limit]

    def list_logs(self, limit: int = 200) -> list[dict[str, Any]]:
        with self._lock:
            rows = self.history_conn.execute(
                """
                SELECT event_type, candidate_id, sample_snapshot_id, payload_json, created_at
                FROM event_log
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
            return [
                {
                    "event_type": row["event_type"],
                    "candidate_id": row["candidate_id"],
                    "sample_snapshot_id": row["sample_snapshot_id"],
                    "payload": _json_load(row["payload_json"], {}),
                    "created_at": row["created_at"],
                }
                for row in rows
            ]

    def _fetch_sources(self, candidate_ids: list[int]) -> dict[int, list[dict[str, Any]]]:
        if not candidate_ids:
            return {}
        placeholders = ", ".join("?" for _ in candidate_ids)
        rows = self.memory_conn.execute(
            f"""
            SELECT
              id,
              candidate_id,
              source_kind,
              source_label_type,
              source_region,
              source_attr,
              sample_snapshot_id,
              page_identity,
              context_terms_json,
              created_at
            FROM candidate_source
            WHERE candidate_id IN ({placeholders})
            ORDER BY created_at DESC
            """,
            tuple(candidate_ids),
        ).fetchall()
        snapshot_ids = sorted(
            {
                row["sample_snapshot_id"]
                for row in rows
                if row["sample_snapshot_id"]
            }
        )
        snapshot_map = self._fetch_snapshots(snapshot_ids)
        source_map: dict[int, list[dict[str, Any]]] = {candidate_id: [] for candidate_id in candidate_ids}
        for row in rows:
            source_map[int(row["candidate_id"])].append(
                {
                    "source_id": int(row["id"]),
                    "source_kind": row["source_kind"],
                    "source_label_type": row["source_label_type"],
                    "source_region": row["source_region"],
                    "source_attr": row["source_attr"],
                    "page_identity": row["page_identity"],
                    "sample_snapshot_id": row["sample_snapshot_id"],
                    "context_terms": _json_load(row["context_terms_json"], []),
                    "created_at": row["created_at"],
                    "sample_snapshot": snapshot_map.get(row["sample_snapshot_id"]),
                }
            )
        return source_map

    def _fetch_snapshots(self, snapshot_ids: list[str]) -> dict[str, dict[str, Any]]:
        if not snapshot_ids:
            return {}
        placeholders = ", ".join("?" for _ in snapshot_ids)
        rows = self.history_conn.execute(
            f"""
            SELECT
              id,
              site_id,
              page_identity,
              target_label_type,
              target_region,
              current_input,
              visible_labels_json,
              label_type_counts_json,
              neighbor_texts_json,
              unreadable_frames_json,
              context_terms_json,
              captured_at
            FROM sample_snapshot
            WHERE id IN ({placeholders})
            """,
            tuple(snapshot_ids),
        ).fetchall()
        snapshot_map: dict[str, dict[str, Any]] = {}
        for row in rows:
            snapshot_map[row["id"]] = {
                "id": row["id"],
                "site_id": row["site_id"],
                "page_identity": row["page_identity"],
                "target_label_type": row["target_label_type"],
                "target_region": row["target_region"],
                "current_input": row["current_input"],
                "visible_labels": _json_load(row["visible_labels_json"], []),
                "label_type_counts": _json_load(row["label_type_counts_json"], {}),
                "neighbor_texts": _json_load(row["neighbor_texts_json"], []),
                "unreadable_frames": _json_load(row["unreadable_frames_json"], []),
                "context_terms": _json_load(row["context_terms_json"], []),
                "captured_at": row["captured_at"],
            }
        return snapshot_map

    def _rebuild_search_index(self, candidate_id: int) -> None:
        candidate = self.memory_conn.execute(
            """
            SELECT id, display_text, normalized_text
            FROM candidate_value
            WHERE id = ?
            """,
            (candidate_id,),
        ).fetchone()
        if candidate is None:
            return
        source_rows = self.memory_conn.execute(
            """
            SELECT source_label_type, context_terms_json
            FROM candidate_source
            WHERE candidate_id = ?
            """,
            (candidate_id,),
        ).fetchall()
        label_types: list[str] = []
        context_terms: list[str] = []
        seen_terms: set[str] = set()
        for row in source_rows:
            label_type = row["source_label_type"]
            if label_type:
                label_types.append(label_type)
            for term in _json_load(row["context_terms_json"], []):
                if term in seen_terms:
                    continue
                seen_terms.add(term)
                context_terms.append(term)

        self.memory_conn.execute("DELETE FROM candidate_search WHERE rowid = ?", (candidate_id,))
        self.memory_conn.execute(
            """
            INSERT INTO candidate_search(rowid, candidate_id, text, normalized_text, label_types, context_terms)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                candidate_id,
                candidate_id,
                candidate["display_text"],
                candidate["normalized_text"],
                " ".join(sorted(set(label_types))),
                " ".join(context_terms[:80]),
            ),
        )
