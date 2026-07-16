import assert from "node:assert/strict";
import test from "node:test";
import {
  CLOUD_PROVIDERS,
  MAX_QUEUE_LENGTH,
  MAX_QUEUE_PERSISTENCE_BYTES,
  PLAYBACK_QUALITIES,
  QUEUE_PERSISTENCE_VERSION,
  REPEAT_MODES,
  canonicalCloudTrackId,
  canonicalCloudTrackPath,
  createQueueState,
  deserializeQueueState,
  getCurrentTrack,
  normalizeQueueState,
  queueReducer,
  serializeQueueState,
} from "../app/lib/player-queue.mjs";

function track(name, extra = {}) {
  return { id: name.toLowerCase(), name, ...extra };
}

function cloudTrack(provider, sourceId, quality = "hires", extra = {}) {
  return {
    id: `cloud-v2-${provider}-${sourceId}-${quality}`,
    name: `${provider}-${sourceId}`,
    type: "audio/mpeg",
    size: 0,
    path: `/api/cloud/v2/${provider}/${sourceId}/${quality}`,
    provider,
    quality,
    sourceId,
    ...extra,
  };
}

function reduce(state, type, extra = {}, rng) {
  return queueReducer(state, { type, ...extra }, rng);
}

function sequenceRng(values) {
  let index = 0;
  return () => values[index++ % values.length];
}

function names(state) {
  return state.queue.map((item) => item.name);
}

test("exports stable constants and creates an empty normalized state", () => {
  assert.equal(MAX_QUEUE_LENGTH, 100);
  assert.equal(QUEUE_PERSISTENCE_VERSION, 2);
  assert.deepEqual(REPEAT_MODES, ["off", "all", "one"]);
  assert.deepEqual(CLOUD_PROVIDERS, ["netease", "kugou"]);
  assert.deepEqual(PLAYBACK_QUALITIES, ["jymaster", "hires", "lossless", "exhigh", "standard"]);
  assert.deepEqual(createQueueState(), {
    queue: [],
    currentIndex: -1,
    repeat: "off",
    shuffle: false,
    shuffleOrder: [],
    shuffleIndex: -1,
  });
  assert.equal(getCurrentTrack(createQueueState()), null);
});

test("normalizes malformed external state, copies tracks, and caps queues", () => {
  const source = Array.from({ length: 105 }, (_, index) => track(`T${index}`));
  source.splice(2, 0, null, "bad");
  const state = normalizeQueueState({
    queue: source,
    currentIndex: 999,
    repeat: "invalid",
    shuffle: "yes",
  });

  assert.equal(state.queue.length, MAX_QUEUE_LENGTH);
  assert.equal(state.currentIndex, -1);
  assert.equal(state.repeat, "off");
  assert.equal(state.shuffle, false);
  assert.notEqual(state.queue[0], source[0]);
  source[0].name = "mutated";
  assert.equal(state.queue[0].name, "T0");
  assert.deepEqual(normalizeQueueState(null), createQueueState());

  const compacted = normalizeQueueState({
    queue: [null, track("Selected"), "bad", track("Last")],
    currentIndex: 1,
  });
  assert.equal(compacted.currentIndex, 0);
  assert.equal(getCurrentTrack(compacted).name, "Selected");
});

test("replace selects its requested index, defaults to first, and remains bounded", () => {
  let state = reduce(createQueueState({ repeat: "all" }), "replace", {
    queue: [track("A"), track("B"), track("C")],
    currentIndex: 2,
  });
  assert.deepEqual(names(state), ["A", "B", "C"]);
  assert.equal(state.currentIndex, 2);
  assert.equal(state.repeat, "all");
  assert.equal(getCurrentTrack(state).name, "C");

  state = reduce(state, "replace", { tracks: [track("D"), track("E")], currentIndex: 9 });
  assert.equal(state.currentIndex, 0);
  assert.equal(getCurrentTrack(state).name, "D");

  state = reduce(state, "replace", { queue: Array.from({ length: 101 }, (_, index) => track(`Q${index}`)) });
  assert.equal(state.queue.length, 100);
  assert.equal(state.queue.at(-1).name, "Q99");

  state = reduce(state, "replace", { queue: [] });
  assert.equal(state.currentIndex, -1);
});

