from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.normalization import is_long_digit_like, normalize_text


class NormalizationTests(unittest.TestCase):
    def test_normalize_text_ignores_spacing_and_separators(self):
        self.assertEqual(
            normalize_text("110101 1990-01-01 1234"),
            "110101199001011234",
        )

    def test_long_digit_like_keeps_fuzzy_ranking_conservative(self):
        self.assertTrue(is_long_digit_like("110101 19900101 1234"))
        self.assertFalse(is_long_digit_like("Invoice A-123"))


if __name__ == "__main__":
    unittest.main()
