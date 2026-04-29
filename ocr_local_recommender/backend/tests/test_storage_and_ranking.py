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


def make_position_snapshot(
    target_label_type: str,
    first_label: str,
    second_label: str,
    first_value: str,
    second_value: str,
) -> SampleSnapshotPayload:
    return SampleSnapshotPayload(
        site_id="sample-ocr",
        page_identity="position-task",
        target_label_type=target_label_type,
        target_region="main",
        current_input="",
        visible_labels=[
            LabelFact(label_type=first_label, value=first_value, region="main", order=1),
            LabelFact(label_type=second_label, value=second_value, region="main", order=2),
        ],
        neighbor_texts=["Generic OCR task", first_label, second_label],
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

    def test_multiline_display_text_is_preserved(self):
        captured = self.storage.capture_value_commit("第一行\n第二行", make_generic_snapshot())
        self.assertEqual(captured["text"], "第一行\n第二行")

    def test_text_query_allows_loose_character_overlap(self):
        self.storage.capture_value_commit("北京朝阳区样本路", make_generic_snapshot(target_label_type="Field 01"))

        suggestions = self.engine.suggest(
            SuggestionRequest(sample_snapshot=make_generic_snapshot(current_input="北京朝羊区样路", target_label_type="Field 01"), limit=3)
        )

        self.assertTrue(suggestions)
        self.assertEqual(suggestions[0]["text"], "北京朝阳区样本路")

    def test_long_digit_query_stays_conservative(self):
        self.storage.capture_value_commit("123456789012", make_generic_snapshot(target_label_type="Field 01"))

        suggestions = self.engine.suggest(
            SuggestionRequest(sample_snapshot=make_generic_snapshot(current_input="123456789013", target_label_type="Field 01"), limit=3)
        )

        self.assertFalse(suggestions)

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

    def test_blank_text_is_not_persisted(self):
        result = self.storage.capture_value_commit("   \n  ", make_snapshot())
        self.assertIsNone(result["candidate_id"])

        entries = self.storage.list_entries()
        self.assertEqual(entries, [])

    def test_like_wildcards_in_query_are_matched_literally(self):
        self.storage.capture_value_commit("AB_X", make_generic_snapshot())
        self.storage.capture_value_commit("ABcX", make_generic_snapshot())

        # The display-text LIKE branch must not treat "_" as a single-character
        # wildcard, otherwise "ABcX" would also be returned for a "AB_X" query.
        results = self.storage.list_entries(query="AB_X")
        texts = [entry["text"] for entry in results]
        self.assertIn("AB_X", texts)
        self.assertNotIn("ABcX", texts)

    def test_list_entries_respects_limit(self):
        for index in range(5):
            self.storage.capture_value_commit(f"value-{index}", make_generic_snapshot())

        entries = self.storage.list_entries(limit=2)
        self.assertEqual(len(entries), 2)

    def test_empty_input_can_use_field_position_without_domain_rules(self):
        self.storage.capture_value_commit(
            "OLD-A",
            make_position_snapshot("Old A", "Old A", "Old B", "OLD-A", "OLD-B"),
        )
        self.storage.capture_value_commit(
            "OLD-B",
            make_position_snapshot("Old B", "Old A", "Old B", "OLD-A", "OLD-B"),
        )

        suggestions = self.engine.suggest(
            SuggestionRequest(
                sample_snapshot=make_position_snapshot("Current B", "Current A", "Current B", "", ""),
                limit=3,
            )
        )

        self.assertTrue(suggestions)
        self.assertEqual(suggestions[0]["text"], "OLD-B")
        self.assertIn("similar field position", suggestions[0]["reasons"])


if __name__ == "__main__":
    unittest.main()
