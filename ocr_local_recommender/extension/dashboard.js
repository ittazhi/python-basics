const entryList = document.getElementById("entry-list");
const logList = document.getElementById("log-list");
const searchInput = document.getElementById("search-query");
const refreshAllButton = document.getElementById("refresh-all");
const searchButton = document.getElementById("search-button");
const clearSearchButton = document.getElementById("clear-search");

let entriesRequestId = 0;
let logsRequestId = 0;

refreshAllButton.addEventListener("click", () => {
  void loadAll();
});
searchButton.addEventListener("click", () => {
  void loadEntries(searchInput.value.trim());
});
clearSearchButton.addEventListener("click", () => {
  searchInput.value = "";
  void loadEntries("");
});

searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void loadEntries(searchInput.value.trim());
  }
});

void loadAll();

async function loadAll() {
  refreshAllButton.disabled = true;
  try {
    await Promise.all([loadEntries(searchInput.value.trim()), loadLogs()]);
  } finally {
    refreshAllButton.disabled = false;
  }
}

async function loadEntries(query) {
  const requestId = ++entriesRequestId;
  entryList.innerHTML = "<div class=\"entry-card\">Loading candidates...</div>";
  const path = query ? `/entries?query=${encodeURIComponent(query)}` : "/entries";
  const response = await api(path, "GET");
  if (requestId !== entriesRequestId) {
    return;
  }
  if (!response?.ok || !response.data?.entries) {
    const message = response?.error || "Failed to load candidates.";
    entryList.innerHTML = `<div class="entry-card">${escapeHtml(message)}</div>`;
    return;
  }

  const entries = response.data.entries;
  if (!entries.length) {
    entryList.innerHTML = "<div class=\"entry-card\">No candidates found.</div>";
    return;
  }

  entryList.innerHTML = "";
  for (const entry of entries) {
    const card = renderEntryCard(entry);
    entryList.appendChild(card);
  }
}

function renderEntryCard(entry) {
  const card = document.createElement("div");
  card.className = "entry-card";
  card.dataset.candidateId = String(entry.candidate_id);
  card.innerHTML = `
    <div class="entry-head">
      <div>
        <div style="font-weight: 700;">${escapeHtml(entry.text)}</div>
        <div class="meta">
          <span>${escapeHtml(entry.label_types.join(", ") || "untyped")}</span>
          <span>${entry.source_count} sources</span>
          <span>${entry.accept_count} accepts</span>
        </div>
      </div>
      <div class="pill ${entry.tier === "weak" ? "weak" : ""}">${escapeHtml(entry.tier)}</div>
    </div>
    <div class="actions">
      <button data-action="toggle">${entry.blacklisted ? "Restore" : "Blacklist"}</button>
      <button data-action="details">Show details</button>
    </div>
    <div class="detail" data-detail-state="summary">
      <div>Last used: ${escapeHtml(entry.last_used_at || "never")}</div>
      <div>Last seen: ${escapeHtml(entry.last_seen_at || "")}</div>
    </div>
  `;

  const toggleButton = card.querySelector("[data-action='toggle']");
  toggleButton.addEventListener("click", async () => {
    toggleButton.disabled = true;
    const original = toggleButton.textContent;
    toggleButton.textContent = entry.blacklisted ? "Restoring..." : "Blacklisting...";
    const endpoint = entry.blacklisted
      ? `/entries/${entry.candidate_id}/restore`
      : `/entries/${entry.candidate_id}/blacklist`;
    const response = await api(endpoint, "POST");
    if (!response?.ok) {
      toggleButton.disabled = false;
      toggleButton.textContent = original;
      return;
    }
    await loadEntries(searchInput.value.trim());
  });

  const detailButton = card.querySelector("[data-action='details']");
  const detailRoot = card.querySelector(".detail");
  detailButton.addEventListener("click", async () => {
    if (detailRoot.dataset.detailState === "loaded") {
      detailRoot.dataset.detailState = "summary";
      detailRoot.innerHTML = `
        <div>Last used: ${escapeHtml(entry.last_used_at || "never")}</div>
        <div>Last seen: ${escapeHtml(entry.last_seen_at || "")}</div>
      `;
      detailButton.textContent = "Show details";
      return;
    }
    detailButton.disabled = true;
    detailButton.textContent = "Loading...";
    const detailResponse = await api(`/entries/${entry.candidate_id}`, "GET");
    detailButton.disabled = false;
    if (!detailResponse?.ok || !detailResponse.data?.entry) {
      detailButton.textContent = "Show details";
      detailRoot.innerHTML = `<div>${escapeHtml(detailResponse?.error || "Failed to load details.")}</div>`;
      return;
    }
    const detail = detailResponse.data.entry;
    detailRoot.dataset.detailState = "loaded";
    detailButton.textContent = "Hide details";
    detailRoot.innerHTML = `
      <div>Repeat count: ${detail.repeat_count}</div>
      <div>Dismiss count: ${detail.dismiss_count}</div>
      <div>Edit-after-accept count: ${detail.edit_after_accept_count}</div>
      <div>Sources:</div>
      ${detail.sources.slice(0, 4).map((source) => `
        <div>- ${escapeHtml([source.source_kind, source.source_label_type, source.source_region, source.page_identity].filter(Boolean).join(" | "))}</div>
      `).join("")}
    `;
  });

  return card;
}

async function loadLogs() {
  const requestId = ++logsRequestId;
  logList.innerHTML = "<div class=\"log-card\">Loading logs...</div>";
  const response = await api("/logs", "GET");
  if (requestId !== logsRequestId) {
    return;
  }
  if (!response?.ok || !response.data?.logs) {
    const message = response?.error || "Failed to load logs.";
    logList.innerHTML = `<div class="log-card">${escapeHtml(message)}</div>`;
    return;
  }
  const logs = response.data.logs;
  if (!logs.length) {
    logList.innerHTML = "<div class=\"log-card\">No logs recorded yet.</div>";
    return;
  }

  logList.innerHTML = "";
  for (const log of logs) {
    const card = document.createElement("div");
    card.className = "log-card";
    card.innerHTML = `
      <div class="log-head">
        <strong>${escapeHtml(log.event_type)}</strong>
        <span class="meta">${escapeHtml(log.created_at)}</span>
      </div>
      <div class="meta">
        <span>Candidate: ${log.candidate_id ?? "-"}</span>
        <span>Snapshot: ${escapeHtml(log.sample_snapshot_id || "-")}</span>
      </div>
      <div class="detail">${escapeHtml(JSON.stringify(log.payload || {}, null, 2))}</div>
    `;
    logList.appendChild(card);
  }
}

async function api(path, method, body) {
  return chrome.runtime.sendMessage({
    type: "ocr-assist:api-request",
    path,
    method,
    body
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}
