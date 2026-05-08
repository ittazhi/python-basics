(function () {
  "use strict";

  if (window.__textMagnifierExtensionApi) return;

  var SCALE = 2;
  var LENS_WIDTH = 260;
  var LENS_HEIGHT = 120;
  var LENS_OFFSET = 16;
  var VIEWPORT_MARGIN = 8;
  var MAX_PREVIEW_LENGTH = 1400;
  var enabled = false;
  var lastMouse = { x: 0, y: 0, target: null };

  var textTargetSelector = [
    "textarea",
    "input[type='text']",
    "input[type='search']",
    "input[type='url']",
    "input[type='email']",
    "input[type='tel']",
    "input:not([type])",
    "[contenteditable='true']",
    "[contenteditable='']",
    "td",
    "th",
    "p",
    "span",
    "li",
    "a",
    "blockquote",
    "pre",
    "code"
  ].join(",");

  var button = document.createElement("button");
  button.type = "button";
  button.className = "tm-toggle";
  button.textContent = "MAG";
  button.title = "Text Magnifier: click to enable, Alt+M to toggle, Esc to close";

  var lens = document.createElement("div");
  lens.className = "tm-lens";
  lens.setAttribute("aria-hidden", "true");
  lens.innerHTML = '<div class="tm-source"></div><div class="tm-content"></div>';

  var sourceNode = lens.querySelector(".tm-source");
  var contentNode = lens.querySelector(".tm-content");

  document.documentElement.appendChild(button);
  document.documentElement.appendChild(lens);

  function normalizeText(text) {
    return String(text || "").replace(/\u00a0/g, " ");
  }

  function hasReadableText(text) {
    return normalizeText(text).trim().length > 0;
  }

  function truncatePreview(text) {
    if (text.length <= MAX_PREVIEW_LENGTH) return text;
    return text.slice(0, MAX_PREVIEW_LENGTH) + "...";
  }

  function isTextInput(element) {
    if (!element) return false;
    if (element instanceof HTMLTextAreaElement) return true;
    if (!(element instanceof HTMLInputElement)) return false;
    var type = (element.getAttribute("type") || "text").toLowerCase();
    return ["text", "search", "url", "email", "tel", ""].indexOf(type) !== -1;
  }

  function getFormSelection(element) {
    var start = element.selectionStart;
    var end = element.selectionEnd;
    if (start === null || end === null || start === end) return null;
    var text = normalizeText(element.value.slice(Math.min(start, end), Math.max(start, end)));
    return hasReadableText(text) ? text : null;
  }

  function getFormPreview(element) {
    var value = normalizeText(element.value);
    if (!hasReadableText(value)) return null;

    var caret = element === document.activeElement ? element.selectionStart : null;
    if (caret === null) return truncatePreview(value);

    var lineStart = element.value.lastIndexOf("\n", Math.max(0, caret - 1)) + 1;
    var lineEndIndex = element.value.indexOf("\n", caret);
    var lineEnd = lineEndIndex === -1 ? element.value.length : lineEndIndex;
    var line = normalizeText(element.value.slice(lineStart, lineEnd));

    return truncatePreview(hasReadableText(line) ? line : value);
  }

  function getDocumentSelection() {
    var selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;

    var range = selection.getRangeAt(0);
    var node = range.commonAncestorContainer;
    var element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (element && element.closest && element.closest(".tm-toggle, .tm-lens")) return null;

    var text = normalizeText(selection.toString());
    return hasReadableText(text) ? text : null;
  }

  function getTargetText(target) {
    if (!(target instanceof Element)) return null;
    if (target.closest(".tm-toggle, .tm-lens")) return null;

    var selectedText = getDocumentSelection();
    if (selectedText) {
      return { text: truncatePreview(selectedText), source: "Selected text" };
    }

    var textTarget = target.closest(textTargetSelector);
    if (!textTarget || textTarget.closest("script, style, noscript")) return null;

    if (isTextInput(textTarget)) {
      var formSelection = getFormSelection(textTarget);
      if (formSelection) {
        return { text: truncatePreview(formSelection), source: "Text field selection" };
      }

      var preview = getFormPreview(textTarget);
      return preview ? { text: preview, source: "Text field" } : null;
    }

    var text = normalizeText(textTarget.innerText || textTarget.textContent || "");
    return hasReadableText(text) ? { text: truncatePreview(text), source: "Page text" } : null;
  }

  function clampLensPosition(clientX, clientY) {
    var x = clientX + LENS_OFFSET;
    var y = clientY + LENS_OFFSET;

    if (x + LENS_WIDTH + VIEWPORT_MARGIN > window.innerWidth) {
      x = clientX - LENS_WIDTH - LENS_OFFSET;
    }
    if (y + LENS_HEIGHT + VIEWPORT_MARGIN > window.innerHeight) {
      y = clientY - LENS_HEIGHT - LENS_OFFSET;
    }

    return {
      x: Math.max(VIEWPORT_MARGIN, Math.min(x, window.innerWidth - LENS_WIDTH - VIEWPORT_MARGIN)),
      y: Math.max(VIEWPORT_MARGIN, Math.min(y, window.innerHeight - LENS_HEIGHT - VIEWPORT_MARGIN))
    };
  }

  function hideLens() {
    lens.classList.remove("tm-visible");
  }

  function updateLens(clientX, clientY, target) {
    if (!enabled) {
      hideLens();
      return;
    }

    var content = getTargetText(target);
    if (!content) {
      hideLens();
      return;
    }

    var position = clampLensPosition(clientX, clientY);
    sourceNode.textContent = content.source + " - " + SCALE + "x";
    contentNode.textContent = content.text;
    lens.style.left = position.x + "px";
    lens.style.top = position.y + "px";
    lens.style.width = LENS_WIDTH + "px";
    lens.style.height = LENS_HEIGHT + "px";
    contentNode.style.fontSize = 12 * SCALE + "px";
    lens.classList.add("tm-visible");
  }

  function setEnabled(nextEnabled) {
    enabled = nextEnabled;
    button.classList.toggle("tm-enabled", enabled);
    button.textContent = enabled ? "ON" : "MAG";
    button.title = enabled
      ? "Text Magnifier is on. Alt+M toggles, Esc closes."
      : "Text Magnifier is off. Click or press Alt+M to enable.";

    if (enabled) {
      updateLens(lastMouse.x, lastMouse.y, lastMouse.target || document.body);
    } else {
      hideLens();
    }
  }

  window.__textMagnifierExtensionApi = {
    toggle: function () {
      setEnabled(!enabled);
      return enabled;
    },
    setEnabled: function (nextEnabled) {
      setEnabled(Boolean(nextEnabled));
      return enabled;
    }
  };

  button.addEventListener("click", function (event) {
    event.preventDefault();
    event.stopPropagation();
    setEnabled(!enabled);
  });

  document.addEventListener("mousemove", function (event) {
    lastMouse = { x: event.clientX, y: event.clientY, target: event.target };
    updateLens(event.clientX, event.clientY, event.target);
  }, true);

  document.addEventListener("mouseup", function (event) {
    lastMouse = { x: event.clientX, y: event.clientY, target: event.target };
    window.setTimeout(function () {
      updateLens(lastMouse.x, lastMouse.y, lastMouse.target);
    }, 0);
  }, true);

  document.addEventListener("selectionchange", function () {
    updateLens(lastMouse.x, lastMouse.y, lastMouse.target || document.activeElement || document.body);
  });

  window.addEventListener("scroll", hideLens, true);
  window.addEventListener("blur", hideLens);

  document.addEventListener("keydown", function (event) {
    if (event.altKey && event.key.toLowerCase() === "m") {
      event.preventDefault();
      setEnabled(!enabled);
      return;
    }

    if (event.key === "Escape" && enabled) {
      setEnabled(false);
    }
  }, true);

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (message, _sender, sendResponse) {
      if (!message || message.type !== "TEXT_MAGNIFIER_TOGGLE") return false;

      var nextEnabled = typeof message.enabled === "boolean" ? message.enabled : !enabled;
      setEnabled(nextEnabled);
      sendResponse({ enabled: enabled });
      return true;
    });
  }
})();
