/**
 * Twitch Delay Sync - Main World Script
 * Runs directly in the Twitch page execution context to access
 * HTML5 Video elements and Twitch React/Player internals.
 */

(function () {
  'use strict';

  // Prevent duplicate execution in the same frame
  if (window.__TWITCH_DELAY_SYNC_INITIALIZED__) {
    return;
  }
  window.__TWITCH_DELAY_SYNC_INITIALIZED__ = true;

  // Runtime state
  const state = {
    enabled: true,
    maxDelay: 3.0,
    reloadThreshold: 5.0,
    cooldown: 10,
    autoCatchupSpeed: true,
    desiredPlaybackRate: 1.0,
    currentActualRate: 1.0,
    autoCatchupActive: false,
    catchupStartTime: 0,
    lastSyncTimestamp: 0,
    isSyncing: false,
    highLatencyStreak: 0,
    currentLatency: null,
    currentBuffer: null,
    isLive: false,
    channel: '',
    cachedPlayer: null,
    attachedVideo: null,
    nativeSetPlaybackRate: null,
    nativeGetPlaybackRate: null
  };

  /**
   * Extract channel name from window location or page title.
   */
  function extractChannelName() {
    const parts = window.location.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return '';
    if (['moderator', 'popout', 'embed'].includes(parts[0]) && parts.length > 1) {
      return parts[1];
    }
    if (!['directory', 'settings', 'videos', 'p'].includes(parts[0])) {
      return parts[0];
    }
    return '';
  }

  /**
   * Find primary stream video element.
   */
  function getMainVideo() {
    // 1. Video inside standard Twitch player containers
    const playerVideo = document.querySelector(
      '[data-a-target="video-player"] video, .video-player__container video, .video-player video'
    );
    if (playerVideo) return playerVideo;

    // 2. Fallback to largest video element on page
    const videos = Array.from(document.querySelectorAll('video'));
    if (videos.length === 0) return null;
    if (videos.length === 1) return videos[0];

    return videos.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
  }

  /**
   * Strictly validate and parse latency values.
   * Filters out invalid timestamp offsets (such as MPEG-TS 2^30 PTS offsets ~1073741824).
   */
  function parseLatency(stats) {
    if (typeof stats === 'number') {
      const num = stats > 100 && stats < 100000 ? stats / 1000 : stats;
      if (Number.isFinite(num) && num >= 0 && num < 60) {
        return num;
      }
      return null;
    }

    if (!stats || typeof stats !== 'object') return null;

    const candidates = [
      stats.hlsLatencyBroadcaster,
      stats.broadcasterLatency,
      stats.latency,
      stats.latencyToBroadcaster,
      stats.videoStats?.hlsLatencyBroadcaster,
      stats.videoStats?.broadcasterLatency,
      stats.videoStats?.latency
    ];

    for (const val of candidates) {
      if (typeof val === 'number') {
        const num = val > 100 && val < 100000 ? val / 1000 : val;
        if (Number.isFinite(num) && num >= 0 && num < 60) {
          return num;
        }
      }
    }
    return null;
  }

  /**
   * Find Twitch Player instance via React Fiber traversal.
   */
  function findTwitchPlayer() {
    if (state.cachedPlayer) {
      try {
        const stats = state.cachedPlayer.getStats?.();
        if (stats && parseLatency(stats) !== null) {
          return state.cachedPlayer;
        }
      } catch (e) {
        state.cachedPlayer = null;
      }
    }

    const video = getMainVideo();
    const candidateElements = [
      video,
      video?.parentElement,
      video?.parentElement?.parentElement,
      video?.closest('[data-a-target="video-player"]'),
      video?.closest('.video-player__container'),
      document.querySelector('[data-a-target="video-player"]'),
      document.querySelector('.video-player__container')
    ].filter(Boolean);

    for (const el of candidateElements) {
      const fiberKey = Object.keys(el).find(
        (key) => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')
      );
      if (!fiberKey) continue;

      let fiber = el[fiberKey];
      let depth = 0;
      while (fiber && depth < 80) {
        const props = fiber.memoizedProps;
        if (props) {
          if (props.player && (typeof props.player.getStats === 'function' || typeof props.player.getLatency === 'function')) {
            state.cachedPlayer = props.player;
            return props.player;
          }
          if (props.mediaPlayerInstance && typeof props.mediaPlayerInstance.getStats === 'function') {
            state.cachedPlayer = props.mediaPlayerInstance;
            return props.mediaPlayerInstance;
          }
          if (props.mediaPlayer && typeof props.mediaPlayer.getStats === 'function') {
            state.cachedPlayer = props.mediaPlayer;
            return props.mediaPlayer;
          }
        }

        const node = fiber.stateNode;
        if (node) {
          if (node.player && (typeof node.player.getStats === 'function' || typeof node.player.getLatency === 'function')) {
            state.cachedPlayer = node.player;
            return node.player;
          }
          if (node.mediaPlayerInstance && typeof node.mediaPlayerInstance.getStats === 'function') {
            state.cachedPlayer = node.mediaPlayerInstance;
            return node.mediaPlayerInstance;
          }
          if (typeof node.getStats === 'function') {
            state.cachedPlayer = node;
            return node;
          }
        }

        fiber = fiber.return;
        depth++;
      }
    }

    return null;
  }

  /**
   * Search React Fiber tree directly for hlsLatencyBroadcaster property.
   */
  function findLatencyFromFiber() {
    const video = getMainVideo();
    if (!video) return null;

    const candidateElements = [
      video,
      video.parentElement,
      video.closest('[data-a-target="video-player"]'),
      video.closest('.video-player__container')
    ].filter(Boolean);

    for (const el of candidateElements) {
      const fiberKey = Object.keys(el).find(
        (key) => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')
      );
      if (!fiberKey) continue;

      let fiber = el[fiberKey];
      let depth = 0;
      while (fiber && depth < 80) {
        const p = fiber.memoizedProps;
        if (p) {
          const val = p.hlsLatencyBroadcaster ?? p.broadcasterLatency ?? p.videoStats?.hlsLatencyBroadcaster ?? p.videoStats?.broadcasterLatency;
          const parsed = parseLatency(val);
          if (parsed !== null) return parsed;
        }

        const s = fiber.memoizedState;
        if (s) {
          const val = s.hlsLatencyBroadcaster ?? s.broadcasterLatency ?? s.videoStats?.hlsLatencyBroadcaster;
          const parsed = parseLatency(val);
          if (parsed !== null) return parsed;
        }

        fiber = fiber.return;
        depth++;
      }
    }

    return null;
  }

  /**
   * Determine if current page is an active live stream.
   */
  function checkIsLiveStream(video, player) {
    const path = window.location.pathname;
    if (path.startsWith('/videos/') || path.startsWith('/directory/') || path.startsWith('/settings/')) {
      return false;
    }

    if (!video) return false;

    // Check player instance live state if available
    if (player && typeof player.isLive === 'function') {
      try {
        const l = player.isLive();
        if (typeof l === 'boolean') return l;
      } catch (e) {}
    }

    // Check live indicator pills in DOM
    const livePill = document.querySelector(
      '[data-a-target="live-status-pill"], .live-indicator-container, [aria-label="LIVE"], .tw-channel-status-indicator--live'
    );
    if (livePill) {
      return true;
    }

    // If on a channel page and video element has media stream, treat as live
    if (video.readyState >= 1) {
      return true;
    }

    return false;
  }

  /**
   * Extract current broadcaster latency and buffer metrics.
   * Strictly filters out bogus timestamp offsets and provides robust forward buffer measurement.
   */
  function extractMetrics() {
    const video = getMainVideo();
    const player = findTwitchPlayer();

    state.channel = extractChannelName();
    state.isLive = checkIsLiveStream(video, player);

    if (!video) {
      state.currentLatency = null;
      state.currentBuffer = null;
      return null;
    }

    let latency = null;
    let buffer = null;

    // 1. Measure HTML5 video forward buffer (always normalized in same timeline as currentTime)
    if (video.buffered && video.buffered.length > 0) {
      const bufEnd = video.buffered.end(video.buffered.length - 1);
      const computedBuffer = Math.max(0, bufEnd - video.currentTime);
      if (Number.isFinite(computedBuffer) && computedBuffer >= 0 && computedBuffer < 60) {
        buffer = computedBuffer;
      }
    }

    // 2. Try Twitch internal player stats
    if (player) {
      try {
        if (typeof player.getStats === 'function') {
          const stats = player.getStats();
          latency = parseLatency(stats);
          if (stats && buffer === null) {
            const rawBuf = stats.buffer ?? stats.bufferSize ?? stats.videoStats?.buffer ?? stats.videoStats?.bufferSize;
            if (typeof rawBuf === 'number' && rawBuf >= 0 && rawBuf < 60) {
              buffer = rawBuf;
            }
          }
        }

        if (latency === null) {
          for (const fnName of ['getLatency', 'getBroadcasterLatency', 'getLiveLatency']) {
            if (typeof player[fnName] === 'function') {
              latency = parseLatency(player[fnName]());
              if (latency !== null) break;
            }
          }
        }
      } catch (err) {
        // Fallback
      }
    }

    // 3. Search React Fiber tree directly for hlsLatencyBroadcaster
    if (latency === null) {
      latency = findLatencyFromFiber();
    }

    // 4. Fallback: Check DOM Video Stats overlay if opened by user
    if (latency === null) {
      const statsPanel = document.querySelector('[data-a-target="video-stats-panel"], .video-stats-panel');
      if (statsPanel) {
        const match = statsPanel.textContent.match(/Latency(?:\s+to\s+Broadcaster)?[:\s]+([\d\.]+)\s*(?:sec|s)/i);
        if (match) {
          latency = parseLatency(parseFloat(match[1]));
        }
      }
    }

    // 5. Ground Truth Live Delay Fallback:
    // If Twitch hides broadcaster metadata inside WASM, the HTML5 forward buffer
    // accurately represents the viewer's live presentation delay behind newest received chunks.
    if (latency === null && typeof buffer === 'number') {
      latency = buffer;
    }

    state.currentLatency = latency;
    state.currentBuffer = buffer;

    return {
      latency: state.currentLatency,
      buffer: state.currentBuffer,
      isLive: state.isLive,
      channel: state.channel,
      isSyncing: state.isSyncing,
      lastSyncTimestamp: state.lastSyncTimestamp
    };
  }

  const originalPlaybackRateDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
  let rampTimer = null;

  /**
   * Smoothly transitions playback rate in micro-steps (+/- 0.01 per 100ms)
   * to eliminate audio phase discontinuities and WSOLA time-stretch popping.
   */
  function setPlaybackRateSmooth(targetRate) {
    targetRate = Math.round(targetRate * 100) / 100;
    state.desiredPlaybackRate = targetRate;

    if (targetRate > 1.0) {
      state.autoCatchupActive = true;
    }

    if (Math.abs(state.currentActualRate - targetRate) < 0.005) {
      return;
    }

    if (rampTimer) {
      clearInterval(rampTimer);
      rampTimer = null;
    }

    const stepInterval = 100; // ms
    const stepDelta = 0.01;

    rampTimer = setInterval(() => {
      const video = getMainVideo();
      if (!video) {
        clearInterval(rampTimer);
        rampTimer = null;
        return;
      }

      if (state.currentActualRate < targetRate) {
        state.currentActualRate = Math.min(targetRate, Math.round((state.currentActualRate + stepDelta) * 100) / 100);
      } else if (state.currentActualRate > targetRate) {
        state.currentActualRate = Math.max(targetRate, Math.round((state.currentActualRate - stepDelta) * 100) / 100);
      }

      video.preservesPitch = true;
      if (state.nativeSetPlaybackRate) {
        state.nativeSetPlaybackRate(state.currentActualRate);
      } else {
        video.playbackRate = state.currentActualRate;
      }

      if (Math.abs(state.currentActualRate - targetRate) < 0.005) {
        clearInterval(rampTimer);
        rampTimer = null;
        if (targetRate === 1.0) {
          state.autoCatchupActive = false;
        }
      }
    }, stepInterval);
  }

  /**
   * Intercept video playbackRate property to prevent Twitch's internal tick loop
   * from resetting playbackRate back to 1.0, eliminating rapid rate toggling (audio popping).
   */
  function interceptVideoPlaybackRate(video) {
    if (!video || video.__playbackRateIntercepted__) return;
    video.__playbackRateIntercepted__ = true;

    const nativeGet = originalPlaybackRateDesc ? originalPlaybackRateDesc.get.bind(video) : () => video.playbackRate;
    const nativeSet = originalPlaybackRateDesc ? originalPlaybackRateDesc.set.bind(video) : (v) => { video.playbackRate = v; };

    state.nativeGetPlaybackRate = nativeGet;
    state.nativeSetPlaybackRate = nativeSet;

    try {
      Object.defineProperty(video, 'playbackRate', {
        configurable: true,
        enumerable: true,
        get() {
          // If extension catch-up is active, report 1.0 to Twitch player queries
          // so Twitch's internal player watchdog never detects a discrepancy
          if (state.autoCatchupActive) {
            return 1.0;
          }
          return nativeGet();
        },
        set(val) {
          // If Twitch internal watchdog attempts to force 1.0 during active catch-up,
          // ignore the reset to eliminate rapid rate toggling
          if (state.autoCatchupActive && val === 1.0) {
            return;
          }
          state.desiredPlaybackRate = val;
          nativeSet(val);
        }
      });
    } catch (e) {
      // Suppress defineProperty errors if any
    }
  }

  /**
   * Attach video element and initialize anti-thrashing interceptor.
   */
  function attachVideoListeners(video) {
    if (!video || state.attachedVideo === video) return;
    state.attachedVideo = video;
    interceptVideoPlaybackRate(video);

    video.addEventListener('pause', () => {
      if (state.autoCatchupActive) {
        setPlaybackRateSmooth(1.0);
      }
    });
  }

  /**
   * Execute live stream synchronization using direct micro pause-and-play.
   * Cuts presentation lag safely without buffer starvation or HLS loading delay.
   */
  function performLiveSync(reason = 'auto') {
    const video = getMainVideo();

    // Respect user's explicit pause
    if (!video || video.paused) {
      return false;
    }

    if (rampTimer) {
      clearInterval(rampTimer);
      rampTimer = null;
    }

    state.isSyncing = true;
    state.lastSyncTimestamp = Date.now();
    state.highLatencyStreak = 0;
    state.catchupStartTime = 0;
    state.desiredPlaybackRate = 1.0;
    state.currentActualRate = 1.0;
    state.autoCatchupActive = false;

    if (state.nativeSetPlaybackRate) {
      state.nativeSetPlaybackRate(1.0);
    } else {
      video.playbackRate = 1.0;
    }

    try {
      // 1. Direct micro-pause on HTML5 video element
      video.pause();

      // 2. Trigger native Twitch player live edge seek to pull freshest manifest segments
      const player = findTwitchPlayer();
      if (player && typeof player.seekToLive === 'function') {
        try { player.seekToLive(); } catch (e) {}
      }

      // 3. Trigger Twitch native live button if present
      const liveBtn = document.querySelector(
        '[data-a-target="player-live-button"], [aria-label="Click to go live"], button[data-a-target="player-live-indicator"]'
      );
      if (liveBtn) {
        try { liveBtn.click(); } catch (e) {}
      }

      // 4. Resume playback after 25ms with safe buffer headroom
      setTimeout(() => {
        try {
          // Safe buffer alignment: Only align within buffered range
          if (video.buffered && video.buffered.length > 0) {
            const bufEnd = video.buffered.end(video.buffered.length - 1);
            const bufferLag = bufEnd - video.currentTime;
            // Dynamically scale buffer cushion based on target max delay
            const targetDelay = state.maxDelay || 3.0;
            const cushion = Math.min(0.5, Math.max(0.15, targetDelay * 0.35));
            if (bufferLag > (cushion + 0.15) && bufferLag < 60) {
              video.currentTime = Math.max(0, bufEnd - cushion);
            }
          }

          video.preservesPitch = true;
          if (state.nativeSetPlaybackRate) {
            state.nativeSetPlaybackRate(1.0);
          } else {
            video.playbackRate = 1.0;
          }
          const playPromise = video.play();
          if (playPromise !== undefined) {
            playPromise.catch(() => {});
          }
        } catch (innerErr) {
          // Suppress transient playback errors
        }
      }, 25);
    } catch (e) {
      // Suppress errors during navigation
    } finally {
      setTimeout(() => {
        state.isSyncing = false;
        postTelemetry();
      }, 1200); // 1.2s stabilization window
    }

    return true;
  }

  /**
   * Adaptive playback rate management to catch up smoothly without audio popping.
   * Accelerates playback rate gradually to 1.05x - 1.08x until delay drops to target.
   * Includes buffer starvation protection to avoid sudden buffering spinners.
   */
  function handleAdaptiveSpeed(video, latency) {
    if (!video || !state.autoCatchupSpeed || !state.isLive || video.paused || state.isSyncing) {
      if (state.currentActualRate !== 1.0) {
        setPlaybackRateSmooth(1.0);
      }
      return;
    }

    // Dynamic Buffer Protection Guard: If forward buffer is depleted, do not accelerate
    const minBufferGuard = Math.min(1.2, Math.max(0.35, (state.maxDelay || 3.0) * 0.5));
    if (state.currentBuffer !== null && state.currentBuffer < minBufferGuard) {
      if (state.currentActualRate !== 1.0) {
        setPlaybackRateSmooth(1.0);
      }
      return;
    }

    const threshold = state.maxDelay || 3.0;

    // 1. Latency is within target delay: smoothly restore normal 1.00x playback speed
    if (latency <= threshold) {
      if (state.currentActualRate !== 1.0) {
        setPlaybackRateSmooth(1.0);
      }
      state.catchupStartTime = 0;
      return;
    }

    // 2. Latency is above target delay: smoothly ramp to gentle catch-up ceiling (1.05x - 1.08x)
    const diff = latency - threshold;
    const targetSpeed = diff > 0.8 ? 1.08 : 1.05;

    if (Math.abs(state.desiredPlaybackRate - targetSpeed) > 0.005) {
      setPlaybackRateSmooth(targetSpeed);
    }

    if (!state.catchupStartTime) {
      state.catchupStartTime = Date.now();
    }
  }

  /**
   * Monitor loop executed every second.
   */
  function tick() {
    const video = getMainVideo();
    if (video) {
      attachVideoListeners(video);
    }

    const metrics = extractMetrics();
    postTelemetry();

    // Auto-sync requires enabled flag, active live stream, and valid latency measurement
    if (!state.enabled || !metrics || !metrics.isLive || typeof metrics.latency !== 'number' || metrics.latency <= 0) {
      state.highLatencyStreak = 0;
      if (state.currentActualRate !== 1.0) {
        setPlaybackRateSmooth(1.0);
      }
      return;
    }

    // Do not auto-sync if user explicitly paused the video
    if (video && video.paused) {
      state.highLatencyStreak = 0;
      if (state.currentActualRate !== 1.0) {
        setPlaybackRateSmooth(1.0);
      }
      return;
    }

    const now = Date.now();
    const cooldownMs = (state.cooldown || 10) * 1000;
    const cooldownElapsed = (now - state.lastSyncTimestamp) >= cooldownMs;
    const threshold = state.maxDelay || 3.0;
    const latency = metrics.latency;

    // 1. Target Met (latency <= threshold):
    if (latency <= threshold) {
      state.highLatencyStreak = 0;
      state.catchupStartTime = 0;
      if (state.currentActualRate !== 1.0) {
        setPlaybackRateSmooth(1.0);
      }
      return;
    }

    // 2. Target Exceeded (latency > threshold):
    const diff = latency - threshold;
    const reloadThreshold = state.reloadThreshold || 5.0;

    if (state.autoCatchupSpeed) {
      // Check if latency has reached or exceeded the reload / hard resync threshold
      if (latency >= reloadThreshold) {
        if (state.currentActualRate !== 1.0) {
          setPlaybackRateSmooth(1.0);
        }

        if (cooldownElapsed && !state.isSyncing) {
          state.highLatencyStreak++;
          if (state.highLatencyStreak >= 2) {
            performLiveSync('auto_reload_threshold_exceeded');
          }
        }
        return;
      }

      // Latency is within catch-up zone (threshold < latency < reloadThreshold)
      handleAdaptiveSpeed(video, latency);

      // Only trigger hard sync if speed catch-up is unable to resolve drift after 18 seconds
      const catchupDuration = state.catchupStartTime ? (now - state.catchupStartTime) : 0;
      const speedStruggling = catchupDuration > 18000;

      if (speedStruggling && cooldownElapsed && !state.isSyncing) {
        state.highLatencyStreak++;
        if (state.highLatencyStreak >= 2) {
          performLiveSync('auto_catchup_timeout');
        }
      }
    } else {
      // Adaptive speed is disabled by user: direct hard sync trigger
      if (state.currentActualRate !== 1.0) {
        setPlaybackRateSmooth(1.0);
      }

      if (cooldownElapsed && !state.isSyncing) {
        state.highLatencyStreak++;
        if (state.highLatencyStreak >= 2 && diff > 0.15) {
          performLiveSync('auto_threshold_exceeded');
        }
      }
    }
  }

  /**
   * Broadcast current metrics to Isolated World script.
   */
  function postTelemetry() {
    window.postMessage(
      {
        source: 'TWITCH_DELAY_SYNC_MAIN',
        type: 'TELEMETRY',
        payload: {
          latency: state.currentLatency,
          buffer: state.currentBuffer,
          isLive: state.isLive,
          channel: state.channel,
          isSyncing: state.isSyncing,
          lastSyncTimestamp: state.lastSyncTimestamp,
          playbackRate: state.currentActualRate || 1.0
        }
      },
      '*'
    );
  }

  // Listen for control commands from Isolated World
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== 'TWITCH_DELAY_SYNC_ISOLATED') {
      return;
    }

    const { type, payload } = event.data;

    switch (type) {
      case 'UPDATE_CONFIG':
        if (payload) {
          if (typeof payload.enabled === 'boolean') state.enabled = payload.enabled;
          if (payload.maxDelay !== undefined) {
            const m = parseFloat(payload.maxDelay);
            if (!isNaN(m) && m > 0) state.maxDelay = Math.max(0.5, Math.round(m * 10) / 10);
          }
          if (payload.reloadThreshold !== undefined) {
            const r = parseFloat(payload.reloadThreshold);
            if (!isNaN(r) && r > 0) state.reloadThreshold = Math.max(0.8, Math.round(r * 10) / 10);
          }
          if (payload.cooldown !== undefined) {
            const c = parseInt(payload.cooldown, 10);
            if (!isNaN(c) && c > 0) state.cooldown = c;
          }
          if (typeof payload.autoCatchupSpeed === 'boolean') {
            state.autoCatchupSpeed = payload.autoCatchupSpeed;
            if (!state.autoCatchupSpeed && state.currentActualRate !== 1.0) {
              setPlaybackRateSmooth(1.0);
            }
          }
        }
        break;

      case 'TRIGGER_SYNC':
        performLiveSync('manual_user_action');
        break;

      case 'REQUEST_TELEMETRY':
        extractMetrics();
        postTelemetry();
        break;

      default:
        break;
    }
  });

  // Request stored configuration from Isolated World on startup
  window.postMessage({ source: 'TWITCH_DELAY_SYNC_MAIN', type: 'REQUEST_CONFIG' }, '*');

  // Start periodic monitor tick (1 second interval)
  setInterval(tick, 1000);

  // Initial poll
  setTimeout(tick, 500);
})();
