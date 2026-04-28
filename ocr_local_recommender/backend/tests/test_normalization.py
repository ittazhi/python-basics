from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.normalization import (
    canonical_label_type,
    classify_value,
    is_long_digit_like,
    normalize_text,
    same_value_family,
    simplify_display_text,
)


class NormalizationTests(unittest.TestCase):
    def test_normalize_text_ignores_spacing_and_separators(self):
        self.assertEqual(
            normalize_text("110101 1990-01-01 1234"),
            "110101199001011234",
        )

    def test_display_text_preserves_original_punctuation_width(self):
        self.assertEqual(simplify_display_text("Ａ（１），张三"), "Ａ（１），张三")
        self.assertEqual(simplify_display_text("  A \n  B  "), "A\nB")

    def test_long_digit_like_keeps_fuzzy_ranking_conservative(self):
        self.assertTrue(is_long_digit_like("110101 19900101 1234"))
        self.assertFalse(is_long_digit_like("Invoice A-123"))

    def test_canonical_label_type_only_normalizes_text_shape(self):
        self.assertEqual(canonical_label_type("Field - 01"), "field01")
        self.assertEqual(canonical_label_type("字段 01"), "字段01")

    def test_value_shape_classification_is_generic(self):
        self.assertEqual(classify_value("110101199001011234"), "numeric_long")
        self.assertEqual(classify_value("1990-01-01"), "date_like")
        self.assertEqual(classify_value("ABC-123"), "mixed_alphanumeric")
        self.assertEqual(classify_value("张三"), "cjk_text_short")
        self.assertTrue(same_value_family("numeric_long", "numeric_medium"))


if __name__ == "__main__":
    unittest.main()
