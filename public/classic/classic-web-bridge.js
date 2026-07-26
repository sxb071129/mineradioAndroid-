(function installMineradioClassicWebBridge() {
  "use strict";

  var SETTINGS_KEY = "mineradio-lan-settings-v1";
  var ROOM_RE = /^[A-Z0-9]{4,8}$/;
  var QUALITY_RE = /^(jymaster|hires|lossless|exhigh|standard)$/;
  var nativeFetch = window.fetch.bind(window);

  function readSettings() {
    try {
      return JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || "{}") || {};
    } catch {
      return {};
    }
  }

  function safeServiceUrl(value, fallback, protocols) {
    try {
      var url = new URL(String(value || fallback));
      if (protocols.indexOf(url.protocol) < 0 || url.username || url.password) return fallback;
      return url.toString().replace(/\/$/, "");
    } catch {
      return fallback;
    }
  }

  var settings = readSettings();
  var pageHost = window.location.hostname || "localhost";
  var apiFallback = "http://" + pageHost + ":8790";
  var relayFallback = "ws://" + pageHost + ":8787/ws";
  var apiOrigin = safeServiceUrl(settings.musicApiUrl, apiFallback, ["http:", "https:"]);
  var relayUrl = safeServiceUrl(settings.relayUrl, relayFallback, ["ws:", "wss:"]);
  var relayHttpOrigin = (function () {
    try {
      var value = new URL(relayUrl);
      value.protocol = value.protocol === "wss:" ? "https:" : "http:";
      return value.origin;
    } catch {
      return "http://" + pageHost + ":8787";
    }
  })();
  var requestedRoom = String(new URLSearchParams(window.location.search).get("room") || "HOME")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 8);
  var roomCode = ROOM_RE.test(requestedRoom) ? requestedRoom : "HOME";

  function jsonResponse(value, status) {
    return new Response(JSON.stringify(value), {
      status: status || 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });
  }

  function parsedInputUrl(input) {
    try {
      return new URL(input instanceof Request ? input.url : String(input), window.location.href);
    } catch {
      return null;
    }
  }

  function fetchAt(url, input, init) {
    var request = input instanceof Request ? new Request(url, input) : null;
    var nextInit = init ? Object.assign({}, init) : {};
    var method = String(nextInit.method || (request && request.method) || "GET").toUpperCase();
    var isLocalApiMutation = false;
    try {
      var targetUrl = new URL(url, apiOrigin + "/");
      isLocalApiMutation = targetUrl.origin === new URL(apiOrigin).origin &&
        targetUrl.pathname.indexOf("/api/") === 0 && method !== "GET" && method !== "HEAD";
    } catch {}

    if (isLocalApiMutation) {
      var headers = new Headers(nextInit.headers || (request && request.headers) || undefined);
      if (!headers.has("X-Mineradio-Application")) {
        headers.set("X-Mineradio-Application", "mineradio-web-v1");
      }
      nextInit.headers = headers;
    }

    if (request) return nativeFetch(request, nextInit);
    return nativeFetch(url, nextInit);
  }

  function qualityFrom(url) {
    var value = String(url.searchParams.get("quality") || "hires").toLowerCase();
    return QUALITY_RE.test(value) ? value : "hires";
  }

  function syntheticStreamResponse(url, provider) {
    var quality = qualityFrom(url);
    var sourceId = String(url.searchParams.get(provider === "kugou" ? "hash" : "id") || "").trim();
    var valid = provider === "kugou" ? /^[a-f0-9]{24}$/i.test(sourceId) : /^[1-9]\d{0,19}$/.test(sourceId);
    if (!valid) {
      return jsonResponse({
        url: "",
        provider: provider,
        level: quality,
        error: provider === "kugou" ? "track_key_expired" : "track_unavailable"
      });
    }
    if (provider === "kugou") sourceId = sourceId.toLowerCase();
    var stream = new URL("/api/stream", apiOrigin + "/");
    stream.searchParams.set("provider", provider);
    stream.searchParams.set("id", sourceId);
    stream.searchParams.set("quality", quality);
    return jsonResponse({
      url: stream.toString(),
      provider: provider,
      level: quality,
      trial: false
    });
  }

  async function prepareKugouStreamResponse(url) {
    var quality = qualityFrom(url);
    var trackRef = String(url.searchParams.get("hash") || "").trim().toLowerCase();
    if (!/^[a-f0-9]{24}$/.test(trackRef)) {
      return jsonResponse({
        url: "",
        provider: "kugou",
        level: quality,
        requestedQuality: quality,
        reason: "track_key_expired",
        message: "歌曲播放凭据已过期，请重新打开歌单"
      });
    }

    try {
      var endpoint = new URL("/api/v2/playback/prepare", apiOrigin + "/");
      var response = await nativeFetch(endpoint.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Mineradio-Application": "mineradio-web-v1"
        },
        body: JSON.stringify({
          provider: "kugou",
          trackRef: trackRef,
          quality: quality
        })
      });
      var prepared = await response.json().catch(function () { return {}; });
      var restriction = prepared && prepared.restriction && typeof prepared.restriction === "object"
        ? prepared.restriction
        : null;

      if (!response.ok || !prepared.playable || !prepared.streamPath) {
        var reason = String(restriction && restriction.category || prepared.error || "provider_unavailable");
        return jsonResponse({
          url: "",
          provider: "kugou",
          level: quality,
          requestedQuality: quality,
          reason: reason,
          message: String(restriction && restriction.message || "酷狗音源暂不可用"),
          restriction: restriction
        });
      }

      var streamUrl = new URL(String(prepared.streamPath), apiOrigin + "/");
      var expectedPath = "/api/v2/stream/" + trackRef;
      if (streamUrl.origin !== new URL(apiOrigin).origin || streamUrl.pathname !== expectedPath) {
        throw new Error("invalid_local_stream_path");
      }
      var resolvedQuality = QUALITY_RE.test(String(prepared.resolvedQuality || "").toLowerCase())
        ? String(prepared.resolvedQuality).toLowerCase()
        : quality;
      return jsonResponse({
        url: streamUrl.toString(),
        provider: "kugou",
        level: resolvedQuality,
        requestedQuality: quality,
        downgraded: resolvedQuality !== quality,
        trial: false,
        restriction: null
      });
    } catch {
      return jsonResponse({
        url: "",
        provider: "kugou",
        level: quality,
        requestedQuality: quality,
        reason: "provider_unavailable",
        message: "本机酷狗音源服务暂时不可用",
        restriction: {
          category: "provider_unavailable",
          action: "retry",
          message: "本机酷狗音源服务暂时不可用"
        }
      });
    }
  }

  window.fetch = function classicWebFetch(input, init) {
    var url = parsedInputUrl(input);
    if (!url) return nativeFetch(input, init);
    var isPageApi = url.origin === window.location.origin && url.pathname.indexOf("/api/") === 0;
    if (!isPageApi) return nativeFetch(input, init);

    if (url.pathname === "/api/kugou/song/url") {
      return prepareKugouStreamResponse(url);
    }
    if (url.pathname === "/api/song/url") {
      return Promise.resolve(syntheticStreamResponse(url, "netease"));
    }
    if (url.pathname === "/api/qq/login/status") {
      return Promise.resolve(jsonResponse({ provider: "qq", loggedIn: false, playbackKeyReady: false }));
    }
    if (url.pathname === "/api/weather/radio") {
      return Promise.resolve(jsonResponse({ weather: null, radio: null, unavailable: true }));
    }
    if (url.pathname === "/api/weather/ip-location") {
      return Promise.resolve(jsonResponse({ location: null, error: "location_unavailable" }));
    }
    if (url.pathname === "/api/update/latest") {
      return Promise.resolve(jsonResponse({
        currentVersion: "1.1.2",
        latestVersion: "1.1.2",
        configured: false,
        preview: false,
        updateAvailable: false,
        release: null
      }));
    }
    if (url.pathname === "/api/audio" || url.pathname === "/api/cover") {
      var target = String(url.searchParams.get("url") || "");
      try {
        var targetUrl = new URL(target, apiOrigin + "/");
        if (targetUrl.protocol === "http:" || targetUrl.protocol === "https:") {
          return fetchAt(targetUrl.toString(), input, init);
        }
      } catch {}
      return Promise.resolve(jsonResponse({ error: "invalid_proxy_target" }, 400));
    }

    var mapped = new URL(url.pathname + url.search, apiOrigin + "/");
    if (url.pathname === "/api/kugou/lyric" && !mapped.searchParams.has("id")) {
      var lyricTrackRef = String(mapped.searchParams.get("hash") || "").trim();
      if (/^[a-f0-9]{24}$/i.test(lyricTrackRef)) {
        mapped.searchParams.delete("hash");
        mapped.searchParams.set("id", lyricTrackRef);
      }
    }
    return fetchAt(mapped.toString(), input, init);
  };

  function directMediaUrl(value) {
    var raw = String(value || "").trim();
    if (!raw) return "";
    if (/^(?:blob:|data:)/i.test(raw)) return raw;
    try {
      var url = new URL(raw, apiOrigin + "/");
      if (url.protocol !== "http:" && url.protocol !== "https:") return "";
      if (url.origin === window.location.origin && url.pathname.indexOf("/api/") === 0) {
        return new URL(url.pathname + url.search, apiOrigin + "/").toString();
      }
      return url.toString();
    } catch {
      return "";
    }
  }

  var bridge = {
    apiOrigin: apiOrigin,
    relayUrl: relayUrl,
    roomCode: roomCode,
    audioUrl: directMediaUrl,
    coverUrl: directMediaUrl,
    sync: {
      connected: false,
      leader: false,
      deviceCount: 0,
      addresses: [],
      error: false,
      latency: 0,
      jitter: 0,
      drift: 0,
      clockReady: false,
      preparing: false,
      readyCount: 0,
      requiredCount: 0,
      prepareError: ""
    }
  };
  window.MineradioWebBridge = bridge;

  var socket = null;
  var clientId = "";
  var applyingRoomState = false;
  var joinedRoom = false;
  var lastRevision = -1;
  var serverOffset = 0;
  var clockSamples = [];
  var clockPingTimer = 0;
  var attachedAudio = null;
  var reconnectTimer = 0;
  var reconnectAttempt = 0;
  var lastPositionSentAt = 0;
  var wrappersInstalled = false;
  var lastRoomState = null;
  var pendingSeekMedia = null;
  var pendingSeekHandler = null;
  var pendingLocalFile = null;
  var localUploadSerial = 0;
  var roomStateChain = Promise.resolve();
  var roomConnectionGeneration = 0;
  var lastVolumeSentAt = 0;
  var pendingVolume = null;
  var volumeSyncTimer = 0;
  var lastSeekSentAt = 0;
  var pendingSeek = null;
  var seekSyncTimer = 0;
  var roomUiInstalled = false;
  var roomUiRetryTimer = 0;
  var leaderBuffering = false;
  var playUnlockNoticeShown = false;
  var scheduledPlayTimer = 0;
  var scheduledPlayGeneration = 0;
  var lastReadyPrepareId = "";
  var suppressNextPlayCommand = false;
  var suppressNextPauseCommand = false;
  var suppressNextSeekCommand = false;
  var suppressSeekResetTimer = 0;
  var roomMediaUnlockMedia = null;
  var roomMediaUnlockPromise = null;
  var roomMediaUnlocked = false;
  var roomMediaPrimeActive = null;
  var roomMediaUnlockNoticeShown = false;
  var leaderStartRequestPending = null;

  bridge.shouldDeferRoomPlayback = function () {
    return joinedRoom && bridge.sync.leader;
  };

  function notify(message) {
    if (typeof window.showToast === "function") window.showToast(message);
  }

  function normalizeRoomInput(value) {
    return String(value || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 8);
  }

  function privateIpv4Candidate(value) {
    var raw = String(value || "");
    var parts = raw.split(".");
    if (parts.length !== 4) return null;
    var numbers = parts.map(function (part) { return /^\d{1,3}$/.test(part) ? Number(part) : -1; });
    if (numbers.some(function (part) { return part < 0 || part > 255; })) return null;
    var score = numbers[0] === 192 && numbers[1] === 168
      ? 300
      : (numbers[0] === 10 ? 200 : (numbers[0] === 172 && numbers[1] >= 16 && numbers[1] <= 31 ? 100 : 0));
    return score ? { host: numbers.join("."), score: score } : null;
  }

  function preferredRoomHost() {
    var hostname = String(window.location.hostname || "").toLowerCase();
    if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "[::1]" && hostname !== "::1") {
      return window.location.hostname;
    }
    var addresses = Array.isArray(bridge.sync.addresses) ? bridge.sync.addresses : [];
    var candidates = addresses.map(privateIpv4Candidate).filter(Boolean).sort(function (left, right) {
      return right.score - left.score;
    });
    return candidates.length ? candidates[0].host : window.location.hostname;
  }

  function roomShareUrl(code) {
    var url = new URL("/", window.location.origin);
    url.hostname = preferredRoomHost();
    url.searchParams.set("room", normalizeRoomInput(code) || roomCode);
    return url.toString();
  }

  function updateRoomSyncUi() {
    var anchor = document.getElementById("room-sync-anchor");
    if (!anchor) return;
    var code = document.getElementById("room-sync-code");
    var count = document.getElementById("room-sync-count");
    var current = document.getElementById("room-sync-current-code");
    var role = document.getElementById("room-sync-role");
    var status = document.getElementById("room-sync-status");
    var devices = document.getElementById("room-sync-devices");
    var dot = document.getElementById("room-sync-meta-dot");
    var link = document.getElementById("room-sync-link");
    var deviceCount = Math.max(0, Number(bridge.sync.deviceCount) || 0);
    var connected = Boolean(bridge.sync.connected);
    var connectionError = Boolean(bridge.sync.error);
    var leader = connected && joinedRoom && Boolean(bridge.sync.leader);
    var timingText = bridge.sync.clockReady
      ? " · " + Math.round(Math.max(0, Number(bridge.sync.latency) || 0)) + " ms"
      : " · 校时中";

    anchor.classList.toggle("connected", connected);
    anchor.classList.toggle("leader", leader);
    anchor.setAttribute(
      "aria-label",
      "局域网同步房间 " + roomCode + "，" + (connected ? "已连接" : (connectionError ? "等待重连" : "正在连接")) + "，" + deviceCount + " 台设备"
    );
    if (code) code.textContent = roomCode;
    if (count) count.textContent = String(deviceCount);
    if (current) current.textContent = roomCode;
    if (role) {
      role.classList.toggle("leader", leader);
      role.classList.toggle("follower", connected && joinedRoom && !leader);
      role.textContent = !connected ? (connectionError ? "等待重连" : "正在连接") : (!joinedRoom ? "正在加入" : (leader ? "主控" : "跟随"));
    }
    if (status) status.textContent = !connected
      ? (connectionError ? "同步服务连接失败，正在重试" : "正在连接同步服务")
      : (bridge.sync.preparing
        ? "等待设备缓冲 · " + bridge.sync.readyCount + "/" + Math.max(1, bridge.sync.requiredCount)
        : (bridge.sync.prepareError
          ? (bridge.sync.prepareError === "start_failed" ? "设备启动失败，请重试播放" : "设备缓冲超时，请重试播放")
          : (joinedRoom ? "同步服务已连接" + timingText : "正在加入同步房间")));
    if (devices) devices.textContent = deviceCount + " 台设备";
    if (dot) dot.classList.toggle("connected", connected);
    if (link) {
      var shareUrl = roomShareUrl(roomCode);
      link.textContent = shareUrl;
      link.title = shareUrl;
    }
  }

  function setRoomPanelOpen(open) {
    var anchor = document.getElementById("room-sync-anchor");
    var panel = document.getElementById("room-sync-panel");
    if (!anchor || !panel) return;
    var next = Boolean(open);
    anchor.classList.toggle("open", next);
    anchor.setAttribute("aria-expanded", next ? "true" : "false");
    panel.classList.toggle("open", next);
    panel.setAttribute("aria-hidden", next ? "false" : "true");
    panel.inert = !next;
    if (next) {
      window.setTimeout(function () {
        var input = document.getElementById("room-sync-input");
        if (input && panel.classList.contains("open")) input.focus({ preventScroll: true });
      }, 0);
    } else if (panel.contains(document.activeElement)) {
      anchor.focus({ preventScroll: true });
    }
  }

  function legacyCopyRoomLink(value) {
    return new Promise(function (resolve, reject) {
      var input = document.createElement("textarea");
      input.value = value;
      input.setAttribute("readonly", "");
      input.style.position = "fixed";
      input.style.left = "-9999px";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      input.setSelectionRange(0, input.value.length);
      var copied = false;
      try { copied = document.execCommand("copy"); } catch {}
      input.remove();
      if (copied) resolve();
      else reject(new Error("copy_failed"));
    });
  }

  function writeRoomLinkToClipboard(value) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(value).catch(function () {
        return legacyCopyRoomLink(value);
      });
    }
    return legacyCopyRoomLink(value);
  }

  function navigateToRoom(value) {
    var code = normalizeRoomInput(value);
    if (!ROOM_RE.test(code)) {
      notify("房间码需要 4–8 位字母或数字");
      return false;
    }
    if (code === roomCode) {
      setRoomPanelOpen(false);
      notify("已经在房间 " + code);
      return true;
    }
    var target = roomShareUrl(code);
    var canNavigateTop = window.top === window;
    if (!canNavigateTop) {
      try { canNavigateTop = window.top.location.origin === window.location.origin; } catch {}
    }
    if (canNavigateTop) {
      window.top.location.assign(target);
      return true;
    }
    window.location.assign(target);
    return true;
  }

  function createRoomCode() {
    var alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    var bytes = new Uint8Array(6);
    if (window.crypto && typeof window.crypto.getRandomValues === "function") {
      window.crypto.getRandomValues(bytes);
    } else {
      for (var index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
    }
    return Array.from(bytes, function (value) { return alphabet[value % alphabet.length]; }).join("");
  }

  function installRoomSyncUi() {
    if (roomUiInstalled) return;
    var anchor = document.getElementById("room-sync-anchor");
    var panel = document.getElementById("room-sync-panel");
    var close = document.getElementById("room-sync-close");
    var input = document.getElementById("room-sync-input");
    var join = document.getElementById("room-sync-join");
    var copy = document.getElementById("room-sync-copy");
    var create = document.getElementById("room-sync-new");
    if (!anchor || !panel || !close || !input || !join || !copy || !create) return;
    roomUiInstalled = true;
    window.clearInterval(roomUiRetryTimer);
    roomUiRetryTimer = 0;
    anchor.setAttribute("data-room-ui-installed", "true");
    input.value = roomCode;

    anchor.addEventListener("pointerdown", function (event) {
      event.preventDefault();
      setRoomPanelOpen(!panel.classList.contains("open"));
      updateRoomSyncUi();
    });
    anchor.addEventListener("keydown", function (event) {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      setRoomPanelOpen(!panel.classList.contains("open"));
      updateRoomSyncUi();
    });
    close.addEventListener("click", function () { setRoomPanelOpen(false); });
    input.addEventListener("input", function () {
      var normalized = normalizeRoomInput(input.value);
      if (input.value !== normalized) input.value = normalized;
    });
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter") navigateToRoom(input.value);
    });
    join.addEventListener("click", function () { navigateToRoom(input.value); });
    copy.addEventListener("click", function () {
      writeRoomLinkToClipboard(roomShareUrl(roomCode)).then(function () {
        notify("局域网房间链接已复制");
      }).catch(function () {
        notify("复制失败，请手动复制上方链接");
      });
    });
    create.addEventListener("click", function () { navigateToRoom(createRoomCode()); });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && panel.classList.contains("open")) {
        event.preventDefault();
        setRoomPanelOpen(false);
      }
    });
    document.addEventListener("pointerdown", function (event) {
      if (!panel.classList.contains("open")) return;
      var target = event.target;
      if (target && target.closest && !target.closest("#room-sync-anchor,#room-sync-panel")) setRoomPanelOpen(false);
    });
    bridge.openRoomPanel = function () { setRoomPanelOpen(true); };
    bridge.roomShareUrl = roomShareUrl;
    updateRoomSyncUi();
  }

  function sendCommand(action, value) {
    var readiness = action === "ready" || action === "start-failed";
    if ((!readiness && !bridge.sync.leader) || !joinedRoom || !socket || socket.readyState !== WebSocket.OPEN) return false;
    var message = { type: "command", action: action };
    if (action === "track") message.track = value;
    else if (action === "ready") {
      var readyValue = value && typeof value === "object" ? value : { prepareId: value };
      message.prepareId = String(readyValue.prepareId || "");
      message.ready = readyValue.ready !== false;
      message.latencyMs = Math.max(0, Number(bridge.sync.latency) || 0);
      message.jitterMs = Math.max(0, Number(bridge.sync.jitter) || 0);
    }
    else if (action === "start-failed") message.prepareId = String(value || "");
    else if (action === "seek" || action === "progress") {
      message.position = Number(value) || 0;
      if (action === "progress") {
        message.sampledServerTime = Date.now() + serverOffset;
        message.advancing = Boolean(window.audio && !window.audio.paused && !leaderBuffering);
      }
    }
    else if (action === "volume") message.volume = Math.max(0, Math.min(1, Number(value) || 0));
    else if (action === "quality") message.quality = String(value || "");
    socket.send(JSON.stringify(message));
    return true;
  }

  function sendVolumeCommand(value, flush) {
    pendingVolume = Math.max(0, Math.min(1, Number(value) || 0));
    var elapsed = Date.now() - lastVolumeSentAt;
    if (flush || elapsed >= 80) {
      window.clearTimeout(volumeSyncTimer);
      volumeSyncTimer = 0;
      var immediate = pendingVolume;
      pendingVolume = null;
      if (sendCommand("volume", immediate)) lastVolumeSentAt = Date.now();
      return;
    }
    window.clearTimeout(volumeSyncTimer);
    volumeSyncTimer = window.setTimeout(function () {
      volumeSyncTimer = 0;
      if (pendingVolume == null) return;
      var trailing = pendingVolume;
      pendingVolume = null;
      if (sendCommand("volume", trailing)) lastVolumeSentAt = Date.now();
    }, Math.max(0, 80 - elapsed));
  }

  function sendSeekCommand(value, flush) {
    pendingSeek = Math.max(0, Number(value) || 0);
    var elapsed = Date.now() - lastSeekSentAt;
    if (flush || elapsed >= 80) {
      window.clearTimeout(seekSyncTimer);
      seekSyncTimer = 0;
      var immediate = pendingSeek;
      pendingSeek = null;
      if (sendCommand("seek", immediate)) lastSeekSentAt = Date.now();
      return;
    }
    window.clearTimeout(seekSyncTimer);
    seekSyncTimer = window.setTimeout(function () {
      seekSyncTimer = 0;
      if (pendingSeek == null) return;
      var trailing = pendingSeek;
      pendingSeek = null;
      if (sendCommand("seek", trailing)) lastSeekSentAt = Date.now();
    }, Math.max(0, 80 - elapsed));
  }

  function sendClockPing() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "ping", clientTime: Date.now() }));
  }

  function recordClockPong(message, receivedAt) {
    var sentAt = Number(message.clientTime);
    var serverSentAt = Number(message.serverTime);
    var serverReceivedAt = Number(message.serverReceivedAt) || serverSentAt;
    if (!Number.isFinite(sentAt) || !Number.isFinite(serverReceivedAt) || !Number.isFinite(serverSentAt)) return;
    if (receivedAt < sentAt || serverSentAt < serverReceivedAt) return;
    var serverProcessing = Math.max(0, Math.min(30000, serverSentAt - serverReceivedAt));
    var rtt = Math.max(0, receivedAt - sentAt - serverProcessing);
    if (rtt > 30000) return;
    var sample = {
      rtt: rtt,
      latency: rtt / 2,
      offset: ((serverReceivedAt - sentAt) + (serverSentAt - receivedAt)) / 2
    };
    var previousBestRtt = clockSamples.length
      ? Math.min.apply(null, clockSamples.map(function (entry) { return entry.rtt; }))
      : Infinity;
    clockSamples.push(sample);
    if (clockSamples.length > 12) clockSamples.shift();
    var sorted = clockSamples.slice().sort(function (left, right) { return left.rtt - right.rtt; });
    var fastest = sorted.slice(0, clockSamples.length >= 3 ? 3 : 1);
    var offsets = fastest.map(function (entry) { return entry.offset; }).sort(function (left, right) { return left - right; });
    var middle = Math.floor(offsets.length / 2);
    var selectedOffset = offsets.length % 2
      ? offsets[middle]
      : (offsets[middle - 1] + offsets[middle]) / 2;
    var meanOffset = offsets.reduce(function (total, value) { return total + value; }, 0) / offsets.length;
    var jitter = Math.sqrt(offsets.reduce(function (total, value) {
      return total + Math.pow(value - meanOffset, 2);
    }, 0) / offsets.length);
    var qualityImproved = sample.rtt + 1 < previousBestRtt * 0.8;
    if (!bridge.sync.clockReady || qualityImproved) serverOffset = selectedOffset;
    else serverOffset = serverOffset * 0.72 + selectedOffset * 0.28;
    bridge.sync.latency = bridge.sync.clockReady
      ? bridge.sync.latency * 0.68 + sample.latency * 0.32
      : sample.latency;
    bridge.sync.jitter = jitter;
    bridge.sync.clockReady = true;
    updateRoomSyncUi();
  }

  function providerForSong(song) {
    if (!song) return "";
    if (typeof window.songProviderKey === "function") {
      try { return window.songProviderKey(song); } catch {}
    }
    var value = String(song.provider || song.source || song.type || "netease").toLowerCase();
    return value === "kugou" ? "kugou" : (value === "netease" ? "netease" : "");
  }

  function localRoomDescriptor(song) {
    var value = song && song.roomTrackDescriptor;
    var id = String(value && value.id || "").toLowerCase();
    if (!/^[a-f0-9]{24}$/.test(id)) return null;
    if (String(value.path || "") !== "/api/tracks/" + id) return null;
    return {
      id: id,
      name: String(value.name || song.name || "Mineradio").slice(0, 160),
      type: /^audio\/[a-z0-9.+-]+$/i.test(String(value.type || "")) ? String(value.type) : "audio/mpeg",
      size: Math.max(0, Number(value.size) || 0),
      path: "/api/tracks/" + id
    };
  }

  function audioMimeForFile(file) {
    var declared = String(file && file.type || "").toLowerCase();
    if (/^audio\/[a-z0-9.+-]+$/.test(declared)) return declared;
    var name = String(file && file.name || "").toLowerCase();
    if (/\.flac$/.test(name)) return "audio/flac";
    if (/\.m4a$/.test(name)) return "audio/mp4";
    if (/\.ogg$/.test(name)) return "audio/ogg";
    if (/\.wav$/.test(name)) return "audio/wav";
    return "audio/mpeg";
  }

  function currentSongForBridge() {
    if (window.playQueue && window.currentIdx >= 0 && window.playQueue[window.currentIdx]) {
      return window.playQueue[window.currentIdx];
    }
    return window.currentLocalSong || null;
  }

  function descriptorForSong(song) {
    if (song && (song.type === "local" || song.source === "local")) {
      return localRoomDescriptor(song);
    }
    var provider = providerForSong(song);
    var sourceId = String(song && (song.playKey || song.id) || "").trim();
    var quality = String(window.playbackQuality || "hires").toLowerCase();
    if (!QUALITY_RE.test(quality)) quality = "hires";
    if (provider === "kugou") {
      sourceId = sourceId.toLowerCase();
      if (!/^[a-f0-9]{24}$/.test(sourceId)) return null;
    } else if (provider === "netease") {
      if (!/^[1-9]\d{0,19}$/.test(sourceId)) return null;
    } else {
      return null;
    }
    var id = "cloud-v2-" + provider + "-" + sourceId + "-" + quality;
    return {
      id: id,
      name: String(song.name || song.title || "Mineradio").slice(0, 160),
      type: "audio/mpeg",
      size: 0,
      path: "/api/cloud/v2/" + provider + "/" + sourceId + "/" + quality,
      provider: provider,
      quality: quality
    };
  }

  function parseRoomTrack(track) {
    var rawId = String(track && track.id || "");
    var match = /^cloud-v2-(netease|kugou)-([A-Za-z0-9]+)-(jymaster|hires|lossless|exhigh|standard)$/.exec(rawId);
    if (!match) {
      if (!/^[a-f0-9]{24}$/.test(rawId) || String(track && track.path || "") !== "/api/tracks/" + rawId) return null;
      var localUrl = new URL("/api/tracks/" + rawId, relayHttpOrigin + "/").toString();
      var localDescriptor = {
        id: rawId,
        name: String(track.name || "Mineradio").slice(0, 160),
        type: /^audio\/[a-z0-9.+-]+$/i.test(String(track.type || "")) ? String(track.type) : "audio/mpeg",
        size: Math.max(0, Number(track.size) || 0),
        path: "/api/tracks/" + rawId
      };
      return {
        provider: "local",
        sourceId: rawId,
        quality: "standard",
        song: {
          provider: "local",
          source: "local",
          type: "local",
          id: rawId,
          localKey: "room:" + rawId,
          localUrl: localUrl,
          roomTrackDescriptor: localDescriptor,
          name: localDescriptor.name,
          artist: "局域网文件",
          album: "",
          cover: ""
        }
      };
    }
    var provider = match[1];
    var sourceId = match[2];
    if (provider === "kugou" && !/^[a-f0-9]{24}$/.test(sourceId)) return null;
    if (provider === "netease" && !/^[1-9]\d{0,19}$/.test(sourceId)) return null;
    return {
      provider: provider,
      sourceId: sourceId,
      quality: match[3],
      song: {
        provider: provider,
        source: provider,
        type: "song",
        id: sourceId,
        playKey: provider === "kugou" ? sourceId : undefined,
        name: String(track.name || "Mineradio"),
        artist: "",
        album: "",
        cover: ""
      }
    };
  }

  function currentDescriptorId() {
    var song = currentSongForBridge();
    var descriptor = descriptorForSong(song);
    return descriptor ? descriptor.id : "";
  }

  function targetPosition(state) {
    var position = Math.max(0, Number(state.position) || 0);
    if (!state.playing) return position;
    return position + Math.max(0, (Date.now() + serverOffset - (Number(state.updatedAt) || Date.now())) / 1000);
  }

  function classicPlaybackCorrection(target, current, playing, forceSeek) {
    var drift = Number(target) - Number(current);
    if (!Number.isFinite(drift)) return { mode: "hold", rate: 1, drift: 0 };
    var jitterSeconds = Math.max(0, Math.min(0.05, (Number(bridge.sync.jitter) || 0) / 1000));
    var hardThreshold = 0.3 + jitterSeconds;
    var softThreshold = 0.05 + jitterSeconds * 0.5;
    var absoluteDrift = Math.abs(drift);
    if (forceSeek || (!playing && absoluteDrift > softThreshold) || absoluteDrift > hardThreshold) {
      return { mode: "seek", rate: 1, drift: drift };
    }
    if (!playing || absoluteDrift <= softThreshold) return { mode: "hold", rate: 1, drift: drift };
    return {
      mode: "rate",
      rate: Math.max(0.96, Math.min(1.04, 1 + drift * 0.3)),
      drift: drift
    };
  }

  function setMediaPlaybackRate(media, rate) {
    if (!media) return;
    var next = Math.max(0.96, Math.min(1.04, Number(rate) || 1));
    try {
      if ("preservesPitch" in media) media.preservesPitch = true;
      if (Math.abs((Number(media.playbackRate) || 1) - next) > 0.001) media.playbackRate = next;
    } catch {}
  }

  function pauseForRoomSync(media) {
    if (!media || media.paused) return;
    suppressNextPauseCommand = true;
    try { media.pause(); } catch { suppressNextPauseCommand = false; }
    window.setTimeout(function () { suppressNextPauseCommand = false; }, 1000);
  }

  function resetRoomMediaUnlockFor(media) {
    if (roomMediaUnlockMedia === media) return;
    roomMediaUnlockMedia = media;
    roomMediaUnlockPromise = null;
    roomMediaUnlocked = false;
    roomMediaPrimeActive = null;
    roomMediaUnlockNoticeShown = false;
  }

  function primeRoomMediaForSync(media, fromUserGesture) {
    if (!media || !media.src) return Promise.resolve(false);
    resetRoomMediaUnlockFor(media);
    if (roomMediaUnlocked || !media.paused) {
      roomMediaUnlocked = true;
      return Promise.resolve(true);
    }
    if (roomMediaUnlockPromise) return roomMediaUnlockPromise;
    // A muted autoplay probe can succeed without granting permission for the
    // later audible scheduled start. Only treat a play attempt made from the
    // device user's gesture as a real unlock.
    if (!fromUserGesture) {
      if (!roomMediaUnlockNoticeShown) {
        notify("请在此设备点击播放键，完成同步播放授权");
        roomMediaUnlockNoticeShown = true;
      }
      return Promise.resolve(false);
    }

    var wasMuted = Boolean(media.muted);
    roomMediaPrimeActive = media;
    try { media.muted = true; } catch {}

    var playResult;
    try {
      playResult = media.play();
    } catch {
      playResult = Promise.reject(new Error("room_media_unlock_failed"));
    }

    var operation = Promise.resolve(playResult).then(function () {
      roomMediaUnlocked = true;
      roomMediaUnlockNoticeShown = false;
      try {
        if (!media.paused) media.pause();
      } catch {}
      return true;
    }, function () {
      roomMediaUnlocked = false;
      if (!roomMediaUnlockNoticeShown) {
        notify(fromUserGesture
          ? "此设备仍无法启用声音，请检查浏览器媒体权限"
          : "请在此设备点击播放键，完成同步播放授权");
        roomMediaUnlockNoticeShown = true;
      }
      return false;
    }).then(function (unlocked) {
      try { media.muted = wasMuted; } catch {}
      if (roomMediaPrimeActive === media) roomMediaPrimeActive = null;
      if (roomMediaUnlockPromise === operation) roomMediaUnlockPromise = null;
      return unlocked;
    });
    roomMediaUnlockPromise = operation;
    return operation;
  }

  function seekForRoomSync(media, target) {
    if (!media || !Number.isFinite(Number(target))) return false;
    suppressNextSeekCommand = true;
    window.clearTimeout(suppressSeekResetTimer);
    try {
      media.currentTime = Math.max(0, Number(target) || 0);
    } catch {
      suppressNextSeekCommand = false;
      return false;
    }
    suppressSeekResetTimer = window.setTimeout(function () {
      suppressNextSeekCommand = false;
      suppressSeekResetTimer = 0;
    }, 2000);
    return true;
  }

  function playForRoomSync(media, prepareId) {
    if (!media || !media.paused) return;
    var scheduledPrepareId = String(prepareId || "");
    suppressNextPlayCommand = true;
    var result;
    try { result = media.play(); } catch {
      suppressNextPlayCommand = false;
      if (scheduledPrepareId) sendCommand("start-failed", scheduledPrepareId);
      return;
    }
    window.setTimeout(function () { suppressNextPlayCommand = false; }, 1000);
    if (result && typeof result.then === "function") {
      result.then(function () {
        playUnlockNoticeShown = false;
        window.playing = true;
        if (typeof window.setPlayIcon === "function") window.setPlayIcon(true);
        if (typeof window.beginListenSession === "function") {
          try { window.beginListenSession(currentSongForBridge(), null); } catch {}
        }
      }).catch(function () {
        suppressNextPlayCommand = false;
        if (scheduledPrepareId) sendCommand("start-failed", scheduledPrepareId);
        if (!playUnlockNoticeShown) notify("点击播放键以允许此设备加入同步播放");
        playUnlockNoticeShown = true;
      });
    }
  }

  function alignScheduledRoomPlayback(media, state) {
    if (!media || !state) return;
    var liveTarget = targetPosition(state);
    var duration = Number(media.duration) || 0;
    if (duration > 0) liveTarget = Math.min(liveTarget, Math.max(0, duration - 0.05));
    if (!Number.isFinite(liveTarget) || media.readyState < 1) return;
    if (Math.abs((Number(media.currentTime) || 0) - liveTarget) > 0.05) {
      seekForRoomSync(media, liveTarget);
    }
  }

  function cancelScheduledRoomPlayback() {
    window.clearTimeout(scheduledPlayTimer);
    scheduledPlayTimer = 0;
    scheduledPlayGeneration += 1;
  }

  function scheduledRoomPlaybackGuard(state) {
    return {
      timerGeneration: scheduledPlayGeneration,
      connectionGeneration: roomConnectionGeneration,
      revision: Number(state && state.revision) || 0,
      trackId: String(state && state.track && state.track.id || ""),
      prepareId: String(state && state.prepareId || ""),
      scheduledAt: Number(state && state.scheduledAt) || 0
    };
  }

  function launchScheduledRoomPlayback(media, guard) {
    if (!guard || guard.timerGeneration !== scheduledPlayGeneration) return;
    if (guard.connectionGeneration !== roomConnectionGeneration) return;
    scheduledPlayTimer = 0;
    var activeState = lastRoomState;
    if (!media
      || media !== window.audio
      || !activeState
      || !activeState.playing
      || activeState.preparing) return;
    if (Number(activeState.revision) !== guard.revision
      || String(activeState.track && activeState.track.id || "") !== guard.trackId
      || currentDescriptorId() !== guard.trackId
      || String(activeState.prepareId || "") !== guard.prepareId
      || Number(activeState.scheduledAt || 0) !== guard.scheduledAt) return;
    var remaining = Number(activeState.scheduledAt) > 0
      ? Number(activeState.scheduledAt) - (Date.now() + serverOffset)
      : 0;
    if (remaining > 20) {
      scheduledPlayTimer = window.setTimeout(function () {
        launchScheduledRoomPlayback(media, guard);
      }, remaining);
      return;
    }
    alignScheduledRoomPlayback(media, activeState);
    playForRoomSync(media, guard.prepareId);
  }

  function hasBufferedPlaybackWindow(media, target) {
    if (!media || !media.buffered) return false;
    var duration = Number(media.duration);
    var requiredEnd = Number.isFinite(duration) ? Math.min(duration, target + 1.2) : target + 1.2;
    for (var index = 0; index < media.buffered.length; index += 1) {
      if (media.buffered.start(index) <= target + 0.08 && media.buffered.end(index) >= requiredEnd - 0.05) return true;
    }
    return false;
  }

  function seekWhenReady(media, seconds, force) {
    if (!media) return;
    if (pendingSeekMedia && pendingSeekHandler) {
      pendingSeekMedia.removeEventListener("loadedmetadata", pendingSeekHandler);
      pendingSeekMedia.removeEventListener("canplay", pendingSeekHandler);
      pendingSeekMedia = null;
      pendingSeekHandler = null;
    }
    var apply = function () {
      if (media !== window.audio) return;
      if (!isFinite(seconds)) return;
      var duration = Number(media.duration) || 0;
      var target = duration > 0 ? Math.min(seconds, Math.max(0, duration - 0.25)) : seconds;
      if (force || Math.abs((Number(media.currentTime) || 0) - target) > 0.3) {
        seekForRoomSync(media, target);
      }
    };
    if (media.readyState >= 1) {
      apply();
      return;
    }
    pendingSeekMedia = media;
    pendingSeekHandler = function () {
      if (pendingSeekMedia) {
        pendingSeekMedia.removeEventListener("loadedmetadata", pendingSeekHandler);
        pendingSeekMedia.removeEventListener("canplay", pendingSeekHandler);
      }
      pendingSeekMedia = null;
      pendingSeekHandler = null;
      apply();
    };
    media.addEventListener("loadedmetadata", pendingSeekHandler);
    media.addEventListener("canplay", pendingSeekHandler);
  }

  function reconcileRoomPlayback(state, forceSeek) {
    var media = window.audio;
    if (!media || !state || !state.track) return;
    var target = targetPosition(state);
    var duration = Number(media.duration) || 0;
    if (duration > 0) target = Math.min(target, Math.max(0, duration - 0.05));
    if (!Number.isFinite(target)) return;
    var correction = { mode: "hold", rate: 1, drift: target - (Number(media.currentTime) || 0) };
    var scheduledInFuture = Boolean(state.playing)
      && Number(state.scheduledAt) > Date.now() + serverOffset;
    var leaderNeedsAlignment = bridge.sync.leader
      && (state.preparing || !state.playing || scheduledInFuture);
    if (media.readyState < 1) {
      setMediaPlaybackRate(media, 1);
      seekWhenReady(media, target, true);
    } else if (!bridge.sync.leader || leaderNeedsAlignment) {
      var current = Number(media.currentTime) || 0;
      correction = classicPlaybackCorrection(
        target,
        current,
        Boolean(state.playing),
        forceSeek || (leaderNeedsAlignment && Math.abs(target - current) > 0.05)
      );
      bridge.sync.drift = Math.round(correction.drift * 1000);
      if (correction.mode === "seek" && !media.seeking) {
        seekForRoomSync(media, target);
      }
      setMediaPlaybackRate(media, correction.rate);
    } else {
      bridge.sync.drift = 0;
      setMediaPlaybackRate(media, 1);
    }

    if (state.preparing) {
      cancelScheduledRoomPlayback();
      try { media.preload = "auto"; } catch {}
      setMediaPlaybackRate(media, 1);
      pauseForRoomSync(media);
      var prepareId = String(state.prepareId || "");
      var aligned = Math.abs((Number(media.currentTime) || 0) - target) <= 0.08;
      if (prepareId
        && prepareId !== lastReadyPrepareId
        && media.readyState >= 3
        && aligned
        && correction.mode !== "seek"
        && hasBufferedPlaybackWindow(media, target)) {
        resetRoomMediaUnlockFor(media);
        if (roomMediaUnlocked) {
          if (sendCommand("ready", prepareId)) lastReadyPrepareId = prepareId;
        } else {
          primeRoomMediaForSync(media, false).then(function (unlocked) {
            if (!unlocked
              || media !== window.audio
              || !lastRoomState
              || !lastRoomState.preparing
              || String(lastRoomState.prepareId || "") !== prepareId) return;
            applyingRoomState = true;
            try { reconcileRoomPlayback(lastRoomState, false); } finally { applyingRoomState = false; }
          });
        }
      }
      return;
    }

    if (state.playing) {
      var startDelay = Number(state.scheduledAt) > 0
        ? Number(state.scheduledAt) - (Date.now() + serverOffset)
        : 0;
      cancelScheduledRoomPlayback();
      var playbackGuard = scheduledRoomPlaybackGuard(state);
      if (startDelay > 20) {
        pauseForRoomSync(media);
        scheduledPlayTimer = window.setTimeout(function () {
          launchScheduledRoomPlayback(media, playbackGuard);
        }, startDelay);
      } else {
        launchScheduledRoomPlayback(media, playbackGuard);
      }
    } else {
      cancelScheduledRoomPlayback();
      setMediaPlaybackRate(media, 1);
      pauseForRoomSync(media);
    }
  }

  async function applyRoomState(state, generation) {
    if (generation !== roomConnectionGeneration) return;
    if (!state) return;
    bridge.sync.deviceCount = Math.max(0, Number(state.deviceCount) || 0);
    bridge.sync.preparing = Boolean(state.preparing);
    bridge.sync.readyCount = Math.max(0, Number(state.readyCount) || 0);
    bridge.sync.requiredCount = Math.max(0, Number(state.requiredCount) || 0);
    bridge.sync.prepareError = String(state.prepareError || "");
    updateRoomSyncUi();
    if (!bridge.sync.clockReady && Number(state.serverTime)) {
      var bootstrapOffset = Number(state.serverTime) - Date.now();
      serverOffset = serverOffset ? serverOffset * 0.8 + bootstrapOffset * 0.2 : bootstrapOffset;
    }
    var revision = Number(state.revision) || 0;
    if (revision < lastRevision) return;
    var sameRevision = revision === lastRevision;
    lastRoomState = state;
    var wasLeader = bridge.sync.leader;
    bridge.sync.leader = String(state.leaderId || "") === clientId;
    updateRoomSyncUi();
    if (bridge.sync.leader && !wasLeader && window.audio) setMediaPlaybackRate(window.audio, 1);
    if (sameRevision) {
      if (state.track
        && currentDescriptorId() === String(state.track.id)
        && (!bridge.sync.leader || state.preparing || Number(state.scheduledAt) > Date.now() + serverOffset)) {
        applyingRoomState = true;
        try { reconcileRoomPlayback(state, false); } finally { applyingRoomState = false; }
      }
      return;
    }
    lastRevision = revision;
    var leaderNeedsBarrierState = state.preparing
      || Number(state.scheduledAt) > Date.now() + serverOffset
      || Boolean(state.prepareError);
    if (bridge.sync.leader && wasLeader && !leaderNeedsBarrierState && state.playing) {
      if (window.audio) setMediaPlaybackRate(window.audio, 1);
      return;
    }

    applyingRoomState = true;
    try {
      if (typeof window.setVolume === "function") {
        window.setVolume(Math.max(0, Math.min(1, Number(state.volume) || 0)), true);
      }
      if (!state.track) {
        cancelScheduledRoomPlayback();
        if (window.audio) setMediaPlaybackRate(window.audio, 1);
        if (window.audio && !window.audio.paused) window.audio.pause();
        return;
      }
      var parsed = parseRoomTrack(state.track);
      if (!parsed || typeof window.playQueueAt !== "function") return;
      var trackChanged = currentDescriptorId() !== String(state.track.id);
      if (trackChanged) {
        cancelScheduledRoomPlayback();
        leaderBuffering = false;
        if (window.audio) setMediaPlaybackRate(window.audio, 1);
        window.playbackQuality = parsed.quality;
        window.playQueue = [parsed.song];
        window.currentIdx = 0;
        await window.playQueueAt(0, { preserveHomeState: true, roomSync: true, deferPlayback: true });
        if (generation !== roomConnectionGeneration) return;
      }
      attachAudioEvents();
      var media = window.audio;
      if (!media) return;
      reconcileRoomPlayback(state, trackChanged);
    } finally {
      applyingRoomState = false;
    }
  }

  function enqueueRoomState(state, generation) {
    roomStateChain = roomStateChain.then(function () {
      if (generation !== roomConnectionGeneration) return;
      return applyRoomState(state, generation);
    }).catch(function (error) {
      applyingRoomState = false;
      console.warn("[MineradioRoomSync] state apply failed", error && error.message ? error.message : "unknown");
    });
    return roomStateChain;
  }

  function announceCurrentTrack(forceResume) {
    cancelScheduledRoomPlayback();
    var song = currentSongForBridge();
    var descriptor = descriptorForSong(song);
    var shouldResume = forceResume === true || Boolean(window.audio && !window.audio.paused && !window.audio.ended);
    if (shouldResume) pauseForRoomSync(window.audio);
    if (!descriptor || !sendCommand("track", descriptor)) return;
    window.setTimeout(function () {
      if (!window.audio) return;
      sendCommand("seek", Number(window.audio.currentTime) || 0);
      sendCommand(shouldResume ? "play" : "pause");
    }, 80);
  }

  function attachAudioEvents() {
    var media = window.audio;
    if (!media || media === attachedAudio) return;
    attachedAudio = media;
    media.addEventListener("play", function () {
      if (roomMediaPrimeActive === media) return;
      if (suppressNextPlayCommand) {
        suppressNextPlayCommand = false;
        return;
      }
      if (!applyingRoomState) {
        if (leaderBuffering && bridge.sync.leader) {
          leaderBuffering = false;
        }
        sendCommand("progress", Number(media.currentTime) || 0);
        sendCommand("play");
      }
    });
    media.addEventListener("pause", function () {
      if (roomMediaPrimeActive === media) return;
      if (suppressNextPauseCommand) {
        suppressNextPauseCommand = false;
        return;
      }
      if (!applyingRoomState && !media.ended) {
        sendCommand("progress", Number(media.currentTime) || 0);
        sendCommand("pause");
      }
    });
    media.addEventListener("seeked", function () {
      if (suppressNextSeekCommand) {
        suppressNextSeekCommand = false;
        window.clearTimeout(suppressSeekResetTimer);
        suppressSeekResetTimer = 0;
        if (lastRoomState && lastRoomState.preparing) {
          applyingRoomState = true;
          try { reconcileRoomPlayback(lastRoomState, false); } finally { applyingRoomState = false; }
        }
        return;
      }
      if (!applyingRoomState) sendSeekCommand(media.currentTime, false);
    });
    media.addEventListener("timeupdate", function () {
      if (roomMediaPrimeActive === media || applyingRoomState || Date.now() - lastPositionSentAt < 1000) return;
      lastPositionSentAt = Date.now();
      sendCommand("progress", media.currentTime);
    });
    var onLeaderWaiting = function () {
      if (roomMediaPrimeActive === media) return;
      if (lastRoomState && lastRoomState.prepareId
        && (lastRoomState.preparing || Number(lastRoomState.scheduledAt) > Date.now() + serverOffset)) {
        sendCommand("ready", { prepareId: lastRoomState.prepareId, ready: false });
        lastReadyPrepareId = "";
      }
      if (applyingRoomState || !bridge.sync.leader || leaderBuffering) return;
      leaderBuffering = true;
      var stalledAt = Number(media.currentTime) || 0;
      pauseForRoomSync(media);
      sendCommand("progress", stalledAt);
      sendCommand("pause");
    };
    media.addEventListener("waiting", onLeaderWaiting);
    media.addEventListener("stalled", onLeaderWaiting);
    media.addEventListener("canplay", function () {
      if (lastRoomState && lastRoomState.preparing) {
        applyingRoomState = true;
        try { reconcileRoomPlayback(lastRoomState, false); } finally { applyingRoomState = false; }
        return;
      }
      if (bridge.sync.leader && leaderBuffering) {
        leaderBuffering = false;
        sendCommand("progress", Number(media.currentTime) || 0);
        sendCommand("play");
        return;
      }
      if (!bridge.sync.leader && lastRoomState) {
        applyingRoomState = true;
        try { reconcileRoomPlayback(lastRoomState, false); } finally { applyingRoomState = false; }
      }
    });
    media.addEventListener("progress", function () {
      if (!lastRoomState || !lastRoomState.preparing) return;
      applyingRoomState = true;
      try { reconcileRoomPlayback(lastRoomState, false); } finally { applyingRoomState = false; }
    });
    media.addEventListener("error", function () {
      if (!lastRoomState || !lastRoomState.prepareId) return;
      sendCommand("ready", { prepareId: lastRoomState.prepareId, ready: false });
      lastReadyPrepareId = "";
    });
  }

  function blockFollowerControl() {
    if (!joinedRoom || bridge.sync.leader || applyingRoomState) return false;
    notify("当前设备正在跟随局域网主控播放");
    return true;
  }

  function canResumeFollowerFromGesture() {
    if (!joinedRoom || bridge.sync.leader || applyingRoomState || !window.audio) return false;
    return Boolean(window.audio.src);
  }

  function audioFileFromList(files) {
    var selected = null;
    for (var index = 0; index < (files ? files.length : 0); index += 1) {
      var file = files[index];
      if (file && (/^audio\//i.test(String(file.type || "")) || /\.(mp3|flac|wav|ogg|m4a)$/i.test(String(file.name || "")))) {
        selected = file;
      }
    }
    return selected;
  }

  function localFileKey(file) {
    return [file.name, file.size || 0, file.lastModified || 0].join(":");
  }

  async function uploadLocalFileToRoom(file) {
    if (!file || !joinedRoom || !bridge.sync.leader) {
      pendingLocalFile = file || pendingLocalFile;
      return;
    }
    var uploadSerial = ++localUploadSerial;
    var expectedKey = localFileKey(file);
    pendingLocalFile = null;
    try {
      var endpoint = new URL("/api/tracks", relayHttpOrigin + "/");
      endpoint.searchParams.set("name", String(file.name || "Mineradio").replace(/\.[^.]+$/, ""));
      endpoint.searchParams.set("type", audioMimeForFile(file));
      var response = await nativeFetch(endpoint.toString(), { method: "POST", body: file });
      var uploaded = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(String(uploaded.error || "upload_failed"));
      var descriptor = localRoomDescriptor({
        type: "local",
        name: uploaded.name,
        roomTrackDescriptor: uploaded
      });
      if (!descriptor) throw new Error("invalid_track_descriptor");
      if (uploadSerial !== localUploadSerial || !window.currentLocalSong || window.currentLocalSong.localKey !== expectedKey) return;
      window.currentLocalSong.source = "local";
      window.currentLocalSong.roomTrackDescriptor = descriptor;
      announceCurrentTrack(true);
    } catch {
      if (uploadSerial === localUploadSerial) notify("本地歌曲发送到局域网失败，请重试");
    }
  }

  function scheduleLocalFileUpload(file) {
    if (!file) return;
    pendingLocalFile = file;
    window.setTimeout(function () { uploadLocalFileToRoom(file); }, 0);
  }

  function installLocalFileSync() {
    document.addEventListener("change", function (event) {
      var target = event.target;
      if (!target || target.id !== "file-input") return;
      var file = audioFileFromList(target.files);
      if (!file) return;
      if (joinedRoom && !bridge.sync.leader) {
        event.preventDefault();
        event.stopImmediatePropagation();
        target.value = "";
        notify("当前设备正在跟随局域网主控播放");
        return;
      }
      scheduleLocalFileUpload(file);
    }, true);
    document.addEventListener("drop", function (event) {
      var file = audioFileFromList(event.dataTransfer && event.dataTransfer.files);
      if (!file) return;
      if (joinedRoom && !bridge.sync.leader) {
        event.preventDefault();
        event.stopImmediatePropagation();
        notify("当前设备正在跟随局域网主控播放");
        return;
      }
      scheduleLocalFileUpload(file);
    }, true);
  }

  function installFollowerControlGuards() {
    function isGuardedTarget(target) {
      if (!target || typeof target.closest !== "function") return false;
      return Boolean(target.closest("#progress-bar, #volume-slider"));
    }
    function isProgressTarget(target) {
      if (!target || typeof target.closest !== "function") return false;
      return Boolean(target.closest("#progress-bar"));
    }
    function guard(event) {
      if (!joinedRoom || bridge.sync.leader || applyingRoomState || !isGuardedTarget(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === "pointerdown" || event.type === "keydown") {
        notify("当前设备正在跟随局域网主控播放");
      }
    }
    document.addEventListener("pointerdown", guard, true);
    document.addEventListener("input", guard, true);
    document.addEventListener("change", guard, true);
    document.addEventListener("keydown", guard, true);
    function flushLeaderSeek(event) {
      if (!joinedRoom || !bridge.sync.leader || applyingRoomState || !isProgressTarget(event.target)) return;
      if (!window.audio) return;
      suppressNextSeekCommand = false;
      window.clearTimeout(suppressSeekResetTimer);
      suppressSeekResetTimer = 0;
      sendSeekCommand(window.audio.currentTime, true);
    }
    document.addEventListener("pointerup", flushLeaderSeek, true);
    document.addEventListener("pointercancel", flushLeaderSeek, true);
  }

  function disableUnavailableQQWebUi() {
    [
      "search-mode-qq",
      "login-provider-qq",
      "qq-web-login-card",
      "login-both-btn",
      "qq-cookie-toggle-btn",
      "qq-cookie-panel",
      "user-provider-qq",
      "account-add-qq"
    ].forEach(function (id) {
      var element = document.getElementById(id);
      if (!element) return;
      element.hidden = true;
      element.setAttribute("aria-hidden", "true");
      element.style.setProperty("display", "none", "important");
      if ("disabled" in element) element.disabled = true;
    });
    if (window.searchMode === "qq" && typeof window.setSearchMode === "function") {
      window.setSearchMode("netease");
    }
  }

  function installFunctionWrappers() {
    if (wrappersInstalled || typeof window.playQueueAt !== "function" || typeof window.setVolume !== "function") return false;
    wrappersInstalled = true;
    var originalPlayQueueAt = window.playQueueAt;
    window.playQueueAt = async function classicRoomPlayQueueAt() {
      if (blockFollowerControl()) return;
      cancelScheduledRoomPlayback();
      leaderBuffering = false;
      if (window.audio) setMediaPlaybackRate(window.audio, 1);
      var args = Array.prototype.slice.call(arguments);
      var deferLeaderStart = !applyingRoomState && joinedRoom && bridge.sync.leader;
      if (deferLeaderStart) args[1] = Object.assign({}, args[1] || {}, { deferPlayback: true });
      var result = await originalPlayQueueAt.apply(this, args);
      attachAudioEvents();
      if (!applyingRoomState && bridge.sync.leader) announceCurrentTrack(deferLeaderStart);
      return result;
    };

    var originalSetVolume = window.setVolume;
    window.setVolume = function classicRoomSetVolume() {
      if (blockFollowerControl()) return;
      var result = originalSetVolume.apply(this, arguments);
      if (!applyingRoomState) sendVolumeCommand(Number(window.targetVolume), false);
      return result;
    };

    ["togglePlay", "nextTrack", "prevTrack", "shuffleQueue", "clearQueue"].forEach(function (name) {
      var original = window[name];
      if (typeof original !== "function") return;
      window[name] = function classicRoomGuardedControl() {
        if (name === "togglePlay" && canResumeFollowerFromGesture()) {
          return primeRoomMediaForSync(window.audio, true).then(function (unlocked) {
            if (!unlocked) return false;
            if (lastRoomState) {
              applyingRoomState = true;
              try { reconcileRoomPlayback(lastRoomState, false); } finally { applyingRoomState = false; }
            }
            notify("此设备声音已启用，将按房间统一时刻播放");
            return true;
          });
        }
        if (blockFollowerControl()) return;
        if (name === "togglePlay" && joinedRoom && bridge.sync.leader && window.audio && window.audio.src) {
          resetRoomMediaUnlockFor(window.audio);
          if (lastRoomState
            && (lastRoomState.playing || lastRoomState.preparing)
            && !roomMediaUnlocked) {
            return primeRoomMediaForSync(window.audio, true).then(function (unlocked) {
              if (!unlocked || !lastRoomState) return false;
              applyingRoomState = true;
              try { reconcileRoomPlayback(lastRoomState, false); } finally { applyingRoomState = false; }
              notify("主控声音已启用，等待全部设备后统一起播");
              return true;
            });
          }
          if (lastRoomState && (lastRoomState.playing || lastRoomState.preparing)) {
            sendCommand("progress", Number(window.audio.currentTime) || 0);
            sendCommand("pause");
            return Promise.resolve();
          }
          if (leaderStartRequestPending) return leaderStartRequestPending;
          var startRequest = primeRoomMediaForSync(window.audio, true).then(function (unlocked) {
            if (!unlocked) return false;
            sendCommand("progress", Number(window.audio.currentTime) || 0);
            return sendCommand("play");
          });
          leaderStartRequestPending = startRequest.then(function (result) {
            leaderStartRequestPending = null;
            return result;
          }, function () {
            leaderStartRequestPending = null;
            return false;
          });
          return leaderStartRequestPending;
        }
        return original.apply(this, arguments);
      };
    });
    return true;
  }

  function connectRoom() {
    if (document.visibilityState === "prerender") {
      document.addEventListener("visibilitychange", function resumePrerenderedRoom() {
        if (document.visibilityState === "prerender") return;
        document.removeEventListener("visibilitychange", resumePrerenderedRoom);
        connectRoom();
      });
      updateRoomSyncUi();
      return;
    }
    if (!window.WebSocket) {
      bridge.sync.error = true;
      updateRoomSyncUi();
      return;
    }
    var generation = ++roomConnectionGeneration;
    try {
      socket = new WebSocket(relayUrl);
    } catch {
      bridge.sync.connected = false;
      bridge.sync.error = true;
      updateRoomSyncUi();
      reconnectAttempt += 1;
      window.clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(connectRoom, Math.min(8000, 500 * Math.pow(2, Math.min(reconnectAttempt, 4))));
      return;
    }
    socket.addEventListener("open", function () {
      if (generation !== roomConnectionGeneration) return;
      reconnectAttempt = 0;
      bridge.sync.connected = true;
      bridge.sync.error = false;
      updateRoomSyncUi();
      window.clearInterval(clockPingTimer);
      sendClockPing();
      socket.send(JSON.stringify({
        type: "join",
        room: roomCode,
        name: "Classic " + String(navigator.platform || "Web").slice(0, 20)
      }));
      clockPingTimer = window.setInterval(sendClockPing, 2500);
    });
    socket.addEventListener("message", function (event) {
      if (generation !== roomConnectionGeneration) return;
      var message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.type === "welcome") {
        clientId = String(message.clientId || "");
        bridge.sync.addresses = Array.isArray(message.addresses) ? message.addresses.map(String) : [];
        if (!bridge.sync.clockReady && Number(message.serverTime)) serverOffset = Number(message.serverTime) - Date.now();
        updateRoomSyncUi();
        return;
      }
      if (message.type === "pong") {
        recordClockPong(message, Date.now());
        if (lastRoomState && !bridge.sync.leader) enqueueRoomState(lastRoomState, generation);
        return;
      }
      if (message.type === "joined") {
        joinedRoom = true;
        bridge.sync.leader = Boolean(message.leader);
        if (message.state) bridge.sync.deviceCount = Math.max(0, Number(message.state.deviceCount) || 0);
        updateRoomSyncUi();
        if (message.state) enqueueRoomState(message.state, generation);
        if (bridge.sync.leader) {
          var initialVolume = Number(window.targetVolume);
          if (!Number.isFinite(initialVolume)) initialVolume = window.audio ? Number(window.audio.volume) : 0.72;
          sendCommand("volume", Math.max(0, Math.min(1, initialVolume)));
          if (pendingLocalFile) uploadLocalFileToRoom(pendingLocalFile);
          window.setTimeout(announceCurrentTrack, 160);
        }
        return;
      }
      if (message.type === "state" && message.state) enqueueRoomState(message.state, generation);
    });
    socket.addEventListener("error", function () {
      if (generation !== roomConnectionGeneration) return;
      bridge.sync.error = true;
      updateRoomSyncUi();
    });
    socket.addEventListener("close", function () {
      if (generation !== roomConnectionGeneration) return;
      roomConnectionGeneration += 1;
      bridge.sync.connected = false;
      bridge.sync.leader = false;
      bridge.sync.deviceCount = 0;
      bridge.sync.error = true;
      bridge.sync.latency = 0;
      bridge.sync.jitter = 0;
      bridge.sync.drift = 0;
      bridge.sync.clockReady = false;
      bridge.sync.preparing = false;
      bridge.sync.readyCount = 0;
      bridge.sync.requiredCount = 0;
      bridge.sync.prepareError = "";
      joinedRoom = false;
      leaderBuffering = false;
      lastReadyPrepareId = "";
      suppressNextPlayCommand = false;
      suppressNextPauseCommand = false;
      suppressNextSeekCommand = false;
      window.clearTimeout(suppressSeekResetTimer);
      suppressSeekResetTimer = 0;
      lastRevision = -1;
      lastRoomState = null;
      serverOffset = 0;
      clockSamples = [];
      window.clearInterval(clockPingTimer);
      clockPingTimer = 0;
      cancelScheduledRoomPlayback();
      if (window.audio) setMediaPlaybackRate(window.audio, 1);
      if (pendingSeekMedia && pendingSeekHandler) {
        pendingSeekMedia.removeEventListener("loadedmetadata", pendingSeekHandler);
        pendingSeekMedia.removeEventListener("canplay", pendingSeekHandler);
      }
      pendingSeekMedia = null;
      pendingSeekHandler = null;
      window.clearTimeout(volumeSyncTimer);
      volumeSyncTimer = 0;
      pendingVolume = null;
      window.clearTimeout(seekSyncTimer);
      seekSyncTimer = 0;
      pendingSeek = null;
      lastSeekSentAt = 0;
      leaderStartRequestPending = null;
      updateRoomSyncUi();
      reconnectAttempt += 1;
      window.clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(connectRoom, Math.min(8000, 500 * Math.pow(2, Math.min(reconnectAttempt, 4))));
    });
  }

  function startBridgeRuntime() {
    var attempts = 0;
    var installTimer = window.setInterval(function () {
      attempts += 1;
      if (installFunctionWrappers() || attempts > 80) window.clearInterval(installTimer);
      attachAudioEvents();
    }, 125);
    disableUnavailableQQWebUi();
    installLocalFileSync();
    installFollowerControlGuards();
    installRoomSyncUi();
    if (!roomUiInstalled) {
      var roomUiAttempts = 0;
      roomUiRetryTimer = window.setInterval(function () {
        roomUiAttempts += 1;
        installRoomSyncUi();
        if (roomUiInstalled || roomUiAttempts > 80) {
          window.clearInterval(roomUiRetryTimer);
          roomUiRetryTimer = 0;
        }
      }, 125);
    }
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState !== "visible") return;
      sendClockPing();
      if (lastRoomState && !bridge.sync.leader) enqueueRoomState(lastRoomState, roomConnectionGeneration);
    });
    window.addEventListener("online", sendClockPing);
    connectRoom();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startBridgeRuntime, { once: true });
  } else {
    startBridgeRuntime();
  }
})();
