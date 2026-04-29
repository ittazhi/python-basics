const CONFIG_KEY = "ocrLocalRecommenderConfig";
const DEFAULT_CONFIG = {
  enabled: true,
  apiBase: "http://127.0.0.1:8765"
};

const API_REQUEST_TIMEOUT_MS = 8000;
const FRAME_SNAPSHOT_TTL_MS = 5 * 60 * 1000;
const MAX_FRAMES_PER_TAB = 24;

const frameSnapshotsByTab = new Map();

chrome.runtime.onInstalled.addListener(() => {
  void ensureConfig();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  frameSnapshotsByTab.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    frameSnapshotsByTab.delete(tabId);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "ocr-assist:get-config":
        sendResponse({ ok: true, config: await getConfig() });
        break;
      case "ocr-assist:set-config":
        sendResponse({ ok: true, config: await setConfig(message.patch || {}) });
        break;
      case "ocr-assist:api-request":
        sendResponse(await apiRequest(message));
        break;
      case "ocr-assist:frame-snapshot":
        sendResponse({ ok: true, stored: storeFrameSnapshot(sender, message) });
        break;
      case "ocr-assist:get-frame-snapshots":
        sendResponse({ ok: true, fragments: getFrameSnapshots(sender, message) });
        break;
      case "ocr-assist:open-dashboard":
        try {
          await chrome.runtime.openOptionsPage();
          sendResponse({ ok: true });
        } catch (error) {
          sendResponse({ ok: false, error: error?.message || String(error) });
        }
        break;
      default:
        sendResponse({ ok: false, error: "Unsupported message type." });
        break;
    }
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  });
  return true;
});

async function ensureConfig() {
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  if (!stored[CONFIG_KEY]) {
    await chrome.storage.local.set({ [CONFIG_KEY]: DEFAULT_CONFIG });
  }
}

async function getConfig() {
  await ensureConfig();
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  return {
    ...DEFAULT_CONFIG,
    ...(stored[CONFIG_KEY] || {})
  };
}

async function setConfig(patch) {
  const sanitizedPatch = sanitizeConfigPatch(patch);
  const nextConfig = {
    ...(await getConfig()),
    ...sanitizedPatch
  };
  await chrome.storage.local.set({ [CONFIG_KEY]: nextConfig });
  await broadcastConfig(nextConfig);
  return nextConfig;
}

function sanitizeConfigPatch(patch) {
  const result = {};
  if (typeof patch.enabled === "boolean") {
    result.enabled = patch.enabled;
  }
  if (typeof patch.apiBase === "string") {
    const cleaned = patch.apiBase.trim();
    if (cleaned && isValidApiBase(cleaned)) {
      result.apiBase = cleaned.replace(/\/+$/, "");
    }
  }
  return result;
}

function isValidApiBase(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (error) {
    return false;
  }
}

async function broadcastConfig(config) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!Number.isInteger(tab.id)) {
      continue;
    }
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: "ocr-assist:config-changed",
        config
      });
    } catch (error) {
      const message = chrome.runtime.lastError?.message || error?.message || "";
      if (message && !message.includes("Receiving end does not exist")) {
        console.warn("Failed to broadcast config:", message);
      }
    }
  }
}

async function apiRequest(message) {
  const config = await getConfig();
  const path = typeof message.path === "string" ? message.path : "/";
  const method = typeof message.method === "string" ? message.method.toUpperCase() : "GET";

  let url;
  try {
    url = new URL(path, config.apiBase.endsWith("/") ? config.apiBase : `${config.apiBase}/`);
  } catch (error) {
    return { ok: false, status: 0, error: "Invalid API base or path." };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_REQUEST_TIMEOUT_MS);
  const options = {
    method,
    headers: { "Content-Type": "application/json" },
    signal: controller.signal
  };
  if (message.body !== undefined) {
    options.body = JSON.stringify(message.body);
  }

  try {
    const response = await fetch(url.toString(), options);
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (error) {
      data = { raw: text };
    }
    return {
      ok: response.ok,
      status: response.status,
      data
    };
  } catch (error) {
    const isAbort = error?.name === "AbortError";
    return {
      ok: false,
      status: 0,
      error: isAbort ? "Request timed out." : error?.message || String(error)
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function storeFrameSnapshot(sender, message) {
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId)) {
    return false;
  }

  const pageKey = String(message.pageKey || "");
  const fragment = message.fragment || {};
  const frameId = Number.isInteger(sender.frameId) ? sender.frameId : 0;
  let tabEntry = frameSnapshotsByTab.get(tabId);
  if (!tabEntry) {
    tabEntry = new Map();
    frameSnapshotsByTab.set(tabId, tabEntry);
  }

  tabEntry.set(frameId, {
    pageKey,
    updatedAt: Date.now(),
    fragment
  });

  pruneFrameEntries(tabEntry);
  return true;
}

function pruneFrameEntries(tabEntry) {
  const cutoff = Date.now() - FRAME_SNAPSHOT_TTL_MS;
  for (const [frameId, entry] of tabEntry) {
    if (entry.updatedAt < cutoff) {
      tabEntry.delete(frameId);
    }
  }
  if (tabEntry.size <= MAX_FRAMES_PER_TAB) {
    return;
  }
  const sortedEntries = [...tabEntry.entries()].sort(
    (left, right) => left[1].updatedAt - right[1].updatedAt
  );
  while (tabEntry.size > MAX_FRAMES_PER_TAB && sortedEntries.length) {
    const [frameId] = sortedEntries.shift();
    tabEntry.delete(frameId);
  }
}

function getFrameSnapshots(sender, message) {
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId)) {
    return [];
  }
  const tabEntry = frameSnapshotsByTab.get(tabId);
  if (!tabEntry) {
    return [];
  }

  pruneFrameEntries(tabEntry);

  const pageKey = String(message.pageKey || "");
  const currentFrameId = Number.isInteger(sender.frameId) ? sender.frameId : 0;
  const exactFragments = [];
  const fallbackFragments = [];
  for (const [frameId, entry] of tabEntry.entries()) {
    if (frameId === currentFrameId) {
      continue;
    }
    fallbackFragments.push(entry.fragment);
    if (!pageKey || !entry.pageKey || entry.pageKey === pageKey) {
      exactFragments.push(entry.fragment);
    }
  }
  return exactFragments.length ? exactFragments : fallbackFragments;
}
