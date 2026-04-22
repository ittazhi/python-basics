from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field


class CompatModel(BaseModel):
    def as_dict(self) -> dict[str, Any]:
        if hasattr(self, "model_dump"):
            return self.model_dump()
        return self.dict()


class LabelFact(CompatModel):
    label_type: str = ""
    attr: str = ""
    value: str = ""
    region: str = ""
    order: int = 0


class SampleSnapshotPayload(CompatModel):
    site_id: str = "generic-ocr-site"
    page_identity: str = ""
    target_label_type: str = ""
    target_region: str = ""
    current_input: str = ""
    visible_labels: list[LabelFact] = Field(default_factory=list)
    label_type_counts: dict[str, int] = Field(default_factory=dict)
    neighbor_texts: list[str] = Field(default_factory=list)
    unreadable_frames: list[str] = Field(default_factory=list)
    captured_at: Optional[str] = None


class ClipboardCaptureRequest(CompatModel):
    text: str
    sample_snapshot: Optional[SampleSnapshotPayload] = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class ValueCommitRequest(CompatModel):
    text: str
    sample_snapshot: SampleSnapshotPayload
    source: str = "page_commit"


class SuggestionRequest(CompatModel):
    sample_snapshot: SampleSnapshotPayload
    limit: int = 5


class SearchRequest(CompatModel):
    query: str
    sample_snapshot: Optional[SampleSnapshotPayload] = None
    limit: int = 20


class FeedbackRequest(CompatModel):
    event_type: str
    candidate_id: Optional[int] = None
    candidate_ids: list[int] = Field(default_factory=list)
    sample_snapshot: Optional[SampleSnapshotPayload] = None
    payload: dict[str, Any] = Field(default_factory=dict)