test("append preserves order and current selection while enforcing capacity", () => {
  let state = createQueueState({ queue: [track("A")], currentIndex: 0 });
  state = reduce(state, "append", { track: track("B") });
  state = reduce(state, "append", { tracks: [track("C"), track("D")] });
  assert.deepEqual(names(state), ["A", "B", "C", "D"]);
  assert.equal(state.currentIndex, 0);

  state = reduce(createQueueState({
    queue: Array.from({ length: 99 }, (_, index) => track(`T${index}`)),
    currentIndex: 50,
  }), "append", { tracks: [track("A"), track("B")] });
  assert.equal(state.queue.length, 100);
  assert.equal(state.queue.at(-1).name, "A");
  assert.equal(state.currentIndex, 50);

  const unchanged = reduce(state, "append", { track: track("overflow") });
  assert.deepEqual(unchanged, state);
  assert.equal(reduce(state, "append", { tracks: [track("array-overflow")] }).queue.length, 100);
  assert.equal(reduce(state, "play-next", { tracks: [track("array-overflow")] }).queue.length, 100);
});

test("play-next inserts immediately after current or at the front without selecting it", () => {
  let state = createQueueState({
    queue: [track("A"), track("D")],
    currentIndex: 0,
  });
  state = reduce(state, "play-next", { tracks: [track("B"), track("C")] });
  assert.deepEqual(names(state), ["A", "B", "C", "D"]);
  assert.equal(getCurrentTrack(state).name, "A");
  state = reduce(state, "next");
  assert.equal(getCurrentTrack(state).name, "B");

  state = reduce(createQueueState({ queue: [track("B")], currentIndex: -1 }), "play-next", {
    track: track("A"),
  });
  assert.deepEqual(names(state), ["A", "B"]);
  assert.equal(state.currentIndex, -1);
  assert.equal(getCurrentTrack(state), null);
});

test("remove is index-based, keeps duplicates, and adjusts current selection", () => {
  const duplicate = track("same");
  let state = createQueueState({
    queue: [duplicate, duplicate, track("C"), track("D")],
    currentIndex: 2,
  });
  state = reduce(state, "remove", { index: 0 });
  assert.deepEqual(names(state), ["same", "C", "D"]);
  assert.equal(state.currentIndex, 1);

  state = reduce(state, "remove", { index: 1 });
  assert.deepEqual(names(state), ["same", "D"]);
  assert.equal(state.currentIndex, 1);
  assert.equal(getCurrentTrack(state).name, "D");

  state = reduce(state, "remove", { index: 1 });
  assert.equal(state.currentIndex, 0);
  assert.equal(getCurrentTrack(state).name, "same");

  assert.deepEqual(reduce(state, "remove", { index: -1 }), state);
  assert.deepEqual(reduce(state, "remove", { index: 20 }), state);
  state = reduce(state, "remove", { index: 0 });
  assert.deepEqual(state, createQueueState());
});

test("clear removes every track but preserves repeat and shuffle settings", () => {
  let state = createQueueState({ queue: [track("A")], currentIndex: 0, repeat: "one" });
  state = reduce(state, "set-shuffle", { shuffle: true }, () => 0.5);
  state = reduce(state, "clear");
  assert.equal(state.queue.length, 0);
  assert.equal(state.currentIndex, -1);
  assert.equal(state.repeat, "one");
  assert.equal(state.shuffle, true);
  assert.deepEqual(state.shuffleOrder, []);
});

test("select supports stop semantics and rejects out-of-bounds indices", () => {
  let state = createQueueState({ queue: [track("A"), track("B")], currentIndex: 0 });
  state = reduce(state, "select", { index: 1 });
  assert.equal(getCurrentTrack(state).name, "B");
  state = reduce(state, "select", { index: -1 });
  assert.equal(getCurrentTrack(state), null);
  assert.deepEqual(reduce(state, "select", { index: -2 }), state);
  assert.deepEqual(reduce(state, "select", { index: 2 }), state);
});

