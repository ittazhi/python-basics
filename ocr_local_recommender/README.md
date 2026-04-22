# OCR Local Recommender

Local-only OCR annotation assistant with:

- A Chrome/Edge MV3 extension for page snapshot capture and inline suggestions.
- A local FastAPI service for clipboard capture, SQLite storage, ranking, and audit logs.
- A hot `memory.db` and cold `history.db` data split.
- Weak-to-strong clipboard candidate promotion.

## Project Layout

```text
ocr_local_recommender/
  backend/
    app/
      main.py            # FastAPI app and HTTP endpoints
      storage.py         # SQLite memory/history stores
      ranking.py         # context + input ranking engine
      normalization.py   # text normalization helpers
      clipboard.py       # macOS pbpaste polling watcher
    tests/
    requirements.txt
  extension/
    manifest.json
    background.js        # API bridge and iframe fragment registry
    content.js           # page adapter, snapshot capture, inline UI
    content.css
    popup.html/js
    dashboard.html/js
```

## Run Backend

Use the workspace virtual environment:

```bash
cd "/Users/max/Desktop/vs code/ocr_local_recommender/backend"
"/Users/max/Desktop/vs code/.venv/bin/python" -m pip install -r requirements.txt
"/Users/max/Desktop/vs code/.venv/bin/python" -m uvicorn app.main:app --host 127.0.0.1 --port 8765
```

If local pip has certificate issues, retry the install with:

```bash
"/Users/max/Desktop/vs code/.venv/bin/python" -m pip install --trusted-host pypi.org --trusted-host files.pythonhosted.org -r requirements.txt
```

The backend stores data in `backend/data/` by default. To use a different location:

```bash
OCR_RECOMMENDER_DATA_DIR="/path/to/data" "/Users/max/Desktop/vs code/.venv/bin/python" -m uvicorn app.main:app --host 127.0.0.1 --port 8765
```

## Load Extension

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable developer mode.
3. Choose "Load unpacked".
4. Select:

```text
/Users/max/Desktop/vs code/ocr_local_recommender/extension
```

Open the extension popup to verify the backend is online. The dashboard is available from the popup.

## Runtime Behavior

- The content script captures currently loaded labels and input context through DOM text and input events.
- Long pages are handled incrementally. The extension does not need to scroll the page to the bottom before recommending.
- Iframes are attempted through `all_frames` injection. Unreadable iframe regions are recorded in the snapshot instead of blocking recommendations.
- Inline suggestions appear near the focused input. The side panel shows reasons and source evidence.
- Candidates are never auto-filled. Click a candidate, press `Alt+1` through `Alt+5`, or press `Ctrl+Enter` after selecting with arrow keys.
- Global fallback search opens with `Ctrl/Cmd+Shift+K`.

## Backend API

- `GET /health`
- `POST /capture/sample-snapshot`
- `POST /capture/value-commit`
- `POST /capture/clipboard`
- `POST /suggest`
- `POST /search`
- `POST /feedback`
- `GET /entries`
- `GET /entries/{candidate_id}`
- `POST /entries/{candidate_id}/blacklist`
- `POST /entries/{candidate_id}/restore`
- `GET /logs`

## Verify

```bash
cd "/Users/max/Desktop/vs code/ocr_local_recommender/backend"
"/Users/max/Desktop/vs code/.venv/bin/python" -m unittest discover -s tests
node --check "/Users/max/Desktop/vs code/ocr_local_recommender/extension/content.js"
```

