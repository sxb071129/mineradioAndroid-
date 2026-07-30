/*
 * Mineradio Web — bounded solo-playback recovery
 *
 * Clean-room functionality adaptation inspired by the stale-URL and provider
 * fallback safety goals described for Mineradio v2.0.2. No upstream source,
 * artwork, assets, provider implementation, or direct media-link logic is
 * copied here. Keep the surrounding GPL-3.0 notices and upstream attribution.
 */
(function boundedPlaybackRecoveryRuntime() {
  "use strict";

  var VERSION = "20260730-v2";
  var RECOVERY_TIMEOUT_MS = 20000;
  var MAX_QUEUE_ADVANCES = 2;
  var INSTALL_RETRY_MS = 125;
  var MAX_INSTALL_ATTEMPTS = 160;

  var existing = window.MineradioPlaybackRecovery;
  if (existing && existing.__version === VERSION && typeof existing.install === "function") {
    existing.install();
    return;
  }

  var installed = false;
  var installTimer = 0;
  var installAttempts = 0;
  var originals = null;
  var activeRecovery = null;
  var currentTrackWatch = null;
  var lastRoomNoticeAt = 0;

  function finiteNumber(value, fallback) {
    var number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function currentToken() {
    return finiteNumber(window.trackSwitchToken, 0);
  }

  function isJoinedRoom() {
    var bridge = window.MineradioWebBridge;
    if (!bridge || typeof bridge !== "object") return false;

    var sync = bridge.sync || {};
    if (typeof bridge.shouldDeferRoomPlayback === "function") {
      try {
        if (bridge.shouldDeferRoomPlayback()) return true;
      } catch {}
    }

    // The bridge deliberately keeps the joined flag private. Treat an active
    // connection or any room-state signal as joined so a false negative never
    // creates a local source switch or queue advance during synchronization.
    return sync.connected === true
      || sync.leader === true
      || sync.preparing === true
      || finiteNumber(sync.deviceCount, 0) > 0
      || finiteNumber(sync.readyCount, 0) > 0
      || finiteNumber(sync.requiredCount, 0) > 0
      || finiteNumber(sync.prepareDeadline, 0) > 0
      || finiteNumber(sync.prepareMaxDeadline, 0) > 0;
  }

  function isRoomAuthoritative() {
    var bridge = window.MineradioWebBridge;
    if (!bridge || typeof bridge !== "object") return false;
    var sync = bridge.sync || {};
    var participants = Math.max(
      finiteNumber(sync.deviceCount, 0),
      finiteNumber(sync.requiredCount, 0)
    );

    // HOME is intentionally connected even for ordinary one-device playback.
    // A local fallback is safe in that case; once a second device participates
    // (or the relay is preparing a shared start), the room becomes authoritative.
    return sync.preparing === true || participants > 1;
  }

  function notify(message) {
    if (typeof window.showToast !== "function") return;
    try { window.showToast(message); } catch {}
  }

  function clearPendingPlaybackUi() {
    try {
      if (typeof window.hideLoading === "function") window.hideLoading();
    } catch {}
    try {
      if (typeof window.forcePlaybackControlsInteractive === "function") {
        window.forcePlaybackControlsInteractive();
      }
    } catch {}
  }

  function songKeyAt(index) {
    var queue = window.playQueue;
    var song = Array.isArray(queue) ? queue[index] : null;
    if (!song || typeof song !== "object") return "index:" + String(index);
    var provider = String(song.provider || song.source || song.platform || "");
    var identity = song.id || song.mid || song.songmid || song.hash || song.albumAudioId || song.localKey || song.url || song.name || "";
    return provider + ":" + String(identity || ("index:" + String(index)));
  }

  function clearRecoveryTimer(state) {
    if (!state || !state.timer) return;
    window.clearTimeout(state.timer);
    state.timer = 0;
  }

  function clearActiveRecovery(reason) {
    if (!activeRecovery) return;
    clearRecoveryTimer(activeRecovery);
    activeRecovery.finishedReason = reason || activeRecovery.finishedReason || "reset";
    activeRecovery = null;
  }

  function createRecovery(index, token) {
    clearActiveRecovery("new-root");
    activeRecovery = {
      rootIndex: finiteNumber(index, -1),
      rootToken: finiteNumber(token, 0),
      createdAt: Date.now(),
      recoveryStartedAt: 0,
      deadline: 0,
      timer: 0,
      expired: false,
      sourceFallbacks: 0,
      queueAdvances: 0,
      expectQueueAdvance: false,
      continuationInFlight: false,
      seenIndexes: Object.create(null),
      seenSongKeys: Object.create(null),
      lastFailureIndex: -1,
      finishedReason: ""
    };
    markSeen(activeRecovery, index);
    return activeRecovery;
  }

  function markSeen(state, index) {
    if (!state || !Number.isFinite(Number(index)) || Number(index) < 0) return;
    var normalized = Number(index);
    state.seenIndexes[String(normalized)] = true;
    state.seenSongKeys[songKeyAt(normalized)] = true;
  }

  function hasSeen(state, index) {
    if (!state || !Number.isFinite(Number(index)) || Number(index) < 0) return false;
    var normalized = Number(index);
    return state.seenIndexes[String(normalized)] === true
      || state.seenSongKeys[songKeyAt(normalized)] === true;
  }

  function invalidateStaleRoot(state) {
    if (!state || isRoomAuthoritative()) return;
    var token = finiteNumber(state.rootToken, 0);
    if (!token || currentToken() !== token) return;
    try {
      window.trackSwitchToken = token + 1;
    } catch {}
  }

  function hasActivePlayback() {
    var media = window.audio;
    return Boolean(media && media.src && !media.paused && !media.ended);
  }

  function endRecovery(state, reason, message, invalidateToken) {
    if (!state || state.expired) return;
    state.expired = true;
    state.finishedReason = reason || "stopped";
    clearRecoveryTimer(state);
    if (invalidateToken) invalidateStaleRoot(state);
    clearPendingPlaybackUi();
    if (message) notify(message);
  }

  function armRecoveryBudget(state) {
    if (!state || state.expired || state.recoveryStartedAt) return;
    state.recoveryStartedAt = Date.now();
    state.deadline = state.recoveryStartedAt + RECOVERY_TIMEOUT_MS;
    state.timer = window.setTimeout(function expireRootRecoveryBudget() {
      if (activeRecovery !== state || isRoomAuthoritative()) return;
      if (hasActivePlayback()) {
        clearActiveRecovery("playback-active");
        return;
      }
      endRecovery(
        state,
        "timeout",
        "自动恢复超过 20 秒仍未完成，已停止自动换源和跳歌；请手动重试。",
        true
      );
    }, RECOVERY_TIMEOUT_MS);
  }

  function recoveryFor(index, token) {
    var normalizedToken = finiteNumber(token, 0);
    if (!activeRecovery) return createRecovery(index, normalizedToken);
    if (activeRecovery.expired) {
      // Do not let a late callback from the just-stopped root silently create
      // another recovery chain. A fresh user selection enters through
      // playQueueAt and explicitly creates its own state there.
      if (!normalizedToken || normalizedToken === activeRecovery.rootToken) return activeRecovery;
      return createRecovery(index, normalizedToken);
    }

    if (normalizedToken && activeRecovery.rootToken && normalizedToken !== activeRecovery.rootToken) {
      return createRecovery(index, normalizedToken);
    }
    if (normalizedToken) activeRecovery.rootToken = normalizedToken;
    if (Number(index) >= 0) markSeen(activeRecovery, index);
    return activeRecovery;
  }

  function isContinuation(opts) {
    opts = opts || {};
    return finiteNumber(opts.fallbackDepth, 0) > 0
      || Boolean(activeRecovery && activeRecovery.expectQueueAdvance && !opts.manual);
  }

  function stopRoomRecovery() {
    clearActiveRecovery("room-joined");
    if (Date.now() - lastRoomNoticeAt < 2500) return;
    lastRoomNoticeAt = Date.now();
    notify("局域网同步已接管播放，未执行本机自动换源或跳歌。");
  }

  function shouldStopForBudget(state) {
    if (!state) return false;
    if (state.expired) return true;
    if (state.deadline && Date.now() >= state.deadline) {
      endRecovery(
        state,
        "timeout",
        "自动恢复超过 20 秒仍未完成，已停止自动换源和跳歌；请手动重试。",
        true
      );
      return true;
    }
    return false;
  }

  function boundedPlayQueueAt(index, opts) {
    if (isRoomAuthoritative()) {
      clearActiveRecovery("room-joined");
      return originals.playQueueAt.apply(this, arguments);
    }

    opts = opts || {};
    var continuing = isContinuation(opts);
    var state = activeRecovery;
    if (!continuing) {
      createRecovery(index, currentToken() + 1);
      armCurrentTrack({ index: index, token: currentToken() + 1 });
    } else if (activeRecovery && activeRecovery.expectQueueAdvance && !opts.manual) {
      activeRecovery.expectQueueAdvance = false;
      if (hasSeen(activeRecovery, index)) {
        endRecovery(
          activeRecovery,
          "visited-queue-item",
          "自动恢复已遇到已尝试的歌曲，已停止循环跳歌；请手动选择歌曲。",
          false
        );
        return Promise.resolve(false);
      }
      markSeen(activeRecovery, index);
    }

    state = activeRecovery;
    if (continuing && state) {
      // Classic increments trackSwitchToken at the beginning of every queued
      // attempt. Carry the root guard to that next token so repeated failures
      // stay inside one bounded recovery chain instead of resetting the cap.
      state.rootToken = currentToken() + 1;
      state.continuationInFlight = true;
    }
    var result = originals.playQueueAt.apply(this, arguments);
    if (!continuing || !state || !result || typeof result.then !== "function") return result;

    return result.then(function recoveryContinuationSettled(value) {
      if (activeRecovery === state && !state.expired && hasActivePlayback()) {
        // The fallback path reached an actually playing media element. Its
        // original implementation already performed provider checks, so the
        // bounded recovery chain has completed successfully.
        clearActiveRecovery("continuation-settled");
      } else if (activeRecovery === state && !state.expired) {
        // Keep the root state while the player reports a failed or blocked
        // continuation. A later skip must still see the same 2-song cap.
        state.continuationInFlight = false;
      }
      return value;
    }, function recoveryContinuationRejected(error) {
      if (activeRecovery === state && !state.expired) {
        state.continuationInFlight = false;
      }
      throw error;
    });
  }

  function boundedSkipFailedQueueItem(index, token) {
    if (isRoomAuthoritative()) {
      stopRoomRecovery();
      clearPendingPlaybackUi();
      return false;
    }

    var state = recoveryFor(index, token);
    armRecoveryBudget(state);
    if (shouldStopForBudget(state)) return false;

    state.lastFailureIndex = finiteNumber(index, -1);
    markSeen(state, index);
    if (state.queueAdvances >= MAX_QUEUE_ADVANCES) {
      endRecovery(
        state,
        "queue-advance-limit",
        "自动恢复已尝试 2 首候选歌曲，已停止跳歌；请手动选择或稍后重试。",
        false
      );
      return false;
    }

    state.queueAdvances += 1;
    state.expectQueueAdvance = true;
    return originals.skipFailedQueueItem.apply(this, arguments);
  }

  async function boundedTryAutoPlaybackFallback(song, data, index, token, opts) {
    if (isRoomAuthoritative()) {
      stopRoomRecovery();
      return false;
    }

    var state = recoveryFor(index, token);
    armRecoveryBudget(state);
    if (shouldStopForBudget(state)) return true;

    // The existing player already enforces which providers can be considered.
    // This wrapper only bounds its time and never constructs or changes a URL.
    state.sourceFallbacks += 1;
    var remaining = Math.max(0, state.deadline - Date.now());
    if (!remaining) {
      endRecovery(
        state,
        "timeout",
        "自动恢复超过 20 秒仍未完成，已停止自动换源和跳歌；请手动重试。",
        true
      );
      return true;
    }

    var originalResult = Promise.resolve().then(function invokeOriginalFallback() {
      return originals.tryAutoPlaybackFallback.call(this, song, data, index, token, opts);
    }.bind(this));
    var timeoutId = 0;
    var timeoutResult = new Promise(function resolveOnDeadline(resolve) {
      timeoutId = window.setTimeout(function recoveryDeadlineReached() {
        if (activeRecovery === state && !isRoomAuthoritative()) {
          endRecovery(
            state,
            "timeout",
            "自动恢复超过 20 秒仍未完成，已停止自动换源和跳歌；请手动重试。",
            true
          );
        }
        resolve(true);
      }, remaining);
    });

    try {
      var fallbackResult = await Promise.race([originalResult, timeoutResult]);
      if (fallbackResult === false && activeRecovery === state && !state.expired) {
        // A terminal provider restriction (for example login-only content)
        // is not a pending recovery. Do not emit a misleading timeout later.
        clearActiveRecovery("no-solo-fallback");
      }
      return fallbackResult;
    } finally {
      if (timeoutId) window.clearTimeout(timeoutId);
    }
  }

  function armCurrentTrack(details) {
    if (isRoomAuthoritative()) {
      currentTrackWatch = null;
      return false;
    }
    details = details || {};
    currentTrackWatch = {
      index: finiteNumber(details.index, finiteNumber(window.currentIdx, -1)),
      token: finiteNumber(details.token, currentToken()),
      songKey: details.songKey || songKeyAt(finiteNumber(details.index, finiteNumber(window.currentIdx, -1))),
      armedAt: Date.now(),
      lastProgressAt: 0,
      lastPosition: 0
    };
    return true;
  }

  function notePlaybackProgress(position, details) {
    if (isRoomAuthoritative() || !currentTrackWatch) return false;
    details = details || {};
    var token = finiteNumber(details.token, currentTrackWatch.token);
    if (currentTrackWatch.token && token && currentTrackWatch.token !== token) return false;
    currentTrackWatch.lastProgressAt = Date.now();
    currentTrackWatch.lastPosition = Math.max(0, finiteNumber(position, currentTrackWatch.lastPosition));
    return true;
  }

  function getState() {
    var state = activeRecovery;
    return {
      installed: installed,
      roomJoined: isJoinedRoom(),
      roomAuthoritative: isRoomAuthoritative(),
      recovery: state ? {
        rootIndex: state.rootIndex,
        rootToken: state.rootToken,
        recoveryStartedAt: state.recoveryStartedAt,
        deadline: state.deadline,
        expired: state.expired,
        sourceFallbacks: state.sourceFallbacks,
        queueAdvances: state.queueAdvances,
        finishedReason: state.finishedReason
      } : null,
      trackWatch: currentTrackWatch ? {
        index: currentTrackWatch.index,
        token: currentTrackWatch.token,
        songKey: currentTrackWatch.songKey,
        armedAt: currentTrackWatch.armedAt,
        lastProgressAt: currentTrackWatch.lastProgressAt,
        lastPosition: currentTrackWatch.lastPosition
      } : null
    };
  }

  function hasPlayerGlobals() {
    return typeof window.playQueueAt === "function"
      && typeof window.skipFailedQueueItem === "function"
      && typeof window.tryAutoPlaybackFallback === "function";
  }

  function stopInstallRetry() {
    if (!installTimer) return;
    window.clearInterval(installTimer);
    installTimer = 0;
  }

  function scheduleInstallRetry() {
    if (installed || installTimer) return;
    installTimer = window.setInterval(function retryInstallWhenClassicGlobalsAppear() {
      installAttempts += 1;
      if (install() || installAttempts >= MAX_INSTALL_ATTEMPTS) stopInstallRetry();
    }, INSTALL_RETRY_MS);
  }

  function install() {
    if (installed) return true;
    if (!hasPlayerGlobals()) {
      scheduleInstallRetry();
      return false;
    }

    originals = {
      playQueueAt: window.playQueueAt,
      skipFailedQueueItem: window.skipFailedQueueItem,
      tryAutoPlaybackFallback: window.tryAutoPlaybackFallback
    };
    window.playQueueAt = boundedPlayQueueAt;
    window.skipFailedQueueItem = boundedSkipFailedQueueItem;
    window.tryAutoPlaybackFallback = boundedTryAutoPlaybackFallback;
    installed = true;
    stopInstallRetry();
    return true;
  }

  var api = {
    __version: VERSION,
    install: install,
    isJoinedRoom: isJoinedRoom,
    isRoomAuthoritative: isRoomAuthoritative,
    armCurrentTrack: armCurrentTrack,
    notePlaybackProgress: notePlaybackProgress,
    getState: getState,
    clear: function clearRecoveryState() {
      clearActiveRecovery("manual-clear");
      currentTrackWatch = null;
    },
    constants: {
      RECOVERY_TIMEOUT_MS: RECOVERY_TIMEOUT_MS,
      MAX_QUEUE_ADVANCES: MAX_QUEUE_ADVANCES
    }
  };
  window.MineradioPlaybackRecovery = api;

  install();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  }
})();
