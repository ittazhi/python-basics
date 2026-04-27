from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.models import LabelFact, SampleSnapshotPayload, SearchRequest, SuggestionRequest
from app.ranking import SuggestionEngine
from app.storage import Storage


def make_snapshot(current_input: str = "", target_label_type: str = "Name") -> SampleSnapshotPayload:
    return SampleSnapshotPayload(
        site_id="sample-ocr",
        page_identity="id-card-front",
        target_label_type=target_label_type,
        target_region="front",
        current_input=current_input,
        visible_labels=[
            LabelFact(label_type="Name", value="Alice Zhang", region="front", order=1),
            LabelFact(label_type="ID Number", value="110101199001011234", region="front", order=2),
            LabelFact(label_type="Address", value="No. 1 Sample Road", region="front", order=3),
        ],
        neighbor_texts=["ID card front side", "Name", "ID Number"],
    )


def make_generic_snapshot(
    current_input: str = "",
    target_label_type: str = "Field 01",
    first_value: str = "ABC-123",
    second_value: str = "Sample Text",
) -> SampleSnapshotPayload:
    return SampleSnapshotPayload(
        site_id="sample-ocr",
        page_identity="generic-task",
        target_label_type=target_label_type,
        target_region="main",
        current_input=current_input,
        visible_labels=[
            LabelFact(label_type="Field 01", value=first_value, region="main", order=1),
            LabelFact(label_type="Field 02", value=second_value, region="main", order=2),
        ],
        neighbor_texts=["Generic OCR task", "Field 01", "Field 02"],
    )


class StorageAndRankingTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.storage = Storage(Path(self.tmpdir.name))
        self.storage.initialize()
        self.engine = SuggestionEngine(self.storage)

    def tearDown(self):
        self.storage.close()
        self.tmpdir.cleanup()

    def test_clipboard_uses_weak_then_strong_promotion(self):
        first = self.storage.capture_clipboard("Alice Zhang")
        self.assertEqual(first["tier"], "weak")

        second = self.storage.capture_clipboard("Alice Zhang")
        self.assertEqual(second["tier"], "strong")

    def test_context_suggests_committed_label_value(self):
        snapshot = make_snapshot()
        captured = self.storage.capture_value_commit("Alice Zhang", snapshot)
        self.assertEqual(captured["tier"], "strong")

        suggestions = self.engine.suggest(SuggestionRequest(sample_snapshot=make_snapshot(), limit=3))
        self.assertTrue(suggestions)
        self.assertEqual(suggestions[0]["text"], "Alice Zhang")

    def test_default_suggest_allows_light_typo_tolerance(self):
        self.storage.capture_value_commit("Alice Zhang", make_snapshot())

        suggestions = self.engine.suggest(SuggestionRequest(sample_snapshot=make_snapshot(current_input="Alicd"), limit=3))
        self.assertTrue(suggestions)
        self.assertEqual(suggestions[0]["text"], "Alice Zhang")

    def test_weak_clipboard_is_searchable_by_prefix(self):
        self.storage.capture_clipboard("No. 1 Sample Road")
        results = self.engine.search(SearchRequest(query="No. 1", sample_snapshot=make_snapshot(), limit=5))
        self.assertTrue(results)
        self.assertEqual(results[0]["text"], "No. 1 Sample Road")

    def test_label_keys_match_after_separator_normalization(self):
        self.storage.capture_value_commit("ABC-123", make_generic_snapshot(target_label_type="Field 01"))

        suggestions = self.engine.suggest(
            SuggestionRequest(sample_snapshot=make_generic_snapshot(target_label_type="Field_01"), limit=3)
        )

        self.assertTrue(suggestions)
        self.assertEqual(suggestions[0]["text"], "ABC-123")
        self.assertIn("same label key", suggestions[0]["reasons"])

    def test_same_label_context_prioritizes_matching_value_over_other_field(self):
        self.storage.capture_value_commit("1234567890", make_generic_snapshot(target_label_type="Field 01"))
        self.storage.capture_value_commit("Sample Text", make_generic_snapshot(target_label_type="Field 02"))

        suggestions = self.engine.suggest(SuggestionRequest(sample_snapshot=make_generic_snapshot(target_label_type="Field 02"), limit=5))

        self.assertTrue(suggestions)
        self.assertEqual(suggestions[0]["text"], "Sample Text")


if __name__ == "__main__":
    unittest.main()
