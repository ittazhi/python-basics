from __future__ import annotations

import os
import platform
import shutil
import subprocess
import threading
from typing import Optional

from .storage import Storage


class ClipboardWatcher:
    def __init__(self, storage: Storage, poll_interval: float | None = None) -> None:
        self.storage = storage
        self.poll_interval = self._resolve_poll_interval(poll_interval)
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._last_text = ""
        self.enabled = platform.system() == "Darwin" and shutil.which("pbpaste") is not None

    def _resolve_poll_interval(self, poll_interval: float | None) -> float:
        if poll_interval is not None:
            return max(1.5, float(poll_interval))
        raw_interval = os.getenv("OCR_RECOMMENDER_CLIPBOARD_INTERVAL", "").strip()
        if raw_interval:
            try:
                return max(1.5, float(raw_interval))
            except ValueError:
                pass
        return 3.0

    def start(self) -> bool:
        if not self.enabled or self._thread is not None:
            return False
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="clipboard-watcher", daemon=True)
        self._thread.start()
        return True

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1.5)
            self._thread = None

    def _run(self) -> None:
        while not self._stop.wait(self.poll_interval):
            text = self._read_clipboard()
            if not text or text == self._last_text:
                continue
            self._last_text = text
            self.storage.capture_clipboard(text=text, sample_snapshot=None, metadata={"source": "clipboard_watcher"})

    def _read_clipboard(self) -> str:
        try:
            result = subprocess.run(
                ["pbpaste"],
                check=False,
                capture_output=True,
                text=True,
                timeout=1.0,
            )
        except (OSError, subprocess.SubprocessError):
            return ""
        if result.returncode != 0:
            return ""
        return result.stdout.strip()
