from __future__ import annotations

import logging
import platform
import shutil
import subprocess
import threading
from typing import Optional

from .storage import Storage

logger = logging.getLogger(__name__)


class ClipboardWatcher:
    def __init__(self, storage: Storage, poll_interval: float = 0.8) -> None:
        self.storage = storage
        self.poll_interval = poll_interval
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._last_text = ""
        self.enabled = platform.system() == "Darwin" and shutil.which("pbpaste") is not None

    def start(self) -> bool:
        if not self.enabled or self._thread is not None:
            return False
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="clipboard-watcher", daemon=True)
        self._thread.start()
        return True

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=max(self.poll_interval * 4, 3.0))
            self._thread = None

    def _run(self) -> None:
        while not self._stop.wait(self.poll_interval):
            try:
                text = self._read_clipboard()
            except Exception:
                logger.exception("Clipboard read failed")
                continue
            if not text or text == self._last_text:
                continue
            self._last_text = text
            try:
                self.storage.capture_clipboard(
                    text=text,
                    sample_snapshot=None,
                    metadata={"source": "clipboard_watcher"},
                )
            except Exception:
                logger.exception("Failed to persist clipboard candidate")

    def _read_clipboard(self) -> str:
        try:
            result = subprocess.run(
                ["pbpaste"],
                check=False,
                capture_output=True,
                timeout=1.0,
            )
        except (OSError, subprocess.SubprocessError):
            return ""
        if result.returncode != 0:
            return ""
        return self._decode_clipboard_bytes(result.stdout).strip()

    @staticmethod
    def _decode_clipboard_bytes(data: bytes) -> str:
        if not data:
            return ""
        for encoding in ("utf-8", "utf-16"):
            try:
                return data.decode(encoding)
            except UnicodeDecodeError:
                continue
        # Fall back to a permissive decode so that the watcher never crashes on
        # exotic clipboard payloads; non-decodable bytes are dropped.
        return data.decode("utf-8", errors="replace")
