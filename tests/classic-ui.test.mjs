import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("home and classic routes embed the original player surface", async () => {
  const home = await readFile(path.join(root, "app", "page.tsx"), "utf8");
  const route = await readFile(path.join(root, "app", "classic", "page.tsx"), "utf8");
  const frame = await readFile(path.join(root, "app", "components", "ClassicPlayerFrame.tsx"), "utf8");
  const modern = await readFile(path.join(root, "app", "modern", "page.tsx"), "utf8");
  assert.match(home, /ClassicPlayerFrame/);
  assert.match(route, /ClassicPlayerFrame/);
  assert.match(frame, /\/classic\/index\.html\?room=/);
  assert.match(frame, /allowFullScreen/);
  assert.match(frame, /allow="autoplay; clipboard-write; fullscreen"/);
  assert.match(frame, /height:\s*"100dvh"/);
  assert.match(modern, /MineradioPlayer/);
});

test("classic bundle carries its visual engine and Web bridge", async () => {
  const classicRoot = path.join(root, "public", "classic");
  const html = await readFile(path.join(classicRoot, "index.html"), "utf8");
  const bridge = await readFile(path.join(classicRoot, "classic-web-bridge.js"), "utf8");

  assert.match(html, /<script src="classic-web-bridge\.js\?v=20260715-start-barrier-v2"><\/script>/);
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
    access(path.join(classicRoot, "assets", "skull-decimation-points.bin")),
  ]);
  assert.ok((await stat(path.join(classicRoot, "index.html"))).size > 1_000_000);
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
  assert.match(html, /#room-sync-anchor,body\.desktop-shell #room-sync-anchor\{[^}]*height:44px/);
  assert.match(html, /\.room-sync-link\{[^}]*user-select:text/);
  assert.match(html, /id="room-sync-panel"[^>]*\sinert>/);
  assert.match(html, /class="room-sync-meta" aria-live="polite"/);
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
  assert.match(bridge, /sendCommand\("ready", prepareId\)/);
  assert.match(bridge, /Number\(state\.scheduledAt\) - \(Date\.now\(\) \+ serverOffset\)/);
  assert.match(bridge, /hasBufferedPlaybackWindow\(media, target\)/);
  assert.match(bridge, /deferPlayback: true/);
  assert.match(html, /opts\.deferPlayback/);
  assert.match(html, /等待全部设备缓冲就绪，再按统一时刻起播/);
  assert.match(bridge, /installRoomSyncUi\(\);[\s\S]*?connectRoom\(\);/);
});

test("classic media URLs no longer depend on the removed upstream proxy", async () => {
  const html = await readFile(path.join(root, "public", "classic", "index.html"), "utf8");
  assert.match(html, /var proxyAudioUrl = window\.MineradioWebBridge/);
  assert.match(html, /return window\.MineradioWebBridge \? window\.MineradioWebBridge\.coverUrl/);
  assert.match(html, /fetch\('vendor\/music-tempo\.min\.js'\)/);
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
  assert.match(html, /currentLocalSong = song && \(song\.type === 'local'/);
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

test("classic web-only controls and hidden side panels expose honest accessible state", async () => {
  const html = await readFile(path.join(root, "public", "classic", "index.html"), "utf8");

  assert.match(html, /<div id="fx-panel" aria-hidden="true" inert>/);
  assert.match(html, /<div id="playlist-panel" aria-hidden="true" inert>/);
  assert.match(html, /function syncPanelAccessibility\(el\)/);
  assert.match(html, /el\.setAttribute\('aria-hidden', visible \? 'false' : 'true'\)/);
  assert.match(html, /if \(visible\) el\.removeAttribute\('inert'\)/);
  assert.match(html, /#fx-panel \.fx-toggle\[onclick\], #fx-panel \.fx-fold-head\[onclick\], #fx-panel \.fx-advanced-head\[onclick\]/);
  assert.match(html, /el\.setAttribute\('role', 'button'\)/);
  assert.match(html, /event\.key !== 'Enter' && event\.key !== ' '/);

  for (const key of [
    "desktopLyrics",
    "desktopLyricsClickThrough",
    "desktopLyricsCinema",
    "desktopLyricsHighlight",
  ]) {
    assert.match(html, new RegExp(`${key}: true`));
  }
  assert.match(html, /网页模式不支持，仅桌面客户端可用/);
  assert.match(html, /桌面歌词仅桌面客户端可用/);
  assert.match(html, /btn\.disabled = isDevelopmentLockedFx\('desktopLyrics'\)/);
  assert.match(html, /permissionDenied \? '手势启动失败：摄像头权限不可用' : '手势启动失败：识别组件加载失败，请检查网络'/);
});

test("classic room leader aligns changed sources without feeding programmatic seeks back to the relay", async () => {
  const bridge = await readFile(path.join(root, "public", "classic", "classic-web-bridge.js"), "utf8");
  assert.match(bridge, /leaderNeedsAlignment = bridge\.sync\.leader/);
  assert.match(bridge, /state\.preparing \|\| !state\.playing \|\| scheduledInFuture/);
  assert.match(bridge, /var aligned = Math\.abs\(\(Number\(media\.currentTime\) \|\| 0\) - target\) <= 0\.08/);
  assert.match(bridge, /function seekForRoomSync\(media, target\)/);
  assert.match(bridge, /if \(suppressNextSeekCommand\)[\s\S]*?reconcileRoomPlayback\(lastRoomState, false\)/);
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