test("previous and next obey linear boundaries and repeat-all wrapping", () => {
  let state = createQueueState({ queue: [track("A"), track("B"), track("C")], currentIndex: -1 });
  state = reduce(state, "next");
  assert.equal(getCurrentTrack(state).name, "A");
  state = reduce(state, "previous");
  assert.equal(getCurrentTrack(state).name, "A");
  state = reduce(state, "next");
  state = reduce(state, "next");
  assert.equal(getCurrentTrack(state).name, "C");
  assert.equal(reduce(state, "next").currentIndex, 2);

  state = reduce(state, "set-repeat", { repeat: "all" });
  state = reduce(state, "next");
  assert.equal(getCurrentTrack(state).name, "A");
  state = reduce(state, "previous");
  assert.equal(getCurrentTrack(state).name, "C");

  state = reduce(state, "select", { index: -1 });
  state = reduce(state, "previous");
  assert.equal(getCurrentTrack(state).name, "C");
  assert.deepEqual(reduce(createQueueState(), "next"), createQueueState());
  assert.deepEqual(reduce(createQueueState(), "previous"), createQueueState());
});

test("set-repeat accepts only canonical modes", () => {
  let state = createQueueState();
  for (const repeat of REPEAT_MODES) {
    state = reduce(state, "set-repeat", { repeat });
    assert.equal(state.repeat, repeat);
  }
  assert.equal(reduce(state, "set-repeat", { repeat: "forever" }).repeat, "one");
});

test("ended keeps repeat-one selected, wraps repeat-all, and stops at repeat-off end", () => {
  const base = createQueueState({ queue: [track("A"), track("B")], currentIndex: 0 });
  let state = reduce(base, "set-repeat", { repeat: "one" });
  const repeated = reduce(state, "ended");
  assert.equal(repeated.currentIndex, 0);
  assert.equal(getCurrentTrack(repeated).name, "A");

  state = reduce(base, "ended");
  assert.equal(getCurrentTrack(state).name, "B");
  const stoppedAtEnd = reduce(state, "ended");
  assert.equal(stoppedAtEnd.currentIndex, 1);
  assert.equal(getCurrentTrack(stoppedAtEnd).name, "B");

  state = reduce(state, "set-repeat", { repeat: "all" });
  state = reduce(state, "ended");
  assert.equal(getCurrentTrack(state).name, "A");

  state = reduce(state, "select", { index: -1 });
  assert.equal(reduce(state, "ended").currentIndex, -1);
});

test("shuffle uses injected RNG deterministically and keeps the current track first", () => {
  const initial = createQueueState({
    queue: [track("A"), track("B"), track("C"), track("D"), track("E")],
    currentIndex: 2,
  });
  const first = reduce(initial, "set-shuffle", { shuffle: true }, sequenceRng([0.1, 0.8, 0.3]));
  const second = reduce(initial, "set-shuffle", { shuffle: true }, sequenceRng([0.1, 0.8, 0.3]));
  const other = reduce(initial, "set-shuffle", { shuffle: true }, sequenceRng([0.9, 0.2, 0.7]));

  assert.deepEqual(first.shuffleOrder, second.shuffleOrder);
  assert.notDeepEqual(first.shuffleOrder, other.shuffleOrder);
  assert.equal(first.shuffleOrder[0], 2);
  assert.equal(first.shuffleIndex, 0);
  assert.deepEqual([...first.shuffleOrder].sort((a, b) => a - b), [0, 1, 2, 3, 4]);
  assert.equal(getCurrentTrack(first).name, "C");
});

