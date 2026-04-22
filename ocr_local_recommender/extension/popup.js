const enabledToggle = document.getElementById("enabled-toggle");
const enabledLabel = document.getElementById("enabled-label");
const apiBaseInput = document.getElementById("api-base");
const healthPill = document.getElementById("health-pill");

document.getElementById("save-config").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({
    type: "ocr-assist:set-config",
    patch: {
      enabled: enabledToggle.checked,
      apiBase: apiBaseInput.value.trim()
    }
  });
  renderEnabled(enabledToggle.checked);
  void refreshHealth();
});

document.getElementById("refresh-health").addEventListener("click", () => {
  void refreshHealth();
});

document.getElementById("open-dashboard").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "ocr-assist:open-dashboard" });
  window.close();
});

enabledToggle.addEventListener("change", () => {
  renderEnabled(enabledToggle.checked);
});

void init();

async function init() {
  const response = await chrome.runtime.sendMessage({ type: "ocr-assist:get-config" });
  const config = response?.config || { enabled: true, apiBase: "http://127.0.0.1:8765" };
  enabledToggle.checked = Boolean(config.enabled);
  apiBaseInput.value = config.apiBase || "http://127.0.0.1:8765";
  renderEnabled(enabledToggle.checked);
  await refreshHealth();
}

function renderEnabled(enabled) {
  enabledLabel.textContent = enabled ? "Enabled" : "Paused";
}

async function refreshHealth() {
  healthPill.textContent = "Checking";
  healthPill.classList.add("offline");
  const response = await chrome.runtime.sendMessage({
    type: "ocr-assist:api-request",
    path: "/health",
    method: "GET"
  });
  if (response?.ok && response.data?.ok) {
    healthPill.textContent = "Online";
    healthPill.classList.remove("offline");
    return;
  }
  healthPill.textContent = "Offline";
  healthPill.classList.add("offline");
}
