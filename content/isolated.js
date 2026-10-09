/**
 * Twitch Delay Sync - Isolated World Bridge Script
 * Acts as the secure bridge between Chrome Extension APIs (storage, messaging, popup)
 * and the Main World script operating inside the Twitch page context.
 */

(function () {
  'use strict';

  // Cached state from Main World
  let latestTelemetry = {
    latency: null,
    buffer: null,
    isLive: false,
    channel: '',
    isSyncing: false,
    lastSyncTimestamp: 0,
    playbackRate: 1.0
  };

  // Local settings cache
  let currentSettings = {
    enabled: true,
    maxDelay: 3.0,
    reloadThreshold: 5.0,
    cooldown: 10,
    autoCatchupSpeed: false
  };

  /**
   * Relay settings update to Main World script.
   */
  function dispatchConfigToMainWorld(config) {
    window.postMessage(
      {
        source: 'TWITCH_DELAY_SYNC_ISOLATED',
        type: 'UPDATE_CONFIG',
        payload: config
      },
      '*'
    );
  }

  /**
   * Send manual sync trigger to Main World script.
   */
  function dispatchSyncToMainWorld() {
    window.postMessage(
      {
        source: 'TWITCH_DELAY_SYNC_ISOLATED',
        type: 'TRIGGER_SYNC'
      },
      '*'
    );
  }

  /**
   * Load stored settings from chrome.storage.local.
   */
  function initializeSettings() {
    chrome.storage.local.get(
      ['enabled', 'maxDelay', 'reloadThreshold', 'cooldown', 'autoCatchupSpeed'],
      (stored) => {
        if (stored) {
          if (typeof stored.enabled === 'boolean') currentSettings.enabled = stored.enabled;
          if (typeof stored.maxDelay === 'number') currentSettings.maxDelay = stored.maxDelay;
          if (typeof stored.reloadThreshold === 'number') currentSettings.reloadThreshold = stored.reloadThreshold;
          if (typeof stored.cooldown === 'number') currentSettings.cooldown = stored.cooldown;
          if (typeof stored.autoCatchupSpeed === 'boolean') currentSettings.autoCatchupSpeed = stored.autoCatchupSpeed;
        }
        dispatchConfigToMainWorld(currentSettings);
      }
    );
  }

  // Listen for storage changes
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;

    let updated = false;
    for (const [key, change] of Object.entries(changes)) {
      if (key in currentSettings) {
        currentSettings[key] = change.newValue;
        updated = true;
      }
    }

    if (updated) {
      dispatchConfigToMainWorld(currentSettings);
    }
  });

  // Listen for messages from Main World
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== 'TWITCH_DELAY_SYNC_MAIN') {
      return;
    }

    const { type, payload } = event.data;

    if (type === 'REQUEST_CONFIG') {
      dispatchConfigToMainWorld(currentSettings);
      return;
    }

    if (type === 'TELEMETRY' && payload) {
      latestTelemetry = { ...latestTelemetry, ...payload };

      // Update extension badge via background service worker
      try {
        chrome.runtime.sendMessage({
          type: 'UPDATE_BADGE',
          latency: latestTelemetry.latency,
          isLive: latestTelemetry.isLive,
          maxDelay: currentSettings.maxDelay
        }).catch(() => {
          // Ignore unhandled background listener disconnection
        });
      } catch (e) {
        // Suppress message failure
      }
    }
  });

  // Listen for messages from Popup
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_STATUS') {
      sendResponse({
        telemetry: latestTelemetry,
        settings: currentSettings
      });
      return true;
    }

    if (message.type === 'SYNC_NOW') {
      dispatchSyncToMainWorld();
      sendResponse({ success: true });
      return true;
    }

    if (message.type === 'SET_SETTINGS' && message.payload) {
      chrome.storage.local.set(message.payload, () => {
        currentSettings = { ...currentSettings, ...message.payload };
        dispatchConfigToMainWorld(currentSettings);
        sendResponse({ success: true, settings: currentSettings });
      });
      return true;
    }
  });

  // Initial setup
  initializeSettings();

  // Request fresh telemetry from Main World after DOM content loaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.postMessage({ source: 'TWITCH_DELAY_SYNC_ISOLATED', type: 'REQUEST_TELEMETRY' }, '*');
    });
  } else {
    window.postMessage({ source: 'TWITCH_DELAY_SYNC_ISOLATED', type: 'REQUEST_TELEMETRY' }, '*');
  }
})();