test("shuffle next/previous follows deterministic history and repeat-all creates a new cycle", () => {
  let state = createQueueState({
    queue: [track("A"), track("B"), track("C"), track("D")],
    currentIndex: 0,
    repeat: "all",
  });
  state = reduce(state, "set-shuffle", { shuffle: true }, () => 0);
  const order = state.shuffleOrder.slice();
  const visited = [state.currentIndex];
  for (let index = 1; index < order.length; index += 1) {
    state = reduce(state, "next");
    visited.push(state.currentIndex);
  }
  assert.deepEqual(visited, order);

  state = reduce(state, "previous");
  assert.equal(state.currentIndex, order.at(-2));
  state = reduce(state, "next");
  assert.equal(state.currentIndex, order.at(-1));
  const previousEnd = state.currentIndex;
  state = reduce(state, "ended", {}, () => 0.75);
  assert.notEqual(state.currentIndex, previousEnd);
  assert.equal(state.shuffleIndex, 0);
  assert.deepEqual([...state.shuffleOrder].sort((a, b) => a - b), [0, 1, 2, 3]);
});

test("shuffle repeat-off remains on the last item and repeat-one never advances", () => {
  let state = createQueueState({ queue: [track("A"), track("B"), track("C")], currentIndex: 0 });
  state = reduce(state, "set-shuffle", { shuffle: true }, () => 0);
  while (state.shuffleIndex < state.shuffleOrder.length - 1) state = reduce(state, "next");
  const end = state;
  assert.deepEqual(reduce(state, "next"), end);
  assert.deepEqual(reduce(state, "ended"), end);

  state = reduce(state, "set-repeat", { repeat: "one" });
  assert.deepEqual(reduce(state, "ended"), state);
});

test("shuffle select starts a new deterministic history and disabling clears internals", () => {
  let state = createQueueState({ queue: [track("A"), track("B"), track("C")], currentIndex: 0 });
  state = reduce(state, "set-shuffle", { shuffle: true }, () => 0.9);
  state = reduce(state, "select", { index: 2 }, () => 0);
  assert.equal(state.currentIndex, 2);
  assert.equal(state.shuffleOrder[0], 2);
  assert.equal(state.shuffleIndex, 0);

  state = reduce(state, "set-shuffle", { shuffle: false });
  assert.equal(state.shuffle, false);
  assert.deepEqual(state.shuffleOrder, []);
  assert.equal(state.shuffleIndex, -1);
});

test("shuffle append randomizes only unvisited tracks and play-next is the next shuffled item", () => {
  let state = createQueueState({ queue: [track("A"), track("B"), track("C")], currentIndex: 0 });
  state = reduce(state, "set-shuffle", { shuffle: true }, () => 0);
  state = reduce(state, "next");
  const visitedPrefix = state.shuffleOrder.slice(0, state.shuffleIndex + 1);
  state = reduce(state, "append", { tracks: [track("D"), track("E")] }, () => 0.75);
  assert.deepEqual(state.shuffleOrder.slice(0, state.shuffleIndex + 1), visitedPrefix);
  assert.deepEqual([...state.shuffleOrder].sort((a, b) => a - b), [0, 1, 2, 3, 4]);

  state = reduce(state, "play-next", { track: track("NOW") });
  const currentName = getCurrentTrack(state).name;
  state = reduce(state, "next");
  assert.equal(getCurrentTrack(state).name, "NOW");
  assert.notEqual(getCurrentTrack(state).name, currentName);
});

test("shuffle removal preserves valid history and chooses the next history item", () => {
  let state = createQueueState({
    queue: [track("A"), track("B"), track("C"), track("D")],
    currentIndex: 0,
  });
  state = reduce(state, "set-shuffle", { shuffle: true }, () => 0);
  state = reduce(state, "next");
  const removedIndex = state.currentIndex;
  state = reduce(state, "remove", { index: removedIndex });

  assert.equal(state.queue.length, 3);
  assert.deepEqual([...state.shuffleOrder].sort((a, b) => a - b), [0, 1, 2]);
  assert.equal(state.shuffleOrder[state.shuffleIndex], state.currentIndex);
  assert.ok(getCurrentTrack(state));
});

