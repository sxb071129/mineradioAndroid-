import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing source marker: ${startMarker}`);
  assert.ok(end > start, `missing source marker after ${startMarker}: ${endMarker}`);
  return source.slice(start, end);
}

test("home and classic routes embed the original player surface", async () => {
  const home = await readFile(path.join(root, "app", "page.tsx"), "utf8");
  const route = await readFile(path.join(root, "app", "classic", "page.tsx"), "utf8");
  const frame = await readFile(path.join(root, "app", "components", "ClassicPlayerFrame.tsx"), "utf8");
  const modern = await readFile(path.join(root, "app", "modern", "page.tsx"), "utf8");
  assert.match(home, /ClassicPlayerFrame/);
  assert.match(route, /ClassicPlayerFrame/);
  assert.match(frame, /\/classic\/index\.html\?room=/);
  assert.match(frame, /allowFullScreen/);
  assert.match(frame, /allow="autoplay; camera; clipboard-write; fullscreen"/);
  assert.match(frame, /height:\s*"100dvh"/);
  assert.match(modern, /MineradioPlayer/);
});

test("classic bundle carries its visual engine and Web bridge", async () => {
  const classicRoot = path.join(root, "public", "classic");
  const html = await readFile(path.join(classicRoot, "index.html"), "utf8");
  const bridge = await readFile(path.join(classicRoot, "classic-web-bridge.js"), "utf8");

  assert.match(html, /<script src="vendor\/qrcode\.min\.js\?v=1\.5\.4"><\/script>/);
  assert.match(html, /<script src="room-sync-core\.js\?v=20260726-calibration-v1"><\/script>/);
  assert.match(html, /<script src="classic-web-bridge\.js\?v=20260730-sync-v2"><\/script>/);
  assert.ok(
    html.indexOf('src="vendor/qrcode.min.js?v=1.5.4"')
      < html.indexOf('src="room-sync-core.js?v=20260726-calibration-v1"')
      && html.indexOf('src="room-sync-core.js?v=20260726-calibration-v1"')
        < html.indexOf('src="classic-web-bridge.js?v=20260730-sync-v2"'),
    "shared room sync core must load before the Classic bridge",
  );
  assert.match(html, /<script src="vendor\/three\.r128\.min\.js"><\/script>/);
  assert.match(html, /MineradioWebBridge\.audioUrl/);
  assert.match(html, /MineradioWebBridge\.coverUrl/);
  assert.match(bridge, /\/api\/kugou\/song\/url/);
  assert.match(bridge, /\/api\/v2\/playback\/prepare/);
  assert.match(bridge, /X-Mineradio-Application/);
  assert.match(bridge, /mineradio-web-v1/);
  assert.match(bridge, /prepared\.resolvedQuality/);
  assert.match(bridge, /prepared\.streamPath/);
  assert.match(bridge, /\/api\/kugou\/lyric/);
  assert.match(bridge, /searchParams\.set\("id", lyricTrackRef\)/);
  assert.match(bridge, /\/api\/qq\/login\/status/);
  assert.match(bridge, /\/api\/weather\/radio/);
  assert.match(bridge, /cloud-v2-.*kugou/);
  assert.match(bridge, /type:\s*"join"/);
  assert.match(bridge, /room:\s*roomCode/);
  assert.match(bridge, /canResumeFollowerFromGesture/);
  assert.match(bridge, /sendCommand\("volume", Math\.max/);
  assert.match(bridge, /pendingSeekMedia\.removeEventListener/);
  assert.match(bridge, /media\.readyState >= 1/);
  assert.match(bridge, /\/api\/tracks/);
  assert.match(bridge, /uploadLocalFileToRoom/);
  assert.match(bridge, /roomTrackDescriptor/);
  assert.match(bridge, /localUrl:\s*localUrl/);
  assert.match(bridge, /lastRevision = -1;\s*lastRoomState = null;/);
  assert.match(bridge, /var wasLeader = bridge\.sync\.leader/);
  assert.match(bridge, /bridge\.sync\.leader && wasLeader/);
  assert.match(bridge, /installFollowerControlGuards/);
  assert.match(bridge, /#progress-bar, #volume-slider/);
  assert.match(bridge, /roomStateChain = roomStateChain\.then/);
  assert.match(bridge, /enqueueRoomState\(message\.state, generation\)/);
  assert.match(bridge, /sendVolumeCommand\(Number\(window\.targetVolume\), false\)/);
  assert.match(bridge, /Math\.max\(0, 80 - elapsed\)/);
  assert.match(bridge, /if \(\/\\\.m4a\$\/\.test\(name\)\) return "audio\/mp4"/);

  await Promise.all([
    access(path.join(classicRoot, "vendor", "three.r128.min.js")),
    access(path.join(classicRoot, "vendor", "gsap.min.js")),
    access(path.join(classicRoot, "vendor", "music-tempo.min.js")),
    access(path.join(classicRoot, "vendor", "qrcode.min.js")),
    access(path.join(classicRoot, "assets", "skull-decimation-points.bin")),
  ]);
  assert.ok((await stat(path.join(classicRoot, "index.html"))).size > 1_000_000);
});

test("classic ports safe upstream visual and bounded recovery enhancements", async () => {
  const classicRoot = path.join(root, "public", "classic");
  const html = await readFile(path.join(classicRoot, "index.html"), "utf8");
  const bridge = await readFile(path.join(classicRoot, "classic-web-bridge.js"), "utf8");
  const terrain = await readFile(path.join(classicRoot, "sonic-terrain.js"), "utf8");
  const recovery = await readFile(path.join(classicRoot, "playback-recovery.js"), "utf8");

  assert.match(html, /<script src="sonic-terrain\.js\?v=20260730-v1"><\/script>/);
  assert.match(html, /<script src="playback-recovery\.js\?v=20260730-v2"><\/script>/);
  assert.ok(
    html.indexOf('src="sonic-terrain.js?v=20260730-v1"')
      < html.indexOf('src="playback-recovery.js?v=20260730-v2"'),
    "the terrain runtime must be available before the Classic app begins its frame loop",
  );
  for (const id of ["fx-sonicterrainintensity", "fx-sonicterrainresponse", "sonic-terrain-theme-seg"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /sonicTerrainIntensity: 1\.15/);
  assert.match(html, /sonicTerrainTheme: 'cover'/);
  assert.match(html, /var SONIC_TERRAIN_PRESET_INDEX = 7/);
  assert.match(html, /window\.MineradioSonicTerrain\.update\(dt,/);
  assert.match(html, /uniforms\.uPreset\.value = fx\.preset === SONIC_TERRAIN_PRESET_INDEX \? 5 : fx\.preset/);
  assert.doesNotMatch(html, /floorMirror/);
  assert.match(html, /function shelfPointerSelectionForegroundActive\(\)/);
  assert.match(html, /card\.selected && shelfPointerSelectionForegroundActive\(\)/);
  assert.match(html, /group\.renderOrder = \(contentOpenForLayer \|\| shelfPinnedOpen \|\| liftedCardActive\) \? 300 : 30/);

  assert.match(terrain, /window\.MineradioSonicTerrain/);
  assert.match(terrain, /INDEX: INDEX/);
  assert.match(terrain, /pointer-events:none/);
  assert.doesNotMatch(terrain, /AudioContext|\.src\s*=|fetch\(/);
  assert.match(recovery, /RECOVERY_TIMEOUT_MS = 20000/);
  assert.match(recovery, /MAX_QUEUE_ADVANCES = 2/);
  assert.match(recovery, /function isJoinedRoom\(\)/);
  assert.match(recovery, /function isRoomAuthoritative\(\)[\s\S]*?participants > 1/);
  assert.match(recovery, /Promise\.race\(\[originalResult, timeoutResult\]\)/);
  assert.match(recovery, /window\.MineradioPlaybackRecovery/);
  assert.doesNotMatch(recovery, /https?:\/\/|\/api\//);
  assert.match(html, /function isRoomControlledPlayback\(opts\)/);
  assert.match(html, /if \(isRoomControlledPlayback\(\)\) return;/);
  assert.match(html, /token !== trackSwitchToken \|\| isRoomControlledPlayback\(opts\)/);
  assert.match(bridge, /function roomPlaybackRequiresSharedAuthority\(\)/);
  assert.match(bridge, /var callerRequestedRoomSync = Boolean\(args\[1\] && args\[1\]\.roomSync\)/);
  assert.match(bridge, /var joinedPlayback = callerRequestedRoomSync \|\| \(joinedRoom && roomPlaybackRequiresSharedAuthority\(\)\)/);
  assert.match(bridge, /Object\.assign\(\{\}, args\[1\] \|\| \{\}, \{ roomSync: true \}\)/);
  assert.match(bridge, /Object\.assign\(\{\}, args\[1\] \|\| \{\}, \{ deferPlayback: true \}\)/);
  assert.match(bridge, /function cancelTrackAnnouncement\(\)[\s\S]*?trackAnnouncementSerial \+= 1/);
  assert.match(bridge, /announcementSerial !== trackAnnouncementSerial[\s\S]*?currentDescriptorId\(\) !== descriptorId/);
  assert.match(bridge, /function shouldHoldPlaybackForRoomJoin\(\)[\s\S]*?!joinedRoom/);
  assert.match(bridge, /\{ deferPlayback: true, roomJoinPending: true \}/);
  assert.match(bridge, /function consumePendingRoomJoinPlayback\(\)[\s\S]*?intent\.descriptorId/);
  assert.match(bridge, /announceCurrentTrack\(resumePendingJoinPlayback\)/);

  await Promise.all([
    access(path.join(classicRoot, "sonic-terrain.js")),
    access(path.join(classicRoot, "playback-recovery.js")),
  ]);
});

test("classic player exposes and wires the LAN room controls", async () => {
  const classicRoot = path.join(root, "public", "classic");
  const html = await readFile(path.join(classicRoot, "index.html"), "utf8");
  const bridge = await readFile(path.join(classicRoot, "classic-web-bridge.js"), "utf8");

  for (const id of [
    "room-sync-anchor",
    "room-sync-panel",
    "room-sync-current-code",
    "room-sync-role",
    "room-sync-status",
    "room-sync-devices",
    "room-service-relay",
    "room-service-relay-value",
    "room-service-music",
    "room-service-music-value",
    "room-service-room",
    "room-service-room-value",
    "room-sync-buffer-label",
    "room-sync-buffer-bar",
    "room-sync-qr",
    "room-sync-qr-status",
    "room-sync-device-list",
    "room-sync-protocol-error",
    "room-sync-input",
    "room-sync-join",
    "room-sync-link",
    "room-sync-copy",
    "room-sync-new",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /@media \(max-width:720px\)[\s\S]*?#room-sync-anchor/);
  assert.match(html, /#room-sync-panel\{[^}]*max-height:calc\(100dvh - 90px\);overflow-y:auto/);
  assert.match(html, /body\.mobile-optimized #room-sync-anchor,body\.android-shell #room-sync-anchor\{[^}]*height:44px/);
  assert.match(html, /\.room-sync-link\{[^}]*user-select:text/);
  assert.match(html, /id="room-sync-panel"[^>]*\sinert>/);
  assert.match(html, /class="room-sync-meta" aria-live="polite"/);
  assert.match(html, /class="room-service-grid" aria-label="服务状态"/);
  assert.match(html, /id="room-sync-device-list"[^>]*role="list"/);
  assert.match(html, /id="room-sync-protocol-error"[^>]*role="alert"[^>]*hidden/);
  assert.match(bridge, /function installRoomSyncUi\(\)/);
  assert.match(bridge, /function updateRoomSyncUi\(\)/);
  assert.match(bridge, /bridge\.sync\.addresses = Array\.isArray\(message\.addresses\)/);
  assert.match(bridge, /url\.hostname = preferredRoomHost\(\)/);
  assert.match(bridge, /navigator\.clipboard && window\.isSecureContext/);
  assert.match(bridge, /navigator\.clipboard\.writeText\(value\)\.catch/);
  assert.match(bridge, /document\.execCommand\("copy"\)/);
  assert.match(bridge, /window\.top\.location\.assign\(target\)/);
  assert.match(bridge, /window\.crypto\.getRandomValues\(bytes\)/);
  assert.match(bridge, /data-room-ui-installed/);
  assert.match(bridge, /anchor\.addEventListener\("pointerdown"/);
  assert.match(bridge, /roomUiRetryTimer = window\.setInterval/);
  assert.match(bridge, /function privateIpv4Candidate\(value\)/);
  assert.match(bridge, /function recordClockPong\(message, receivedAt\)/);
  assert.match(bridge, /serverReceivedAt/);
  assert.match(bridge, /clockPingTimer = window\.setInterval\(sendClockPing, 2500\)/);
  assert.match(bridge, /var sameRevision = revision === lastRevision/);
  assert.match(bridge, /reconcileRoomPlayback\(state, false\)/);
  assert.match(bridge, /Math\.max\(0\.96, Math\.min\(1\.04, 1 \+ drift \* 0\.3\)\)/);
  assert.match(bridge, /media\.addEventListener\("waiting", onLeaderWaiting\)/);
  assert.match(bridge, /Date\.now\(\) - lastPositionSentAt < 1000/);
  assert.match(bridge, /sendCommand\("ready", readyPayload\)/);
  assert.match(bridge, /Number\(state\.scheduledAt\) - \(Date\.now\(\) \+ serverOffset\)/);
  assert.match(bridge, /hasBufferedPlaybackWindow\(media, target\)/);
  assert.match(bridge, /window\.MineradioRoomSyncCore/);
  assert.match(bridge, /core\.measureBufferedWindow\(media, target,/);
  assert.match(bridge, /sendCommand\("device-status", immediate\)/);
  assert.match(bridge, /bufferedSeconds:\s*measurement\.bufferedSeconds/);
  assert.match(bridge, /bufferGoalSeconds:\s*measurement\.bufferGoalSeconds/);
  assert.match(bridge, /Object\.assign\(\{\}, deviceStatus\.payload, \{ ready: true \}\)/);
  assert.match(bridge, /window\.setInterval\(function \(\) \{\s*reportCurrentRoomDeviceStatus\(false\);\s*\}, 500\)/);
  assert.match(bridge, /\["loadedmetadata", "durationchange"\]\.forEach[\s\S]*?media\.addEventListener\(eventName/);
  assert.match(bridge, /checkServiceHealth\("relay", relayHttpOrigin\)/);
  assert.match(bridge, /checkServiceHealth\("music", apiOrigin\)/);
  assert.match(bridge, /new URL\("\/health", origin \+ "\/"\)/);
  assert.match(bridge, /document\.visibilityState === "visible"/);
  assert.match(bridge, /message\.type === "error"/);
  assert.match(bridge, /protocolErrorMessage\(message\.code\)/);
  assert.match(bridge, /deferPlayback: true/);
  assert.match(html, /opts\.deferPlayback/);
  assert.match(html, /等待全部设备缓冲就绪，再按统一时刻起播/);
  assert.match(bridge, /installRoomSyncUi\(\);[\s\S]*?connectRoom\(\);/);

  const deviceRenderer = sourceBetween(bridge, "function renderRoomDevices", "function protocolErrorMessage");
  assert.match(deviceRenderer, /document\.createElement\("div"\)/);
  assert.match(deviceRenderer, /name\.textContent = String\(device\.name/);
  assert.match(deviceRenderer, /state\.textContent = stateLabel\.text/);
  assert.doesNotMatch(deviceRenderer, /\.innerHTML\s*=/);
});

test("classic room QR stays local and falls back when the Relay endpoint stalls", async () => {
  const classicRoot = path.join(root, "public", "classic");
  const html = await readFile(path.join(classicRoot, "index.html"), "utf8");
  const bridge = await readFile(path.join(classicRoot, "classic-web-bridge.js"), "utf8");
  const qrVendor = await readFile(path.join(classicRoot, "vendor", "qrcode.min.js"), "utf8");
  const qrRenderer = sourceBetween(bridge, "function renderRoomQr", "function boundedMetric");

  assert.match(html, /id="room-sync-qr-status" role="status" aria-live="polite"/);
  assert.match(qrRenderer, /new URL\("\/api\/room\/qr", relayHttpOrigin \+ "\/"\)/);
  assert.match(qrRenderer, /endpoint\.searchParams\.set\("text", value\)/);
  assert.match(qrRenderer, /new window\.AbortController\(\)/);
  assert.match(qrRenderer, /abortController\.abort\(\)/);
  assert.match(qrRenderer, /2500/);
  assert.match(qrRenderer, /window\.MineradioQRCode/);
  assert.match(qrRenderer, /qr\.toDataURL\(value/);
  assert.doesNotMatch(qrRenderer, /googleapis|quickchart|qrserver|chart\.google/);
  assert.match(qrVendor, /qrcode 1\.5\.4 \| MIT/);
});

test("classic room calibration persists per device and compensates the audible timeline", async () => {
  const html = await readFile(path.join(root, "public", "classic", "index.html"), "utf8");
  const bridge = await readFile(path.join(root, "public", "classic", "classic-web-bridge.js"), "utf8");
  const audioGraph = sourceBetween(html, "function initAudio()", "function resumeAudioAnalysis");
  const command = sourceBetween(bridge, "function sendCommand", "function sendDeviceStatusCommand");
  const calibrationSender = sourceBetween(
    bridge,
    "function sendDeviceCalibrationCommand",
    "function sendVolumeCommand",
  );

  assert.match(html, /mineradio-room-device-calibration-v1/);
  assert.match(html, /clampRange\(Number\(value\.volumeTrimDb\) \|\| 0, -24, 12\)/);
  assert.match(html, /clampRange\(Number\(value\.delayMs\) \|\| 0, 0, 500\)/);
  assert.match(html, /window\.applyRoomDeviceCalibration = applyRoomDeviceCalibration/);
  assert.match(html, /window\.getRoomDeviceCalibration = getRoomDeviceCalibration/);
  assert.match(audioGraph, /roomCalibrationGainNode = audioCtx\.createGain\(\)/);
  assert.match(audioGraph, /roomCalibrationLimiterNode = audioCtx\.createDynamicsCompressor\(\)/);
  assert.match(audioGraph, /roomCalibrationDelayNode = audioCtx\.createDelay\(0\.55\)/);
  assert.match(audioGraph, /threshold\.value = -1/);
  assert.match(audioGraph, /ratio\.value = 20/);
  assert.match(
    audioGraph,
    /gainNode\.connect\(roomCalibrationGainNode\)[\s\S]*?roomCalibrationGainNode\.connect\(roomCalibrationLimiterNode\)[\s\S]*?roomCalibrationLimiterNode\.connect\(roomCalibrationDelayNode\)[\s\S]*?roomCalibrationDelayNode\.connect\(audioCtx\.destination\)/,
  );
  assert.match(bridge, /Math\.max\(-24, Math\.min\(12, Number\(input\.volumeTrimDb\) \|\| 0\)\)/);
  assert.match(bridge, /minimum: -24[\s\S]*?maximum: 12[\s\S]*?step: 0\.5/);
  assert.match(bridge, /if \(!bridge\.sync\.leader \|\| !device\.clientId\) return/);
  assert.match(command, /action === "device-calibration"/);
  assert.match(command, /message\.targetClientId/);
  assert.match(command, /message\.volumeTrimDb = calibrationValue\.volumeTrimDb/);
  assert.match(command, /message\.delayMs = calibrationValue\.delayMs/);
  assert.match(calibrationSender, /pendingCalibration/);
  assert.match(calibrationSender, /Math\.max\(0, 120 - elapsed\)/);
  assert.match(bridge, /applyCalibrationFromRoomDevices\(bridge\.sync\.devices\)/);
  assert.match(bridge, /reportLocalDeviceCalibration\(\);\s*if \(message\.state\) enqueueRoomState/);
  assert.match(
    bridge,
    /Number\(activeState\.scheduledAt\) - \(Date\.now\(\) \+ serverOffset\) - localDeviceDelayMs\(\)/,
  );
  assert.match(
    bridge,
    /Number\(state\.scheduledAt\) - \(Date\.now\(\) \+ serverOffset\) - localDeviceDelayMs\(\)/,
  );
  assert.match(bridge, /message\.position = Math\.max\(0, message\.position - delayMs \/ 1000\)/);
});

test("classic exposes lock-screen metadata and guarded Media Session controls", async () => {
  const bridge = await readFile(path.join(root, "public", "classic", "classic-web-bridge.js"), "utf8");
  const metadata = sourceBetween(
    bridge,
    "function updateMediaSessionMetadata",
    "function mediaSessionPosition",
  );
  const installer = sourceBetween(bridge, "function installMediaSession", "function descriptorForSong");

  assert.match(metadata, /new window\.MediaMetadata\(metadata\)/);
  assert.match(metadata, /metadata\.artwork = \[\{ src: cover \}\]/);
  assert.match(bridge, /navigator\.mediaSession\.setPositionState/);
  assert.match(bridge, /position - localDeviceDelayMs\(\) \/ 1000/);
  for (const action of [
    "play",
    "pause",
    "previoustrack",
    "nexttrack",
    "seekbackward",
    "seekforward",
    "seekto",
    "stop",
  ]) {
    assert.match(installer, new RegExp(`${action}: function`), `${action} handler must be installed`);
  }
  assert.match(installer, /navigator\.mediaSession\.setActionHandler\(action, handlers\[action\]\)/);
  assert.match(bridge, /function mediaSessionSeekTo[\s\S]*?blockFollowerControl\(\)/);
  assert.match(bridge, /if \(joinedRoom && bridge\.sync\.leader\) sendSeekCommand\(target, true\)/);
  assert.match(bridge, /media\.addEventListener\("timeupdate"[\s\S]*?updateMediaSessionPlaybackState\(false\)/);
  assert.match(bridge, /installFollowerControlGuards\(\);[\s\S]*?installMediaSession\(\);/);
});

test("classic media URLs no longer depend on the removed upstream proxy", async () => {
  const html = await readFile(path.join(root, "public", "classic", "index.html"), "utf8");
  assert.match(html, /var proxyAudioUrl = window\.MineradioWebBridge/);
  assert.match(html, /return window\.MineradioWebBridge \? window\.MineradioWebBridge\.coverUrl/);
  assert.match(html, /fetch\('vendor\/music-tempo\.min\.js'\)/);
});

test("classic restores Web DIY controls, original mobile gestures, and portrait rendering", async () => {
  const html = await readFile(path.join(root, "public", "classic", "index.html"), "utf8");

  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /height:100vh;height:100dvh/);
  for (const id of ["web-diy-mode-btn", "fx-fab", "mobile-gesture-btn"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /\['diy-mode-btn', 'fullscreen-diy-btn', 'web-diy-mode-btn'\]/);
  assert.match(html, /onclick="toggleFxPanelFromFab\(event\)"/);
  assert.match(html, /if \(panel\.classList\.contains\('show'\)\)/);
  assert.match(html, /panel\.classList\.remove\('peek', 'closing'\)/);
  assert.match(html, /panel\.classList\.add\('show'\)/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /function isTouchInteractionShell\(\)/);
  assert.match(html, /function initMobileInteractionLogic\(\)/);
  assert.match(html, /if \(isMobileInteractionShell\(\)\) \{[\s\S]*?setPeek\(fp, false, 'fx'\);[\s\S]*?setPeek\(pp, false, 'pl'\);/);
  assert.match(html, /UI_HIT_SELECTOR[^\n]*#bottom-handle,#mobile-gesture-btn,#web-diy-mode-btn/);
  assert.match(html, /mobileStagePointer\.edge === 'left'/);
  assert.match(html, /mobileStagePointer\.edge === 'right'/);
  assert.match(html, /mobileStagePointer\.edge === 'bottom'/);
  assert.match(html, /openMobileVisualConsole\(\)/);
  assert.match(html, /applyParticleSpinDrag\(dx, dy, dt\)/);
  assert.match(html, /isDoubleTap[\s\S]*?togglePlay\(\)/);
  assert.match(html, /@media \(max-width:720px\) and \(orientation:portrait\)/);
  assert.match(html, /safe-area-inset-bottom/);
  assert.match(html, /body\.mobile-optimized #bottom-bar/);
  assert.match(html, /function isPortraitStageLayout\(\)/);
  assert.match(html, /canvasW:1536, canvasH:512/);
  assert.match(html, /maxLines:2[\s\S]*?worldW:4\.72/);
});

test("classic DIY primary switches have usable controls and survive the main settings round trip", async () => {
  const html = await readFile(path.join(root, "public", "classic", "index.html"), "utf8");
  const reader = sourceBetween(html, "function readSavedLyricLayout()", "function saveLyricLayout()");
  const writer = sourceBetween(html, "function saveLyricLayout()", "function normalizeHexColor(");

  assert.match(html, /id="t-float"[^>]*onclick="toggleFx\('floatLayer'\)"/);
  assert.doesNotMatch(html, /#t-float[^{}]*\{[^}]*display\s*:\s*none(?:\s*!important)?/);
  assert.match(html, /id="t-aidepth"[^>]*onclick="toggleFx\('aiDepth'\)"/);
  assert.match(
    html,
    /function updateUserCapsuleAutoHideFromPointer\(x, y\)[\s\S]*?getBoundingClientRect\(\)[\s\S]*?insideCapsule[\s\S]*?nearTopRight/,
    "the hidden desktop capsule must stay reachable while moving onto its DIY control",
  );

  for (const key of ["floatLayer", "aiDepth", "particleLyrics", "backCover"]) {
    assert.match(reader, new RegExp(`${key}:\\s*[^,\\n]*raw\\.${key}`), `${key} must be restored from the main settings store`);
    assert.match(writer, new RegExp(`${key}:\\s*[^,\\n]*fx\\.${key}`), `${key} must be written to the main settings store`);
  }
});

test("classic DIY preserves valid zero-valued visual settings", async () => {
  const html = await readFile(path.join(root, "public", "classic", "index.html"), "utf8");
  const reader = sourceBetween(html, "function readSavedLyricLayout()", "function saveLyricLayout()");
  const writer = sourceBetween(html, "function saveLyricLayout()", "function normalizeHexColor(");

  for (const key of ["cinemaShake", "bgFade", "bloomStrength", "lyricGlowStrength"]) {
    assert.doesNotMatch(
      reader,
      new RegExp(`Number\\(raw\\.${key}\\)\\s*\\|\\|\\s*fxDefaults\\.${key}`),
      `${key}=0 must not be replaced by its default while reading`,
    );
    assert.doesNotMatch(
      writer,
      new RegExp(`Number\\(fx\\.${key}\\)\\s*\\|\\|\\s*fxDefaults\\.${key}`),
      `${key}=0 must not be replaced by its default while saving`,
    );
  }
});

test("classic DIY one-control reset reapplies dependent visual surfaces", async () => {
  const html = await readFile(path.join(root, "public", "classic", "index.html"), "utf8");
  const reset = sourceBetween(html, "function resetFxSliderValue", "function ensureFxSliderResetButton");

  assert.match(reset, /backgroundOpacity[\s\S]*?updateCustomBackgroundControls\(\)/);
  assert.match(reset, /shelf(?:Size|OffsetX|OffsetY|OffsetZ|AngleY|Opacity|BgOpacity)[\s\S]*?shelfManager\.refreshTheme\(\)/);
  assert.match(reset, /lyric(?:LetterSpacing|LineHeight|Weight)[\s\S]*?refreshCurrentLyricStyle\(\)/);
  assert.match(reset, /(?:lyricScale|lyricGlowStrength|desktopLyricsSize|desktopLyricsOpacity|desktopLyricsY)[\s\S]*?pushDesktopLyricsState\(true\)/);
  assert.match(reset, /wallpaperOpacity[\s\S]*?pushWallpaperState\(true\)/);
});

test("classic DIY strength sliders automatically enable their visible effect switches", async () => {
  const html = await readFile(path.join(root, "public", "classic", "index.html"), "utf8");
  const bindings = sourceBetween(html, "function bindFxPanel()", "function toggleFx(key)");

  assert.match(
    bindings,
    /pair\[1\] === 'bloomStrength'[\s\S]*?fx\.bloomStrength > 0[\s\S]*?!fx\.bloom[\s\S]*?fx\.bloom = true[\s\S]*?getElementById\('t-bloom'\)/,
  );
  assert.match(
    bindings,
    /pair\[1\] === 'lyricGlowStrength'[\s\S]*?fx\.lyricGlowStrength > 0[\s\S]*?!fx\.lyricGlow[\s\S]*?fx\.lyricGlow = true[\s\S]*?getElementById\('t-lyricGlow'\)/,
  );
});

test("classic DIY background images use durable descriptors and clean stale blobs safely", async () => {
  const html = await readFile(path.join(root, "public", "classic", "index.html"), "utf8");
  const imageImport = sourceBetween(html, "function readBackgroundImageFile(file)", "function readBackgroundVideoFile(file)");
  const archiveApply = sourceBetween(html, "function applyFxArchiveSnapshot(snapshot)", "var hadStoredUserFxArchives");
  const reset = sourceBetween(html, "function resetFx()", "function setShelfMode(m)");

  assert.match(imageImport, /encodeCustomBackgroundImageBlob\(cv\)/);
  assert.match(
    imageImport,
    /putCustomBackgroundBlob\(id, blob,[\s\S]*?setCustomBackgroundMedia\(\{\s*type:\s*'image',\s*id:\s*id,/,
  );
  for (const block of [archiveApply, reset]) {
    assert.match(block, /customBgImportToken \+= 1/);
    assert.match(block, /deleteCustomBackgroundBlobIfUnused\(previousBackground\.id\)/);
    assert.doesNotMatch(block, /deleteCustomBackgroundBlob\(previousBackground\.id\)/);
  }
});

test("classic DIY user archives retain media settings without duplicate handlers", async () => {
  const html = await readFile(path.join(root, "public", "classic", "index.html"), "utf8");
  const normalizeArchive = sourceBetween(html, "function normalizeFxArchiveSnapshot(raw)", "function readUserFxArchives()");
  const captureArchive = sourceBetween(html, "function captureFxArchiveSnapshot()", "function applySavedLyricPaletteState()");

  assert.match(normalizeArchive, /backgroundMedia:\s*normalizeCustomBackgroundMedia\(raw\.backgroundMedia \|\| raw\.backgroundImage\)/);
  assert.match(normalizeArchive, /wallpaperOpacity:\s*archiveNumber\(raw, 'wallpaperOpacity'/);
  assert.match(captureArchive, /normalizeFxArchiveSnapshot\(Object\.assign\(\{ visualPresetSchema: VISUAL_PRESET_SCHEMA \}, fx\)\)/);

  for (const name of [
    "normalizeFxArchiveSnapshot",
    "readUserFxArchives",
    "saveUserFxArchives",
    "applyFxArchiveSnapshot",
    "renderUserFxArchives",
    "saveUserFxArchive",
    "applyUserFxArchive",
  ]) {
    const definitions = html.match(new RegExp(`function\\s+${name}\\s*\\(`, "g")) ?? [];
    assert.equal(definitions.length, 1, `${name} must have exactly one function definition`);
  }
});

test("classic DIY archive files carry local background assets across devices", async () => {
  const html = await readFile(path.join(root, "public", "classic", "index.html"), "utf8");
  const exporter = sourceBetween(html, "function userFxArchiveExportPayload(slot)", "function normalizeImportedFxArchivePayload");
  const restorer = sourceBetween(html, "function restoreImportedUserFxArchiveBackground", "function importUserFxArchiveText");
  const importer = sourceBetween(html, "function importUserFxArchiveText", "function importUserFxArchiveFromDialog");

  assert.match(html, /var USER_FX_ARCHIVE_SCHEMA = 2/);
  assert.match(exporter, /getCustomBackgroundBlob\(media\.id\)/);
  assert.match(exporter, /readArchiveBlobAsDataUrl\(blob\)/);
  assert.match(exporter, /payload\.backgroundAsset\s*=/);
  assert.match(exporter, /payload\.snapshot\.backgroundMedia = null/);
  assert.match(exporter, /背景素材不存在或无法读取，未导出不完整存档/);

  assert.match(restorer, /archiveDataUrlToBlob\(dataUrl,/);
  assert.match(restorer, /putCustomBackgroundBlob\(id, blob/);
  assert.match(restorer, /slot\.snapshot\.backgroundMedia = \{ type: type, id: id, src: ''/);
  assert.match(restorer, /本地背景未包含在旧版存档中，已清除失效引用/);
  assert.match(importer, /if \(!saveUserFxArchives\(\)\)[\s\S]*?userFxArchives\.pop\(\)/);
  assert.match(importer, /deleteCustomBackgroundBlobIfUnused\(result\.storedId\)/);
});

test("classic DIY background media changes roll back atomically when settings storage fails", async () => {
  const html = await readFile(path.join(root, "public", "classic", "index.html"), "utf8");
  const setter = sourceBetween(html, "function setCustomBackgroundMedia(media, silent)", "var CUSTOM_BG_DATA_URL_FALLBACK_LIMIT");

  assert.match(setter, /var saved = saveLyricLayout\(\)/);
  assert.match(
    setter,
    /if \(!saved\)[\s\S]*?fx\.backgroundMedia = previous[\s\S]*?fx\.backgroundImage = previous && previous\.type === 'image'/,
  );
  assert.match(setter, /deleteCustomBackgroundBlobIfUnused\(media\.id\)/);
  assert.match(setter, /return false/);
  assert.match(setter, /if \(previous && previous\.id[\s\S]*?deleteCustomBackgroundBlobIfUnused\(previous\.id\)/);
});

test("classic DIY archive import and export bound background memory before decoding", async () => {
  const html = await readFile(path.join(root, "public", "classic", "index.html"), "utf8");
  const exporter = sourceBetween(html, "function readArchiveBlobAsDataUrl(blob)", "function normalizeImportedFxArchivePayload");
  const restorer = sourceBetween(html, "function restoreImportedUserFxArchiveBackground", "function importUserFxArchiveText");
  const textImporter = sourceBetween(html, "function importUserFxArchiveText", "function importUserFxArchiveFromDialog");
  const fileImporter = sourceBetween(html, "function readUserFxArchiveImportFile", "function bindUserFxArchiveDrop");

  assert.match(html, /var USER_FX_ARCHIVE_ASSET_MAX_BYTES = 24 \* 1024 \* 1024/);
  assert.match(html, /var USER_FX_ARCHIVE_TEXT_MAX_CHARS = 36 \* 1024 \* 1024/);
  assert.match(exporter, /userFxArchiveAssetTooLarge\(blob\.size\)[\s\S]*?reader\.readAsDataURL\(blob\)/);
  assert.match(exporter, /userFxArchiveDataUrlTooLarge\(normalizedDataUrl\)[\s\S]*?atob\(/);
  assert.match(exporter, /ARCHIVE_BACKGROUND_TOO_LARGE/);
  assert.match(restorer, /userFxArchiveDataUrlTooLarge\(dataUrl\)[\s\S]*?archiveDataUrlToBlob\(dataUrl,/);
  assert.match(textImporter, /text\.length > USER_FX_ARCHIVE_TEXT_MAX_CHARS[\s\S]*?JSON\.parse\(text\)/);
  assert.match(fileImporter, /file\.size[\s\S]*?USER_FX_ARCHIVE_FILE_MAX_BYTES[\s\S]*?reader\.readAsText/);
});

test("classic DIY toggle state and locked slider reset controls expose their real state", async () => {
  const html = await readFile(path.join(root, "public", "classic", "index.html"), "utf8");
  const development = sourceBetween(html, "function updateDevelopmentFxControls()", "function updateDesktopLyricsFpsControls()");
  const updater = sourceBetween(html, "function syncFxTogglePressedState(toggle)", "function animateFxResetButton");
  const bindings = sourceBetween(html, "function bindFxPanel()", "function toggleFx(key)");
  const toggle = sourceBetween(html, "function toggleFx(key)", "function toggleFxPanelFromFab");

  assert.match(development, /row\.querySelector\('\.fx-reset-one'\)[\s\S]*?reset\.disabled = locked/);
  assert.match(updater, /setAttribute\('aria-pressed', toggle\.classList\.contains\('on'\) \? 'true' : 'false'\)/);
  assert.match(updater, /syncAllFxTogglePressedStates\(\)/);
  assert.match(bindings, /syncFxTogglePressedState\(el\)/);
  assert.match(toggle, /syncAllFxTogglePressedStates\(\)/);
  assert.match(html, /\.fx-reset-one:disabled\{/);
});

test("classic full DIY reset reapplies shelf mode and lyric styling", async () => {
  const html = await readFile(path.join(root, "public", "classic", "index.html"), "utf8");
  const reset = sourceBetween(html, "function resetFx()", "function setShelfMode(m)");

  assert.match(reset, /setStageLyricPalette\(/);
  assert.match(reset, /refreshCurrentLyricStyle\(\)/);
  assert.match(reset, /setShelfMode\(fx\.shelf\)/);
  assert.match(reset, /shelfManager && shelfManager\.refreshTheme/);
});

test("classic full DIY reset forces the default preset and resets the camera orbit", async () => {
  const html = await readFile(path.join(root, "public", "classic", "index.html"), "utf8");
  const reset = sourceBetween(html, "function resetFx()", "function setShelfMode(m)");

  assert.match(reset, /fx\.preset\s*=\s*-1/);
  assert.match(
    reset,
    /setPreset\(fxDefaults\.preset,\s*\{[^}]*preserveCamera:\s*false[^}]*skipTransition:\s*true[^}]*\}\)/,
  );
  assert.doesNotMatch(reset, /setPreset\(fx\.preset,/);
});

test("classic color lab never opens from disabled or unavailable DIY controls", async () => {
  const html = await readFile(path.join(root, "public", "classic", "index.html"), "utf8");
  const pickerBinding = sourceBetween(html, "function bindColorLabPicker(picker)", "function liftFxFloatingPopups()");
  const rowBinding = sourceBetween(html, "function bindColorLabRows()", "function repositionFxFloatingPanels()");

  assert.match(pickerBinding, /picker\.disabled/);
  assert.match(pickerBinding, /fx-unavailable/);
  assert.match(pickerBinding, /dev-locked/);
  assert.equal(
    (pickerBinding.match(/openColorLabForPicker\(picker\)/g) ?? []).length,
    1,
    "all picker event paths must pass through one guarded opener",
  );
  assert.match(pickerBinding, /addEventListener\('click'[\s\S]*?openFromPickerEvent\(e\)/);

  const rowGuard = rowBinding.indexOf("picker.disabled");
  const unavailableGuard = rowBinding.indexOf("row.classList.contains('fx-unavailable')");
  const lockedGuard = rowBinding.indexOf("row.classList.contains('dev-locked')");
  const openCall = rowBinding.indexOf("openColorLabForPicker(picker)");
  assert.ok(rowGuard >= 0 && unavailableGuard > rowGuard && lockedGuard > unavailableGuard);
  assert.ok(openCall > lockedGuard, "row availability guards must run before opening the color lab");
});

test("classic camera gestures are cancellable, front-camera aware, and honest on LAN HTTP", async () => {
  const html = await readFile(path.join(root, "public", "classic", "index.html"), "utf8");

  assert.match(html, /function gestureSecureContextAvailable\(\)/);
  assert.match(html, /INSECURE_CAMERA_CONTEXT/);
  assert.match(html, /局域网 HTTP 无法使用摄像头手势，请改用 HTTPS；触摸手势仍可用/);
  assert.match(html, /var gestureStartSerial = 0/);
  assert.match(html, /var scriptLoadPromises = Object\.create\(null\)/);
  assert.match(html, /function gestureStartStillWanted\(token, session\)/);
  assert.match(html, /function stopGestureFrameLoop\(\)/);
  assert.match(html, /GESTURE_FRAME_MIN_MS = 1000 \/ 18/);
  assert.match(html, /if \(gestureSession === session\) gestureFrameBusy = false/);
  assert.match(html, /async function gestureFrontCameraDeviceIds\(\)/);
  assert.match(html, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(html, /facingMode.*'user'/s);
  assert.match(html, /modelComplexity: mobileHands \? 0 : 1/);
  assert.match(html, /function releaseGestureSession\(session\)/);
  assert.match(html, /session\.hands && session\.hands\.close/);
  assert.match(html, /function stopGestureControl\(\) \{\s*gestureStartSerial\+\+/);
  const stopStart = html.indexOf("function stopGestureControl()");
  const stopEnd = html.indexOf("function resizeHandCanvas()", stopStart);
  assert.ok(stopStart >= 0 && stopEnd > stopStart);
  assert.doesNotMatch(html.slice(stopStart, stopEnd), /if \(!gestureActive\) return/);
  assert.match(html, /window\.addEventListener\('pagehide', stopGestureControl\)/);
  const dismissSplash = sourceBetween(html, "function dismissSplash()", "function markSplashReadyToEnter()");
  const pageShow = sourceBetween(html, "window.addEventListener('pageshow'", "function onHandLost()");
  assert.match(dismissSplash, /(?:restore|resume|start)[A-Za-z]*Gesture[A-Za-z]*\(/i);
  assert.match(pageShow, /fx(?:\s*&&)?[\s\S]*?\.cam\s*===\s*'gesture'[\s\S]*?(?:restore|resume|start)[A-Za-z]*Gesture[A-Za-z]*\(/i);
  assert.doesNotMatch(pageShow, /event\.persisted\s*&&/);
  assert.doesNotMatch(html, /@mediapipe\/camera_utils/);
});

test("classic camera gestures stop and synchronize UI after repeated frame failures", async () => {
  const html = await readFile(path.join(root, "public", "classic", "index.html"), "utf8");
  const frameLoop = sourceBetween(html, "function startGestureFrameLoop(session)", "async function startGestureCameraStream");

  assert.match(html, /var GESTURE_FRAME_FAILURE_LIMIT = 4/);
  assert.match(frameLoop, /session\.frameFailureCount = 0/);
  assert.match(frameLoop, /session\.frameFailureCount = \(Number\(session\.frameFailureCount\) \|\| 0\) \+ 1/);
  assert.match(frameLoop, /session\.frameFailureCount < GESTURE_FRAME_FAILURE_LIMIT/);
  assert.match(frameLoop, /stopGestureControl\(\)/);
  assert.match(frameLoop, /fx\.cam = 'off'/);
  assert.match(frameLoop, /syncMobileGestureButton\(false\)/);
  assert.match(frameLoop, /saveLyricLayout\(\)/);
  assert.match(frameLoop, /手势识别连续失败，已自动关闭/);
  assert.match(frameLoop, /\.then\(function\(\)\{[\s\S]*?session\.frameFailureCount = 0/);
});

test("classic particle lyrics free GPU resources and persist when disabled", async () => {
  const html = await readFile(path.join(root, "public", "classic", "index.html"), "utf8");
  const setter = sourceBetween(html, "function setParticleLyricsSilently(on)", "function updateImmersiveButton()");

  assert.match(setter, /if \(fx\.particleLyrics\)[\s\S]*?createLyricsParticles\(\)/);
  assert.match(setter, /else[\s\S]*?disposeLyricsParticles\(\)/);
  assert.match(setter, /saveLyricLayout\(\)/);
});

test("classic beat analysis uses a bounded cloud stream without changing playback quality", async () => {
  const html = await readFile(path.join(root, "public", "classic", "index.html"), "utf8");
  const resolverStart = html.indexOf("async function fetchBeatPrefetchAudioUrl(song)");
  const resolverEnd = html.indexOf("async function resolveBeatAnalysisAudioUrl", resolverStart);
  assert.ok(resolverStart >= 0 && resolverEnd > resolverStart);
  const resolver = html.slice(resolverStart, resolverEnd);

  assert.match(html, /var BEAT_ANALYSIS_CLOUD_QUALITY = 'standard'/);
  assert.match(resolver, /var analysisQuality = BEAT_ANALYSIS_CLOUD_QUALITY/);
  assert.match(resolver, /quality=' \+ encodeURIComponent\(analysisQuality\)/);
  assert.match(resolver, /resolvedQuality !== 'standard' && resolvedQuality !== 'exhigh'/);
  assert.doesNotMatch(resolver, /normalizePlaybackQuality\(playbackQuality\)/);
  assert.doesNotMatch(resolver, /qqPlaybackQualityCeiling/);

  assert.match(html, /var analysisAudioUrl = await resolveBeatAnalysisAudioUrl\(song, audioUrl\)/);
  assert.match(html, /schedulePodcastDjAnalysis\(djKey, data\.url, djTok, djDurationSec, song\)/);
  assert.match(html, /dc\.decodeAudioData\(ab, resolve, reject\)/);
  assert.match(html, /ab = null;/);
  assert.doesNotMatch(html, /dc\.decodeAudioData\(ab\.slice\(0\)/);

  // Playback itself must continue to honor the user's selected quality.
  assert.match(html, /var requestedQuality = normalizePlaybackQuality\(opts\.qualityOverride \|\| playbackQuality\)/);
  assert.match(html, /audio\.src = proxyAudioUrl/);
});

test("classic queue beatmap prefetch is disabled on mobile and reduced-resource devices", async () => {
  const html = await readFile(path.join(root, "public", "classic", "index.html"), "utf8");
  const detectorStart = html.indexOf("function isBeatPrefetchDisabledForDevice()");
  const detectorEnd = html.indexOf("function findNextBeatPrefetchIndex", detectorStart);
  assert.ok(detectorStart >= 0 && detectorEnd > detectorStart);
  const detector = html.slice(detectorStart, detectorEnd);

  assert.match(detector, /userAgentData && nav\.userAgentData\.mobile/);
  assert.match(detector, /matchMedia\('\(pointer: coarse\)'\)\.matches/);
  assert.match(detector, /connection && connection\.saveData/);
  assert.match(detector, /nav\.deviceMemory/);
  assert.match(detector, /nav\.hardwareConcurrency/);
  assert.match(
    html,
    /localBeatAnalysis\.active \|\| isBeatPrefetchDisabledForDevice\(\)/,
  );
  assert.match(
    html,
    /async function runQueueBeatPrefetch[\s\S]*?if \(isBeatPrefetchDisabledForDevice\(\)\) return;/,
  );
});

test("classic queue can play LAN-relayed local tracks without treating them as Netease", async () => {
  const html = await readFile(path.join(root, "public", "classic", "index.html"), "utf8");
  assert.match(html, /var isLocalPlayback = !!\(song/);
  assert.match(html, /playbackProvider = isLocalPlayback \? 'local'/);
  assert.match(html, /\{ url: song\.localUrl, provider: 'local', level: 'standard', trial: false \}/);
  assert.match(html, /var nextLocalSong = song && \(song\.type === 'local'/);
  assert.match(html, /releaseLocalSongObjectUrl\(currentLocalSong, nextLocalSong && nextLocalSong\.localUrl\)/);
});

test("classic Kugou lyrics and playback use the opaque play key and bound lyric expansion", async () => {
  const html = await readFile(path.join(root, "public", "classic", "index.html"), "utf8");

  assert.match(html, /var playKey = song\.playKey \|\| song\.id \|\| ''/);
  assert.match(html, /\/api\/kugou\/lyric\?id=/);
  assert.doesNotMatch(html, /\/api\/kugou\/lyric\?hash=/);
  assert.match(html, /song\.playKey \|\| song\.id \|\| ''/);
  assert.match(html, /CLIENT_LYRIC_MAX_LINES = 5000/);
  assert.match(html, /CLIENT_LYRIC_MAX_TIMESTAMPS = 8/);
  assert.match(html, /CLIENT_YRC_MAX_WORDS_PER_LINE = 256/);
  assert.match(html, /parseServerLyricLines\(r\.lines\)/);
  assert.match(html, /while \(low <= high\)/);
});

test("classic cover inputs are bounded, proxied, and refresh lock-screen artwork", async () => {
  const [html, bridge] = await Promise.all([
    readFile(path.join(root, "public", "classic", "index.html"), "utf8"),
    readFile(path.join(root, "public", "classic", "classic-web-bridge.js"), "utf8"),
  ]);

  assert.match(html, /file\.size > 12 \* 1024 \* 1024/);
  assert.match(html, /iw \* ih > 40000000/);
  assert.match(html, /img\.onerror = function\(\)/);
  assert.match(html, /mineradio:coverchange/);
  assert.match(html, /function isProxyableCoverUrl[\s\S]*?parsed\.protocol === 'https:'/);
  assert.match(bridge, /function coverMediaUrl/);
  assert.match(bridge, /new URL\("\/api\/cover", apiOrigin/);
  assert.match(bridge, /window\.addEventListener\("mineradio:coverchange", updateMediaSessionMetadata\)/);
});

test("classic DIY exposes the backed cover layer and keyboard-native preset cards", async () => {
  const html = await readFile(path.join(root, "public", "classic", "index.html"), "utf8");
  const packaged = JSON.parse(
    await readFile(path.join(root, "public", "classic", "default-user-fx-archive.json"), "utf8"),
  );

  assert.match(html, /id="t-backCover"[^>]*toggleFx\('backCover'\)/);
  assert.match(html, /if \(key === 'backCover'\) \{ if \(fx\.backCover\) createBackCoverLayer\(\); else destroyBackCoverLayer\(\); \}/);
  assert.match(html, /<button type="button" class="preset-card"/);
  assert.match(html, /\.preset-card:focus-visible/);
  assert.equal(packaged.schema, 2);
  assert.equal(packaged.name, "MR//ROOM 默认视觉");
  assert.equal(packaged.snapshot.sonicTerrainTheme, "cover");
});

test("classic quality controls never apply the Netease SVIP gate to Kugou", async () => {
  const html = await readFile(path.join(root, "public", "classic", "index.html"), "utf8");

  assert.match(
    html,
    /provider === 'netease' && next === 'jymaster' && !hasProviderSvip\('netease', loginStatus\)/,
  );
  assert.match(
    html,
    /playbackProvider === 'netease' && requestedQuality === 'jymaster' && !hasProviderSvip\('netease', loginStatus\)/,
  );
  assert.match(html, /provider !== 'netease' \|\| hasProviderSvip\('netease', loginStatus\)/);
  assert.match(html, /locked = provider === 'netease'/);
  assert.match(html, /isKugouPlayback \? '酷狗'/);
  assert.match(html, /if \(song\) return songProviderKey\(song\)/);
  assert.match(html, /hasPlatformLogin\('kugou'\) && !hasPlatformLogin\('netease'\)/);
  assert.match(html, /return '';/);

  assert.doesNotMatch(html, /!isQQPlayback && requestedQuality === 'jymaster'/);
  assert.doesNotMatch(html, /provider !== 'kugou' && next === 'jymaster'/);
  assert.doesNotMatch(html, /provider !== 'kugou' && option\.dataset\.svip/);
  assert.match(html, /var isSvip = !!info\.isSvip \|\| String\(info\.vipLevel/);
  assert.match(html, /var vipLevel = isSvip \? 'svip'/);
  assert.match(html, /\/api\/kugou\/login\/refresh/);
});

test("classic account mutations use explicit POST intent headers", async () => {
  const html = await readFile(path.join(root, "public", "classic", "index.html"), "utf8");
  const bridge = await readFile(path.join(root, "public", "classic", "classic-web-bridge.js"), "utf8");
  assert.match(html, /apiJson\('\/api\/song\/like',\s*\{\s*method: 'POST'/);
  assert.match(html, /apiJson\('\/api\/playlist\/create',\s*\{\s*method: 'POST'/);
  assert.match(html, /X-Mineradio-Application': 'mineradio-web-v1'/);
  assert.match(html, /apiJson\(isKugouCookie \? '\/api\/kugou\/login\/cookie'/);
  assert.match(bridge, /method !== "GET" && method !== "HEAD"/);
  assert.match(bridge, /headers\.set\("X-Mineradio-Application", "mineradio-web-v1"\)/);
});

test("classic account refreshes preserve successful providers and transient Kugou state", async () => {
  const html = await readFile(path.join(root, "public", "classic", "index.html"), "utf8");
  const playlistsStart = html.indexOf("async function refreshUserPlaylists(force)");
  const playlistsEnd = html.indexOf("var playlistPanelDetailState", playlistsStart);
  const playlists = html.slice(playlistsStart, playlistsEnd);
  const kugouStatusStart = html.indexOf("async function refreshKugouLoginStatus()");
  const kugouStatusEnd = html.indexOf("function renderUserBtn()", kugouStatusStart);
  const kugouStatus = html.slice(kugouStatusStart, kugouStatusEnd);

  assert.match(playlists, /Promise\.allSettled\(/);
  assert.match(playlists, /cachedNeteaseLists/);
  assert.match(playlists, /result\[2\]\.status === 'rejected'[\s\S]*?qqPlaylists/);
  assert.match(playlists, /result\[3\]\.status === 'rejected'[\s\S]*?kugouPlaylists/);
  assert.match(playlists, /renderUserPlaylistsList/);
  assert.doesNotMatch(playlists, /await Promise\.all\(/);
  assert.match(kugouStatus, /statusUnavailable: true/);
  assert.doesNotMatch(kugouStatus, /normalizeKugouLoginStatus\(null\)/);
});

test("classic capability-gated controls and hidden side panels expose honest accessible state", async () => {
  const html = await readFile(path.join(root, "public", "classic", "index.html"), "utf8");

  assert.match(html, /<div id="fx-panel" aria-hidden="true" inert>/);
  assert.match(html, /<div id="playlist-panel" aria-hidden="true" inert>/);
  assert.match(html, /function syncPanelAccessibility\(el\)/);
  assert.match(html, /el\.setAttribute\('aria-hidden', visible \? 'false' : 'true'\)/);
  assert.match(html, /if \(visible\) el\.removeAttribute\('inert'\)/);
  assert.match(html, /#fx-panel \.fx-toggle\[onclick\], #fx-panel \.fx-fold-head\[onclick\], #fx-panel \.fx-advanced-head\[onclick\]/);
  assert.match(html, /el\.setAttribute\('role', 'button'\)/);
  assert.match(html, /event\.key !== 'Enter' && event\.key !== ' '/);

  const desktopFxKeys = sourceBetween(html, "var DESKTOP_LYRICS_FX", "function desktopFxCapability");
  const capabilityLocks = sourceBetween(html, "function desktopFxCapability", "function readSavedPlaybackVisualPreset");
  assert.doesNotMatch(html, /var DEVELOPMENT_LOCKED_FX/);
  for (const key of [
    "desktopLyrics",
    "desktopLyricsClickThrough",
    "desktopLyricsCinema",
    "desktopLyricsHighlight",
  ]) {
    assert.match(desktopFxKeys, new RegExp(`${key}:\\s*true`), `${key} must be capability-gated as a desktop lyric feature`);
  }
  assert.match(capabilityLocks, /(?:window\.desktopWindow|getDesktopWindowApi\(\))/);
  assert.match(capabilityLocks, /(?:isDesktop|updateDesktopLyrics|setDesktopLyricsEnabled)/);
  assert.match(capabilityLocks, /isDevelopmentLockedFx\('desktopLyrics'\)[\s\S]*?fx\.desktopLyrics\s*=\s*false/);
  assert.match(html, /btn\.disabled = isDevelopmentLockedFx\('desktopLyrics'\)/);
  assert.match(html, /id="desktop-capability-note"/);
  assert.match(html, /系统动态壁纸需要桌面客户端支持/);
  assert.doesNotMatch(html, /开发中，暂不可用/);
  assert.match(html, /手势启动失败：请允许摄像头权限/);
  assert.match(html, /手势启动失败：识别组件或摄像头不可用，请检查网络/);
});

test("classic room leader aligns changed sources without feeding programmatic seeks back to the relay", async () => {
  const bridge = await readFile(path.join(root, "public", "classic", "classic-web-bridge.js"), "utf8");
  assert.match(bridge, /leaderNeedsAlignment = bridge\.sync\.leader/);
  assert.match(bridge, /state\.preparing \|\| !state\.playing \|\| scheduledInFuture/);
  assert.match(bridge, /var aligned = Math\.abs\(\(Number\(media && media\.currentTime\) \|\| 0\) - target\) <= 0\.08/);
  assert.match(bridge, /function seekForRoomSync\(media, target\)/);
  assert.match(bridge, /if \(suppressNextSeekCommand\)[\s\S]*?reconcileRoomPlayback\(lastRoomState, false\)/);
});

test("classic room start is gesture-gated, catches up late timers, and preserves the final dragged seek", async () => {
  const bridge = await readFile(path.join(root, "public", "classic", "classic-web-bridge.js"), "utf8");
  const modern = await readFile(path.join(root, "app", "components", "MineradioPlayer.tsx"), "utf8");
  const prime = sourceBetween(bridge, "function primeRoomMediaForSync", "function seekForRoomSync");
  const scheduledStart = sourceBetween(bridge, "function launchScheduledRoomPlayback", "function hasBufferedPlaybackWindow");
  const seekThrottle = sourceBetween(bridge, "function sendSeekCommand", "function sendClockPing");
  const audioEvents = sourceBetween(bridge, "function attachAudioEvents", "function blockFollowerControl");
  const controlGuards = sourceBetween(bridge, "function installFollowerControlGuards", "function disableUnavailableQQWebUi");

  assert.match(prime, /media\.muted = true/);
  assert.match(prime, /playResult = media\.play\(\)/);
  assert.match(prime, /if \(!media\.paused\) media\.pause\(\)/);
  assert.match(
    prime,
    /if \(!fromUserGesture\)[\s\S]*?return Promise\.resolve\(false\)[\s\S]*?media\.muted = true/,
  );
  assert.match(
    modern,
    /if \(!fromUserGesture\)[\s\S]*?setNeedsUnlock\(true\)[\s\S]*?return Promise\.resolve\(false\)[\s\S]*?const sequence = \+\+roomPlaybackUnlockSequenceRef\.current/,
  );
  assert.match(bridge, /primeRoomMediaForSync\(media, false\)[\s\S]*?reconcileRoomPlayback\(lastRoomState, false\)/);
  assert.match(bridge, /primeRoomMediaForSync\(window\.audio, true\)/);
  assert.match(
    bridge,
    /lastRoomState\.playing \|\| lastRoomState\.preparing\)[\s\S]*?!roomMediaUnlocked[\s\S]*?primeRoomMediaForSync\(window\.audio, true\)/,
  );

  assert.match(scheduledStart, /var activeState = lastRoomState/);
  assert.match(scheduledStart, /guard\.timerGeneration !== scheduledPlayGeneration/);
  assert.match(scheduledStart, /guard\.connectionGeneration !== roomConnectionGeneration/);
  assert.match(scheduledStart, /!activeState\.playing[\s\S]*?activeState\.preparing/);
  assert.match(scheduledStart, /Number\(activeState\.revision\) !== guard\.revision/);
  assert.match(scheduledStart, /currentDescriptorId\(\) !== guard\.trackId/);
  assert.match(scheduledStart, /String\(activeState\.prepareId \|\| ""\) !== guard\.prepareId/);
  assert.match(scheduledStart, /Number\(activeState\.scheduledAt \|\| 0\) !== guard\.scheduledAt/);
  assert.match(scheduledStart, /alignScheduledRoomPlayback\(media, activeState\)/);
  assert.match(bridge, /function alignScheduledRoomPlayback[\s\S]*?targetPosition\(state\)[\s\S]*?seekForRoomSync\(media, liveTarget\)/);
  assert.match(
    bridge,
    /if \(trackChanged\) \{\s*cancelScheduledRoomPlayback\(\);[\s\S]*?await window\.playQueueAt/,
  );
  assert.match(
    bridge,
    /window\.playQueueAt = async function classicRoomPlayQueueAt\(\) \{[\s\S]*?cancelScheduledRoomPlayback\(\);[\s\S]*?await originalPlayQueueAt/,
  );
  assert.match(bridge, /function announceCurrentTrack\(forceResume\) \{\s*cancelScheduledRoomPlayback\(\);/);

  assert.match(seekThrottle, /pendingSeek = Math\.max/);
  assert.match(seekThrottle, /Math\.max\(0, 80 - elapsed\)/);
  assert.match(audioEvents, /sendSeekCommand\(media\.currentTime, false\)/);
  assert.doesNotMatch(audioEvents, /sendCommand\("seek", media\.currentTime\)/);
  assert.match(controlGuards, /function isProgressTarget[\s\S]*?target\.closest\("#progress-bar"\)/);
  assert.match(controlGuards, /flushLeaderSeek[\s\S]*?!isProgressTarget\(event\.target\)/);
  assert.match(controlGuards, /document\.addEventListener\("pointerup", flushLeaderSeek, true\)/);
  assert.match(controlGuards, /sendSeekCommand\(window\.audio\.currentTime, true\)/);
});

test("classic web mode hides unsupported desktop-only QQ controls and avoids failed QQ searches", async () => {
  const html = await readFile(path.join(root, "public", "classic", "index.html"), "utf8");
  const bridge = await readFile(path.join(root, "public", "classic", "classic-web-bridge.js"), "utf8");
  const searchResolver = html.match(/async function fetchMusicSearchResults[\s\S]*?\n\}/)?.[0] || "";
  assert.match(searchResolver, /if \(mode === 'qq'\) \{\s*return \[\];/);
  assert.doesNotMatch(searchResolver, /\/api\/qq\/search/);
  assert.match(html, /if \(songProviderKey\(song\) !== 'qq'\) return null/);
  assert.match(bridge, /disableUnavailableQQWebUi/);
  assert.match(bridge, /"login-provider-qq"/);
  assert.match(bridge, /style\.setProperty\("display", "none", "important"\)/);
});

test("classic particle fallbacks remain drawable when optional skull assets fail", async () => {
  const html = await readFile(path.join(root, "public", "classic", "index.html"), "utf8");
  const loader = sourceBetween(html, "function loadSkullParticleAsset", "function skullPushPoint");
  const creator = sourceBetween(html, "function createSkullParticleLayer", "function isSkullShelfCompositionActive");
  const updater = sourceBetween(html, "function updateSkullParticleLayer", "// ============================================================\n//  封面背面粒子层");
  const starRiver = sourceBetween(html, "function ensureLyricStarRiver", "function updateLyricStarRiver");

  assert.match(loader, /maxAttempts/);
  assert.match(loader, /retryAt/);
  assert.match(loader, /Math\.pow\(2,/);
  assert.doesNotMatch(creator, /if \(!asset\) return null/);
  assert.match(creator, /replaceSkullFallbackWithAsset/);
  assert.match(updater, /createSkullParticleLayer\(\)/);
  assert.match(html, /var skullLayerReady = skullPresetActive && skullParticleGroup && skullParticleOpacity > 0\.34/);
  assert.match(starRiver, /new Float32Array\(count \* 3\)/);
  assert.match(starRiver, /setAttribute\('position', new THREE\.BufferAttribute\(positions, 3\)\)/);
});

test("classic cover loads are last-request-wins and clear every stale visual on failure", async () => {
  const html = await readFile(path.join(root, "public", "classic", "index.html"), "utf8");
  const currentCheck = sourceBetween(html, "function coverApplyStillCurrent", "function setControlCoverSrc");
  const clear = sourceBetween(html, "function clearCurrentCoverVisuals", "function updateControlTrackInfo");
  const urlLoader = sourceBetween(html, "function loadCoverFromUrl", "function setAlbumBackground");
  const dataLoader = sourceBetween(html, "function applyCoverDataUrl", "function commitCustomCoverCanvas");

  assert.match(html, /coverProcessToken = 0, coverRequestToken = 0/);
  assert.match(currentCheck, /coverRequestToken[\s\S]*?coverRequestToken/);
  assert.match(currentCheck, /next\.coverRequestToken = \+\+coverRequestToken/);
  assert.match(urlLoader, /opts = beginCoverRequestOptions\(opts\)/);
  assert.match(dataLoader, /opts = beginCoverRequestOptions\(opts\)/);
  assert.match(urlLoader, /clearCurrentCoverVisuals\(opts\)/);
  assert.match(clear, /setAlbumBackground\(''\)/);
  assert.match(clear, /thumb\.removeAttribute\('src'\)/);
  assert.match(clear, /shelfManager\.onCoverChange\(''\)/);
});

test("classic cover fallback preserves aspect ratio and never reuses another song's depth map", async () => {
  const html = await readFile(path.join(root, "public", "classic", "index.html"), "utf8");
  const apply = sourceBetween(html, "function applyCoverCanvas", "// ============================================================\n//  离线节拍预解析");
  const urlLoader = sourceBetween(html, "function loadCoverFromUrl", "function setAlbumBackground");

  assert.match(html, /var neutralCoverDepthCanvas = null/);
  assert.match(html, /function resetCoverDepthTexture\(\)/);
  assert.match(apply, /resetCoverDepthTexture\(\);\s*setCoverDepthState\(0, 0, 1\)/);
  assert.doesNotMatch(apply, /uniforms\.uHasDepth\.value > 0\.5 \? 0\.22/);
  assert.match(urlLoader, /var cv = makeSquareCoverCanvas\(img2, size\)/);
  assert.doesNotMatch(urlLoader, /drawImage\(img2, 0, 0, size, size\)/);
});

test("classic adaptive particle quality observes delivered frame cadence", async () => {
  const html = await readFile(path.join(root, "public", "classic", "index.html"), "utf8");
  const sampler = sourceBetween(html, "function sampleAdaptiveParticlePerformance", "window.__mineradioAdaptiveParticleSnapshot");
  const loop = sourceBetween(html, "function animate()", "animate();");

  assert.match(sampler, /frameIntervalMs/);
  assert.match(sampler, /averageIntervalMs/);
  assert.match(sampler, /missedRatio/);
  assert.match(sampler, /intervalOverloaded/);
  assert.match(sampler, /'delivered-fps'/);
  assert.match(loop, /renderedFrameIntervalMs/);
  assert.match(loop, /sampleAdaptiveParticlePerformance\(performance\.now\(\) - frameWorkStartedAt, now, renderedFrameIntervalMs\)/);
});
