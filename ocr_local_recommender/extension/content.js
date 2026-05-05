(function () {
  const GLOBAL_FLAG = "__ocrLocalRecommenderLoaded";
  const UI_POSITION_KEY = "ocrLocalRecommenderUiPositions";
  if (window[GLOBAL_FLAG]) {
    return;
  }
  window[GLOBAL_FLAG] = true;

  const EDITABLE_SELECTOR = [
    "textarea",
    "input:not([type])",
    "input[type='text']",
    "input[type='search']",
    "input[type='number']",
    "input[type='email']",
    "input[type='tel']",
    "input[type='url']",
    "[contenteditable='true']",
    "[contenteditable='']",
    "[contenteditable='plaintext-only']"
  ].join(", ");

  const CONTAINER_SELECTORS = [
    ".anno-card",
    ".annotation-card",
    ".annotation-item",
    "[data-annotation-card]",
    "[data-label-card]",
    ".ocr-annotation-card",
    ".ant-form-item",
    ".el-form-item",
    ".form-item",
    ".form-row"
  ].join(", ");

  const state = {
    isTopFrame: window.top === window,
    config: {
      enabled: true,
      apiBase: "http://127.0.0.1:8765"
    },
    activeTarget: null,
    suggestions: [],
    selectedIndex: 0,
    suggestionTimer: null,
    captureTimer: null,
    publishTimer: null,
    suggestionSequence: 0,
    lastSnapshot: null,
    lastSnapshotSignature: "",
    lastCommitSignature: "",
    acceptedCandidate: null,
    uiPositions: {
      popover: null,
      sidebar: null
    },
    drag: null,
    ui: null,
    observer: null
  };

  const SNAPSHOT_LIMITS = {
    containers: 80,
    editables: 80,
    neighborElements: 50,
    labels: 160,
    frames: 20
  };

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "ocr-assist:config-changed") {
      return false;
    }
    state.config = {
      ...state.config,
      ...(message.config || {})
    };
    if (!state.config.enabled) {
      hideAllUi();
      disconnectDomObserver();
    } else if (state.isTopFrame && state.activeTarget) {
      ensureDomObserver();
      scheduleSuggest("config", 10);
    }
    return false;
  });

  void init();

  async function init() {
    const response = await sendMessage({ type: "ocr-assist:get-config" });
    state.config = {
      ...state.config,
      ...(response?.config || {})
    };
    if (!state.config.enabled) {
      return;
    }

    installHistoryHooks();
    bindCommonEvents();

    if (state.isTopFrame) {
      createUi();
      await loadUiPositions();
      applyPanelPosition("sidebar");
    } else {
      scheduleFramePublish("init", 600);
    }
  }

  function bindCommonEvents() {
    document.addEventListener("focusin", handleFocusIn, true);
    document.addEventListener("input", handleInput, true);
    document.addEventListener("change", handleChange, true);
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("blur", handleBlur, true);
    window.addEventListener("resize", handleViewportChange, true);
    window.addEventListener("scroll", handleViewportChange, true);
    window.addEventListener("ocr-assist:navigation", handleNavigation, true);
    window.addEventListener("popstate", handleNavigation, true);
  }

  function ensureDomObserver() {
    if (state.observer) {
      return;
    }
    state.observer = new MutationObserver((records) => {
      if (!state.config.enabled) {
        return;
      }
      if (records.every(isInternalMutation)) {
        return;
      }
      if (state.isTopFrame) {
        if (state.activeTarget && document.contains(state.activeTarget)) {
          scheduleSnapshotCapture("mutation", 900);
        }
      } else {
        scheduleFramePublish("mutation", 900);
      }
    });
    if (document.documentElement) {
      state.observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: false
      });
    }
  }

  function disconnectDomObserver() {
    if (!state.observer) {
      return;
    }
    state.observer.disconnect();
    state.observer = null;
  }

  function isInternalMutation(record) {
    if (!state.ui?.root) {
      return false;
    }
    if (state.ui.root.contains(record.target)) {
      return true;
    }
    const nodes = [...record.addedNodes, ...record.removedNodes];
    return nodes.length > 0 && nodes.every((node) => node === state.ui.root || state.ui.root.contains(node));
  }

  function createUi() {
    if (state.ui || !document.documentElement) {
      return;
    }

    const root = document.createElement("div");
    root.id = "ocr-local-recommender-root";
    root.innerHTML = `
      <div class="ocr-lr-popover" data-visible="false">
        <div class="ocr-lr-popover-head" data-drag-handle="popover" title="Drag to move">
          <div class="ocr-lr-popover-title">
            <strong>Local suggestions</strong>
            <span id="ocr-lr-status">Waiting for focus</span>
          </div>
          <div class="ocr-lr-panel-actions">
            <span class="ocr-lr-drag-hint">Drag title</span>
            <button class="ocr-lr-inline-button" data-action="open-search">Search all</button>
            <button class="ocr-lr-inline-button" data-action="reset-popover">Reset</button>
          </div>
        </div>
        <div class="ocr-lr-list"></div>
        <div class="ocr-lr-footer">Click a card or press Option+1-5. Arrow keys + Option+Enter accept the selected card.</div>
      </div>
      <aside class="ocr-lr-sidebar" data-visible="false">
        <div class="ocr-lr-sidebar-head" data-drag-handle="sidebar" title="Drag to move">
          <div class="ocr-lr-sidebar-title">
            <strong>Current context</strong>
            <span class="ocr-lr-meta" id="ocr-lr-context-meta">No active field</span>
          </div>
          <button class="ocr-lr-inline-button" data-action="reset-sidebar">Reset</button>
        </div>
        <div class="ocr-lr-sidebar-body"></div>
      </aside>
      <div class="ocr-lr-modal" data-visible="false">
        <div class="ocr-lr-modal-card">
          <div class="ocr-lr-modal-head">
            <strong>History search</strong>
            <button class="ocr-lr-inline-button" data-action="close-search">Close</button>
          </div>
          <div class="ocr-lr-modal-toolbar">
            <input type="text" placeholder="Search all local history" id="ocr-lr-search-input">
            <button class="ocr-lr-inline-button" data-action="run-search">Search</button>
          </div>
          <div class="ocr-lr-modal-list"></div>
        </div>
      </div>
    `;
    document.documentElement.appendChild(root);

    root.querySelector("[data-action='open-search']").addEventListener("click", () => {
      void openSearchModal();
    });
    root.querySelector("[data-action='reset-popover']").addEventListener("click", () => {
      resetPanelPosition("popover");
    });
    root.querySelector("[data-action='reset-sidebar']").addEventListener("click", () => {
      resetPanelPosition("sidebar");
    });
    root.querySelector("[data-action='close-search']").addEventListener("click", closeSearchModal);
    root.querySelector("[data-action='run-search']").addEventListener("click", () => {
      void runSearch(root.querySelector("#ocr-lr-search-input").value);
    });
    root.querySelector("#ocr-lr-search-input").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void runSearch(event.currentTarget.value);
      }
    });
    root.addEventListener("mousedown", (event) => {
      if (event.target.closest(".ocr-lr-item, .ocr-lr-search-card, .ocr-lr-inline-button")) {
        event.preventDefault();
      }
    });
    root.addEventListener("pointerdown", handlePanelPointerDown);

    state.ui = {
      root,
      popover: root.querySelector(".ocr-lr-popover"),
      list: root.querySelector(".ocr-lr-list"),
      status: root.querySelector("#ocr-lr-status"),
      sidebar: root.querySelector(".ocr-lr-sidebar"),
      sidebarBody: root.querySelector(".ocr-lr-sidebar-body"),
      contextMeta: root.querySelector("#ocr-lr-context-meta"),
      modal: root.querySelector(".ocr-lr-modal"),
      modalInput: root.querySelector("#ocr-lr-search-input"),
      modalList: root.querySelector(".ocr-lr-modal-list")
    };
  }

  function handleFocusIn(event) {
    if (!state.config.enabled || !isTrackableEditable(event.target)) {
      return;
    }

    state.activeTarget = event.target;
    state.acceptedCandidate = null;
    ensureDomObserver();
    if (state.isTopFrame) {
      positionPopover();
      window.clearTimeout(state.captureTimer);
      scheduleSuggest("focus", 100);
    } else {
      scheduleFramePublish("focus", 80);
    }
  }

  function handleInput(event) {
    if (!state.config.enabled || !isTrackableEditable(event.target)) {
      return;
    }
    if (state.isTopFrame) {
      state.activeTarget = event.target;
      positionPopover();
      maybeReportEditedAcceptance(event.target);
      scheduleSuggest("input", 180);
    } else {
      scheduleFramePublish("input", 180);
    }
  }

  function handleChange(event) {
    if (!state.config.enabled || !isTrackableEditable(event.target)) {
      return;
    }
    if (state.isTopFrame) {
      void commitCurrentValue("change_commit");
    } else {
      scheduleFramePublish("change", 120);
    }
  }

  function handleBlur(event) {
    if (!state.isTopFrame || !state.config.enabled || !isTrackableEditable(event.target)) {
      return;
    }
    const target = event.target;
    window.setTimeout(() => {
      if (document.activeElement && isTrackableEditable(document.activeElement)) {
        return;
      }
      if (target === state.activeTarget) {
        void commitCurrentValue("blur_commit");
        hidePopover();
        state.activeTarget = null;
        disconnectDomObserver();
      }
    }, 120);
  }

  function handleViewportChange() {
    if (!state.config.enabled) {
      return;
    }
    if (state.isTopFrame) {
      positionPopover();
      applyPanelPosition("sidebar");
      if (state.activeTarget && document.contains(state.activeTarget)) {
        scheduleSnapshotCapture("viewport", 900);
      }
    } else {
      scheduleFramePublish("viewport", 900);
    }
  }

  function handleNavigation() {
    state.lastSnapshot = null;
    state.lastSnapshotSignature = "";
    state.lastCommitSignature = "";
    state.suggestions = [];
    state.selectedIndex = 0;
    state.acceptedCandidate = null;
    if (state.isTopFrame) {
      renderSuggestions();
      window.clearTimeout(state.captureTimer);
      if (state.activeTarget && document.contains(state.activeTarget)) {
        scheduleSuggest("navigation", 260);
      }
    } else {
      scheduleFramePublish("navigation", 700);
    }
  }

  function handleKeyDown(event) {
    if (!state.config.enabled || !state.isTopFrame) {
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "k") {
      event.preventDefault();
      void openSearchModal();
      return;
    }

    if (!state.ui || state.ui.modal.dataset.visible === "true") {
      if (event.key === "Escape") {
        closeSearchModal();
      }
      return;
    }

    if (!state.suggestions.length || !state.ui.popover.dataset.visible || state.ui.popover.dataset.visible !== "true") {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      state.selectedIndex = (state.selectedIndex + 1) % state.suggestions.length;
      updateActiveSuggestionItem();
      renderSidebar(state.lastSnapshot, state.suggestions[state.selectedIndex] || null);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      state.selectedIndex = (state.selectedIndex - 1 + state.suggestions.length) % state.suggestions.length;
      updateActiveSuggestionItem();
      renderSidebar(state.lastSnapshot, state.suggestions[state.selectedIndex] || null);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      hidePopover();
      return;
    }

    if (isAcceptShortcut(event)) {
      event.preventDefault();
      const suggestion = state.suggestions[state.selectedIndex];
      if (suggestion) {
        void acceptSuggestion(suggestion);
      }
      return;
    }

    const directPickIndex = getDirectPickShortcutIndex(event);
    if (directPickIndex >= 0) {
      const index = directPickIndex;
      const suggestion = state.suggestions[index];
      if (suggestion) {
        event.preventDefault();
        void acceptSuggestion(suggestion);
      }
    }
  }

  function isAcceptShortcut(event) {
    return event.altKey && !event.ctrlKey && !event.metaKey && event.key === "Enter";
  }

  function getDirectPickShortcutIndex(event) {
    if (!event.altKey || event.ctrlKey || event.metaKey) {
      return -1;
    }
    const codeMatch = /^Digit([1-5])$/.exec(event.code || "");
    if (codeMatch) {
      return Number(codeMatch[1]) - 1;
    }
    if (/^[1-5]$/.test(event.key)) {
      return Number(event.key) - 1;
    }
    return -1;
  }

  function scheduleSuggest(reason, delay) {
    if (!state.isTopFrame || !state.config.enabled) {
      return;
    }
    window.clearTimeout(state.suggestionTimer);
    state.suggestionTimer = window.setTimeout(() => {
      void updateSuggestions(reason);
    }, delay);
  }

  function scheduleSnapshotCapture(reason, delay) {
    if (!state.isTopFrame || !state.config.enabled) {
      return;
    }
    window.clearTimeout(state.captureTimer);
    state.captureTimer = window.setTimeout(() => {
      void captureSnapshot(reason);
    }, delay);
  }

  function scheduleFramePublish(reason, delay) {
    if (state.isTopFrame || !state.config.enabled) {
      return;
    }
    window.clearTimeout(state.publishTimer);
    state.publishTimer = window.setTimeout(() => {
      void publishFrameFragment(reason);
    }, delay);
  }

  async function captureSnapshot(reason) {
    const snapshot = await buildSnapshot();
    if (!snapshot) {
      return;
    }
    const signature = snapshotSignature(snapshot);
    if (signature === state.lastSnapshotSignature && reason !== "focus" && reason !== "navigation") {
      return;
    }
    state.lastSnapshot = snapshot;
    state.lastSnapshotSignature = signature;
    const response = await apiRequest("/capture/sample-snapshot", "POST", snapshot);
    if (!response?.ok) {
      setStatus("Backend unavailable");
    }
  }

  async function publishFrameFragment(reason) {
    const fragment = buildFrameFragment();
    if (!fragment) {
      return;
    }
    await sendMessage({
      type: "ocr-assist:frame-snapshot",
      pageKey: fragment.page_identity,
      reason,
      fragment
    });
  }

  async function updateSuggestions(reason) {
    if (!state.activeTarget || !document.contains(state.activeTarget)) {
      hidePopover();
      return;
    }
    const snapshot = await buildSnapshot();
    if (!snapshot) {
      hidePopover();
      return;
    }

    const requestId = ++state.suggestionSequence;
    setStatus("Loading suggestions");
    const response = await apiRequest("/suggest", "POST", {
      sample_snapshot: snapshot,
      limit: snapshot.current_input ? 5 : 3
    });

    if (requestId !== state.suggestionSequence) {
      return;
    }

    if (!response?.ok || !response.data?.suggestions) {
      state.suggestions = [];
      renderSuggestions();
      renderSidebar(snapshot, null);
      setStatus("Backend unavailable");
      return;
    }

    state.lastSnapshot = snapshot;
    state.suggestions = response.data.suggestions || [];
    state.selectedIndex = 0;
    renderSuggestions();
    renderSidebar(snapshot, state.suggestions[0] || null);

    if (state.suggestions.length) {
      setStatus(`${state.suggestions.length} suggestions`);
      void apiRequest("/feedback", "POST", {
        event_type: "show",
        candidate_ids: state.suggestions.map((item) => item.candidate_id),
        payload: { reason }
      });
    } else {
      setStatus(snapshot.current_input ? "No matching history" : "No high-confidence candidate");
    }
  }

  async function commitCurrentValue(source) {
    if (!state.activeTarget || !document.contains(state.activeTarget)) {
      return;
    }
    const value = cleanDisplayText(readEditableValue(state.activeTarget));
    if (!value) {
      return;
    }

    const snapshot = await buildSnapshot();
    if (!snapshot) {
      return;
    }
    const signature = [source, snapshot.page_identity, snapshot.target_label_type, value].join("|");
    if (signature === state.lastCommitSignature) {
      return;
    }
    state.lastCommitSignature = signature;
    await apiRequest("/capture/value-commit", "POST", {
      text: value,
      source,
      sample_snapshot: snapshot
    });
  }

  function maybeReportEditedAcceptance(target) {
    if (
      !state.acceptedCandidate ||
      state.acceptedCandidate.target !== target ||
      state.acceptedCandidate.logged
    ) {
      return;
    }
    const currentValue = cleanDisplayText(readEditableValue(target));
    if (!currentValue || currentValue === state.acceptedCandidate.text) {
      return;
    }
    state.acceptedCandidate.logged = true;
    void (async () => {
      const snapshot = await buildSnapshot();
      if (!snapshot) {
        return;
      }
      await apiRequest("/feedback", "POST", {
        event_type: "accept_then_edit",
        candidate_id: state.acceptedCandidate.candidateId,
        sample_snapshot: snapshot,
        payload: {
          edited_text: currentValue
        }
      });
    })();
  }

  async function acceptSuggestion(suggestion) {
    if (!state.activeTarget || !document.contains(state.activeTarget)) {
      return;
    }
    writeEditableValue(state.activeTarget, suggestion.text);
    state.acceptedCandidate = {
      candidateId: suggestion.candidate_id,
      target: state.activeTarget,
      text: suggestion.text,
      logged: false
    };
    const snapshot = await buildSnapshot();
    if (snapshot) {
      snapshot.current_input = suggestion.text;
      await apiRequest("/feedback", "POST", {
        event_type: "accept",
        candidate_id: suggestion.candidate_id,
        sample_snapshot: snapshot,
        payload: {
          source_preview: suggestion.source_preview
        }
      });
      renderSidebar(snapshot, suggestion);
    }
    hidePopover();
  }

  async function openSearchModal() {
    if (!state.ui) {
      return;
    }
    state.ui.modal.dataset.visible = "true";
    const seed = cleanText(state.activeTarget ? readEditableValue(state.activeTarget) : "");
    state.ui.modalInput.value = seed;
    state.ui.modalList.innerHTML = "<div class=\"ocr-lr-empty\">Search all local history, including weak clipboard candidates.</div>";
    state.ui.modalInput.focus();
    if (seed) {
      await runSearch(seed);
    }
  }

  function closeSearchModal() {
    if (!state.ui) {
      return;
    }
    state.ui.modal.dataset.visible = "false";
  }

  async function runSearch(query) {
    if (!state.ui) {
      return;
    }
    const cleanQuery = cleanText(query);
    if (!cleanQuery) {
      state.ui.modalList.innerHTML = "<div class=\"ocr-lr-empty\">Type something to search local history.</div>";
      return;
    }
    state.ui.modalList.innerHTML = "<div class=\"ocr-lr-empty\">Searching...</div>";
    const snapshot = await buildSnapshot();
    const response = await apiRequest("/search", "POST", {
      query: cleanQuery,
      sample_snapshot: snapshot,
      limit: 20
    });
    const results = response?.ok && response.data?.results ? response.data.results : [];
    if (!results.length) {
      state.ui.modalList.innerHTML = "<div class=\"ocr-lr-empty\">No history matched that query.</div>";
      return;
    }
    state.ui.modalList.innerHTML = "";
    for (const item of results) {
      const card = document.createElement("button");
      card.className = "ocr-lr-search-card";
      card.innerHTML = `
        <div class="ocr-lr-item-top">
          <div class="ocr-lr-item-text">${escapeHtml(item.text)}</div>
          <span class="ocr-lr-pill" data-tier="${escapeHtml(item.tier)}">${escapeHtml(item.tier)}</span>
        </div>
        <div class="ocr-lr-meta">${escapeHtml(item.source_preview || "")}</div>
        <div class="ocr-lr-reasons">
          ${(item.reasons || []).map((reason) => `<span class="ocr-lr-reason">${escapeHtml(reason)}</span>`).join("")}
        </div>
      `;
      card.addEventListener("click", () => {
        void acceptSuggestion(item);
        closeSearchModal();
      });
      state.ui.modalList.appendChild(card);
    }
  }

  function buildFrameFragment() {
    const activeTarget = isTrackableEditable(document.activeElement) ? document.activeElement : null;
    const active = extractActiveTarget(activeTarget);
    return {
      page_identity: extractPageIdentity(),
      target_label_type: active.labelType,
      target_region: active.region,
      current_input: active.currentInput,
      visible_labels: extractVisibleLabels(activeTarget),
      neighbor_texts: extractNeighborTexts(activeTarget),
      unreadable_frames: collectUnreadableFrames()
    };
  }

  async function buildSnapshot() {
    if (!state.config.enabled) {
      return null;
    }

    const activeTarget = state.activeTarget && document.contains(state.activeTarget)
      ? state.activeTarget
      : (isTrackableEditable(document.activeElement) ? document.activeElement : null);
    const active = extractActiveTarget(activeTarget);
    const localLabels = extractVisibleLabels(activeTarget);
    const localNeighborTexts = extractNeighborTexts(activeTarget);
    const unreadableFrames = collectUnreadableFrames();

    const mergedLabels = [...localLabels];
    const mergedNeighborTexts = [...localNeighborTexts];
    if (state.isTopFrame) {
      const frameResponse = await sendMessage({
        type: "ocr-assist:get-frame-snapshots",
        pageKey: extractPageIdentity()
      });
      for (const fragment of frameResponse?.fragments || []) {
        mergedLabels.push(...(fragment.visible_labels || []));
        mergedNeighborTexts.push(...(fragment.neighbor_texts || []));
        unreadableFrames.push(...(fragment.unreadable_frames || []));
      }
    }

    const dedupedLabels = dedupeItems(mergedLabels, (label) => {
      return [
        normalizeText(label.label_type),
        normalizeText(label.attr),
        normalizeText(label.value),
        normalizeText(label.region),
        label.order
      ].join("|");
    }).slice(0, SNAPSHOT_LIMITS.labels);

    return {
      site_id: location.host || "generic-ocr-site",
      page_identity: extractPageIdentity(),
      target_label_type: active.labelType,
      target_region: active.region,
      current_input: active.currentInput,
      visible_labels: dedupedLabels,
      label_type_counts: countLabelTypes(dedupedLabels),
      neighbor_texts: dedupeItems(mergedNeighborTexts, (item) => normalizeText(item)).slice(0, 20),
      unreadable_frames: dedupeItems(unreadableFrames, (item) => item).slice(0, 8),
      captured_at: new Date().toISOString()
    };
  }

  function extractVisibleLabels(activeTarget) {
    const labels = [];
    const cardContainers = collectVisibleElements(document, CONTAINER_SELECTORS, SNAPSHOT_LIMITS.containers);
    if (cardContainers.length) {
      cardContainers.forEach((container, index) => {
        const label = extractLabelFromContainer(container, index, activeTarget);
        if (label) {
          labels.push(label);
        }
      });
      return labels;
    }

    const editables = collectTrackableEditables(document, SNAPSHOT_LIMITS.editables);

    editables.forEach((editable, index) => {
      const active = extractActiveTarget(editable);
      labels.push({
        label_type: active.labelType,
        attr: active.attr,
        value: cleanDisplayText(readEditableValue(editable)),
        region: active.region,
        order: index
      });
    });
    return labels;
  }

  function collectVisibleElements(root, selector, limit) {
    const result = [];
    for (const element of root.querySelectorAll(selector)) {
      if (!isVisible(element)) {
        continue;
      }
      result.push(element);
      if (result.length >= limit) {
        break;
      }
    }
    return result;
  }

  function collectTrackableEditables(root, limit) {
    const result = [];
    for (const editable of root.querySelectorAll(EDITABLE_SELECTOR)) {
      if (!isTrackableEditable(editable)) {
        continue;
      }
      result.push(editable);
      if (result.length >= limit) {
        break;
      }
    }
    return result;
  }

  function extractLabelFromContainer(container, order, activeTarget) {
    const focusedEditable = activeTarget && container.contains(activeTarget) ? activeTarget : null;
    const valueEditable = focusedEditable || findPrimaryValueEditable(container);
    const labelType = readContainerLabelType(container, valueEditable);
    const attr = readContainerAttribute(container);
    const region = findRegion(container);
    const value = cleanDisplayText(valueEditable ? readEditableValue(valueEditable) : readContainerValue(container));

    if (!labelType && !value && !attr) {
      return null;
    }

    return {
      label_type: labelType,
      attr,
      value,
      region,
      order
    };
  }

  function extractActiveTarget(target) {
    if (!isTrackableEditable(target)) {
      return {
        labelType: "",
        attr: "",
        region: "",
        currentInput: ""
      };
    }

    const container = target.closest(CONTAINER_SELECTORS) || target.closest("label, fieldset, form, section, article, .panel");
    return {
      labelType: readContainerLabelType(container, target) || findAssociatedLabelText(target),
      attr: readContainerAttribute(container) || "",
      region: findRegion(container || target),
      currentInput: cleanDisplayText(readEditableValue(target))
    };
  }

  function readContainerLabelType(container, editable) {
    if (!container) {
      return editable ? findAssociatedLabelText(editable) : "";
    }

    const candidates = [];
    const select = container.querySelector("select");
    if (select && select.selectedIndex >= 0) {
      candidates.push(select.options[select.selectedIndex]?.textContent || "");
    }
    candidates.push(
      textFrom(container.querySelector(".anno-title span:last-child")),
      textFrom(container.querySelector(".label-type")),
      textFrom(container.querySelector(".field span")),
      textFrom(container.querySelector(".ant-form-item-label")),
      textFrom(container.querySelector(".el-form-item__label")),
      textFrom(container.querySelector("legend")),
      textFrom(container.querySelector("label"))
    );
    if (editable) {
      candidates.push(findAssociatedLabelText(editable));
    }
    return firstMeaningfulText(candidates);
  }

  function readContainerAttribute(container) {
    if (!container) {
      return "";
    }
    return firstMeaningfulText([
      container.getAttribute("data-label-attr"),
      textFrom(container.querySelector(".anno-id")),
      textFrom(container.querySelector(".metrics")),
      textFrom(container.querySelector("[data-role='label-attr']"))
    ]);
  }

  function findPrimaryValueEditable(container) {
    if (!container) {
      return null;
    }
    const editables = collectTrackableEditables(container, 12);
    if (!editables.length) {
      return null;
    }
    editables.sort((left, right) => {
      return cleanText(readEditableValue(right)).length - cleanText(readEditableValue(left)).length;
    });
    return editables[0];
  }

  function readContainerValue(container) {
    if (!container) {
      return "";
    }
    const explicitValue = textFrom(container.querySelector(".label-value, .value, .content, .ocr-value"));
    if (explicitValue) {
      return explicitValue;
    }
    const text = cleanText(container.textContent || "");
    return text.length > 120 ? text.slice(0, 120) : text;
  }

  function extractNeighborTexts(activeTarget) {
    const anchor = activeTarget
      ? (activeTarget.closest(CONTAINER_SELECTORS) || activeTarget.closest(".panel, section, article, aside, form") || document.body)
      : document.body;

    const candidates = new Set();
    const elements = anchor.querySelectorAll("h1, h2, h3, h4, legend, label, .panel-title, .anno-title, .field span, .ant-form-item-label, .el-form-item__label, p, th, td, .meta");
    let inspected = 0;
    for (const element of elements) {
      if (inspected >= SNAPSHOT_LIMITS.neighborElements) {
        break;
      }
      inspected += 1;
      if (activeTarget && activeTarget.contains(element)) {
        continue;
      }
      const text = cleanText(element.textContent || "");
      if (!isMeaningfulText(text)) {
        continue;
      }
      candidates.add(text.slice(0, 120));
      if (candidates.size >= 12) {
        break;
      }
    }
    return Array.from(candidates);
  }

  function findAssociatedLabelText(editable) {
    const candidates = [];
    if (editable?.labels?.length) {
      for (const label of editable.labels) {
        candidates.push(label.textContent || "");
      }
    }
    if (editable) {
      const closestLabel = editable.closest("label");
      if (closestLabel) {
        candidates.push(closestLabel.textContent || "");
      }
      const fieldContainer = editable.closest(".field, .ant-form-item, .el-form-item, .form-item, .form-row");
      if (fieldContainer) {
        candidates.push(
          textFrom(fieldContainer.querySelector(".field span")),
          textFrom(fieldContainer.querySelector(".ant-form-item-label")),
          textFrom(fieldContainer.querySelector(".el-form-item__label")),
          textFrom(fieldContainer.querySelector("label"))
        );
      }
    }
    return firstMeaningfulText(candidates);
  }

  function findRegion(container) {
    if (!container) {
      return firstMeaningfulText([
        textFrom(document.querySelector("h1")),
        textFrom(document.querySelector("[role='tab'][aria-selected='true']")),
        document.title
      ]);
    }

    const panel = container.closest("[data-region], .panel, section, article, aside, .ant-card, .el-card");
    const candidates = [];
    if (panel) {
      candidates.push(
        panel.getAttribute("data-region") || "",
        textFrom(panel.querySelector(".panel-title")),
        textFrom(panel.querySelector(".panel-head")),
        textFrom(panel.querySelector("legend")),
        textFrom(panel.querySelector("h1, h2, h3"))
      );
    }
    const activeTab = document.querySelector("[role='tab'][aria-selected='true'], .tab.active, .is-active");
    candidates.push(textFrom(activeTab));
    return firstMeaningfulText(candidates);
  }

  function extractPageIdentity() {
    const parts = [
      location.host,
      location.pathname,
      document.title,
      textFrom(document.querySelector("h1")),
      textFrom(document.querySelector("[role='tab'][aria-selected='true'], .tab.active, .is-active"))
    ].filter(Boolean);
    return dedupeItems(parts, (item) => normalizeText(item)).join(" | ").slice(0, 200);
  }

  function collectUnreadableFrames() {
    const unreadable = [];
    if (!state.isTopFrame) {
      return unreadable;
    }
    const frames = document.querySelectorAll("iframe");
    for (const frame of frames) {
      if (unreadable.length >= SNAPSHOT_LIMITS.frames) {
        break;
      }
      try {
        const frameDocument = frame.contentDocument;
        if (!frameDocument) {
          unreadable.push(frame.src || "cross-origin-iframe");
        }
      } catch (error) {
        unreadable.push(frame.src || "cross-origin-iframe");
      }
    }
    return unreadable;
  }

  function positionPopover() {
    if (!state.ui || !state.activeTarget || !document.contains(state.activeTarget)) {
      return;
    }
    if (state.uiPositions.popover) {
      applyPanelPosition("popover");
      return;
    }
    const rect = state.activeTarget.getBoundingClientRect();
    const popover = state.ui.popover;
    const width = Math.min(460, window.innerWidth - 24);
    const left = Math.min(
      Math.max(12, rect.left),
      Math.max(12, window.innerWidth - width - 12)
    );
    const belowTop = rect.bottom + 8;
    const fitsBelow = belowTop + 260 <= window.innerHeight;
    const top = fitsBelow ? belowTop : Math.max(12, rect.top - 268);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }

  function renderSuggestions() {
    if (!state.ui) {
      return;
    }
    const list = state.ui.list;
    if (!state.suggestions.length || !state.activeTarget) {
      list.innerHTML = "";
      hidePopover();
      return;
    }

    list.innerHTML = "";
    state.ui.popover.dataset.visible = "true";
    positionPopover();
    state.suggestions.forEach((item, index) => {
      const button = document.createElement("button");
      button.className = "ocr-lr-item";
      button.dataset.active = index === state.selectedIndex ? "true" : "false";
      button.dataset.primary = index === 0 ? "true" : "false";
      button.innerHTML = `
        <div class="ocr-lr-shortcut-badge">⌥${index + 1}</div>
        <div class="ocr-lr-item-top">
          <div class="ocr-lr-item-text">${escapeHtml(item.text)}</div>
          <div class="ocr-lr-item-actions">
            <span class="ocr-lr-pill" data-tier="${escapeHtml(item.tier)}">${escapeHtml(item.tier)}</span>
            <span class="ocr-lr-use-pill">Use</span>
          </div>
        </div>
        <div class="ocr-lr-meta">${escapeHtml(item.source_preview || "")}</div>
        <div class="ocr-lr-reasons">
          ${(item.reasons || []).map((reason) => `<span class="ocr-lr-reason">${escapeHtml(reason)}</span>`).join("")}
        </div>
      `;
      button.addEventListener("mouseenter", () => {
        state.selectedIndex = index;
        updateActiveSuggestionItem();
        renderSidebar(state.lastSnapshot, item);
      });
      button.addEventListener("click", () => {
        void acceptSuggestion(item);
      });
      list.appendChild(button);
    });
  }

  function updateActiveSuggestionItem() {
    if (!state.ui) {
      return;
    }
    state.ui.list.querySelectorAll(".ocr-lr-item").forEach((item, index) => {
      item.dataset.active = index === state.selectedIndex ? "true" : "false";
    });
  }

  function renderSidebar(snapshot, suggestion) {
    if (!state.ui) {
      return;
    }
    state.ui.sidebar.dataset.visible = state.activeTarget ? "true" : "false";
    if (!snapshot) {
      state.ui.contextMeta.textContent = "No active field";
      state.ui.sidebarBody.innerHTML = "";
      return;
    }

    state.ui.contextMeta.textContent = [
      snapshot.target_label_type || "unknown label",
      snapshot.target_region || "unknown region",
      snapshot.page_identity || "page"
    ].filter(Boolean).join(" | ");

    const sections = [];
    sections.push(`
      <section class="ocr-lr-detail-card">
        <div class="ocr-lr-detail-title">Current snapshot</div>
        <div class="ocr-lr-detail-grid">
          <div>Visible labels: ${snapshot.visible_labels.length}</div>
          <div>Current input: ${escapeHtml(snapshot.current_input || "(empty)")}</div>
          <div>Unreadable frames: ${snapshot.unreadable_frames.length}</div>
        </div>
      </section>
    `);

    if (suggestion) {
      sections.push(`
        <section class="ocr-lr-detail-card">
          <div class="ocr-lr-detail-title">Selected candidate</div>
          <div class="ocr-lr-detail-grid">
            <div>${escapeHtml(suggestion.text)}</div>
            <div>Reasons: ${escapeHtml((suggestion.reasons || []).join(", "))}</div>
            <div>Source: ${escapeHtml(suggestion.source_preview || "-")}</div>
          </div>
        </section>
      `);
      if (suggestion.source_details?.length) {
        sections.push(`
          <section class="ocr-lr-detail-card">
            <div class="ocr-lr-detail-title">Source evidence</div>
            <div class="ocr-lr-detail-grid">
              ${suggestion.source_details.map((detail) => `
                <div>${escapeHtml([detail.source_kind, detail.source_label_type, detail.source_region, detail.page_identity].filter(Boolean).join(" | "))}</div>
              `).join("")}
            </div>
          </section>
        `);
      }
    } else {
      sections.push(`
        <section class="ocr-lr-detail-card">
          <div class="ocr-lr-detail-title">Waiting for suggestions</div>
          <div class="ocr-lr-detail-grid">
            <div>Focus an editable field, then start typing or leave the field empty for context-only ranking.</div>
          </div>
        </section>
      `);
    }

    state.ui.sidebarBody.innerHTML = sections.join("");
  }

  function setStatus(message) {
    if (state.ui) {
      state.ui.status.textContent = message;
    }
  }

  function hidePopover() {
    if (state.ui) {
      state.ui.popover.dataset.visible = "false";
    }
  }

  async function loadUiPositions() {
    try {
      const stored = await chrome.storage.local.get(UI_POSITION_KEY);
      const positions = stored[UI_POSITION_KEY] || {};
      state.uiPositions = {
        popover: parsePanelPosition(positions.popover),
        sidebar: parsePanelPosition(positions.sidebar)
      };
    } catch (error) {
      state.uiPositions = {
        popover: null,
        sidebar: null
      };
    }
  }

  function parsePanelPosition(value) {
    if (!value || typeof value !== "object") {
      return null;
    }
    const left = Number(value.left);
    const top = Number(value.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) {
      return null;
    }
    return { left, top };
  }

  function handlePanelPointerDown(event) {
    if (!state.ui || event.button !== 0 || event.target.closest("button, input, textarea, select, a")) {
      return;
    }
    const handle = event.target.closest("[data-drag-handle]");
    if (!handle || !state.ui.root.contains(handle)) {
      return;
    }

    const panelName = handle.dataset.dragHandle;
    const panel = getPanelElement(panelName);
    if (!panel || panel.dataset.visible !== "true") {
      return;
    }

    const rect = panel.getBoundingClientRect();
    state.drag = {
      panelName,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: rect.width,
      height: rect.height
    };
    panel.dataset.dragging = "true";
    document.addEventListener("pointermove", handlePanelPointerMove, true);
    document.addEventListener("pointerup", handlePanelPointerUp, true);
    document.addEventListener("pointercancel", handlePanelPointerUp, true);
    event.preventDefault();
  }

  function handlePanelPointerMove(event) {
    if (!state.drag) {
      return;
    }
    const next = clampPanelPosition(
      event.clientX - state.drag.offsetX,
      event.clientY - state.drag.offsetY,
      state.drag.width,
      state.drag.height
    );
    state.uiPositions[state.drag.panelName] = next;
    applyPanelPosition(state.drag.panelName);
    event.preventDefault();
  }

  function handlePanelPointerUp() {
    if (!state.drag) {
      return;
    }
    const panel = getPanelElement(state.drag.panelName);
    if (panel) {
      delete panel.dataset.dragging;
    }
    document.removeEventListener("pointermove", handlePanelPointerMove, true);
    document.removeEventListener("pointerup", handlePanelPointerUp, true);
    document.removeEventListener("pointercancel", handlePanelPointerUp, true);
    state.drag = null;
    void saveUiPositions();
  }

  function getPanelElement(panelName) {
    if (!state.ui) {
      return null;
    }
    if (panelName === "popover") {
      return state.ui.popover;
    }
    if (panelName === "sidebar") {
      return state.ui.sidebar;
    }
    return null;
  }

  function applyPanelPosition(panelName) {
    const panel = getPanelElement(panelName);
    const position = state.uiPositions[panelName];
    if (!panel || !position) {
      return;
    }

    const rect = panel.getBoundingClientRect();
    const fallbackWidth = panelName === "popover"
      ? Math.min(460, window.innerWidth - 24)
      : Math.min(360, window.innerWidth - 32);
    const fallbackHeight = panelName === "popover" ? 260 : Math.min(420, window.innerHeight - 32);
    const next = clampPanelPosition(
      position.left,
      position.top,
      rect.width || fallbackWidth,
      rect.height || fallbackHeight
    );
    state.uiPositions[panelName] = next;
    panel.style.left = `${next.left}px`;
    panel.style.top = `${next.top}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.dataset.positionMode = "manual";
  }

  function clampPanelPosition(left, top, width, height) {
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - Math.max(width, 1) - margin);
    const maxTop = Math.max(margin, window.innerHeight - Math.max(height, 1) - margin);
    return {
      left: Math.round(Math.min(Math.max(margin, left), maxLeft)),
      top: Math.round(Math.min(Math.max(margin, top), maxTop))
    };
  }

  function resetPanelPosition(panelName) {
    state.uiPositions[panelName] = null;
    const panel = getPanelElement(panelName);
    if (panel) {
      panel.style.left = "";
      panel.style.top = "";
      panel.style.right = "";
      panel.style.bottom = "";
      delete panel.dataset.positionMode;
    }
    if (panelName === "popover") {
      positionPopover();
    }
    void saveUiPositions();
  }

  async function saveUiPositions() {
    try {
      await chrome.storage.local.set({ [UI_POSITION_KEY]: state.uiPositions });
    } catch (error) {
      // Position persistence is optional; dragging should keep working for this page.
    }
  }

  function hideAllUi() {
    state.suggestions = [];
    if (state.ui) {
      state.ui.popover.dataset.visible = "false";
      state.ui.sidebar.dataset.visible = "false";
      state.ui.modal.dataset.visible = "false";
    }
  }

  function snapshotSignature(snapshot) {
    return JSON.stringify([
      snapshot.page_identity,
      snapshot.target_label_type,
      snapshot.target_region,
      snapshot.visible_labels.map((label) => `${label.label_type}|${label.attr}|${label.value}|${label.region}`).join("||"),
      snapshot.unreadable_frames.join("|")
    ]);
  }

  function isTrackableEditable(node) {
    if (!(node instanceof HTMLElement)) {
      return false;
    }
    if (!node.matches(EDITABLE_SELECTOR)) {
      return false;
    }
    if (!isVisible(node)) {
      return false;
    }
    if (node.matches("input[type='checkbox'], input[type='radio'], input[type='file'], input[type='hidden'], input[type='password']")) {
      return false;
    }
    return true;
  }

  function isVisible(node) {
    if (!(node instanceof Element)) {
      return false;
    }
    const style = window.getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function readEditableValue(node) {
    if (!(node instanceof HTMLElement)) {
      return "";
    }
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
      return node.value || "";
    }
    if (node.isContentEditable) {
      return node.textContent || "";
    }
    return "";
  }

  function writeEditableValue(node, value) {
    if (!(node instanceof HTMLElement)) {
      return;
    }
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
      const descriptor = Object.getOwnPropertyDescriptor(node.constructor.prototype, "value");
      descriptor?.set?.call(node, value);
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    if (node.isContentEditable) {
      node.textContent = value;
      node.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    }
  }

  function textFrom(node) {
    if (!(node instanceof Element)) {
      return "";
    }
    return cleanText(node.textContent || "");
  }

  function cleanText(text) {
    return String(text || "")
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .trim();
  }

  function cleanDisplayText(text) {
    return String(text || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/[ \t\f\v]+/g, " ")
      .replace(/ *\n */g, "\n")
      .trim();
  }

  function normalizeText(text) {
    return cleanText(text)
      .toLowerCase()
      .replace(/[-_/,:;|()（）[\]{}<>【】、，。；：'"`~!@#$%^&*+=?]/g, "")
      .replace(/\s+/g, "");
  }

  function countLabelTypes(labels) {
    const counts = {};
    for (const label of labels) {
      if (!label.label_type) {
        continue;
      }
      counts[label.label_type] = (counts[label.label_type] || 0) + 1;
    }
    return counts;
  }

  function firstMeaningfulText(items) {
    for (const item of items) {
      const text = cleanText(item || "");
      if (isMeaningfulText(text)) {
        return text;
      }
    }
    return "";
  }

  function isMeaningfulText(text) {
    if (!text) {
      return false;
    }
    if (text.length > 120) {
      return false;
    }
    const normalized = normalizeText(text);
    if (!normalized) {
      return false;
    }
    if (["delete", "remove", "save", "search", "open dashboard"].includes(normalized)) {
      return false;
    }
    return true;
  }

  function dedupeItems(items, keyFn) {
    const seen = new Set();
    const result = [];
    for (const item of items) {
      const key = keyFn(item);
      if (!key || seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push(item);
    }
    return result;
  }

  async function apiRequest(path, method, body) {
    const response = await sendMessage({
      type: "ocr-assist:api-request",
      path,
      method,
      body
    });
    return response;
  }

  async function sendMessage(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  function installHistoryHooks() {
    if (window.__ocrAssistHistoryHookInstalled) {
      return;
    }
    window.__ocrAssistHistoryHookInstalled = true;
    const wrap = (methodName) => {
      const original = history[methodName];
      history[methodName] = function wrappedHistoryState(...args) {
        const result = original.apply(this, args);
        window.dispatchEvent(new Event("ocr-assist:navigation"));
        return result;
      };
    };
    wrap("pushState");
    wrap("replaceState");
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll("\"", "&quot;");
  }
})();
