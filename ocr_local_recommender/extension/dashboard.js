const entryList = document.getElementById("entry-list");
const logList = document.getElementById("log-list");
const searchInput = document.getElementById("search-query");

document.getElementById("refresh-all").addEventListener("click", () => {
  void loadAll();
});
document.getElementById("search-button").addEventListener("click", () => {
  void loadEntries(searchInput.value.trim());
});
document.getElementById("clear-search").addEventListener("click", () => {
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
  await Promise.all([loadEntries(searchInput.value.trim()), loadLogs()]);
}

async function loadEntries(query) {
  entryList.innerHTML = "<div class=\"entry-card\">Loading candidates...</div>";
  const path = query ? `/entries?query=${encodeURIComponent(query)}` : "/entries";
  const response = await api(path, "GET");
  if (!response?.ok || !response.data?.entries) {
    entryList.innerHTML = "<div class=\"entry-card\">Failed to load candidates.</div>";
    return;
  }

  const entries = response.data.entries;
  if (!entries.length) {
    entryList.innerHTML = "<div class=\"entry-card\">No candidates found.</div>";
    return;
  }

  entryList.innerHTML = "";
  for (const entry of entries) {
    const card = document.createElement("div");
    card.className = "entry-card";
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
        <button data-action="details">Reload details</button>
      </div>
      <div class="detail">
        <div>Last used: ${escapeHtml(entry.last_used_at || "never")}</div>
        <div>Last seen: ${escapeHtml(entry.last_seen_at || "")}</div>
      </div>
    `;

    card.querySelector("[data-action='toggle']").addEventListener("click", async () => {
      const endpoint = entry.blacklisted ? `/entries/${entry.candidate_id}/restore` : `/entries/${entry.candidate_id}/blacklist`;
      await api(endpoint, "POST");
      await loadEntries(searchInput.value.trim());
    });

    card.querySelector("[data-action='details']").addEventListener("click", async () => {
      const detailResponse = await api(`/entries/${entry.candidate_id}`, "GET");
      if (!detailResponse?.ok || !detailResponse.data?.entry) {
        return;
      }
      const detail = detailResponse.data.entry;
      const detailRoot = card.querySelector(".detail");
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

    entryList.appendChild(card);
  }
}

async function loadLogs() {
  logList.innerHTML = "<div class=\"log-card\">Loading logs...</div>";
  const response = await api("/logs", "GET");
  if (!response?.ok || !response.data?.logs) {
    logList.innerHTML = "<div class=\"log-card\">Failed to load logs.</div>";
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
