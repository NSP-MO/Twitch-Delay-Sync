/**
 * Twitch Delay Sync - Popup Controller
 * Manages user interactions, configuration persistence, and real-time telemetry polling.
 */

document.addEventListener('DOMContentLoaded', () => {
  // DOM element bindings
  const channelName = document.getElementById('channelName');
  const latencyValue = document.getElementById('latencyValue');
  const bufferValue = document.getElementById('bufferValue');
  const playbackRate = document.getElementById('playbackRate');
  const lastSyncTime = document.getElementById('lastSyncTime');
  const autoSyncToggle = document.getElementById('autoSyncToggle');
  const maxDelayInput = document.getElementById('maxDelayInput');
  const btnDelayMinus = document.getElementById('btnDelayMinus');
  const btnDelayPlus = document.getElementById('btnDelayPlus');
  const delayPresets = document.querySelectorAll('.preset-btn');
  const adaptiveSpeedToggle = document.getElementById('adaptiveSpeedToggle');
  const reloadThresholdInput = document.getElementById('reloadThresholdInput');
  const btnReloadMinus = document.getElementById('btnReloadMinus');
  const btnReloadPlus = document.getElementById('btnReloadPlus');
  const cooldownInput = document.getElementById('cooldownInput');
  const btnSyncNow = document.getElementById('btnSyncNow');

  let activeTabId = null;
  let isTwitchTab = false;
  let needsTabReload = false;
  let pollInterval = null;

  let currentSettings = {
    enabled: true,
    maxDelay: 3.0,
    reloadThreshold: 5.0,
    cooldown: 10,
    autoCatchupSpeed: false
  };



  /**
   * Format relative timestamp.
   */
  function formatRelativeTime(timestamp) {
    if (!timestamp || timestamp <= 0) return 'Never';
    const elapsed = Math.round((Date.now() - timestamp) / 1000);
    if (elapsed < 3) return 'Just now';
    if (elapsed < 60) return `${elapsed}s ago`;
    const mins = Math.floor(elapsed / 60);
    return `${mins}m ago`;
  }

  /**
   * Update active state of preset buttons.
   */
  function updatePresetButtons(currentMax) {
    delayPresets.forEach((btn) => {
      const val = parseFloat(btn.dataset.delay);
      if (Math.abs(val - currentMax) < 0.05) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }

  /**
   * Apply settings to UI controls.
   */
  function renderSettings(settings) {
    if (!settings) return;
    currentSettings = { ...currentSettings, ...settings };
    autoSyncToggle.checked = !!currentSettings.enabled;
    maxDelayInput.value = (currentSettings.maxDelay || 3.0).toFixed(1);
    if (reloadThresholdInput) {
      reloadThresholdInput.value = (currentSettings.reloadThreshold || 5.0).toFixed(1);
    }
    adaptiveSpeedToggle.checked = !!currentSettings.autoCatchupSpeed;
    cooldownInput.value = currentSettings.cooldown || 10;
    updatePresetButtons(currentSettings.maxDelay);
  }

  /**
   * Save settings to storage and notify tab.
   */
  function persistSettings(updatedFields) {
    currentSettings = { ...currentSettings, ...updatedFields };
    chrome.storage.local.set(currentSettings, () => {
      renderSettings(currentSettings);
      if (activeTabId && isTwitchTab) {
        chrome.tabs.sendMessage(activeTabId, {
          type: 'SET_SETTINGS',
          payload: currentSettings
        }).catch(() => {});
      }
    });
  }

  /**
   * Update telemetry metrics in popup UI.
   */
  function renderTelemetry(telemetry) {
    if (!telemetry) {
      if (channelName) channelName.textContent = 'Connecting...';
      return;
    }

    if (channelName) {
      channelName.textContent = telemetry.channel ? telemetry.channel : 'Twitch Stream';
    }

    if (!telemetry.isLive) {
      if (latencyValue) {
        latencyValue.textContent = '--';
        latencyValue.className = 'latency-number';
      }
      if (bufferValue) bufferValue.textContent = '--';
      if (playbackRate) playbackRate.textContent = '1.0x';
      if (lastSyncTime) {
        lastSyncTime.textContent = telemetry.lastSyncTimestamp ? formatRelativeTime(telemetry.lastSyncTimestamp) : 'Never';
      }
      if (btnSyncNow) btnSyncNow.disabled = false;
      return;
    }

    if (typeof telemetry.latency === 'number' && telemetry.latency >= 0) {
      const latVal = telemetry.latency;
      if (latencyValue) {
        latencyValue.textContent = latVal.toFixed(2);
        const maxLimit = currentSettings.maxDelay || 3.0;
        if (latVal > maxLimit) {
          latencyValue.className = 'latency-number latency-alert';
        } else {
          latencyValue.className = 'latency-number latency-normal';
        }
      }
    } else {
      if (latencyValue) {
        latencyValue.textContent = '--';
        latencyValue.className = 'latency-number';
      }
    }

    if (bufferValue) {
      if (typeof telemetry.buffer === 'number') {
        bufferValue.textContent = `${telemetry.buffer.toFixed(1)}s`;
      } else {
        bufferValue.textContent = '--';
      }
    }

    if (playbackRate) {
      if (typeof telemetry.playbackRate === 'number') {
        const rate = telemetry.playbackRate;
        playbackRate.textContent = `${rate.toFixed(2)}x`;
        if (rate > 1.02) {
          playbackRate.style.color = '#38bdf8';
        } else {
          playbackRate.style.color = '';
        }
      } else {
        playbackRate.textContent = '1.00x';
        playbackRate.style.color = '';
      }
    }

    if (lastSyncTime) {
      lastSyncTime.textContent = formatRelativeTime(telemetry.lastSyncTimestamp);
    }
    if (btnSyncNow) btnSyncNow.disabled = false;
  }

  /**
   * Poll active tab for telemetry data.
   */
  function queryActiveTab() {
    if (!activeTabId) return;

    chrome.tabs.sendMessage(activeTabId, { type: 'GET_STATUS' }, (response) => {
      if (chrome.runtime.lastError || !response) {
        return;
      }
      isTwitchTab = true;
      needsTabReload = false;
      if (response.telemetry) {
        renderTelemetry(response.telemetry);
      }
      if (response.settings) {
        renderSettings(response.settings);
      }
    });
  }

  /**
   * Attach event listeners to UI controls.
   */
  function setupEventListeners() {
    // Auto-sync switch
    autoSyncToggle.addEventListener('change', (e) => {
      persistSettings({ enabled: e.target.checked });
    });

    // Adaptive speed switch
    adaptiveSpeedToggle.addEventListener('change', (e) => {
      persistSettings({ autoCatchupSpeed: e.target.checked });
    });

    // Cooldown input
    cooldownInput.addEventListener('change', (e) => {
      let val = parseInt(e.target.value, 10);
      if (isNaN(val) || val < 5) val = 5;
      if (val > 60) val = 60;
      e.target.value = val;
      persistSettings({ cooldown: val });
    });

    // Max delay input
    maxDelayInput.addEventListener('change', (e) => {
      let val = parseFloat(e.target.value);
      if (isNaN(val) || val < 0.5) val = 0.5;
      if (val > 15.0) val = 15.0;
      val = Math.round(val * 10) / 10;
      e.target.value = val.toFixed(1);
      const updates = { maxDelay: val };
      if (val >= (currentSettings.reloadThreshold || 5.0)) {
        updates.reloadThreshold = Math.round((val + 0.3) * 10) / 10;
      }
      persistSettings(updates);
    });

    // Minus button (steps by 0.1, min 0.5)
    btnDelayMinus.addEventListener('click', () => {
      let val = parseFloat(maxDelayInput.value) || 3.0;
      val = Math.max(0.5, Math.round((val - 0.1) * 10) / 10);
      maxDelayInput.value = val.toFixed(1);
      persistSettings({ maxDelay: val });
    });

    // Plus button (steps by 0.1)
    btnDelayPlus.addEventListener('click', () => {
      let val = parseFloat(maxDelayInput.value) || 3.0;
      val = Math.min(15.0, Math.round((val + 0.1) * 10) / 10);
      maxDelayInput.value = val.toFixed(1);
      const updates = { maxDelay: val };
      if (val >= (currentSettings.reloadThreshold || 5.0)) {
        updates.reloadThreshold = Math.round((val + 0.3) * 10) / 10;
      }
      persistSettings(updates);
    });

    // Quick presets
    delayPresets.forEach((btn) => {
      btn.addEventListener('click', () => {
        const val = parseFloat(btn.dataset.delay);
        if (!isNaN(val)) {
          maxDelayInput.value = val.toFixed(1);
          const updates = { maxDelay: val };
          if (val >= (currentSettings.reloadThreshold || 5.0)) {
            updates.reloadThreshold = Math.round((val + 0.3) * 10) / 10;
          }
          persistSettings(updates);
        }
      });
    });

    // Hard Resync / Reload threshold input
    if (reloadThresholdInput) {
      reloadThresholdInput.addEventListener('change', (e) => {
        let val = parseFloat(e.target.value);
        const minVal = Math.max(0.8, Math.round(((currentSettings.maxDelay || 3.0) + 0.1) * 10) / 10);
        if (isNaN(val) || val < minVal) val = minVal;
        if (val > 30.0) val = 30.0;
        val = Math.round(val * 10) / 10;
        e.target.value = val.toFixed(1);
        persistSettings({ reloadThreshold: val });
      });
    }

    // Reload minus button (steps by 0.1)
    if (btnReloadMinus) {
      btnReloadMinus.addEventListener('click', () => {
        let val = parseFloat(reloadThresholdInput.value) || 5.0;
        const minVal = Math.max(0.8, Math.round(((currentSettings.maxDelay || 3.0) + 0.1) * 10) / 10);
        val = Math.max(minVal, Math.round((val - 0.1) * 10) / 10);
        reloadThresholdInput.value = val.toFixed(1);
        persistSettings({ reloadThreshold: val });
      });
    }

    // Reload plus button (steps by 0.1)
    if (btnReloadPlus) {
      btnReloadPlus.addEventListener('click', () => {
        let val = parseFloat(reloadThresholdInput.value) || 5.0;
        val = Math.min(30.0, Math.round((val + 0.1) * 10) / 10);
        reloadThresholdInput.value = val.toFixed(1);
        persistSettings({ reloadThreshold: val });
      });
    }

    // Sync Now action button
    btnSyncNow.addEventListener('click', () => {
      if (!activeTabId) return;

      if (needsTabReload) {
        chrome.tabs.reload(activeTabId);
        window.close();
        return;
      }

      btnSyncNow.disabled = true;
      const icon = btnSyncNow.querySelector('.btn-icon');
      if (icon) icon.classList.add('spinning');

      chrome.tabs.sendMessage(activeTabId, { type: 'SYNC_NOW' }, () => {
        setTimeout(() => {
          btnSyncNow.disabled = false;
          if (icon) icon.classList.remove('spinning');
          queryActiveTab();
        }, 500);
      });
    });
  }

  // Initialize
  chrome.storage.local.get(['enabled', 'maxDelay', 'reloadThreshold', 'cooldown', 'autoCatchupSpeed'], (stored) => {
    renderSettings(stored);
  });

  setupEventListeners();

  // Detect active tab and probe content script
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || tabs.length === 0) return;

    const tab = tabs[0];
    activeTabId = tab.id;

    const isUrlTwitch = !!(tab.url && tab.url.includes('twitch.tv'));

    // Probe content script directly via message
    chrome.tabs.sendMessage(activeTabId, { type: 'GET_STATUS' }, (response) => {
      if (chrome.runtime.lastError || !response) {
        if (isUrlTwitch) {
          // Tab is on Twitch, but content script port is not yet active (tab open before extension install/reload)
          isTwitchTab = true;
          needsTabReload = true;
          if (channelName) channelName.textContent = 'Refresh Twitch page (F5)';
          if (btnSyncNow) {
            btnSyncNow.disabled = false;
            const syncSpan = btnSyncNow.querySelector('span');
            if (syncSpan) syncSpan.textContent = 'Reload Twitch Tab';
          }
        } else {
          isTwitchTab = false;
          if (channelName) channelName.textContent = 'Open twitch.tv';
          if (btnSyncNow) btnSyncNow.disabled = true;
        }
        return;
      }

      // Content script responded successfully
      isTwitchTab = true;
      needsTabReload = false;
      if (response.telemetry) renderTelemetry(response.telemetry);
      if (response.settings) renderSettings(response.settings);

      // Start regular poll
      pollInterval = setInterval(queryActiveTab, 1000);
    });
  });

  window.addEventListener('unload', () => {
    if (pollInterval) clearInterval(pollInterval);
  });
});
