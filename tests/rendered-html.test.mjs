import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(new URL(pathname, "http://localhost/"), { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the original player as the default entry", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Mineradio<\/title>/);
  assert.match(html, /<iframe[^>]+src="\/classic\/index\.html\?room=HOME"/);
  assert.match(html, /title="Mineradio Classic 播放器"/);
  assert.match(html, /allow="autoplay; camera; clipboard-write; fullscreen"/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/);
});

test("player wires the reducer-backed queue without extending room authority", async () => {
  const player = await readFile(new URL("../app/components/MineradioPlayer.tsx", import.meta.url), "utf8");
  assert.match(player, /useReducer\(playerQueueReducer/);
  assert.match(player, /serializeQueueState\(queueState\)/);
  assert.match(player, /deserializeQueueState/);
  assert.match(player, /multiple\s*\n\s*accept="audio\/\*/);
  assert.match(player, /dispatchQueue\(\{ type: "ended" \}\)/);
  assert.match(player, /dispatchQueue\(\{ type: "set-shuffle"/);
  assert.match(player, /房间模式只同步当前歌曲和时间线/);
  assert.match(player, /mode !== "solo"[\s\S]*?房间模式暂不共享播放队列/);
  assert.doesNotMatch(player, /sendRoomCommand\(\{ action: "(?:next|previous|queue|repeat|shuffle)"/);
});

test("room playback waits for buffered devices and uses the calibrated server start time", async () => {
  const player = await readFile(new URL("../app/components/MineradioPlayer.tsx", import.meta.url), "utf8");
  const hook = await readFile(new URL("../app/hooks/use-room-sync.ts", import.meta.url), "utf8");
  const relay = await readFile(new URL("../scripts/lan-relay.mjs", import.meta.url), "utf8");

  assert.match(player, /measureBufferedWindow\(audio, target/);
  assert.doesNotMatch(player, /function hasBufferedPlaybackWindow/);
  assert.match(player, /const primeRoomPlayback = useCallback/);
  assert.match(player, /roomPlaybackUnlockedElementRef\.current !== audio[\s\S]*?primeRoomPlayback\(false\)/);
  assert.match(player, /const liveTarget = targetPosition\(\)[\s\S]*?audio\.currentTime = liveTarget/);
  assert.match(player, /action: "device-status"[\s\S]*?bufferedSeconds:[\s\S]*?bufferGoalSeconds:[\s\S]*?driftMs:/);
  assert.match(player, /action: "ready"[\s\S]*?bufferedSeconds: metrics\.bufferedSeconds[\s\S]*?jitterMs: metrics\.jitterMs/);
  assert.match(player, /ready: false[\s\S]*?bufferState,[\s\S]*?driftMs: metrics\.driftMs/);
  assert.match(player, /state\.scheduledAt - deviceCalibration\.delayMs - getRoomServerNow\(\)/);
  assert.match(player, /action: "start-failed"/);
  assert.match(player, /setInterval\(reconcile, 250\)/);
  assert.match(hook, /sampledServerTime: Date\.now\(\) \+ offsetRef\.current/);
  assert.doesNotMatch(hook, /setState\(\(current\) => current \? \{ \.\.\.current \}/);
  assert.match(relay, /prepareParticipants = new Set/);
  assert.match(relay, /room\.readyClients\.size >= room\.prepareParticipants\.size/);
  assert.match(relay, /room\.playbackStartLeadMs \+ networkLeadMs/);
  assert.match(relay, /prepareError = "start_failed"|cancelPlaybackPreparation\(room, now, "start_failed"(?:,|\))/);
  const togglePlayback = player.slice(
    player.indexOf("const togglePlayback"),
    player.indexOf("const unlockAudio"),
  );
  assert.ok(
    togglePlayback.indexOf('if (mode === "room")') < togglePlayback.indexOf("await ensureAudioGraph()"),
    "room commands must not wait for AudioContext resume",
  );
  assert.match(togglePlayback, /const playbackGate = primeRoomPlayback\(true\)[\s\S]*?if \(!await playbackGate\) return;[\s\S]*?action: "play"/);
});

test("modern room controls preserve leader position, final slider values, and safe sharing", async () => {
  const player = await readFile(new URL("../app/components/MineradioPlayer.tsx", import.meta.url), "utf8");
  assert.match(player, /leaderNeedsAlignment = roomIsLeader && \(state\.preparing \|\| !state\.playing \|\| scheduledInFuture\)/);
  assert.match(player, /audio\.currentTime = value;[\s\S]*?sendThrottledRoomControl\("seek", value, flush\)/);
  assert.match(player, /ROOM_CONTROL_THROTTLE_MS = 80/);
  assert.match(player, /onPointerUp=\{\(event\) => seek\(Number\(event\.currentTarget\.value\), true\)\}/);
  assert.match(player, /preferredLanHost\(room\.addresses, url\.hostname\)/);
  assert.match(player, /document\.execCommand\("copy"\)/);
});

test("modern room drawer exposes service health and per-device diagnostics", async () => {
  const player = await readFile(new URL("../app/components/MineradioPlayer.tsx", import.meta.url), "utf8");
  const serviceCenter = await readFile(new URL("../app/components/RoomServiceCenter.tsx", import.meta.url), "utf8");
  const healthHook = await readFile(new URL("../app/hooks/use-service-health.ts", import.meta.url), "utf8");
  const syncTypes = await readFile(new URL("../app/lib/sync-types.ts", import.meta.url), "utf8");

  assert.match(player, /<RoomServiceCenter/);
  assert.match(player, /Music API 地址/);
  assert.match(serviceCenter, /服务与设备中心/);
  assert.match(serviceCenter, /device\.bufferProgress/);
  assert.match(serviceCenter, /device\.latencyMs/);
  assert.match(serviceCenter, /device\.jitterMs/);
  assert.match(serviceCenter, /device\.driftMs/);
  assert.match(serviceCenter, /prepareErrorClientIds/);
  assert.match(healthHook, /Promise\.all\(\[/);
  assert.match(healthHook, /url\.pathname = "\/health"/);
  assert.match(syncTypes, /devices: RoomDeviceState\[\]/);
  assert.match(syncTypes, /prepareDeadline: number/);
  assert.match(syncTypes, /action: "device-status"/);
});

test("modern room calibration is persisted, bounded, applied, and leader-addressable", async () => {
  const player = await readFile(new URL("../app/components/MineradioPlayer.tsx", import.meta.url), "utf8");
  const serviceCenter = await readFile(new URL("../app/components/RoomServiceCenter.tsx", import.meta.url), "utf8");
  const syncHook = await readFile(new URL("../app/hooks/use-room-sync.ts", import.meta.url), "utf8");
  const syncTypes = await readFile(new URL("../app/lib/sync-types.ts", import.meta.url), "utf8");

  assert.match(player, /DEVICE_CALIBRATION_STORAGE_KEY = "mineradio-device-calibration-v1"/);
  assert.match(player, /MIN_VOLUME_TRIM_DB = -24/);
  assert.match(player, /MAX_VOLUME_TRIM_DB = 12/);
  assert.match(player, /MAX_DEVICE_DELAY_MS = 500/);
  assert.match(player, /action: "device-calibration",[\s\S]*?targetClientId,[\s\S]*?volumeTrimDb:[\s\S]*?delayMs:/);
  assert.match(player, /volume\.gain\.value = playbackVolumeRef\.current \* dbToGain/);
  assert.match(player, /volume\.connect\(limiter\);[\s\S]*?limiter\.connect\(calibrationDelay\);/);
  assert.match(player, /context\.createDelay\(1\)/);
  assert.match(player, /getRoomTargetPosition\(state\) \+ delayCompensation/);
  assert.match(player, /state\.scheduledAt - deviceCalibration\.delayMs - getRoomServerNow\(\)/);
  assert.match(player, /action: "progress",[\s\S]*?position: Math\.max\(0, \(audio\.currentTime \|\| 0\) - deviceCalibration\.delayMs \/ 1000\)/);
  assert.match(player, /const mediaSessionPosition = mode === "room"[\s\S]*?progress - deviceCalibration\.delayMs \/ 1000/);
  assert.match(serviceCenter, /min="-24"[\s\S]*?max="12"/);
  assert.match(serviceCenter, /const calibrationRef = useRef\(/);
  assert.match(serviceCenter, /const calibrationCommitTimerRef = useRef<number \| null>\(null\)/);
  assert.match(serviceCenter, /calibrationRef\.current\.volumeTrimDb = next[\s\S]*?setVolumeTrimDb\(next\)/);
  assert.match(serviceCenter, /calibrationRef\.current\.delayMs = next[\s\S]*?setDelayMs\(next\)/);
  assert.match(serviceCenter, /scheduleCalibration\(\)/);
  assert.match(serviceCenter, /onCalibrate\(device\.clientId, \{ \.\.\.calibrationRef\.current \}\)/);
  assert.match(serviceCenter, /key=\{`\$\{device\.clientId\}:\$\{device\.volumeTrimDb \|\| 0\}:\$\{device\.delayMs \|\| 0\}`\}/);
  assert.match(syncTypes, /action: "device-calibration";[\s\S]*?targetClientId: string;[\s\S]*?volumeTrimDb: number;[\s\S]*?delayMs: number;/);
  assert.match(syncHook, /device_not_found:/);
  assert.match(syncHook, /invalid_calibration:/);
});

test("modern player prefetches and commits one deterministic dual-audio transition", async () => {
  const player = await readFile(new URL("../app/components/MineradioPlayer.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(player, /type PrefetchedQueueTrack = \{[\s\S]*?baseState: QueueState<LocalTrack>;[\s\S]*?nextState: QueueState<LocalTrack>;/);
  assert.match(player, /const currentTrackReady = Boolean\([\s\S]*?localTrack\?\.id === activeQueueTrack\.id[\s\S]*?&& audioSource/);
  assert.match(player, /const request = options\.silent[\s\S]*?options\.controller \|\| new AbortController\(\)[\s\S]*?: beginPrepareRequest\(\)/);
  assert.match(player, /const prefetchController = new AbortController\(\)[\s\S]*?silent: true,[\s\S]*?controller: prefetchController/);
  assert.match(player, /prefetchController\.abort\(\)/);
  assert.match(player, /prefetched\.baseState === latest[\s\S]*?prefetched\.nextState/);
  assert.match(player, /dispatchQueue\(\{ type: "hydrate", state: next \}\)/);
  assert.match(player, /ref=\{nextAudioRef\}[\s\S]*?preload="auto"/);
  assert.match(player, /createMediaElementSource\(nextAudio\)/);
  assert.match(player, /mainFade\.gain\.linearRampToValueAtTime\(0,[\s\S]*?nextFade\.gain\.linearRampToValueAtTime\(1,/);
  assert.match(player, /current\.repeat === "all" && current\.queue\.length === 1/);
  assert.match(player, /const liveHandoffPosition = Math\.min\([\s\S]*?nextAudio\.currentTime/);
  assert.match(player, /\.catch\(\(\) => \{[\s\S]*?stopSecondaryPlayback\(true\);[\s\S]*?setSoloPlaying\(false\)/);
  assert.match(player, /双音源交叠淡化/);
  assert.match(player, /PLAYBACK_TRANSITION_STORAGE_KEY/);
  assert.match(css, /\.queue-transition-settings\s*\{/);
});

test("modern player uses local room QR generation and throttled Media Session controls", async () => {
  const player = await readFile(new URL("../app/components/MineradioPlayer.tsx", import.meta.url), "utf8");
  const mediaSession = await readFile(new URL("../app/hooks/use-media-session.ts", import.meta.url), "utf8");

  assert.match(player, /new URL\("\/api\/room\/qr", room\.httpBase\)/);
  assert.match(player, /url\.searchParams\.set\("text", shareUrl\)/);
  assert.doesNotMatch(player, /api\.qrserver|quickchart|chart\.googleapis/);
  assert.match(mediaSession, /new MediaMetadata/);
  assert.match(mediaSession, /try \{[\s\S]*?session\.metadata = new MediaMetadata/);
  assert.match(mediaSession, /artwork: track\.artwork \? \[\{ src: track\.artwork \}\]/);
  assert.match(mediaSession, /session\.setPositionState\(\)/);
  assert.match(mediaSession, /now - previous\.updatedAt < 1000/);
  assert.match(mediaSession, /setActionHandler/);
  assert.match(mediaSession, /"seekto"/);
  assert.match(player, /const mediaSessionNext = useCallback\(\(\) => \{[\s\S]*?if \(!canControl\) return;/);
  assert.match(player, /const mediaSessionPrevious = useCallback\(\(\) => \{[\s\S]*?if \(!canControl\) return;/);
  assert.match(player, /const mediaSessionSeek = useCallback\(\(position: number\) => \{[\s\S]*?if \(!canControl\) return;/);
});

test("Kugou player uses the versioned prepare boundary", async () => {
  const player = await readFile(new URL("../app/components/MineradioPlayer.tsx", import.meta.url), "utf8");
  assert.match(player, /\/api\/v2\/playback\/prepare/);
  assert.match(player, /"X-Mineradio-Application": "mineradio-web-v1"/);
  assert.match(player, /body: JSON\.stringify\(\{ provider: "kugou", trackRef, quality \}\)/);
  assert.match(player, /\^\\\/api\\\/v2\\\/stream\\\/\(\[a-f0-9\]\{24\}\)\$/);
  assert.match(player, /cloudTrackPath\(provider, sourceId, quality\)/);
  assert.match(player, /KUGOU_COMPATIBILITY_NOTICE/);
  assert.match(player, /prepareSequenceRef/);
  assert.doesNotMatch(player, /localStorage\.setItem\([^\n]*(?:streamPath|attemptId|trackRef)/);
});

test("responsive and accessible fallbacks are present", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /100dvh/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /forced-colors:\s*active/);
  assert.match(css, /focus-visible/);
  assert.match(css, /@supports \(backdrop-filter/);
  assert.match(css, /\.mineradio-shell\s*\{[\s\S]*?height:\s*auto;[\s\S]*?overflow:\s*visible;/);
  assert.match(css, /\.home-workspace\s*\{[\s\S]*?height:\s*auto;[\s\S]*?min-height:\s*610px;[\s\S]*?overflow:\s*visible;/);
  assert.match(css, /\.queue-list\s*\{[\s\S]*?overflow-y:\s*auto;/);
  assert.match(css, /\.room-drawer\s*\{[\s\S]*?overflow:\s*auto;/);
  assert.match(css, /overscroll-behavior:\s*contain/);
  assert.match(css, /\.device-metrics\s*\{[\s\S]*?grid-template-columns:/);
});

test("modern overlays expose modal semantics and make closed popovers inert", async () => {
  const player = await readFile(new URL("../app/components/MineradioPlayer.tsx", import.meta.url), "utf8");
  assert.match(player, /aria-hidden=\{!qualityOpen\}/);
  assert.match(player, /inert=\{!qualityOpen\}/);
  assert.match(player, /aria-hidden=\{!audioEffectOpen\}[\s\S]*?inert=\{!audioEffectOpen\}/);
  assert.match(player, /role="dialog"[\s\S]*?aria-modal="true"[\s\S]*?aria-labelledby="lyrics-stage-title"/);
  assert.match(player, /if \(event\.key !== "Escape"\) return/);
});
