(function installMineradioClassicWebBridge() {
  "use strict";

  var SETTINGS_KEY = "mineradio-lan-settings-v1";
  var DEVICE_CALIBRATION_KEY = "mineradio-room-device-calibration-v1";
  var ROOM_RE = /^[A-Z0-9]{4,8}$/;
  var QUALITY_RE = /^(jymaster|hires|lossless|exhigh|standard)$/;
  var ROOM_SYNC_PROTOCOL_VERSION = 3;
  var ROOM_SYNC_BUILD_ID = "20260801-sync-v6";
  var ROOM_SYNC_REFRESH_GUARD_KEY = "mineradio-room-sync-refresh-v3";
  var ROOM_SYNC_CAPABILITIES = Object.freeze({
    bufferContract: true,
    armedPlayback: true
  });
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
  var securePage = window.location.protocol === "https:";
  var apiFallback = securePage ? window.location.origin : "http://" + pageHost + ":8790";
  var relayFallback = securePage
    ? "wss://" + window.location.host + "/sync"
    : "ws://" + pageHost + ":8787/ws";
  function withoutMixedContent(value, fallback) {
    try {
      var url = new URL(String(value || fallback));
      if (securePage && (url.protocol === "http:" || url.protocol === "ws:")) {
        return fallback;
      }
      return url.toString();
    } catch {
      return fallback;
    }
  }
  var apiOrigin = safeServiceUrl(
    withoutMixedContent(settings.musicApiUrl, apiFallback),
    apiFallback,
    ["http:", "https:"]
  );
  var relayUrl = safeServiceUrl(
    withoutMixedContent(settings.relayUrl, relayFallback),
    relayFallback,
    ["ws:", "wss:"]
  );
  var relayHttpOrigin = (function () {
    try {
      var value = new URL(relayUrl);
      value.protocol = value.protocol === "wss:" ? "https:" : "http:";
      return value.origin;
    } catch {
      return securePage ? window.location.origin : "http://" + pageHost + ":8787";
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
    if (url.pathname === "/api/cover") {
      return fetchAt(new URL(url.pathname + url.search, apiOrigin + "/").toString(), input, init);
    }
    if (url.pathname === "/api/audio") {
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

  function safeArtworkUrl(value) {
    var raw = String(value || "").trim();
    if (!raw) return "";
    if (/^data:image\/(?:avif|gif|jpeg|png|webp);base64,/i.test(raw)) {
      return raw.length <= 4 * 1024 * 1024 ? raw : "";
    }
    if (raw.length > 2048) return "";
    try {
      var url = new URL(raw);
      if (url.protocol !== "https:" || url.username || url.password) return "";
      return url.toString();
    } catch {
      return "";
    }
  }

  function coverMediaUrl(value) {
    var raw = String(value || "").trim();
    if (/^blob:/i.test(raw)) return directMediaUrl(raw);
    if (/^data:image\/(?:avif|gif|jpeg|png|webp);base64,/i.test(raw)) return safeArtworkUrl(raw);
    var target = safeArtworkUrl(raw);
    if (!target) return "";
    var proxy = new URL("/api/cover", apiOrigin + "/");
    proxy.searchParams.set("url", target);
    return proxy.toString();
  }

  var bridge = {
    apiOrigin: apiOrigin,
    relayUrl: relayUrl,
    roomCode: roomCode,
    audioUrl: directMediaUrl,
    coverUrl: coverMediaUrl,
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
      protocolVersion: 1,
      strictSync: false,
      preparing: false,
      readyCount: 0,
      requiredCount: 0,
      armedCount: 0,
      strictRequiredCount: 0,
      commitState: "",
      prepareError: "",
      bufferProgress: 0,
      prepareDeadline: 0,
      prepareMaxDeadline: 0,
      devices: [],
      protocolError: "",
      services: {
        relay: { state: "checking", latency: 0, detail: "检测中" },
        music: { state: "checking", latency: 0, detail: "检测中" }
      }
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
  var lastArmedCommitKey = "";
  var strictRoomProtocol = false;
  var activeBufferLoadPrepareId = "";
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
  var lastDeviceStatusSentAt = 0;
  var pendingDeviceStatus = null;
  var deviceStatusTimer = 0;
  var deviceStatusPulseTimer = 0;
  var serviceHealthTimer = 0;
  var serviceHealthInFlight = false;
  var roomDeviceRenderSignature = "";
  var localCalibrationMinimumUpdatedAt = 0;
  var lastAppliedCalibrationSignature = "";
  var roomQrRenderedValue = "";
  var roomQrPendingValue = "";
  var roomQrRenderGeneration = 0;
  var roomQrObjectUrl = "";
  var mediaSessionInstalled = false;
  var lastMediaSessionPositionAt = 0;
  var trackAnnouncementTimer = 0;
  var joinAnnouncementTimer = 0;
  var trackAnnouncementSerial = 0;
  var pendingRoomJoinPlayback = null;

  bridge.shouldDeferRoomPlayback = function () {
    return (joinedRoom && bridge.sync.leader) || shouldHoldPlaybackForRoomJoin();
  };

  function roomPlaybackRequiresSharedAuthority() {
    var participants = Math.max(
      Number(bridge.sync.deviceCount) || 0,
      Number(bridge.sync.requiredCount) || 0
    );
    return bridge.sync.preparing === true || participants > 1;
  }

  function shouldHoldPlaybackForRoomJoin() {
    // The LAN launcher joins HOME immediately. Until the relay confirms the
    // role, load the track but do not let this browser begin alone; the joined
    // handler will promote the same intent through the ready/start barrier.
    return !applyingRoomState
      && !joinedRoom
      && !bridge.sync.error
      && typeof window.WebSocket === "function";
  }

  function beginPendingRoomJoinPlayback(index) {
    pendingRoomJoinPlayback = {
      index: Number.isFinite(Number(index)) ? Number(index) : -1,
      descriptorId: "",
      createdAt: Date.now()
    };
    return pendingRoomJoinPlayback;
  }

  function finalizePendingRoomJoinPlayback(intent) {
    if (!intent || pendingRoomJoinPlayback !== intent) return false;
    var descriptorId = currentDescriptorId();
    if (!descriptorId || !window.audio || !window.audio.src) {
      pendingRoomJoinPlayback = null;
      return false;
    }
    intent.descriptorId = descriptorId;
    return true;
  }

  function consumePendingRoomJoinPlayback() {
    var intent = pendingRoomJoinPlayback;
    // A very fast joined message can arrive before the deferred source has
    // finished resolving. Keep that intent intact so the wrapper can promote
    // it as soon as the same playQueueAt call completes.
    if (!intent || !intent.descriptorId || !window.audio || !window.audio.src) return false;
    pendingRoomJoinPlayback = null;
    return intent.descriptorId === currentDescriptorId();
  }

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

  function setRoomQrImage(source, statusText, objectUrl, generation, shareUrl) {
    if (generation !== roomQrRenderGeneration) {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      return;
    }
    var image = document.getElementById("room-sync-qr");
    var status = document.getElementById("room-sync-qr-status");
    roomQrPendingValue = "";
    if (!image) {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      return;
    }
    if (roomQrObjectUrl) URL.revokeObjectURL(roomQrObjectUrl);
    roomQrObjectUrl = objectUrl || "";
    image.src = source;
    image.alt = "扫码加入局域网房间 " + roomCode;
    image.title = shareUrl;
    if (status) status.textContent = statusText;
    roomQrRenderedValue = shareUrl;
  }

  function renderRoomQr(shareUrl) {
    var value = String(shareUrl || "");
    if (!value || value === roomQrRenderedValue || value === roomQrPendingValue) return;
    var image = document.getElementById("room-sync-qr");
    var status = document.getElementById("room-sync-qr-status");
    if (!image) return;
    roomQrPendingValue = value;
    var generation = ++roomQrRenderGeneration;
    if (status) status.textContent = "正在本地生成";
    var endpoint = new URL("/api/room/qr", relayHttpOrigin + "/");
    endpoint.searchParams.set("text", value);
    var abortController = typeof window.AbortController === "function"
      ? new window.AbortController()
      : null;
    var qrTimeout = abortController
      ? window.setTimeout(function () { abortController.abort(); }, 2500)
      : 0;
    var requestOptions = { cache: "no-store" };
    if (abortController) requestOptions.signal = abortController.signal;
    nativeFetch(endpoint.toString(), requestOptions).then(function (response) {
      if (!response.ok || !/^image\/png\b/i.test(String(response.headers.get("content-type") || ""))) {
        throw new Error("relay_qr_unavailable");
      }
      return response.blob();
    }).then(function (blob) {
      window.clearTimeout(qrTimeout);
      if (!blob || !blob.size) throw new Error("empty_qr");
      var objectUrl = URL.createObjectURL(blob);
      setRoomQrImage(objectUrl, "由本机 Relay 生成", objectUrl, generation, value);
    }).catch(function () {
      window.clearTimeout(qrTimeout);
      var qr = window.MineradioQRCode;
      if (!qr || typeof qr.toDataURL !== "function") throw new Error("local_qr_unavailable");
      return qr.toDataURL(value, {
        errorCorrectionLevel: "M",
        margin: 2,
        width: 192,
        color: { dark: "#080b10", light: "#ffffff" }
      }).then(function (dataUrl) {
        setRoomQrImage(dataUrl, "浏览器本地生成", "", generation, value);
      });
    }).catch(function () {
      if (generation !== roomQrRenderGeneration) return;
      roomQrPendingValue = "";
      image.removeAttribute("src");
      if (status) status.textContent = "二维码不可用，请复制下方房间链接";
    });
  }

  function boundedMetric(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, Number(value) || 0));
  }

  function normalizeDeviceCalibration(value) {
    var input = value && typeof value === "object" ? value : {};
    return {
      volumeTrimDb: Math.round(Math.max(-24, Math.min(12, Number(input.volumeTrimDb) || 0)) * 2) / 2,
      delayMs: Math.round(Math.max(0, Math.min(500, Number(input.delayMs) || 0)) / 5) * 5
    };
  }

  function localDeviceCalibration() {
    if (typeof window.getRoomDeviceCalibration === "function") {
      try { return normalizeDeviceCalibration(window.getRoomDeviceCalibration()); } catch {}
    }
    try {
      return normalizeDeviceCalibration(JSON.parse(window.localStorage.getItem(DEVICE_CALIBRATION_KEY) || "{}"));
    } catch {
      return { volumeTrimDb: 0, delayMs: 0 };
    }
  }

  function applyLocalDeviceCalibration(value, immediate) {
    var calibration = normalizeDeviceCalibration(value);
    var signature = calibration.volumeTrimDb + ":" + calibration.delayMs;
    if (signature === lastAppliedCalibrationSignature) return calibration;
    lastAppliedCalibrationSignature = signature;
    if (typeof window.applyRoomDeviceCalibration === "function") {
      try {
        return normalizeDeviceCalibration(window.applyRoomDeviceCalibration(
          calibration.volumeTrimDb,
          calibration.delayMs,
          { persist: true, immediate: Boolean(immediate) }
        ));
      } catch {}
    }
    try { window.localStorage.setItem(DEVICE_CALIBRATION_KEY, JSON.stringify(calibration)); } catch {}
    return calibration;
  }

  function localDeviceDelayMs() {
    return localDeviceCalibration().delayMs;
  }

  function applyCalibrationFromRoomDevices(devices) {
    if (!clientId || !Array.isArray(devices)) return;
    var localDevice = devices.find(function (device) {
      return String(device && device.clientId || "") === clientId;
    });
    if (!localDevice
      || !Number.isFinite(Number(localDevice.volumeTrimDb))
      || !Number.isFinite(Number(localDevice.delayMs))) return;
    var updatedAt = Number(localDevice.updatedAt) || 0;
    if (localCalibrationMinimumUpdatedAt && updatedAt + 5 < localCalibrationMinimumUpdatedAt) return;
    localCalibrationMinimumUpdatedAt = 0;
    applyLocalDeviceCalibration({
      volumeTrimDb: localDevice.volumeTrimDb,
      delayMs: localDevice.delayMs
    }, false);
  }

  function reportLocalDeviceCalibration() {
    var calibration = localDeviceCalibration();
    localCalibrationMinimumUpdatedAt = Date.now() + serverOffset;
    sendDeviceStatusCommand({
      prepareId: "",
      latencyMs: bridge.sync.latency,
      jitterMs: bridge.sync.jitter,
      driftMs: bridge.sync.drift,
      quality: currentRoomPlaybackQuality(lastRoomState),
      volumeTrimDb: calibration.volumeTrimDb,
      delayMs: calibration.delayMs
    }, true);
  }

  function serviceState(kind) {
    var services = bridge.sync.services || {};
    return services[kind] || { state: "checking", latency: 0, detail: "检测中" };
  }

  function setServiceState(kind, state, latency, detail) {
    if (!bridge.sync.services) bridge.sync.services = {};
    bridge.sync.services[kind] = {
      state: /^(online|offline|checking)$/.test(String(state || "")) ? String(state) : "offline",
      latency: boundedMetric(latency, 0, 30000),
      detail: String(detail || "")
    };
    updateRoomSyncUi();
  }

  function checkServiceHealth(kind, origin) {
    var startedAt = Date.now();
    var controller = typeof window.AbortController === "function" ? new window.AbortController() : null;
    var timeout = window.setTimeout(function () {
      if (controller) controller.abort();
    }, 2800);
    var endpoint;
    try {
      var serviceOrigin = new URL(origin + "/").origin;
      var sameSecureGateway = securePage && serviceOrigin === window.location.origin;
      var healthPath = sameSecureGateway
        ? "/.well-known/mr-room/health/" + (kind === "relay" ? "relay" : "music")
        : "/health";
      endpoint = new URL(healthPath, serviceOrigin + "/").toString();
    } catch {
      window.clearTimeout(timeout);
      setServiceState(kind, "offline", 0, "地址无效");
      return Promise.resolve(false);
    }
    return nativeFetch(endpoint, {
      cache: "no-store",
      signal: controller ? controller.signal : undefined
    }).then(function (response) {
      if (!response.ok) throw new Error("HTTP_" + response.status);
      return response.json().catch(function () { return {}; });
    }).then(function (payload) {
      window.clearTimeout(timeout);
      if (payload && payload.ok === false) throw new Error("service_unavailable");
      var latency = Math.max(0, Date.now() - startedAt);
      setServiceState(kind, "online", latency, "在线 · " + latency + " ms");
      return true;
    }).catch(function () {
      window.clearTimeout(timeout);
      setServiceState(kind, "offline", 0, "无法访问");
      return false;
    });
  }

  function refreshServiceHealth() {
    if (document.visibilityState === "hidden" || serviceHealthInFlight) return Promise.resolve(false);
    serviceHealthInFlight = true;
    return Promise.all([
      checkServiceHealth("relay", relayHttpOrigin),
      checkServiceHealth("music", apiOrigin)
    ]).then(function (values) {
      serviceHealthInFlight = false;
      return values.some(Boolean);
    }, function () {
      serviceHealthInFlight = false;
      return false;
    });
  }

  function startServiceHealthPolling() {
    window.clearInterval(serviceHealthTimer);
    serviceHealthTimer = window.setInterval(function () {
      if (document.visibilityState === "visible") refreshServiceHealth();
    }, 15000);
    refreshServiceHealth();
  }

  function updateServiceCard(kind, state, value) {
    var card = document.getElementById("room-service-" + kind);
    var text = document.getElementById("room-service-" + kind + "-value");
    if (!card || !text) return;
    card.classList.remove("online", "offline", "checking");
    card.classList.add(state);
    text.textContent = value;
    text.title = value;
  }

  function deviceBufferStateLabel(device) {
    if (device.blocked || device.bufferState === "error") return { text: "设备异常", className: "error" };
    if (device.bufferState === "unlock_required") return { text: "需要点击播放", className: "waiting" };
    if (device.bufferState === "stalled") return { text: "正在自动恢复", className: "waiting" };
    if (device.participant && device.armed) return { text: "启动已确认", className: "ready" };
    if (device.participant && device.ready) return { text: "已就绪", className: "ready" };
    if (device.bufferState === "ready") return { text: "缓冲充足", className: "ready" };
    if (device.participant) {
      var percent = Math.round(boundedMetric(device.bufferProgress, 0, 1) * 100);
      return { text: "缓冲 " + percent + "%", className: "waiting" };
    }
    return { text: device.leader ? "主控设备" : "已连接", className: "" };
  }

  function renderRoomDevices() {
    var list = document.getElementById("room-sync-device-list");
    if (!list) return;
    var devices = Array.isArray(bridge.sync.devices) ? bridge.sync.devices : [];
    var signature;
    try { signature = clientId + ":" + JSON.stringify(devices); } catch { signature = String(Date.now()); }
    if (signature === roomDeviceRenderSignature) return;
    roomDeviceRenderSignature = signature;
    while (list.firstChild) list.removeChild(list.firstChild);
    if (!devices.length) {
      var empty = document.createElement("div");
      empty.className = "room-sync-device-empty";
      empty.textContent = bridge.sync.connected ? "房间设备信息同步中" : "连接房间后显示设备状态";
      list.appendChild(empty);
      return;
    }
    var fragment = document.createDocumentFragment();
    devices.forEach(function (rawDevice) {
      var device = rawDevice && typeof rawDevice === "object" ? rawDevice : {};
      var row = document.createElement("div");
      row.className = "room-sync-device";
      row.setAttribute("role", "listitem");
      if (device.leader) row.classList.add("is-leader");
      if (device.blocked || device.bufferState === "error") row.classList.add("is-blocked");

      var top = document.createElement("div");
      top.className = "room-sync-device-top";
      var name = document.createElement("span");
      name.className = "room-sync-device-name";
      name.textContent = String(device.name || "设备") + (String(device.clientId || "") === clientId ? " · 本机" : "");
      var stateLabel = deviceBufferStateLabel(device);
      var state = document.createElement("span");
      state.className = "room-sync-device-state" + (stateLabel.className ? " " + stateLabel.className : "");
      state.textContent = stateLabel.text;
      top.appendChild(name);
      top.appendChild(state);
      row.appendChild(top);

      if (device.participant && !device.ready) {
        var progress = boundedMetric(device.bufferProgress, 0, 1);
        var progressTrack = document.createElement("div");
        progressTrack.className = "room-sync-device-progress";
        progressTrack.setAttribute("aria-label", "同步准备 " + Math.round(progress * 100) + "%");
        var progressFill = document.createElement("i");
        progressFill.style.width = Math.round(progress * 100) + "%";
        progressTrack.appendChild(progressFill);
        row.appendChild(progressTrack);
      }
      fragment.appendChild(row);
    });
    list.appendChild(fragment);
  }

  function protocolErrorMessage(code) {
    var value = String(code || "unknown");
    var messages = {
      invalid_room: "房间码无效，请输入 4–8 位字母或数字",
      invalid_command: "中继无法识别此同步操作，请更新主机 LAN 服务",
      invalid_track: "这首歌曲无法通过局域网中继播放",
      invalid_device: "目标设备已离开房间，请刷新设备列表",
      device_not_found: "目标设备已离开房间，请刷新设备列表",
      invalid_calibration: "设备校准参数无效，请重置后重试",
      buffer_contract_required: "同步服务要求完整的缓冲状态，请刷新播放器",
      buffer_not_ready: "当前设备缓冲尚未达到同步起播要求",
      strict_sync_required: "当前同步操作需要协议 v3，请刷新播放器",
      leader_only: "只有房间主控可以执行此操作",
      not_joined: "设备尚未加入房间，正在尝试重新连接",
      quality_unavailable: "当前歌曲或账号暂不支持所选音质",
      rate_limited: "同步指令过于频繁，已自动降低发送频率",
      room_full: "房间已达到 64 台设备上限",
      command_failed: "同步指令处理失败，请重试播放",
      invalid_message: "同步服务收到无法识别的数据",
      message_too_large: "同步数据超过服务限制"
    };
    return messages[value] || ("同步协议错误：" + value);
  }

  function refreshForCurrentRoomProtocol() {
    try {
      if (window.sessionStorage.getItem(ROOM_SYNC_REFRESH_GUARD_KEY) === ROOM_SYNC_BUILD_ID) return false;
      window.sessionStorage.setItem(ROOM_SYNC_REFRESH_GUARD_KEY, ROOM_SYNC_BUILD_ID);
    } catch {}
    window.setTimeout(function () {
      var target;
      try {
        target = new URL(window.location.href);
        target.searchParams.set("room", roomCode);
        target.searchParams.set("syncBuild", ROOM_SYNC_BUILD_ID);
      } catch {
        window.location.reload();
        return;
      }
      if (typeof window.location.replace === "function") window.location.replace(target.toString());
      else window.location.reload();
    }, 180);
    return true;
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
    var bufferLabel = document.getElementById("room-sync-buffer-label");
    var bufferBar = document.getElementById("room-sync-buffer-bar");
    var protocolError = document.getElementById("room-sync-protocol-error");
    var deviceCount = Math.max(0, Number(bridge.sync.deviceCount) || 0);
    var connected = Boolean(bridge.sync.connected);
    var connectionError = Boolean(bridge.sync.error);
    var leader = connected && joinedRoom && Boolean(bridge.sync.leader);
    var timingText = bridge.sync.clockReady ? " · 自动校准已开启" : " · 自动校时中";

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
        ? (bridge.sync.commitState === "tentative"
          ? "确认同步启动 · " + bridge.sync.armedCount + "/" + Math.max(1, bridge.sync.strictRequiredCount)
          : "等待设备缓冲 · " + bridge.sync.readyCount + "/" + Math.max(1, bridge.sync.requiredCount))
        : (bridge.sync.prepareError
          ? (bridge.sync.prepareError === "start_failed" ? "设备启动未完成，请重新点击播放" : "缓冲未完成，请重新点击播放")
          : (joinedRoom ? "同步服务已连接" + timingText : "正在加入同步房间")));
    if (devices) devices.textContent = deviceCount + " 台设备";
    if (dot) dot.classList.toggle("connected", connected);
    if (link) {
      var shareUrl = roomShareUrl(roomCode);
      link.textContent = shareUrl;
      link.title = shareUrl;
      renderRoomQr(shareUrl);
    }
    var relayService = serviceState("relay");
    var musicService = serviceState("music");
    updateServiceCard("relay", relayService.state, relayService.detail || "检测中");
    updateServiceCard("music", musicService.state, musicService.detail || "检测中");
    var roomServiceState = connectionError ? "offline" : (connected && joinedRoom ? "online" : "checking");
    var roomServiceValue = connectionError
      ? "等待重连"
      : (connected && joinedRoom
      ? ((leader ? "主控" : "跟随") + " · " + deviceCount + " 台")
      : "正在加入");
    updateServiceCard("room", roomServiceState, roomServiceValue);
    var scheduledInFuture = Boolean(lastRoomState && lastRoomState.playing)
      && Number(lastRoomState.scheduledAt) > Date.now() + serverOffset;
    var bufferProgress = scheduledInFuture ? 1 : boundedMetric(bridge.sync.bufferProgress, 0, 1);
    if (bufferBar) bufferBar.style.width = Math.round(bufferProgress * 100) + "%";
    if (bufferLabel) {
      bufferLabel.textContent = bridge.sync.preparing
        ? (bridge.sync.commitState === "tentative"
          ? ("缓冲完成 · " + bridge.sync.armedCount + "/" + Math.max(1, bridge.sync.strictRequiredCount) + " 已确认")
          : (Math.round(bufferProgress * 100) + "% · " + bridge.sync.readyCount + "/" + Math.max(1, bridge.sync.requiredCount) + " 已就绪"))
        : (bridge.sync.prepareError
          ? "准备失败"
          : (scheduledInFuture ? "全部就绪 · 即将同步起播" : "等待播放"));
    }
    if (protocolError) {
      protocolError.hidden = !bridge.sync.protocolError;
      protocolError.textContent = bridge.sync.protocolError;
    }
    renderRoomDevices();
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
      refreshServiceHealth();
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

  function appendDeviceStatusFields(message, value) {
    var statusValue = value && typeof value === "object" ? value : {};
    message.prepareId = String(statusValue.prepareId || "");
    message.bufferedSeconds = boundedMetric(statusValue.bufferedSeconds, 0, 86400);
    message.bufferGoalSeconds = boundedMetric(statusValue.bufferGoalSeconds, 0, 120);
    message.latencyMs = boundedMetric(
      statusValue.latencyMs == null ? bridge.sync.latency : statusValue.latencyMs,
      0,
      5000
    );
    message.jitterMs = boundedMetric(
      statusValue.jitterMs == null ? bridge.sync.jitter : statusValue.jitterMs,
      0,
      1000
    );
    message.driftMs = Math.max(-10000, Math.min(10000, Number(statusValue.driftMs) || 0));
    var quality = String(statusValue.quality || "").toLowerCase();
    if (QUALITY_RE.test(quality)) message.quality = quality;
    var bufferState = String(statusValue.bufferState || "").toLowerCase();
    if (/^(loading|buffering|ready|stalled|error|unlock_required)$/.test(bufferState)) {
      message.bufferState = bufferState;
    }
    var fallbackCalibration = localDeviceCalibration();
    var calibration = normalizeDeviceCalibration({
      volumeTrimDb: Number.isFinite(Number(statusValue.volumeTrimDb))
        ? statusValue.volumeTrimDb
        : fallbackCalibration.volumeTrimDb,
      delayMs: Number.isFinite(Number(statusValue.delayMs))
        ? statusValue.delayMs
        : fallbackCalibration.delayMs
    });
    message.volumeTrimDb = calibration.volumeTrimDb;
    message.delayMs = calibration.delayMs;
  }

  function sendCommand(action, value) {
    var readiness = action === "ready"
      || action === "armed"
      || action === "start-failed"
      || action === "device-status";
    if ((!readiness && !bridge.sync.leader) || !joinedRoom || !socket || socket.readyState !== WebSocket.OPEN) return false;
    var message = { type: "command", action: action };
    if (action === "track") message.track = value;
    else if (action === "ready") {
      var readyValue = value && typeof value === "object" ? value : { prepareId: value };
      appendDeviceStatusFields(message, readyValue);
      message.ready = readyValue.ready !== false;
    }
    else if (action === "armed") {
      var armedValue = value && typeof value === "object" ? value : {};
      appendDeviceStatusFields(message, armedValue);
      message.commitId = String(armedValue.commitId || "");
      message.armed = armedValue.armed !== false;
    }
    else if (action === "device-status") appendDeviceStatusFields(message, value);
    else if (action === "device-calibration") {
      var calibrationValue = normalizeDeviceCalibration(value);
      message.targetClientId = String(value && value.targetClientId || "").slice(0, 96);
      message.volumeTrimDb = calibrationValue.volumeTrimDb;
      message.delayMs = calibrationValue.delayMs;
    }
    else if (action === "start-failed") {
      var failureValue = value && typeof value === "object" ? value : { prepareId: value };
      message.prepareId = String(failureValue.prepareId || "");
      if (failureValue.commitId) message.commitId = String(failureValue.commitId);
    }
    else if (action === "seek" || action === "progress") {
      message.position = Number(value) || 0;
      if (action === "progress") {
        var delayMs = localDeviceDelayMs();
        var delayCompensationActive = lastRoomState
          && lastRoomState.playing
          && !lastRoomState.preparing
          && Date.now() + serverOffset + delayMs >= Number(lastRoomState.scheduledAt || 0);
        if (delayCompensationActive) {
          message.position = Math.max(0, message.position - delayMs / 1000);
        }
        message.sampledServerTime = Date.now() + serverOffset;
        message.advancing = Boolean(window.audio && !window.audio.paused && !leaderBuffering);
      }
    }
    else if (action === "volume") message.volume = Math.max(0, Math.min(1, Number(value) || 0));
    else if (action === "quality") message.quality = String(value || "");
    socket.send(JSON.stringify(message));
    return true;
  }

  function sendDeviceStatusCommand(value, flush) {
    pendingDeviceStatus = Object.assign({}, value || {});
    var elapsed = Date.now() - lastDeviceStatusSentAt;
    if (flush || elapsed >= 320) {
      window.clearTimeout(deviceStatusTimer);
      deviceStatusTimer = 0;
      var immediate = pendingDeviceStatus;
      pendingDeviceStatus = null;
      if (sendCommand("device-status", immediate)) lastDeviceStatusSentAt = Date.now();
      return;
    }
    window.clearTimeout(deviceStatusTimer);
    deviceStatusTimer = window.setTimeout(function () {
      deviceStatusTimer = 0;
      if (!pendingDeviceStatus) return;
      var trailing = pendingDeviceStatus;
      pendingDeviceStatus = null;
      if (sendCommand("device-status", trailing)) lastDeviceStatusSentAt = Date.now();
    }, Math.max(0, 320 - elapsed));
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
      path: "/api/tracks/" + id,
      artist: cleanRoomText(value.artist || song.artist, 160),
      album: cleanRoomText(value.album || song.album, 160),
      cover: safeArtworkUrl(value.cover || song.cover)
    };
  }

  function cleanRoomText(value, maxLength) {
    return String(value || "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, maxLength);
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

  function mediaSessionArtist(song) {
    if (!song) return "";
    if (typeof song.artist === "string") return song.artist;
    var values = Array.isArray(song.artists) ? song.artists : (Array.isArray(song.ar) ? song.ar : []);
    return values.map(function (artist) {
      return typeof artist === "string" ? artist : String(artist && artist.name || "");
    }).filter(Boolean).join(" / ");
  }

  function mediaSessionAlbum(song) {
    if (!song) return "";
    if (typeof song.album === "string") return song.album;
    return String(song.album && song.album.name || song.al && song.al.name || "");
  }

  function mediaSessionCover(song) {
    if (!song) return "";
    var custom = "";
    if (typeof window.getCustomCoverForSong === "function") {
      try { custom = window.getCustomCoverForSong(song); } catch {}
    }
    return coverMediaUrl(
      custom
      || song.customCover
      || song.cover
      || song.picUrl
      || song.album && song.album.picUrl
      || song.al && song.al.picUrl
      || ""
    );
  }

  function updateMediaSessionMetadata() {
    if (!("mediaSession" in navigator) || typeof window.MediaMetadata !== "function") return;
    var song = currentSongForBridge();
    if (!song) {
      navigator.mediaSession.metadata = null;
      return;
    }
    var cover = mediaSessionCover(song);
    var metadata = {
      title: String(song.name || song.title || "Mineradio"),
      artist: mediaSessionArtist(song),
      album: mediaSessionAlbum(song)
    };
    if (cover) metadata.artwork = [{ src: cover }];
    try { navigator.mediaSession.metadata = new window.MediaMetadata(metadata); } catch {}
    updateMediaSessionPlaybackState(true);
  }

  function mediaSessionPosition(media) {
    var position = Math.max(0, Number(media && media.currentTime) || 0);
    if (lastRoomState && lastRoomState.playing && !lastRoomState.preparing) {
      position = Math.max(0, position - localDeviceDelayMs() / 1000);
    }
    return position;
  }

  function updateMediaSessionPlaybackState(forcePosition) {
    if (!("mediaSession" in navigator)) return;
    var media = window.audio;
    try {
      navigator.mediaSession.playbackState = media && !media.paused ? "playing" : "paused";
    } catch {}
    if (!media || typeof navigator.mediaSession.setPositionState !== "function") return;
    var now = Date.now();
    if (!forcePosition && now - lastMediaSessionPositionAt < 1000) return;
    var duration = Number(media.duration);
    if (!Number.isFinite(duration) || duration <= 0) return;
    var position = Math.min(Math.max(0, duration - 0.001), mediaSessionPosition(media));
    try {
      navigator.mediaSession.setPositionState({
        duration: duration,
        playbackRate: Math.max(0.5, Math.min(4, Number(media.playbackRate) || 1)),
        position: position
      });
      lastMediaSessionPositionAt = now;
    } catch {}
  }

  function mediaSessionSeekTo(seconds, fastSeek) {
    var media = window.audio;
    if (!media || blockFollowerControl()) return;
    var duration = Number(media.duration) || 0;
    var target = Math.max(0, Number(seconds) || 0);
    if (duration > 0) target = Math.min(target, Math.max(0, duration - 0.05));
    if (fastSeek && typeof media.fastSeek === "function") {
      suppressNextSeekCommand = true;
      window.clearTimeout(suppressSeekResetTimer);
      try {
        media.fastSeek(target);
        suppressSeekResetTimer = window.setTimeout(function () {
          suppressNextSeekCommand = false;
          suppressSeekResetTimer = 0;
        }, 2000);
      } catch {
        seekForRoomSync(media, target);
      }
    } else {
      seekForRoomSync(media, target);
    }
    if (joinedRoom && bridge.sync.leader) sendSeekCommand(target, true);
    updateMediaSessionPlaybackState(true);
  }

  function installMediaSession() {
    if (mediaSessionInstalled || !("mediaSession" in navigator)) return;
    mediaSessionInstalled = true;
    var handlers = {
      play: function () {
        if (window.audio && window.audio.paused && typeof window.togglePlay === "function") window.togglePlay();
      },
      pause: function () {
        if (window.audio && !window.audio.paused && typeof window.togglePlay === "function") window.togglePlay();
      },
      previoustrack: function () {
        if (typeof window.prevTrack === "function") window.prevTrack();
      },
      nexttrack: function () {
        if (typeof window.nextTrack === "function") window.nextTrack();
      },
      seekbackward: function (detail) {
        mediaSessionSeekTo(mediaSessionPosition(window.audio) - (Number(detail && detail.seekOffset) || 10), false);
      },
      seekforward: function (detail) {
        mediaSessionSeekTo(mediaSessionPosition(window.audio) + (Number(detail && detail.seekOffset) || 10), false);
      },
      seekto: function (detail) {
        mediaSessionSeekTo(detail && detail.seekTime, Boolean(detail && detail.fastSeek));
      },
      stop: function () {
        if (window.audio && !window.audio.paused && typeof window.togglePlay === "function") window.togglePlay();
      }
    };
    Object.keys(handlers).forEach(function (action) {
      try { navigator.mediaSession.setActionHandler(action, handlers[action]); } catch {}
    });
    window.addEventListener("mineradio:coverchange", updateMediaSessionMetadata);
    updateMediaSessionMetadata();
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
      name: cleanRoomText(song.name || song.title || "Mineradio", 160),
      type: "audio/mpeg",
      size: 0,
      path: "/api/cloud/v2/" + provider + "/" + sourceId + "/" + quality,
      provider: provider,
      quality: quality,
      artist: cleanRoomText(mediaSessionArtist(song), 160),
      album: cleanRoomText(mediaSessionAlbum(song), 160),
      cover: safeArtworkUrl(song.cover || song.picUrl || song.album && song.album.picUrl || song.al && song.al.picUrl)
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
        path: "/api/tracks/" + rawId,
        artist: cleanRoomText(track.artist, 160),
        album: cleanRoomText(track.album, 160),
        cover: safeArtworkUrl(track.cover)
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
          artist: localDescriptor.artist || "局域网文件",
          album: localDescriptor.album,
          cover: localDescriptor.cover
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
        artist: cleanRoomText(track.artist, 160),
        album: cleanRoomText(track.album, 160),
        cover: safeArtworkUrl(track.cover)
      }
    };
  }

  function currentDescriptorId() {
    var song = currentSongForBridge();
    var descriptor = descriptorForSong(song);
    return descriptor ? descriptor.id : "";
  }

  function strictCommitRequired(state) {
    return Boolean(strictRoomProtocol && state && state.strictSync);
  }

  function committedRoomPlaybackAllowed(state) {
    if (!state || !state.playing || state.preparing) return false;
    if (!strictCommitRequired(state)) return true;
    return Number(state.protocolVersion) >= ROOM_SYNC_PROTOCOL_VERSION
      && String(state.commitState || "") === "committed"
      && Boolean(String(state.commitId || ""));
  }

  function roomCommitKey(state) {
    var prepareId = String(state && state.prepareId || "");
    var commitId = String(state && state.commitId || "");
    return prepareId && commitId ? prepareId + ":" + commitId : "";
  }

  function strictCommitCanBeRevoked(state) {
    if (!strictCommitRequired(state) || !roomCommitKey(state)) return false;
    if (String(state.commitState || "") === "tentative" && state.preparing) return true;
    return String(state.commitState || "") === "committed"
      && state.playing
      && Number(state.scheduledAt || 0) > Date.now() + serverOffset;
  }

  function targetPosition(state) {
    var position = Math.max(0, Number(state.position) || 0);
    if (!state.playing) return position;
    var delayMs = localDeviceDelayMs();
    return position + Math.max(
      0,
      (Date.now() + serverOffset - (Number(state.updatedAt) || Date.now()) + delayMs) / 1000
    );
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

  function reportScheduledStartFailure(guard) {
    if (!guard || !guard.prepareId) return;
    sendCommand("start-failed", {
      prepareId: guard.prepareId,
      commitId: guard.commitId
    });
  }

  function playForRoomSync(media, guard) {
    if (!media || !media.paused) return;
    suppressNextPlayCommand = true;
    var result;
    try { result = media.play(); } catch {
      suppressNextPlayCommand = false;
      if (scheduledPlaybackIdentityMatches(media, guard, false)) reportScheduledStartFailure(guard);
      return;
    }
    window.setTimeout(function () { suppressNextPlayCommand = false; }, 1000);
    if (result && typeof result.then === "function") {
      result.then(function () {
        if (!scheduledPlaybackIdentityMatches(media, guard, false) || media.paused) return;
        playUnlockNoticeShown = false;
        window.playing = true;
        if (typeof window.setPlayIcon === "function") window.setPlayIcon(true);
        if (typeof window.beginListenSession === "function") {
          try { window.beginListenSession(currentSongForBridge(), null); } catch {}
        }
      }).catch(function () {
        suppressNextPlayCommand = false;
        if (scheduledPlaybackIdentityMatches(media, guard, false)) reportScheduledStartFailure(guard);
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

  function cancelTrackAnnouncement() {
    trackAnnouncementSerial += 1;
    window.clearTimeout(trackAnnouncementTimer);
    window.clearTimeout(joinAnnouncementTimer);
    trackAnnouncementTimer = 0;
    joinAnnouncementTimer = 0;
  }

  function scheduledRoomPlaybackGuard(state) {
    return {
      timerGeneration: scheduledPlayGeneration,
      connectionGeneration: roomConnectionGeneration,
      revision: Number(state && state.revision) || 0,
      trackId: String(state && state.track && state.track.id || ""),
      prepareId: String(state && state.prepareId || ""),
      commitId: String(state && state.commitId || ""),
      commitState: String(state && state.commitState || ""),
      strictCommit: strictCommitRequired(state),
      scheduledAt: Number(state && state.scheduledAt) || 0
    };
  }

  function scheduledPlaybackIdentityMatches(media, guard, requireRevision) {
    var activeState = lastRoomState;
    if (!media
      || media !== window.audio
      || !guard
      || !activeState
      || !committedRoomPlaybackAllowed(activeState)) return false;
    if (guard.connectionGeneration !== roomConnectionGeneration
      || String(activeState.track && activeState.track.id || "") !== guard.trackId
      || currentDescriptorId() !== guard.trackId
      || String(activeState.prepareId || "") !== guard.prepareId
      || Number(activeState.scheduledAt || 0) !== guard.scheduledAt
      || strictCommitRequired(activeState) !== guard.strictCommit) return false;
    if (requireRevision && Number(activeState.revision) !== guard.revision) return false;
    if (guard.strictCommit) {
      if (String(activeState.commitState || "") !== "committed"
        || guard.commitState !== "committed"
        || !guard.commitId
        || String(activeState.commitId || "") !== guard.commitId) return false;
    }
    return true;
  }

  function launchScheduledRoomPlayback(media, guard) {
    if (!guard
      || guard.timerGeneration !== scheduledPlayGeneration
      || guard.connectionGeneration !== roomConnectionGeneration) return;
    scheduledPlayTimer = 0;
    if (!scheduledPlaybackIdentityMatches(media, guard, true)) return;
    var activeState = lastRoomState;
    var remaining = Number(activeState.scheduledAt) > 0
      ? Number(activeState.scheduledAt) - (Date.now() + serverOffset) - localDeviceDelayMs()
      : 0;
    if (remaining > 20) {
      scheduledPlayTimer = window.setTimeout(function () {
        launchScheduledRoomPlayback(media, guard);
      }, remaining);
      return;
    }
    alignScheduledRoomPlayback(media, activeState);
    if (guard.strictCommit) {
      var liveTarget = targetPosition(activeState);
      var duration = Number(media.duration) || 0;
      if (duration > 0) liveTarget = Math.min(liveTarget, Math.max(0, duration - 0.05));
      var launchStatus = roomDeviceStatus(media, activeState, liveTarget, { launchWindow: true });
      if (!bridge.sync.clockReady || !launchStatus.ready) {
        revokeArmedRoomCommit(activeState, launchStatus, true);
        reportScheduledStartFailure(guard);
        return;
      }
    }
    playForRoomSync(media, guard);
  }

  function measureRoomBufferWindow(media, target) {
    var core = window.MineradioRoomSyncCore;
    if (!core || typeof core.measureBufferedWindow !== "function") {
      bridge.sync.protocolError = "同步缓冲组件未加载，请刷新页面";
      updateRoomSyncUi();
      return { bufferedSeconds: 0, bufferGoalSeconds: 4, bufferProgress: 0, ready: false };
    }
    return core.measureBufferedWindow(media, target, {
      latencyMs: bridge.sync.latency,
      jitterMs: bridge.sync.jitter
    });
  }

  function measureRoomLaunchWindow(media, target) {
    var core = window.MineradioRoomSyncCore;
    if (!core || typeof core.measureLaunchWindow !== "function") {
      return measureRoomBufferWindow(media, target);
    }
    return core.measureLaunchWindow(media, target, {
      latencyMs: bridge.sync.latency,
      jitterMs: bridge.sync.jitter
    });
  }

  function hasBufferedPlaybackWindow(media, target) {
    return measureRoomBufferWindow(media, target).ready;
  }

  function currentRoomPlaybackQuality(state) {
    var quality = String(window.playbackQuality || (state && state.track && state.track.quality) || "").toLowerCase();
    return QUALITY_RE.test(quality) ? quality : "";
  }

  function roomDeviceStatus(media, state, target, options) {
    var input = options || {};
    var measurement = input.launchWindow
      ? measureRoomLaunchWindow(media, target)
      : measureRoomBufferWindow(media, target);
    var aligned = Math.abs((Number(media && media.currentTime) || 0) - target) <= 0.08;
    var readyState = Number(media && media.readyState) || 0;
    var bufferState = input.bufferState || "";
    if (!bufferState) {
      if (media && media.error) bufferState = "error";
      else if (readyState < 2) bufferState = "loading";
      else if (!measurement.ready) bufferState = "buffering";
      else if (!roomMediaUnlocked) bufferState = "unlock_required";
      else bufferState = "ready";
    }
    var ready = measurement.ready
      && aligned
      && readyState >= 3
      && roomMediaUnlocked
      && bufferState !== "error"
      && bufferState !== "stalled";
    return {
      measurement: measurement,
      aligned: aligned,
      ready: ready,
      payload: {
        prepareId: String(state && state.prepareId || ""),
        bufferedSeconds: measurement.bufferedSeconds,
        bufferGoalSeconds: measurement.bufferGoalSeconds,
        latencyMs: bridge.sync.latency,
        jitterMs: bridge.sync.jitter,
        driftMs: bridge.sync.drift,
        quality: currentRoomPlaybackQuality(state),
        bufferState: ready ? "ready" : bufferState
      }
    };
  }

  function revokeArmedRoomCommit(state, status, force) {
    var key = roomCommitKey(state);
    if (!key || !strictCommitCanBeRevoked(state)) return false;
    if (!force && lastArmedCommitKey !== key) return false;
    var deviceStatus = status;
    if (!deviceStatus && window.audio) {
      var target = targetPosition(state);
      var duration = Number(window.audio.duration) || 0;
      if (duration > 0) target = Math.min(target, Math.max(0, duration - 0.05));
      deviceStatus = roomDeviceStatus(window.audio, state, target);
    }
    var payload = Object.assign(
      {},
      deviceStatus ? deviceStatus.payload : { prepareId: String(state.prepareId || "") },
      {
        commitId: String(state.commitId || ""),
        armed: false,
        bufferState: deviceStatus && deviceStatus.payload.bufferState
          ? deviceStatus.payload.bufferState
          : "buffering"
      }
    );
    var sent = sendCommand("armed", payload);
    if (sent && lastArmedCommitKey === key) lastArmedCommitKey = "";
    return sent;
  }

  function acknowledgeTentativeRoomCommit(state, deviceStatus, readyForBarrier) {
    if (!strictCommitRequired(state)
      || String(state.commitState || "") !== "tentative"
      || !state.preparing) return false;
    var key = roomCommitKey(state);
    if (!key) return false;
    if (lastArmedCommitKey && lastArmedCommitKey !== key) lastArmedCommitKey = "";
    var canArm = Boolean(
      readyForBarrier
      && deviceStatus
      && deviceStatus.ready
      && bridge.sync.clockReady
    );
    if (!canArm) {
      revokeArmedRoomCommit(state, deviceStatus, false);
      return false;
    }
    if (lastArmedCommitKey === key) return true;
    var payload = Object.assign({}, deviceStatus.payload, {
      commitId: String(state.commitId || ""),
      armed: true
    });
    if (sendCommand("armed", payload)) {
      lastArmedCommitKey = key;
      return true;
    }
    return false;
  }

  function reportCurrentRoomDeviceStatus(flush, bufferState) {
    var media = window.audio;
    var state = lastRoomState;
    if (!media || !state || !state.track) return null;
    var scheduledInFuture = Boolean(state.playing)
      && Number(state.scheduledAt) > Date.now() + serverOffset;
    if (!state.preparing && !scheduledInFuture && !state.playing) return null;
    var target = targetPosition(state);
    var duration = Number(media.duration) || 0;
    if (duration > 0) target = Math.min(target, Math.max(0, duration - 0.05));
    var committedStartPending = strictCommitRequired(state)
      && String(state.commitState || "") === "committed"
      && scheduledInFuture;
    var status = roomDeviceStatus(media, state, target, {
      bufferState: bufferState,
      launchWindow: committedStartPending
    });
    sendDeviceStatusCommand(status.payload, Boolean(flush));
    if (!status.ready) revokeArmedRoomCommit(state, status, false);
    return status;
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
    var activeCommitKey = roomCommitKey(state);
    if (lastArmedCommitKey && lastArmedCommitKey !== activeCommitKey) {
      lastArmedCommitKey = "";
    }
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
      if (prepareId && activeBufferLoadPrepareId !== prepareId) {
        activeBufferLoadPrepareId = prepareId;
        // Some tablet engines stop after metadata while paused. Restart the
        // resource fetch once for this preparation so progress cannot stay at
        // zero forever; subsequent events drive the normal readiness checks.
        if (media.readyState < 2 && Number(media.networkState) !== 2) {
          try { media.load(); } catch {}
        }
      }
      resetRoomMediaUnlockFor(media);
      var deviceStatus = roomDeviceStatus(media, state, target);
      sendDeviceStatusCommand(deviceStatus.payload, deviceStatus.ready);
      var readyForBarrier = prepareId
        && deviceStatus.ready
        && correction.mode !== "seek"
        && hasBufferedPlaybackWindow(media, target);
      if (!readyForBarrier) revokeArmedRoomCommit(state, deviceStatus, false);
      if (readyForBarrier && prepareId !== lastReadyPrepareId) {
        var readyPayload = Object.assign({}, deviceStatus.payload, { ready: true });
        if (sendCommand("ready", readyPayload)) lastReadyPrepareId = prepareId;
      } else if (!readyForBarrier && prepareId === lastReadyPrepareId) {
        sendCommand("ready", Object.assign({}, deviceStatus.payload, { ready: false }));
        lastReadyPrepareId = "";
      }
      acknowledgeTentativeRoomCommit(state, deviceStatus, readyForBarrier);
      if (deviceStatus.measurement.ready && deviceStatus.aligned && !roomMediaUnlocked) {
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
      return;
    }

    if (state.playing) {
      if (!committedRoomPlaybackAllowed(state)) {
        cancelScheduledRoomPlayback();
        setMediaPlaybackRate(media, 1);
        pauseForRoomSync(media);
        bridge.sync.protocolError = "同步启动确认无效，已保持暂停并等待房间重新安排";
        updateRoomSyncUi();
        return;
      }
      var startDelay = Number(state.scheduledAt) > 0
        ? Number(state.scheduledAt) - (Date.now() + serverOffset) - localDeviceDelayMs()
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
    var revision = Number(state.revision) || 0;
    if (revision < lastRevision) return;
    bridge.sync.deviceCount = Math.max(0, Number(state.deviceCount) || 0);
    bridge.sync.strictSync = Boolean(strictRoomProtocol && state.strictSync);
    bridge.sync.preparing = Boolean(state.preparing);
    bridge.sync.readyCount = Math.max(0, Number(state.readyCount) || 0);
    bridge.sync.requiredCount = Math.max(0, Number(state.requiredCount) || 0);
    bridge.sync.armedCount = Math.max(0, Number(state.armedCount) || 0);
    bridge.sync.strictRequiredCount = Math.max(0, Number(state.strictRequiredCount) || 0);
    bridge.sync.commitState = String(state.commitState || "");
    bridge.sync.prepareError = String(state.prepareError || "");
    bridge.sync.bufferProgress = boundedMetric(state.bufferProgress, 0, 1);
    bridge.sync.prepareDeadline = Math.max(0, Number(state.prepareDeadline) || 0);
    bridge.sync.prepareMaxDeadline = Math.max(0, Number(state.prepareMaxDeadline) || 0);
    bridge.sync.devices = Array.isArray(state.devices) ? state.devices.slice(0, 64) : [];
    applyCalibrationFromRoomDevices(bridge.sync.devices);
    updateRoomSyncUi();
    if (!bridge.sync.clockReady && Number(state.serverTime)) {
      var bootstrapOffset = Number(state.serverTime) - Date.now();
      serverOffset = serverOffset ? serverOffset * 0.8 + bootstrapOffset * 0.2 : bootstrapOffset;
    }
    var sameRevision = revision === lastRevision;
    lastRoomState = state;
    if (!state.prepareId) lastReadyPrepareId = "";
    if (lastArmedCommitKey && lastArmedCommitKey !== roomCommitKey(state)) {
      lastArmedCommitKey = "";
    }
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
        lastReadyPrepareId = "";
        lastArmedCommitKey = "";
        activeBufferLoadPrepareId = "";
        if (window.audio) setMediaPlaybackRate(window.audio, 1);
        if (window.audio && !window.audio.paused) window.audio.pause();
        return;
      }
      var parsed = parseRoomTrack(state.track);
      if (!parsed || typeof window.playQueueAt !== "function") return;
      var trackChanged = currentDescriptorId() !== String(state.track.id);
      if (trackChanged) {
        cancelScheduledRoomPlayback();
        activeBufferLoadPrepareId = "";
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
    cancelTrackAnnouncement();
    var song = currentSongForBridge();
    var descriptor = descriptorForSong(song);
    var shouldResume = forceResume === true || Boolean(window.audio && !window.audio.paused && !window.audio.ended);
    var announcementSerial = trackAnnouncementSerial;
    var connectionGeneration = roomConnectionGeneration;
    var descriptorId = descriptor && String(descriptor.id || "");
    if (shouldResume) pauseForRoomSync(window.audio);
    if (!descriptor || !sendCommand("track", descriptor)) return;
    trackAnnouncementTimer = window.setTimeout(function () {
      trackAnnouncementTimer = 0;
      // A delayed start belongs to exactly one leader, connection, and track.
      // Never let a fast song switch or reconnect send a stale seek/play pair.
      if (announcementSerial !== trackAnnouncementSerial
        || connectionGeneration !== roomConnectionGeneration
        || !joinedRoom
        || !bridge.sync.leader
        || !window.audio
        || currentDescriptorId() !== descriptorId) return;
      sendCommand("seek", Number(window.audio.currentTime) || 0);
      sendCommand(shouldResume ? "play" : "pause");
    }, 80);
  }

  function attachAudioEvents() {
    var media = window.audio;
    if (!media || media === attachedAudio) return;
    attachedAudio = media;
    updateMediaSessionMetadata();
    media.addEventListener("play", function () {
      if (roomMediaPrimeActive === media) return;
      updateMediaSessionPlaybackState(true);
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
      updateMediaSessionPlaybackState(true);
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
      updateMediaSessionPlaybackState(true);
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
      updateMediaSessionPlaybackState(false);
      if (roomMediaPrimeActive === media || applyingRoomState || Date.now() - lastPositionSentAt < 1000) return;
      lastPositionSentAt = Date.now();
      sendCommand("progress", media.currentTime);
    });
    var onLeaderWaiting = function () {
      if (roomMediaPrimeActive === media) return;
      if (lastRoomState && lastRoomState.prepareId
        && (lastRoomState.preparing || Number(lastRoomState.scheduledAt) > Date.now() + serverOffset)) {
        var stalledStatus = reportCurrentRoomDeviceStatus(true, "stalled");
        sendCommand("ready", Object.assign(
          { prepareId: lastRoomState.prepareId, ready: false, bufferState: "stalled" },
          stalledStatus ? stalledStatus.payload : {}
        ));
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
      reportCurrentRoomDeviceStatus(true);
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
      reportCurrentRoomDeviceStatus(false);
      if (lastRoomState && lastRoomState.preparing) {
        applyingRoomState = true;
        try { reconcileRoomPlayback(lastRoomState, false); } finally { applyingRoomState = false; }
      }
    });
    media.addEventListener("error", function () {
      if (!lastRoomState || !lastRoomState.prepareId) return;
      var errorStatus = reportCurrentRoomDeviceStatus(true, "error");
      sendCommand("ready", Object.assign(
        { prepareId: lastRoomState.prepareId, ready: false, bufferState: "error" },
        errorStatus ? errorStatus.payload : {}
      ));
      lastReadyPrepareId = "";
    });
    ["loadedmetadata", "durationchange"].forEach(function (eventName) {
      media.addEventListener(eventName, function () {
        updateMediaSessionMetadata();
        updateMediaSessionPlaybackState(true);
        reportCurrentRoomDeviceStatus(true);
        if (!lastRoomState || !lastRoomState.preparing) return;
        applyingRoomState = true;
        try { reconcileRoomPlayback(lastRoomState, false); } finally { applyingRoomState = false; }
      });
    });
    ["emptied", "abort"].forEach(function (eventName) {
      media.addEventListener(eventName, function () {
        if (!lastRoomState || !lastRoomState.prepareId) return;
        var loadingStatus = reportCurrentRoomDeviceStatus(true, "loading");
        sendCommand("ready", Object.assign(
          { prepareId: lastRoomState.prepareId, ready: false, bufferState: "loading" },
          loadingStatus ? loadingStatus.payload : {}
        ));
        lastReadyPrepareId = "";
      });
    });
    media.addEventListener("ended", function () {
      updateMediaSessionPlaybackState(true);
    });
  }

  function refreshRoomTimelineAfterClockSample(generation) {
    if (generation !== roomConnectionGeneration
      || applyingRoomState
      || !lastRoomState
      || !lastRoomState.track
      || !window.audio
      || currentDescriptorId() !== String(lastRoomState.track.id || "")) return;
    applyingRoomState = true;
    try {
      reconcileRoomPlayback(lastRoomState, false);
    } finally {
      applyingRoomState = false;
    }
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
      var activation = window.navigator && window.navigator.userActivation;
      var invokedFromUserGesture = Boolean(activation && activation.isActive);
      cancelScheduledRoomPlayback();
      leaderBuffering = false;
      if (window.audio) setMediaPlaybackRate(window.audio, 1);
      var args = Array.prototype.slice.call(arguments);
      var callerRequestedRoomSync = Boolean(args[1] && args[1].roomSync);
      var holdForRoomJoin = !callerRequestedRoomSync && shouldHoldPlaybackForRoomJoin();
      var pendingJoinIntent = holdForRoomJoin ? beginPendingRoomJoinPlayback(args[0]) : null;
      var joinedPlayback = callerRequestedRoomSync || (joinedRoom && roomPlaybackRequiresSharedAuthority());
      if (joinedPlayback) args[1] = Object.assign({}, args[1] || {}, { roomSync: true });
      var deferLeaderStart = !applyingRoomState && joinedRoom && bridge.sync.leader;
      if (deferLeaderStart) args[1] = Object.assign({}, args[1] || {}, { deferPlayback: true });
      if (holdForRoomJoin) args[1] = Object.assign({}, args[1] || {}, { deferPlayback: true, roomJoinPending: true });
      var result = await originalPlayQueueAt.apply(this, args);
      var pendingJoinReady = finalizePendingRoomJoinPlayback(pendingJoinIntent);
      attachAudioEvents();
      updateMediaSessionMetadata();
      if (invokedFromUserGesture
        && window.audio
        && window.audio.src
        && (deferLeaderStart || holdForRoomJoin)) {
        // Track selection is itself a trusted playback gesture. Preserve that
        // intent across provider URL resolution so the first buffered track can
        // enter the V3 ready barrier without requiring a second click.
        await primeRoomMediaForSync(window.audio, true);
      }
      if (holdForRoomJoin && pendingJoinReady && !joinedRoom) {
        notify("正在加入同步房间，歌曲会在全部设备缓冲就绪后统一播放");
      }
      if (!applyingRoomState && bridge.sync.leader) {
        announceCurrentTrack(deferLeaderStart || (holdForRoomJoin && pendingJoinReady));
      }
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
        if (name === "togglePlay" && pendingRoomJoinPlayback && shouldHoldPlaybackForRoomJoin()) {
          notify("正在加入同步房间，等待所有设备缓冲后统一播放");
          return Promise.resolve(false);
        }
        if (name === "clearQueue") pendingRoomJoinPlayback = null;
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
    cancelTrackAnnouncement();
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
        name: "Classic " + String(navigator.platform || "Web").slice(0, 20),
        protocolVersion: ROOM_SYNC_PROTOCOL_VERSION,
        capabilities: ROOM_SYNC_CAPABILITIES
      }));
      clockPingTimer = window.setInterval(sendClockPing, 2500);
    });
    socket.addEventListener("message", function (event) {
      if (generation !== roomConnectionGeneration) return;
      var message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        bridge.sync.protocolError = "同步服务返回了无法解析的数据";
        updateRoomSyncUi();
        return;
      }
      if (message.type === "welcome") {
        clientId = String(message.clientId || "");
        bridge.sync.addresses = Array.isArray(message.addresses) ? message.addresses.map(String) : [];
        if (!bridge.sync.clockReady && Number(message.serverTime)) serverOffset = Number(message.serverTime) - Date.now();
        updateRoomSyncUi();
        return;
      }
      if (message.type === "pong") {
        recordClockPong(message, Date.now());
        if (lastRoomState
          && (!bridge.sync.leader
            || lastRoomState.preparing
            || Number(lastRoomState.scheduledAt || 0) > Date.now() + serverOffset)) {
          refreshRoomTimelineAfterClockSample(generation);
        }
        return;
      }
      if (message.type === "error") {
        var protocolCode = String(message.code || "");
        var refreshingProtocol = (protocolCode === "strict_sync_required" || protocolCode === "buffer_contract_required")
          && refreshForCurrentRoomProtocol();
        bridge.sync.protocolError = refreshingProtocol
          ? "检测到旧版同步脚本，正在自动刷新并恢复连接"
          : protocolErrorMessage(protocolCode);
        updateRoomSyncUi();
        return;
      }
      if (message.type === "joined") {
        joinedRoom = true;
        var joinedCapabilities = message.capabilities && typeof message.capabilities === "object"
          ? message.capabilities
          : {};
        var joinedProtocolVersion = Math.max(1, Math.floor(Number(message.protocolVersion) || 1));
        strictRoomProtocol = joinedProtocolVersion >= ROOM_SYNC_PROTOCOL_VERSION
          && joinedCapabilities.bufferContract === true
          && joinedCapabilities.armedPlayback === true;
        bridge.sync.protocolVersion = strictRoomProtocol ? ROOM_SYNC_PROTOCOL_VERSION : 1;
        bridge.sync.strictSync = Boolean(strictRoomProtocol && message.state && message.state.strictSync);
        bridge.sync.leader = Boolean(message.leader);
        bridge.sync.protocolError = "";
        if (message.state) bridge.sync.deviceCount = Math.max(0, Number(message.state.deviceCount) || 0);
        updateRoomSyncUi();
        reportLocalDeviceCalibration();
        if (message.state) enqueueRoomState(message.state, generation);
        if (bridge.sync.leader) {
          var resumePendingJoinPlayback = consumePendingRoomJoinPlayback();
          var initialVolume = Number(window.targetVolume);
          if (!Number.isFinite(initialVolume)) initialVolume = window.audio ? Number(window.audio.volume) : 0.72;
          sendCommand("volume", Math.max(0, Math.min(1, initialVolume)));
          if (pendingLocalFile) uploadLocalFileToRoom(pendingLocalFile);
          var joinAnnouncementSerial = trackAnnouncementSerial;
          joinAnnouncementTimer = window.setTimeout(function () {
            joinAnnouncementTimer = 0;
            if (joinAnnouncementSerial !== trackAnnouncementSerial
              || generation !== roomConnectionGeneration
              || !joinedRoom
              || !bridge.sync.leader) return;
            announceCurrentTrack(resumePendingJoinPlayback);
          }, 160);
        } else {
          pendingRoomJoinPlayback = null;
        }
        return;
      }
      if (message.type === "state" && message.state) enqueueRoomState(message.state, generation);
    });
    socket.addEventListener("error", function () {
      if (generation !== roomConnectionGeneration) return;
      bridge.sync.error = true;
      bridge.sync.protocolError = "同步连接发生错误，正在自动重连";
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
      bridge.sync.protocolVersion = 1;
      bridge.sync.strictSync = false;
      bridge.sync.preparing = false;
      bridge.sync.readyCount = 0;
      bridge.sync.requiredCount = 0;
      bridge.sync.armedCount = 0;
      bridge.sync.strictRequiredCount = 0;
      bridge.sync.commitState = "";
      bridge.sync.prepareError = "";
      bridge.sync.bufferProgress = 0;
      bridge.sync.prepareDeadline = 0;
      bridge.sync.prepareMaxDeadline = 0;
      bridge.sync.devices = [];
      joinedRoom = false;
      strictRoomProtocol = false;
      leaderBuffering = false;
      lastReadyPrepareId = "";
      lastArmedCommitKey = "";
      activeBufferLoadPrepareId = "";
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
      cancelTrackAnnouncement();
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
      window.clearTimeout(deviceStatusTimer);
      deviceStatusTimer = 0;
      pendingDeviceStatus = null;
      lastDeviceStatusSentAt = 0;
      localCalibrationMinimumUpdatedAt = 0;
      roomDeviceRenderSignature = "";
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
    installMediaSession();
    startServiceHealthPolling();
    window.clearInterval(deviceStatusPulseTimer);
    deviceStatusPulseTimer = window.setInterval(function () {
      reportCurrentRoomDeviceStatus(false);
    }, 500);
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
      refreshServiceHealth();
      if (lastRoomState
        && (!bridge.sync.leader
          || lastRoomState.preparing
          || Number(lastRoomState.scheduledAt || 0) > Date.now() + serverOffset)) {
        refreshRoomTimelineAfterClockSample(roomConnectionGeneration);
      }
    });
    window.addEventListener("online", function () {
      sendClockPing();
      refreshServiceHealth();
    });
    connectRoom();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startBridgeRuntime, { once: true });
  } else {
    startBridgeRuntime();
  }
})();
