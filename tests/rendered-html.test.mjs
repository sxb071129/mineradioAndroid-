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

  assert.match(player, /hasBufferedPlaybackWindow\(audio, target\)/);
  assert.match(player, /const primeRoomPlayback = useCallback/);
  assert.match(player, /roomPlaybackUnlockedElementRef\.current !== audio[\s\S]*?primeRoomPlayback\(false\)/);
  assert.match(player, /const liveTarget = targetPosition\(\)[\s\S]*?audio\.currentTime = liveTarget/);
  assert.match(player, /action: "ready"[\s\S]*?latencyMs: roomLatency[\s\S]*?jitterMs: roomClockJitter/);
  assert.match(player, /state\.scheduledAt - getRoomServerNow\(\)/);
  assert.match(player, /action: "start-failed"/);
  assert.match(player, /setInterval\(reconcile, 250\)/);
  assert.match(hook, /sampledServerTime: Date\.now\(\) \+ offsetRef\.current/);
  assert.match(relay, /prepareParticipants = new Set/);
  assert.match(relay, /room\.readyClients\.size >= room\.prepareParticipants\.size/);
  assert.match(relay, /room\.playbackStartLeadMs \+ networkLeadMs/);
  assert.match(relay, /prepareError = "start_failed"|cancelPlaybackPreparation\(room, now, "start_failed"\)/);
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
});

test("modern overlays expose modal semantics and make closed popovers inert", async () => {
  const player = await readFile(new URL("../app/components/MineradioPlayer.tsx", import.meta.url), "utf8");
  assert.match(player, /aria-hidden=\{!qualityOpen\}/);
  assert.match(player, /inert=\{!qualityOpen\}/);
  assert.match(player, /aria-hidden=\{!audioEffectOpen\}[\s\S]*?inert=\{!audioEffectOpen\}/);
  assert.match(player, /role="dialog"[\s\S]*?aria-modal="true"[\s\S]*?aria-labelledby="lyrics-stage-title"/);
  assert.match(player, /if \(event\.key !== "Escape"\) return/);
});
