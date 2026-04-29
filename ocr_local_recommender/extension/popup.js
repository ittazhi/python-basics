const enabledToggle = document.getElementById("enabled-toggle");
const enabledLabel = document.getElementById("enabled-label");
const apiBaseInput = document.getElementById("api-base");
const healthPill = document.getElementById("health-pill");
const saveButton = document.getElementById("save-config");
const refreshButton = document.getElementById("refresh-health");
const dashboardButton = document.getElementById("open-dashboard");
const feedbackEl = document.getElementById("config-feedback");

const DEFAULT_API_BASE = "http://127.0.0.1:8765";
let healthRequestId = 0;

saveButton.addEventListener("click", () => {
  void saveConfig();
});

refreshButton.addEventListener("click", () => {
  void refreshHealth();
});

dashboardButton.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "ocr-assist:open-dashboard" });
  window.close();
});

enabledToggle.addEventListener("change", () => {
  renderEnabled(enabledToggle.checked);
});

apiBaseInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void saveConfig();
  }
});

void init();

async function init() {
  const response = await chrome.runtime.sendMessage({ type: "ocr-assist:get-config" });
  const config = response?.config || { enabled: true, apiBase: DEFAULT_API_BASE };
  enabledToggle.checked = Boolean(config.enabled);
  apiBaseInput.value = config.apiBase || DEFAULT_API_BASE;
  renderEnabled(enabledToggle.checked);
  await refreshHealth();
}

function renderEnabled(enabled) {
  enabledLabel.textContent = enabled ? "Enabled" : "Paused";
}

async function saveConfig() {
  const rawValue = apiBaseInput.value.trim();
  if (!rawValue) {
    showFeedback("API base cannot be empty.", "error");
    return;
  }
  if (!isValidApiBase(rawValue)) {
    showFeedback("API base must start with http:// or https://", "error");
    return;
  }

  saveButton.disabled = true;
  const previousLabel = saveButton.textContent;
  saveButton.textContent = "Saving...";
  showFeedback("", "info");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "ocr-assist:set-config",
      patch: {
        enabled: enabledToggle.checked,
        apiBase: rawValue
      }
    });
    if (response?.ok) {
      const stored = response.config?.apiBase;
      if (typeof stored === "string" && stored) {
        apiBaseInput.value = stored;
      }
      renderEnabled(enabledToggle.checked);
      showFeedback("Saved.", "success");
      await refreshHealth();
    } else {
      showFeedback(response?.error || "Failed to save settings.", "error");
    }
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = previousLabel;
  }
}

async function refreshHealth() {
  const requestId = ++healthRequestId;
  healthPill.textContent = "Checking";
  healthPill.classList.add("offline");
  const response = await chrome.runtime.sendMessage({
    type: "ocr-assist:api-request",
    path: "/health",
    method: "GET"
  });
  if (requestId !== healthRequestId) {
    return;
  }
  if (response?.ok && response.data?.ok) {
    healthPill.textContent = "Online";
    healthPill.classList.remove("offline");
    return;
  }
  healthPill.textContent = "Offline";
  healthPill.classList.add("offline");
}

function showFeedback(message, kind) {
  if (!feedbackEl) {
    return;
  }
  feedbackEl.textContent = message;
  feedbackEl.dataset.kind = message ? (kind || "info") : "";
}

function isValidApiBase(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (error) {
    return false;
  }
}
