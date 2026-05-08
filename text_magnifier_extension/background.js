const ENABLED_TABS_KEY = "textMagnifierEnabledTabs";
const SETTINGS_KEY = "textMagnifierSettings";
const CONTENT_SCRIPT_FILES = ["content.js"];
const CONTENT_STYLE_FILES = ["content.css"];

const DEFAULT_SETTINGS = {
  zoom: 2.2,
  panelWidth: 380,
  showFocusedField: true
};

async function getEnabledTabs() {
  const stored = await chrome.storage.session.get(ENABLED_TABS_KEY);
  return stored[ENABLED_TABS_KEY] || {};
}

async function isTabEnabled(tabId) {
  if (!Number.isInteger(tabId)) {
    return false;
  }

  const enabledTabs = await getEnabledTabs();
  return Boolean(enabledTabs[String(tabId)]);
}

async function setTabEnabled(tabId, enabled) {
  if (!Number.isInteger(tabId)) {
    throw new Error("Expected a numeric tab id.");
  }

  const enabledTabs = await getEnabledTabs();
  const nextTabs = { ...enabledTabs };

  if (enabled) {
    nextTabs[String(tabId)] = true;
  } else {
    delete nextTabs[String(tabId)];
  }

  await chrome.storage.session.set({ [ENABLED_TABS_KEY]: nextTabs });
}

async function removeTabState(tabId) {
  if (!Number.isInteger(tabId)) {
    return;
  }

  const enabledTabs = await getEnabledTabs();
  if (!enabledTabs[String(tabId)]) {
    return;
  }

  const nextTabs = { ...enabledTabs };
  delete nextTabs[String(tabId)];
  await chrome.storage.session.set({ [ENABLED_TABS_KEY]: nextTabs });
}

async function getSettings() {
  const stored = await chrome.storage.sync.get(SETTINGS_KEY);
  return normalizeSettings(stored[SETTINGS_KEY]);
}

async function setSettings(settings) {
  const nextSettings = normalizeSettings(settings);
  await chrome.storage.sync.set({ [SETTINGS_KEY]: nextSettings });
  return nextSettings;
}

function normalizeSettings(settings) {
  const source = settings && typeof settings === "object" ? settings : {};
  return {
    zoom: clampNumber(source.zoom, DEFAULT_SETTINGS.zoom, 1.5, 4),
    panelWidth: clampNumber(source.panelWidth, DEFAULT_SETTINGS.panelWidth, 280, 620),
    showFocusedField:
      typeof source.showFocusedField === "boolean"
        ? source.showFocusedField
        : DEFAULT_SETTINGS.showFocusedField
  };
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, number));
}

function isSupportedUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

async function ensureContentScript(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!isSupportedUrl(tab.url)) {
    throw new Error("Current tab is not a supported http/https page.");
  }

  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "text-magnifier:ping" });
    if (response?.ok) {
      return;
    }
  } catch (error) {
    const message = chrome.runtime.lastError?.message || error?.message || "";
    if (!message.includes("Receiving end does not exist")) {
      throw error;
    }
  }

  await chrome.scripting.insertCSS({
    target: { tabId },
    files: CONTENT_STYLE_FILES
  });

  await chrome.scripting.executeScript({
    target: { tabId },
    files: CONTENT_SCRIPT_FILES
  });
}

async function notifyTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    const text = chrome.runtime.lastError?.message || error?.message || "";
    if (!text.includes("Receiving end does not exist")) {
      console.warn("Failed to notify text magnifier content script:", error);
    }
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void removeTabState(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete") {
    return;
  }

  void (async () => {
    if (!(await isTabEnabled(tabId))) {
      return;
    }

    try {
      await ensureContentScript(tabId);
      await notifyTab(tabId, {
        type: "text-magnifier:set-enabled",
        enabled: true,
        settings: await getSettings()
      });
    } catch (error) {
      console.warn("Failed to re-enable text magnifier after navigation:", error);
    }
  })();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "text-magnifier:get-tab-state": {
        const tabId = Number.isInteger(message.tabId) ? message.tabId : sender.tab?.id;
        sendResponse({
          enabled: await isTabEnabled(tabId),
          settings: await getSettings()
        });
        break;
      }

      case "text-magnifier:set-tab-enabled": {
        const tabId = message.tabId;
        const enabled = Boolean(message.enabled);
        const settings = await getSettings();

        if (enabled) {
          await ensureContentScript(tabId);
        }

        await setTabEnabled(tabId, enabled);
        await notifyTab(tabId, {
          type: "text-magnifier:set-enabled",
          enabled,
          settings
        });
        sendResponse({ ok: true, enabled, settings });
        break;
      }

      case "text-magnifier:set-settings": {
        const settings = await setSettings(message.settings);
        if (Number.isInteger(message.tabId)) {
          await notifyTab(message.tabId, {
            type: "text-magnifier:set-settings",
            settings
          });
        }
        sendResponse({ ok: true, settings });
        break;
      }

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