test("malformed shuffle internals normalize to a safe traversal order", () => {
  const state = normalizeQueueState({
    queue: [track("A"), track("B"), track("C")],
    currentIndex: 1,
    shuffle: true,
    shuffleOrder: [1, 1, 99],
    shuffleIndex: 99,
  });
  assert.deepEqual(state.shuffleOrder, [1, 0, 2]);
  assert.equal(state.shuffleIndex, 0);
});

test("unknown actions and invalid RNG results remain safe and deterministic", () => {
  const state = createQueueState({ queue: [track("A"), track("B"), track("C")], currentIndex: 0 });
  assert.deepEqual(queueReducer(state, { type: "unknown" }), state);
  const shuffled = reduce(state, "set-shuffle", { shuffle: true }, () => Number.NaN);
  assert.deepEqual([...shuffled.shuffleOrder].sort((a, b) => a - b), [0, 1, 2]);
});

test("canonical cloud helpers strictly validate provider, identity, and quality", () => {
  assert.equal(
    canonicalCloudTrackPath("netease", "123456", "lossless"),
    "/api/cloud/v2/netease/123456/lossless",
  );
  assert.equal(
    canonicalCloudTrackId("kugou", "0123456789abcdef01234567", "hires"),
    "cloud-v2-kugou-0123456789abcdef01234567-hires",
  );
  assert.equal(canonicalCloudTrackPath("local", "123", "hires"), null);
  assert.equal(canonicalCloudTrackPath("netease", "0", "hires"), null);
  assert.equal(canonicalCloudTrackPath("kugou", "A".repeat(24), "hires"), null);
  assert.equal(canonicalCloudTrackPath("kugou", "a".repeat(24), "ultra"), null);
  assert.equal(canonicalCloudTrackPath("netease", "1/../../secret", "hires"), null);
});

test("v2 serialization retains only canonical cloud identity, name, provider, and quality", () => {
  const secret = "DO_NOT_PERSIST_TOKEN";
  const state = createQueueState({
    queue: [
      cloudTrack("netease", "123456", "lossless", {
        artist: "Artist",
        album: "Album",
        cover: "https://secret.example/cover.jpg",
        url: `https://secret.example/${secret}`,
        hash: "A".repeat(32),
        token: secret,
        secret,
        arbitrary: { nested: secret },
      }),
      cloudTrack("kugou", "0123456789abcdef01234567", "hires", {
        playKey: "0123456789abcdef01234567",
        path: `/private/${secret}`,
      }),
    ],
    currentIndex: 1,
    repeat: "all",
    shuffle: true,
  });
  const serialized = serializeQueueState(state);
  const snapshot = JSON.parse(serialized);

  assert.deepEqual(snapshot, {
    version: 2,
    queue: [
      { provider: "netease", id: "123456", name: "netease-123456", quality: "lossless" },
      { provider: "kugou", id: "0123456789abcdef01234567", name: "kugou-0123456789abcdef01234567", quality: "hires" },
    ],
    currentIndex: 1,
    repeat: "all",
    shuffle: true,
  });
  assert.doesNotMatch(serialized, /url|hash|token|secret|path|artist|album|cover|DO_NOT_PERSIST/i);
});

test("persistence excludes local and malformed cloud tracks and remaps current index", () => {
  const state = createQueueState({
    queue: [
      { id: "local-file", name: "Local", path: "C:\\secret\\song.mp3", provider: "local" },
      cloudTrack("netease", "42", "standard"),
      cloudTrack("kugou", "not-a-play-key", "hires"),
      cloudTrack("kugou", "abcdef0123456789abcdef01", "exhigh"),
    ],
    currentIndex: 3,
  });
  assert.deepEqual(JSON.parse(serializeQueueState(state)), {
    version: 2,
    queue: [
      { provider: "netease", id: "42", name: "netease-42", quality: "standard" },
      { provider: "kugou", id: "abcdef0123456789abcdef01", name: "kugou-abcdef0123456789abcdef01", quality: "exhigh" },
    ],
    currentIndex: 1,
    repeat: "off",
    shuffle: false,
  });

  const localSelected = createQueueState({ queue: [state.queue[0], state.queue[1]], currentIndex: 0 });
  assert.equal(JSON.parse(serializeQueueState(localSelected)).currentIndex, -1);
});

