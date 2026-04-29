from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.clipboard import ClipboardWatcher


class ClipboardDecodingTests(unittest.TestCase):
    def test_utf8_bytes_decode_directly(self):
        self.assertEqual(
            ClipboardWatcher._decode_clipboard_bytes("Alice".encode("utf-8")),
            "Alice",
        )
        self.assertEqual(
            ClipboardWatcher._decode_clipboard_bytes("北京".encode("utf-8")),
            "北京",
        )

    def test_utf16_bytes_fall_back_to_utf16(self):
        payload = "测试 ✓".encode("utf-16")
        self.assertEqual(ClipboardWatcher._decode_clipboard_bytes(payload), "测试 ✓")

    def test_invalid_bytes_never_raise(self):
        garbage = b"abc\xff\xfe\x00plain"
        decoded = ClipboardWatcher._decode_clipboard_bytes(garbage)
        self.assertIsInstance(decoded, str)
        self.assertIn("plain", decoded)

    def test_empty_bytes_return_empty_string(self):
        self.assertEqual(ClipboardWatcher._decode_clipboard_bytes(b""), "")


if __name__ == "__main__":
    unittest.main()
