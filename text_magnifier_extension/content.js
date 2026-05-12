(function () {
  const GLOBAL_FLAG = "__textMagnifierLoaded";
  if (window[GLOBAL_FLAG]) {
    return;
  }
  window[GLOBAL_FLAG] = true;

  const PANEL_ID = "codex-text-magnifier";
  const TOAST_ID = "codex-text-magnifier-toast";
  const UPDATE_DELAY_MS = 80;
  const FOCUS_OUT_DELAY_MS = 120;
  const MAX_TEXT_LENGTH = 6000;
  const PASSIVE_CAPTURE = { capture: true, passive: true };
  const TEXT_INPUT_TYPES = new Set([
    "text",
    "search",
    "url",
    "tel",
    "email",
    "number",
    "date",
    "time",
    "datetime-local",
    "month",
    "week"
  ]);

  const DEFAULT_SETTINGS = {
    zoom: 2.2,
    panelWidth: 380,
    showFocusedField: true
  };

  const state = {
    enabled: false,
    settings: { ...DEFAULT_SETTINGS },
    panel: null,
    toast: null,
    updateTimer: null,
    hideTimer: null,
    toastTimer: null,
    repositionFrame: 0,
    lastPointer: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
    lastAnchorRect: null,
    currentSignature: "",
    renderedSignature: "",
    closedSignature: ""
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "text-magnifier:ping") {
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === "text-magnifier:set-enabled") {
      setSettings(message.settings);
      setEnabled(Boolean(message.enabled));
      sendResponse({ ok: true, enabled: state.enabled });
      return false;
    }

    if (message?.type === "text-magnifier:set-settings") {
      setSettings(message.settings);
      if (state.enabled) {
        queueUpdate(0);
      }
      sendResponse({ ok: true, settings: state.settings });
      return false;
    }

    return false;
  });

  init();

  async function init() {
    const response = await safeSendMessage({ type: "text-magnifier:get-tab-state" });
    setSettings(response?.settings);

    if (response?.enabled) {
      setEnabled(true);
    }
  }

  function setEnabled(enabled) {
    if (state.enabled === enabled) {
      if (enabled) {
        queueUpdate(0);
      } else {
        hidePanel();
      }
      return;
    }

    state.enabled = enabled;

    if (enabled) {
      document.addEventListener("selectionchange", handleSelectionChange, true);
      document.addEventListener("mouseup", handleMouseUp, true);
      document.addEventListener("keyup", handleKeyUp, true);
      document.addEventListener("keydown", handleKeyDown, true);
      document.addEventListener("focusin", handleFocusIn, true);
      document.addEventListener("focusout", handleFocusOut, true);
      document.addEventListener("input", handleInput, true);
      window.addEventListener("scroll", handleViewportChange, PASSIVE_CAPTURE);
      window.addEventListener("resize", handleViewportChange, PASSIVE_CAPTURE);
      queueUpdate(0);
      showToast("文本放大镜已开启");
      return;
    }

    document.removeEventListener("selectionchange", handleSelectionChange, true);
    document.removeEventListener("mouseup", handleMouseUp, true);
    document.removeEventListener("keyup", handleKeyUp, true);
    document.removeEventListener("keydown", handleKeyDown, true);
    document.removeEventListener("focusin", handleFocusIn, true);
    document.removeEventListener("focusout", handleFocusOut, true);
    document.removeEventListener("input", handleInput, true);
    window.removeEventListener("scroll", handleViewportChange, PASSIVE_CAPTURE);
    window.removeEventListener("resize", handleViewportChange, PASSIVE_CAPTURE);
    clearTimers();
    hidePanel();
    showToast("文本放大镜已关闭");
  }

  function setSettings(settings) {
    const source = settings && typeof settings === "object" ? settings : {};
    state.settings = {
      zoom: clampNumber(source.zoom, DEFAULT_SETTINGS.zoom, 1.5, 4),
      panelWidth: clampNumber(source.panelWidth, DEFAULT_SETTINGS.panelWidth, 280, 620),
      showFocusedField:
        typeof source.showFocusedField === "boolean"
          ? source.showFocusedField
          : DEFAULT_SETTINGS.showFocusedField
    };

    if (state.panel) {
      applyPanelSettings();
      if (state.lastAnchorRect) {
        queuePositionUpdate(state.lastAnchorRect);
      }
    }
  }

  function clampNumber(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }

    return Math.min(max, Math.max(min, number));
  }

  function handleSelectionChange() {
    queueUpdate(UPDATE_DELAY_MS);
  }

  function handleMouseUp(event) {
    if (event.button === 0) {
      state.lastPointer = { x: event.clientX, y: event.clientY };
      queueUpdate(0);
    }
  }

  function handleKeyUp() {
    queueUpdate(UPDATE_DELAY_MS);
  }

  function handleKeyDown(event) {
    if (event.key === "Escape") {
      closeCurrentPanel();
    }
  }

  function handleFocusIn() {
    window.clearTimeout(state.hideTimer);
    state.hideTimer = null;
    queueUpdate(0);
  }

  function handleFocusOut() {
    window.clearTimeout(state.hideTimer);
    state.hideTimer = window.setTimeout(() => {
      state.hideTimer = null;
      queueUpdate(0);
    }, FOCUS_OUT_DELAY_MS);
  }

  function handleInput() {
    queueUpdate(UPDATE_DELAY_MS);
  }

  function handleViewportChange() {
    if (isPanelVisible()) {
      queueUpdate(UPDATE_DELAY_MS);
    }
  }

  function queueUpdate(delay) {
    if (!state.enabled) {
      return;
    }

    window.clearTimeout(state.updateTimer);
    state.updateTimer = window.setTimeout(updateMagnifier, delay);
  }

  function updateMagnifier() {
    state.updateTimer = null;

    if (!state.enabled) {
      return;
    }

    const content = getCurrentContent();
    if (!content) {
      state.currentSignature = "";
      state.closedSignature = "";
      hidePanel();
      return;
    }

    const signature = buildSignature(content);
    state.currentSignature = signature;
    if (signature === state.closedSignature) {
      hidePanel();
      return;
    }

    state.lastAnchorRect = content.anchorRect || null;
    if (signature === state.renderedSignature && isPanelVisible()) {
      queuePositionUpdate(content.anchorRect);
      return;
    }

    renderPanel(content, signature);
  }

  function getCurrentContent() {
    const activeElement = document.activeElement;

    if (state.settings.showFocusedField) {
      const fieldState = getFocusedFieldState(activeElement);
      if (fieldState) {
        return fieldState;
      }
    }

    return getPageSelectionState();
  }

  function getFocusedFieldState(element) {
    if (!element || isPanelElement(element)) {
      return null;
    }

    if (isTextInput(element) || element instanceof HTMLTextAreaElement) {
      if (element instanceof HTMLInputElement && element.type.toLowerCase() === "password") {
        return null;
      }

      const value = element.value || "";
      const selectedText = getInputSelectionText(element);
      const text = selectedText || value;
      if (!hasReadableText(text)) {
        return null;
      }

      return {
        source: selectedText ? "input-selection" : "input-content",
        title: selectedText ? "输入框选区" : "输入框内容",
        text: truncateText(text),
        anchorRect: element.getBoundingClientRect()
      };
    }

    if (isContentEditable(element)) {
      const selection = window.getSelection();
      const selectedText =
        selection && !selection.isCollapsed && element.contains(selection.anchorNode)
          ? selection.toString()
          : "";
      const text = selectedText || element.textContent || "";
      if (!hasReadableText(text)) {
        return null;
      }

      const anchorRect = selectedText ? getSelectionRect(selection) : element.getBoundingClientRect();
      return {
        source: selectedText ? "editable-selection" : "editable-content",
        title: selectedText ? "可编辑区域选区" : "可编辑区域内容",
        text: truncateText(text),
        anchorRect
      };
    }

    return null;
  }

  function getInputSelectionText(element) {
    try {
      const start = element.selectionStart;
      const end = element.selectionEnd;
      if (
        typeof start === "number" &&
        typeof end === "number" &&
        end > start &&
        typeof element.value === "string"
      ) {
        return element.value.slice(start, end);
      }
    } catch (error) {
      return "";
    }

    return "";
  }

  function getPageSelectionState() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return null;
    }

    if (isPanelElement(selection.anchorNode) || isPanelElement(selection.focusNode)) {
      return null;
    }

    const text = selection.toString();
    if (!hasReadableText(text)) {
      return null;
    }

    return {
      source: "page-selection",
      title: "选中文本",
      text: truncateText(text),
      anchorRect: getSelectionRect(selection)
    };
  }

  function getSelectionRect(selection) {
    if (!selection || selection.rangeCount === 0) {
      return null;
    }

    const range = selection.getRangeAt(0);
    const clientRects = Array.from(range.getClientRects());
    const visibleRect = clientRects.find((rect) => rect.width > 0 && rect.height > 0);
    if (visibleRect) {
      return visibleRect;
    }

    const boundingRect = range.getBoundingClientRect();
    return boundingRect.width > 0 || boundingRect.height > 0 ? boundingRect : null;
  }

  function hasReadableText(text) {
    return typeof text === "string" && text.replace(/\s+/g, "").length > 0;
  }

  function truncateText(text) {
    if (text.length <= MAX_TEXT_LENGTH) {
      return text;
    }

    return `${text.slice(0, MAX_TEXT_LENGTH)}\n\n... 已截断，原文过长`;
  }

  function buildSignature(content) {
    return [
      content.source,
      content.text.length,
      content.text.slice(0, 240),
      content.text.slice(-160)
    ].join(":");
  }

  function renderPanel(content, signature) {
    const panel = ensurePanel();
    const title = panel.querySelector(".codex-text-magnifier__title");
    const body = panel.querySelector(".codex-text-magnifier__body");

    title.textContent = content.title;
    body.textContent = content.text;
    state.lastAnchorRect = content.anchorRect || null;
    state.renderedSignature = signature;
    applyPanelSettings();

    panel.dataset.visible = "true";
    queuePositionUpdate(content.anchorRect);
  }

  function ensurePanel() {
    if (state.panel && document.documentElement.contains(state.panel)) {
      return state.panel;
    }

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-live", "polite");
    panel.innerHTML = [
      '<div class="codex-text-magnifier__header">',
      '  <span class="codex-text-magnifier__title"></span>',
      '  <button class="codex-text-magnifier__close" type="button" aria-label="关闭文本放大镜">×</button>',
      "</div>",
      '<div class="codex-text-magnifier__body"></div>'
    ].join("");

    panel.querySelector(".codex-text-magnifier__close").addEventListener("click", () => {
      closeCurrentPanel();
    });

    document.documentElement.appendChild(panel);
    state.panel = panel;
    return panel;
  }

  function applyPanelSettings() {
    if (!state.panel) {
      return;
    }

    state.panel.style.setProperty("--codex-text-magnifier-zoom", String(state.settings.zoom));
    state.panel.style.setProperty(
      "--codex-text-magnifier-width",
      `${state.settings.panelWidth}px`
    );
  }

  function positionPanel(anchorRect) {
    const panel = state.panel;
    if (!panel || panel.dataset.visible !== "true") {
      return;
    }

    const viewportPadding = 12;
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const panelRect = panel.getBoundingClientRect();
    const fallbackX = state.lastPointer.x;
    const fallbackY = state.lastPointer.y;
    const anchor = getUsableRect(anchorRect) || {
      left: fallbackX,
      right: fallbackX,
      top: fallbackY,
      bottom: fallbackY,
      width: 0,
      height: 0
    };

    const targetWidth = Math.min(panelRect.width, viewportWidth - viewportPadding * 2);
    let left = anchor.left + anchor.width / 2 - targetWidth / 2;
    left = Math.max(viewportPadding, Math.min(left, viewportWidth - targetWidth - viewportPadding));

    const belowTop = anchor.bottom + 10;
    const aboveTop = anchor.top - panelRect.height - 10;
    let top = belowTop;
    if (belowTop + panelRect.height > viewportHeight - viewportPadding && aboveTop >= viewportPadding) {
      top = aboveTop;
    }

    top = Math.max(viewportPadding, Math.min(top, viewportHeight - panelRect.height - viewportPadding));

    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  }

  function queuePositionUpdate(anchorRect) {
    if (anchorRect) {
      state.lastAnchorRect = anchorRect;
    }

    if (state.repositionFrame) {
      return;
    }

    state.repositionFrame = window.requestAnimationFrame(() => {
      state.repositionFrame = 0;
      positionPanel(state.lastAnchorRect);
    });
  }

  function getUsableRect(rect) {
    if (!rect) {
      return null;
    }

    const width = Math.max(0, Number(rect.width) || 0);
    const height = Math.max(0, Number(rect.height) || 0);
    const left = Number(rect.left);
    const right = Number(rect.right);
    const top = Number(rect.top);
    const bottom = Number(rect.bottom);

    if (![left, right, top, bottom].every(Number.isFinite)) {
      return null;
    }

    return { left, right, top, bottom, width, height };
  }

  function closeCurrentPanel() {
    state.closedSignature = state.currentSignature;
    hidePanel();
  }

  function hidePanel() {
    if (!state.panel) {
      return;
    }

    state.panel.dataset.visible = "false";
    state.renderedSignature = "";
  }

  function showToast(message) {
    const toast = ensureToast();
    toast.textContent = message;
    toast.dataset.visible = "true";

    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => {
      toast.dataset.visible = "false";
    }, 1400);
  }

  function ensureToast() {
    if (state.toast && document.documentElement.contains(state.toast)) {
      return state.toast;
    }

    const toast = document.createElement("div");
    toast.id = TOAST_ID;
    document.documentElement.appendChild(toast);
    state.toast = toast;
    return toast;
  }

  function clearTimers() {
    window.clearTimeout(state.updateTimer);
    window.clearTimeout(state.hideTimer);
    if (state.repositionFrame) {
      window.cancelAnimationFrame(state.repositionFrame);
    }
    state.updateTimer = null;
    state.hideTimer = null;
    state.repositionFrame = 0;
  }

  function isPanelVisible() {
    return Boolean(state.panel && state.panel.dataset.visible === "true");
  }

  function isTextInput(element) {
    if (!(element instanceof HTMLInputElement)) {
      return false;
    }

    const type = (element.type || "text").toLowerCase();
    return TEXT_INPUT_TYPES.has(type);
  }

  function isContentEditable(element) {
    return element instanceof HTMLElement && element.isContentEditable;
  }

  function isPanelElement(node) {
    if (!node) {
      return false;
    }

    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return Boolean(element?.closest?.(`#${PANEL_ID}, #${TOAST_ID}`));
  }

  async function safeSendMessage(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      return null;
    }
  }
})();