test("v2 restoration rebuilds relative canonical paths and never restores autoplay state", () => {
  const input = JSON.stringify({
    version: 2,
    queue: [
      {
        provider: "netease",
        id: "123456",
        name: " Song Name ",
        quality: "jymaster",
        url: "https://attacker.example/audio.mp3",
        path: "/arbitrary/path",
        token: "SECRET",
      },
      {
        provider: "kugou",
        id: "abcdef0123456789abcdef01",
        name: "Kugou",
        quality: "standard",
        hash: "A".repeat(32),
      },
    ],
    currentIndex: 1,
    repeat: "one",
    shuffle: true,
    playing: true,
    autoplay: true,
    currentTime: 123,
  });
  const restored = deserializeQueueState(input);

  assert.deepEqual(restored.queue, [
    {
      id: "cloud-v2-netease-123456-jymaster",
      name: "Song Name",
      type: "audio/mpeg",
      size: 0,
      path: "/api/cloud/v2/netease/123456/jymaster",
      provider: "netease",
      quality: "jymaster",
      sourceId: "123456",
    },
    {
      id: "cloud-v2-kugou-abcdef0123456789abcdef01-standard",
      name: "Kugou",
      type: "audio/mpeg",
      size: 0,
      path: "/api/cloud/v2/kugou/abcdef0123456789abcdef01/standard",
      provider: "kugou",
      quality: "standard",
      sourceId: "abcdef0123456789abcdef01",
    },
  ]);
  assert.equal(restored.currentIndex, 1);
  assert.equal(restored.repeat, "one");
  assert.equal(restored.shuffle, true);
  assert.equal("playing" in restored, false);
  assert.equal("autoplay" in restored, false);
  assert.equal("currentTime" in restored, false);
  assert.doesNotMatch(JSON.stringify(restored), /attacker|SECRET|hash|url|autoplay|playing/i);
});

test("persistence round-trip is canonical and supports composite cloud IDs", () => {
  const original = createQueueState({
    queue: [
      {
        id: "cloud-v2-netease-98765-hires",
        name: "Composite",
        path: "/wrong/path",
        provider: "netease",
        quality: "hires",
      },
      {
        id: "cloud-v2-kugou-0123456789abcdef01234567-lossless",
        playKey: "0123456789abcdef01234567",
        name: "Kugou",
        provider: "kugou",
        quality: "lossless",
      },
    ],
    currentIndex: 0,
    repeat: "all",
  });
  const serialized = serializeQueueState(original);
  const restored = deserializeQueueState(serialized);
  const serializedAgain = serializeQueueState(restored);

  assert.equal(serializedAgain, serialized);
  assert.equal(restored.queue[0].path, "/api/cloud/v2/netease/98765/hires");
  assert.equal(restored.queue[1].path, "/api/cloud/v2/kugou/0123456789abcdef01234567/lossless");
});

test("v2 restoration treats persisted id as authoritative and rejects malformed required fields", () => {
  const restored = deserializeQueueState(JSON.stringify({
    version: 2,
    queue: [
      { provider: "netease", id: "123", sourceId: "456", name: "N", quality: "hires" },
      { provider: "kugou", id: "0123456789abcdef01234567", playKey: "abcdef0123456789abcdef01", name: "K", quality: "lossless" },
      { provider: "local", id: "cloud-v2-netease-777-hires", name: "Fallback provider", quality: "hires" },
      { provider: "netease", id: "cloud-v2-netease-888-hires", name: "Composite id", quality: "hires" },
      { provider: "netease", id: "999", name: "Fallback quality", quality: "ultra" },
    ],
    currentIndex: 0,
    repeat: "off",
    shuffle: false,
  }));

  assert.deepEqual(restored.queue.map((item) => item.sourceId), ["123", "0123456789abcdef01234567"]);
  assert.equal(restored.currentIndex, 0);
});

