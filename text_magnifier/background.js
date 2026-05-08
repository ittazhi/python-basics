function isRestrictedUrl(url) {
  return !url || /^(chrome|edge|about|chrome-extension):/i.test(url);
}

function sendToggle(tabId) {
  chrome.tabs.sendMessage(tabId, { type: "TEXT_MAGNIFIER_TOGGLE" }, function () {
    if (!chrome.runtime.lastError) return;
    injectThenToggle(tabId);
  });
}

function injectThenToggle(tabId) {
  chrome.scripting.insertCSS(
    {
      target: { tabId: tabId },
      files: ["content.css"]
    },
    function () {
      if (chrome.runtime.lastError) return;

      chrome.scripting.executeScript(
        {
          target: { tabId: tabId },
          files: ["content.js"]
        },
        function () {
          if (chrome.runtime.lastError) return;

          chrome.tabs.sendMessage(tabId, { type: "TEXT_MAGNIFIER_TOGGLE" }, function () {
            void chrome.runtime.lastError;
          });
        }
      );
    }
  );
}

chrome.action.onClicked.addListener(function (tab) {
  if (!tab.id || isRestrictedUrl(tab.url)) return;
  sendToggle(tab.id);
});
