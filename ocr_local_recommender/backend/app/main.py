from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from .clipboard import ClipboardWatcher
from .models import (
    ClipboardCaptureRequest,
    FeedbackRequest,
    SampleSnapshotPayload,
    SearchRequest,
    SuggestionRequest,
    ValueCommitRequest,
)
from .ranking import SuggestionEngine
from .storage import Storage

_DEFAULT_DATA_DIR = Path(__file__).resolve().parents[1] / "data"
_data_dir_env = os.getenv("OCR_RECOMMENDER_DATA_DIR", "").strip()
DATA_DIR = Path(_data_dir_env) if _data_dir_env else _DEFAULT_DATA_DIR
storage = Storage(DATA_DIR)
engine = SuggestionEngine(storage)
clipboard_watcher = ClipboardWatcher(storage)


@asynccontextmanager
async def lifespan(app: FastAPI):
    storage.initialize()
    clipboard_watcher.start()
    try:
        yield
    finally:
        clipboard_watcher.stop()
        storage.close()


app = FastAPI(title="OCR Local Recommender", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, object]:
    return {
        "ok": True,
        "clipboard_watcher": clipboard_watcher.enabled,
        "data_dir": str(DATA_DIR),
    }


@app.post("/capture/sample-snapshot")
def capture_sample_snapshot(payload: SampleSnapshotPayload) -> dict[str, object]:
    snapshot_id = storage.capture_sample_snapshot(payload)
    return {"ok": True, "snapshot_id": snapshot_id}


@app.post("/capture/value-commit")
def capture_value_commit(payload: ValueCommitRequest) -> dict[str, object]:
    result = storage.capture_value_commit(
        text=payload.text,
        sample_snapshot=payload.sample_snapshot,
        source_kind=payload.source,
    )
    return {"ok": True, "candidate": result}


@app.post("/capture/clipboard")
def capture_clipboard(payload: ClipboardCaptureRequest) -> dict[str, object]:
    result = storage.capture_clipboard(
        text=payload.text,
        sample_snapshot=payload.sample_snapshot,
        metadata=payload.metadata,
    )
    return {"ok": True, "candidate": result}


@app.post("/suggest")
def suggest(payload: SuggestionRequest) -> dict[str, object]:
    suggestions = engine.suggest(payload)
    return {"ok": True, "suggestions": suggestions}


@app.post("/search")
def search(payload: SearchRequest) -> dict[str, object]:
    results = engine.search(payload)
    return {"ok": True, "results": results}


@app.post("/feedback")
def feedback(payload: FeedbackRequest) -> dict[str, object]:
    return storage.record_feedback(payload)


@app.get("/entries")
def get_entries(query: str = Query(default=""), limit: int = Query(default=100, ge=1, le=500)) -> dict[str, object]:
    return {"ok": True, "entries": storage.list_entries(query=query, limit=limit)}


@app.get("/entries/{candidate_id}")
def get_entry(candidate_id: int) -> dict[str, object]:
    try:
        entry = storage.get_candidate_summary(candidate_id)
    except KeyError as error:
        raise HTTPException(status_code=404, detail=f"Unknown candidate {candidate_id}") from error
    return {"ok": True, "entry": entry}


@app.post("/entries/{candidate_id}/blacklist")
def blacklist_entry(candidate_id: int) -> dict[str, object]:
    storage.blacklist_candidate(candidate_id, True)
    return {"ok": True}


@app.post("/entries/{candidate_id}/restore")
def restore_entry(candidate_id: int) -> dict[str, object]:
    storage.blacklist_candidate(candidate_id, False)
    return {"ok": True}


@app.get("/logs")
def get_logs(limit: int = Query(default=200, ge=1, le=1000)) -> dict[str, object]:
    return {"ok": True, "logs": storage.list_logs(limit=limit)}
