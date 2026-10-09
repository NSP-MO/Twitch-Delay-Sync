/**
 * Twitch Delay Sync - Background Service Worker
 * Manages storage initialization and toolbar badge telemetry.
 */

const DEFAULT_SETTINGS = {
  enabled: true,
  maxDelay: 2.0,
  reloadThreshold: 5.0,
  cooldown: 10,
  autoCatchupSpeed: false
};

// Initialize default settings on install or update
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS), (stored) => {
    const toSet = {};
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (stored[key] === undefined) {
        toSet[key] = value;
      }
    }
    if (Object.keys(toSet).length > 0) {
      chrome.storage.local.set(toSet);
    }
  });
});

// Listen for messages from content scripts or popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'UPDATE_BADGE' && sender.tab?.id) {
    const tabId = sender.tab.id;
    if (message.isLive && typeof message.latency === 'number' && message.latency > 0) {
      const text = `${message.latency.toFixed(1)}s`;
      const isOver = message.latency > (message.maxDelay || 2.5);
      const color = isOver ? '#d9534f' : '#0e639c';

      chrome.action.setBadgeText({ text, tabId });
      chrome.action.setBadgeBackgroundColor({ color, tabId });
    } else {
      chrome.action.setBadgeText({ text: '', tabId });
    }
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'GET_SETTINGS') {
    chrome.storage.local.get(DEFAULT_SETTINGS, (settings) => {
      sendResponse(settings);
    });
    return true;
  }
});
