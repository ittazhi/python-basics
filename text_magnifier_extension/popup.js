const DEFAULT_SETTINGS = {
  zoom: 2.2,
  panelWidth: 380,
  showFocusedField: true
};

const toggle = document.getElementById("enabled-toggle");
const statusEl = document.getElementById("status");
const zoomRange = document.getElementById("zoom-range");
const zoomValue = document.getElementById("zoom-value");
const widthRange = document.getElementById("width-range");
const widthValue = document.getElementById("width-value");
const fieldToggle = document.getElementById("field-toggle");

let activeTab = null;
let settings = { ...DEFAULT_SETTINGS };
let settingsTimer = null;

init().catch((error) => {
  console.error(error);
  setStatus("读取插件状态失败。", "error");
  setControlsDisabled(true);
});

async function init() {
  activeTab = await getActiveTab();

  if (!activeTab?.id || !isSupportedPage(activeTab.url)) {
    toggle.checked = false;
    setControlsDisabled(true);
    setStatus("当前页面不支持", "error");
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: "text-magnifier:get-tab-state",
    tabId: activeTab.id
  });

  settings = normalizeSettings(response?.settings);
  renderSettings();
  toggle.checked = Boolean(response?.enabled);
  setControlsDisabled(false);
  renderState(toggle.checked);

  toggle.addEventListener("change", handleEnabledChange);
  zoomRange.addEventListener("input", () => handleSettingsInput(false));
  zoomRange.addEventListener("change", () => handleSettingsInput(true));
  widthRange.addEventListener("input", () => handleSettingsInput(false));
  widthRange.addEventListener("change", () => handleSettingsInput(true));
  fieldToggle.addEventListener("change", () => handleSettingsInput(true));
}

async function handleEnabledChange() {
  toggle.disabled = true;
  setStatus("正在更新...", "idle");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "text-magnifier:set-tab-enabled",
      tabId: activeTab.id,
      enabled: toggle.checked
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Unknown background error.");
    }

    renderState(Boolean(response.enabled));
  } catch (error) {
    console.error(error);
    toggle.checked = !toggle.checked;
    setStatus("切换失败", "error");
  } finally {
    toggle.disabled = false;
  }
}

function handleSettingsInput(saveImmediately) {
  settings = normalizeSettings({
    zoom: zoomRange.value,
    panelWidth: widthRange.value,
    showFocusedField: fieldToggle.checked
  });
  renderSettings();

  window.clearTimeout(settingsTimer);
  settingsTimer = window.setTimeout(saveSettings, saveImmediately ? 0 : 120);
}

async function saveSettings() {
  settingsTimer = null;

  try {
    const response = await chrome.runtime.sendMessage({
      type: "text-magnifier:set-settings",
      tabId: activeTab.id,
      settings
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Unknown background error.");
    }

    settings = normalizeSettings(response.settings);
    renderSettings();
  } catch (error) {
    console.error(error);
    setStatus("保存设置失败", "error");
  }
}

function renderSettings() {
  zoomRange.value = String(settings.zoom);
  zoomValue.textContent = `${settings.zoom.toFixed(1)}×`;
  widthRange.value = String(settings.panelWidth);
  widthValue.textContent = `${Math.round(settings.panelWidth)} px`;
  fieldToggle.checked = settings.showFocusedField;
}

function renderState(enabled) {
  if (enabled) {
    setStatus("已开启", "enabled");
    return;
  }

  setStatus("已关闭", "idle");
}

function setControlsDisabled(disabled) {
  toggle.disabled = disabled;
  zoomRange.disabled = disabled;
  widthRange.disabled = disabled;
  fieldToggle.disabled = disabled;
}

function setStatus(message, state) {
  statusEl.textContent = message;
  statusEl.dataset.state = state;
}

function normalizeSettings(source) {
  const settingsSource = source && typeof source === "object" ? source : {};
  return {
    zoom: clampNumber(settingsSource.zoom, DEFAULT_SETTINGS.zoom, 1.5, 4),
    panelWidth: clampNumber(settingsSource.panelWidth, DEFAULT_SETTINGS.panelWidth, 280, 620),
    showFocusedField:
      typeof settingsSource.showFocusedField === "boolean"
        ? settingsSource.showFocusedField
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

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

function isSupportedPage(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}