test("deserialization safely rejects corruption, wrong versions, shapes, and oversized input", () => {
  const empty = createQueueState();
  const invalidInputs = [
    null,
    undefined,
    123,
    "",
    "{broken",
    "null",
    "[]",
    JSON.stringify({ version: 1, queue: [] }),
    JSON.stringify({ version: 3, queue: [] }),
    JSON.stringify({ version: 2, queue: {} }),
    "x".repeat(MAX_QUEUE_PERSISTENCE_BYTES + 1),
    "😀".repeat(Math.ceil(MAX_QUEUE_PERSISTENCE_BYTES / 4) + 1),
  ];
  for (const input of invalidInputs) assert.deepEqual(deserializeQueueState(input), empty);
});

test("deserialization sanitizes entries, canonical fields, modes, and bounds", () => {
  const queue = Array.from({ length: 105 }, (_, index) => ({
    provider: "netease",
    id: String(index + 1),
    name: `Song ${index}`,
    quality: "hires",
    url: `https://attacker.example/${index}`,
  }));
  queue.splice(1, 0,
    { provider: "local", id: "local", name: "Local", quality: "hires", path: "C:\\secret" },
    { provider: "kugou", id: "A".repeat(24), name: "Bad", quality: "hires" },
    { provider: "netease", id: "3", name: "Bad quality", quality: "ultra" },
  );
  const restored = deserializeQueueState(JSON.stringify({
    version: 2,
    queue,
    currentIndex: 0,
    repeat: "forever",
    shuffle: "yes",
  }));

  assert.equal(restored.queue.length, 100);
  assert.equal(restored.queue[0].sourceId, "1");
  assert.equal(restored.queue.at(-1).sourceId, "100");
  assert.equal(restored.currentIndex, 0);
  assert.equal(restored.repeat, "off");
  assert.equal(restored.shuffle, false);
  assert.doesNotMatch(JSON.stringify(restored), /attacker|C:\\|local|ultra/);
});

test("serialization caps count, field length, and encoded byte size", () => {
  const longUnicodeName = "矿".repeat(MAX_QUEUE_PERSISTENCE_BYTES);
  const state = createQueueState({
    queue: Array.from({ length: 100 }, (_, index) => cloudTrack("netease", String(index + 1), "hires", {
      name: longUnicodeName,
    })),
    currentIndex: 99,
  });
  const serialized = serializeQueueState(state);
  const byteLength = new TextEncoder().encode(serialized).byteLength;
  const snapshot = JSON.parse(serialized);

  assert.ok(byteLength <= MAX_QUEUE_PERSISTENCE_BYTES);
  assert.ok(snapshot.queue.length <= MAX_QUEUE_LENGTH);
  assert.ok(Array.from(snapshot.queue[0]?.name ?? "").length <= 160);
  assert.ok(snapshot.currentIndex === -1 || snapshot.currentIndex < snapshot.queue.length);
  assert.equal(snapshot.currentIndex, snapshot.queue.length - 1);
  assert.equal(snapshot.queue[snapshot.currentIndex].id, "100");
});

test("mismatched composite identity cannot smuggle a different provider, ID, or quality", () => {
  const tracks = [
    {
      id: "cloud-v2-netease-123-hires",
      sourceId: "456",
      provider: "netease",
      quality: "hires",
      name: "Different ID",
    },
    {
      id: "cloud-v2-netease-123-hires",
      provider: "kugou",
      playKey: "0123456789abcdef01234567",
      quality: "hires",
      name: "Different provider",
    },
    {
      id: "cloud-v2-netease-123-hires",
      provider: "netease",
      quality: "lossless",
      name: "Different quality",
    },
  ];
  const serialized = serializeQueueState(createQueueState({ queue: tracks, currentIndex: 0 }));
  assert.deepEqual(JSON.parse(serialized).queue, []);
});
