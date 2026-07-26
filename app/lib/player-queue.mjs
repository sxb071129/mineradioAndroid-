export const MAX_QUEUE_LENGTH = 100;
export const QUEUE_PERSISTENCE_VERSION = 2;
export const MAX_QUEUE_PERSISTENCE_BYTES = 64 * 1024;
export const MAX_QUEUE_TRACK_NAME_LENGTH = 160;

export const REPEAT_MODES = Object.freeze(["off", "all", "one"]);
export const CLOUD_PROVIDERS = Object.freeze(["netease", "kugou"]);
export const PLAYBACK_QUALITIES = Object.freeze([
  "jymaster",
  "hires",
  "lossless",
  "exhigh",
  "standard",
]);

const REPEAT_MODE_SET = new Set(REPEAT_MODES);
const CLOUD_PROVIDER_SET = new Set(CLOUD_PROVIDERS);
const PLAYBACK_QUALITY_SET = new Set(PLAYBACK_QUALITIES);
const DEFAULT_RNG = () => 0.5;
const MAX_QUEUE_INPUT_ENTRIES = MAX_QUEUE_LENGTH * 10;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedInteger(value, fallback = -1) {
  return Number.isSafeInteger(value) ? value : fallback;
}

function copyTracks(value, limit = MAX_QUEUE_LENGTH) {
  if (!Array.isArray(value) || limit <= 0) return [];
  const tracks = [];
  const inspectedLength = Math.min(value.length, MAX_QUEUE_INPUT_ENTRIES);
  for (let index = 0; index < inspectedLength && tracks.length < limit; index += 1) {
    const track = value[index];
    if (isRecord(track)) tracks.push({ ...track });
  }
  return tracks;
}

function compactedIndex(value, requestedIndex, compactedLength) {
  if (!Number.isSafeInteger(requestedIndex) || requestedIndex < -1) return -1;
  if (requestedIndex === -1) return -1;
  if (!Array.isArray(value) || requestedIndex >= Math.min(value.length, MAX_QUEUE_INPUT_ENTRIES)) return -1;
  let index = -1;
  for (let sourceIndex = 0; sourceIndex <= requestedIndex; sourceIndex += 1) {
    if (isRecord(value[sourceIndex])) index += 1;
    if (index >= compactedLength) return -1;
  }
  return isRecord(value[requestedIndex]) ? index : -1;
}

function actionTracks(value, limit = MAX_QUEUE_LENGTH) {
  if (Array.isArray(value)) return copyTracks(value, limit);
  return isRecord(value) && limit > 0 ? [{ ...value }] : [];
}

function naturalOrder(length, currentIndex) {
  const order = Array.from({ length }, (_, index) => index);
  if (currentIndex < 0) return order;
  return [currentIndex, ...order.filter((index) => index !== currentIndex)];
}

function isPermutation(order, length) {
  if (!Array.isArray(order) || order.length !== length) return false;
  const seen = new Set();
  for (const index of order) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= length || seen.has(index)) return false;
    seen.add(index);
  }
  return true;
}

function randomUnit(rng) {
  const value = Number(rng());
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value >= 1) return 1 - Number.EPSILON;
  return value;
}

function shuffled(indices, rng) {
  const result = indices.slice();
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(randomUnit(rng) * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function newShuffleOrder(length, currentIndex, rng) {
  const indices = Array.from({ length }, (_, index) => index);
  if (currentIndex < 0) return shuffled(indices, rng);
  return [currentIndex, ...shuffled(indices.filter((index) => index !== currentIndex), rng)];
}

function normalizedCurrentIndex(value, length) {
  const index = boundedInteger(value);
  return index >= -1 && index < length ? index : -1;
}

/**
 * Normalize external or previously persisted queue state without mutating it.
 * Invalid tracks are discarded and all queues are capped at MAX_QUEUE_LENGTH.
 */
export function normalizeQueueState(value = {}) {
  const input = isRecord(value) ? value : {};
  const queue = copyTracks(input.queue);
  const currentIndex = compactedIndex(input.queue, input.currentIndex, queue.length);
  const repeat = REPEAT_MODE_SET.has(input.repeat) ? input.repeat : "off";
  const shuffle = input.shuffle === true;

  if (!shuffle) {
    return { queue, currentIndex, repeat, shuffle: false, shuffleOrder: [], shuffleIndex: -1 };
  }

  const shuffleOrder = isPermutation(input.shuffleOrder, queue.length)
    ? input.shuffleOrder.slice()
    : naturalOrder(queue.length, currentIndex);
  const shuffleIndex = currentIndex < 0 ? -1 : shuffleOrder.indexOf(currentIndex);
  return { queue, currentIndex, repeat, shuffle: true, shuffleOrder, shuffleIndex };
}

export function createQueueState(initial = {}) {
  return normalizeQueueState(initial);
}

export function getCurrentTrack(state) {
  if (!isRecord(state) || !Array.isArray(state.queue)) return null;
  const index = normalizedCurrentIndex(state.currentIndex, state.queue.length);
  return index < 0 ? null : state.queue[index] ?? null;
}

function withShuffleOrder(state, queue, currentIndex, shuffleOrder) {
  return {
    queue,
    currentIndex,
    repeat: state.repeat,
    shuffle: state.shuffle,
    shuffleOrder: state.shuffle ? shuffleOrder : [],
    shuffleIndex: state.shuffle && currentIndex >= 0 ? shuffleOrder.indexOf(currentIndex) : -1,
  };
}

function replaceQueue(state, action, rng) {
  const source = action.queue ?? action.tracks;
  const queue = copyTracks(source);
  const requestedIndex = action.currentIndex === undefined
    ? queue.length ? 0 : -1
    : compactedIndex(source, action.currentIndex, queue.length);
  const currentIndex = action.currentIndex !== -1 && requestedIndex === -1 && queue.length
    ? 0
    : requestedIndex;
  const shuffleOrder = state.shuffle ? newShuffleOrder(queue.length, currentIndex, rng) : [];
  return withShuffleOrder(state, queue, currentIndex, shuffleOrder);
}

function appendQueue(state, action, rng) {
  const available = MAX_QUEUE_LENGTH - state.queue.length;
  const additions = actionTracks(action.tracks ?? action.track, available);
  if (!additions.length) return state;

  const oldLength = state.queue.length;
  const queue = [...state.queue, ...additions];
  if (!state.shuffle) return withShuffleOrder(state, queue, state.currentIndex, []);

  const splitAt = state.shuffleIndex >= 0 ? state.shuffleIndex + 1 : 0;
  const prefix = state.shuffleOrder.slice(0, splitAt);
  const future = [
    ...state.shuffleOrder.slice(splitAt),
    ...Array.from({ length: additions.length }, (_, index) => oldLength + index),
  ];
  return withShuffleOrder(state, queue, state.currentIndex, [...prefix, ...shuffled(future, rng)]);
}

function playNext(state, action) {
  const available = MAX_QUEUE_LENGTH - state.queue.length;
  const additions = actionTracks(action.tracks ?? action.track, available);
  if (!additions.length) return state;

  const insertionIndex = state.currentIndex >= 0 ? state.currentIndex + 1 : 0;
  const queue = [
    ...state.queue.slice(0, insertionIndex),
    ...additions,
    ...state.queue.slice(insertionIndex),
  ];
  if (!state.shuffle) return withShuffleOrder(state, queue, state.currentIndex, []);

  const mappedOrder = state.shuffleOrder.map((index) => (
    index >= insertionIndex ? index + additions.length : index
  ));
  const insertedIndices = Array.from(
    { length: additions.length },
    (_, index) => insertionIndex + index,
  );
  const currentIndex = state.currentIndex;
  const orderInsertionIndex = currentIndex >= 0 ? mappedOrder.indexOf(currentIndex) + 1 : 0;
  const shuffleOrder = mappedOrder.slice();
  shuffleOrder.splice(orderInsertionIndex, 0, ...insertedIndices);
  return withShuffleOrder(state, queue, currentIndex, shuffleOrder);
}

function removeAt(state, action) {
  const index = boundedInteger(action.index);
  if (index < 0 || index >= state.queue.length) return state;

  const queue = [...state.queue.slice(0, index), ...state.queue.slice(index + 1)];
  if (!queue.length) return withShuffleOrder(state, [], -1, []);

  if (!state.shuffle) {
    let currentIndex = state.currentIndex;
    if (index < currentIndex) currentIndex -= 1;
    else if (index === currentIndex) currentIndex = Math.min(index, queue.length - 1);
    return withShuffleOrder(state, queue, currentIndex, []);
  }

  const removedOrderIndex = state.shuffleOrder.indexOf(index);
  const shuffleOrder = state.shuffleOrder
    .filter((candidate) => candidate !== index)
    .map((candidate) => candidate > index ? candidate - 1 : candidate);
  let currentIndex;
  if (index === state.currentIndex) {
    const nextOrderIndex = Math.min(Math.max(removedOrderIndex, 0), shuffleOrder.length - 1);
    currentIndex = shuffleOrder[nextOrderIndex];
  } else if (state.currentIndex > index) {
    currentIndex = state.currentIndex - 1;
  } else {
    currentIndex = state.currentIndex;
  }
  return withShuffleOrder(state, queue, currentIndex, shuffleOrder);
}

function selectAt(state, action, rng) {
  const index = boundedInteger(action.index);
  if (index < -1 || index >= state.queue.length) return state;
  if (!state.shuffle) return withShuffleOrder(state, state.queue, index, []);
  if (index === -1) return withShuffleOrder(state, state.queue, -1, state.shuffleOrder);
  if (index === state.currentIndex) return state;
  return withShuffleOrder(
    state,
    state.queue,
    index,
    newShuffleOrder(state.queue.length, index, rng),
  );
}

function nextTrack(state, rng) {
  if (!state.queue.length) return state;
  if (!state.shuffle) {
    if (state.currentIndex < 0) return withShuffleOrder(state, state.queue, 0, []);
    if (state.currentIndex < state.queue.length - 1) {
      return withShuffleOrder(state, state.queue, state.currentIndex + 1, []);
    }
    return state.repeat === "all"
      ? withShuffleOrder(state, state.queue, 0, [])
      : state;
  }

  if (state.currentIndex < 0) {
    return withShuffleOrder(state, state.queue, state.shuffleOrder[0], state.shuffleOrder);
  }
  if (state.shuffleIndex < state.shuffleOrder.length - 1) {
    return withShuffleOrder(
      state,
      state.queue,
      state.shuffleOrder[state.shuffleIndex + 1],
      state.shuffleOrder,
    );
  }
  if (state.repeat !== "all") return state;

  const shuffleOrder = shuffled(
    Array.from({ length: state.queue.length }, (_, index) => index),
    rng,
  );
  if (shuffleOrder.length > 1 && shuffleOrder[0] === state.currentIndex) {
    [shuffleOrder[0], shuffleOrder[1]] = [shuffleOrder[1], shuffleOrder[0]];
  }
  return withShuffleOrder(state, state.queue, shuffleOrder[0], shuffleOrder);
}

function previousTrack(state) {
  if (!state.queue.length) return state;
  if (!state.shuffle) {
    if (state.currentIndex < 0) {
      return withShuffleOrder(state, state.queue, state.queue.length - 1, []);
    }
    if (state.currentIndex > 0) {
      return withShuffleOrder(state, state.queue, state.currentIndex - 1, []);
    }
    return state.repeat === "all"
      ? withShuffleOrder(state, state.queue, state.queue.length - 1, [])
      : state;
  }

  if (state.currentIndex < 0) {
    const lastIndex = state.shuffleOrder.length - 1;
    return withShuffleOrder(state, state.queue, state.shuffleOrder[lastIndex], state.shuffleOrder);
  }
  if (state.shuffleIndex > 0) {
    return withShuffleOrder(
      state,
      state.queue,
      state.shuffleOrder[state.shuffleIndex - 1],
      state.shuffleOrder,
    );
  }
  if (state.repeat !== "all") return state;
  const lastIndex = state.shuffleOrder.length - 1;
  return withShuffleOrder(state, state.queue, state.shuffleOrder[lastIndex], state.shuffleOrder);
}

/**
 * Pure queue transition. Pass an RNG as the third argument for shuffle actions.
 * The deterministic default keeps the reducer referentially transparent.
 */
export function queueReducer(previousState, action, rng = DEFAULT_RNG) {
  const state = normalizeQueueState(previousState);
  const event = isRecord(action) ? action : {};
  const random = typeof rng === "function" ? rng : DEFAULT_RNG;

  switch (event.type) {
    case "replace":
      return replaceQueue(state, event, random);
    case "append":
      return appendQueue(state, event, random);
    case "play-next":
      return playNext(state, event);
    case "remove":
      return removeAt(state, event);
    case "clear":
      return withShuffleOrder(state, [], -1, []);
    case "select":
      return selectAt(state, event, random);
    case "previous":
      return previousTrack(state);
    case "next":
      return nextTrack(state, random);
    case "ended":
      return state.currentIndex < 0 || state.repeat === "one" ? state : nextTrack(state, random);
    case "set-repeat": {
      const repeat = event.repeat ?? event.value;
      return REPEAT_MODE_SET.has(repeat) ? { ...state, repeat } : state;
    }
    case "set-shuffle": {
      const shuffle = event.shuffle ?? event.enabled ?? event.value;
      if (typeof shuffle !== "boolean" || shuffle === state.shuffle) return state;
      if (!shuffle) return { ...state, shuffle: false, shuffleOrder: [], shuffleIndex: -1 };
      const shuffleOrder = newShuffleOrder(state.queue.length, state.currentIndex, random);
      return {
        ...state,
        shuffle: true,
        shuffleOrder,
        shuffleIndex: state.currentIndex < 0 ? -1 : shuffleOrder.indexOf(state.currentIndex),
      };
    }
    default:
      return state;
  }
}

function validProvider(value) {
  if (typeof value !== "string" || value.length > 8) return null;
  const provider = value.toLowerCase();
  return CLOUD_PROVIDER_SET.has(provider) ? provider : null;
}

function validQuality(value) {
  return typeof value === "string" && value.length <= 8 && PLAYBACK_QUALITY_SET.has(value) ? value : null;
}

function validCloudIdentity(provider, value) {
  if (typeof value !== "string" || value.length > 24) return null;
  if (provider === "netease" && /^[1-9]\d{0,19}$/.test(value)) return value;
  if (provider === "kugou" && /^[a-f0-9]{24}$/.test(value)) return value;
  return null;
}

function parseCompositeCloudId(value) {
  if (typeof value !== "string" || value.length > 58) return null;
  const match = /^cloud-v2-(netease|kugou)-([A-Za-z0-9]{1,24})-(jymaster|hires|lossless|exhigh|standard)$/.exec(value);
  if (!match) return null;
  const identity = validCloudIdentity(match[1], match[2]);
  return identity ? { provider: match[1], id: identity, quality: match[3] } : null;
}

function cleanTrackName(value) {
  if (typeof value !== "string") return "";
  const clipped = value.slice(0, MAX_QUEUE_TRACK_NAME_LENGTH * 2).trim();
  return Array.from(clipped).slice(0, MAX_QUEUE_TRACK_NAME_LENGTH).join("");
}

function persistedRuntimeCloudTrack(track) {
  if (!isRecord(track)) return null;
  const composite = parseCompositeCloudId(track.id);
  const provider = validProvider(track.provider);
  const quality = validQuality(track.quality);
  if (!provider || !quality) return null;

  const candidates = [
    composite?.id ?? null,
    validCloudIdentity(provider, track.id),
    validCloudIdentity(provider, track.sourceId),
    provider === "kugou" ? validCloudIdentity(provider, track.playKey) : null,
  ].filter(Boolean);
  const id = candidates[0] ?? null;
  if (!id || candidates.some((candidate) => candidate !== id) || (composite && (
    composite.provider !== provider || composite.quality !== quality
  ))) return null;

  return { provider, id, name: cleanTrackName(track.name), quality };
}

function persistedSnapshotCloudTrack(track) {
  if (!isRecord(track)) return null;
  const provider = validProvider(track.provider);
  const quality = validQuality(track.quality);
  const id = provider ? validCloudIdentity(provider, track.id) : null;
  if (!provider || !quality || !id) return null;
  return { provider, id, name: cleanTrackName(track.name), quality };
}

export function canonicalCloudTrackPath(providerValue, identityValue, qualityValue) {
  const provider = validProvider(providerValue);
  const quality = validQuality(qualityValue);
  const identity = provider ? validCloudIdentity(provider, identityValue) : null;
  if (!provider || !identity || !quality) return null;
  return `/api/cloud/v2/${provider}/${identity}/${quality}`;
}

export function canonicalCloudTrackId(providerValue, identityValue, qualityValue) {
  const path = canonicalCloudTrackPath(providerValue, identityValue, qualityValue);
  if (!path) return null;
  return `cloud-v2-${providerValue.toLowerCase()}-${identityValue}-${qualityValue}`;
}

function utf8ByteLength(value) {
  if (value.length > MAX_QUEUE_PERSISTENCE_BYTES) return value.length;
  return new TextEncoder().encode(value).byteLength;
}

function emptySnapshotState() {
  return createQueueState();
}

/**
 * Serialize a v2 snapshot. Only canonical cloud identity, display name,
 * provider, and requested quality survive for each track.
 */
export function serializeQueueState(value) {
  const input = isRecord(value) ? value : {};
  const sourceQueue = Array.isArray(input.queue) ? input.queue : [];
  const inspectedLength = Math.min(sourceQueue.length, MAX_QUEUE_INPUT_ENTRIES);
  const queue = [];
  let currentIndex = -1;

  for (let index = 0; index < inspectedLength && queue.length < MAX_QUEUE_LENGTH; index += 1) {
    const track = persistedRuntimeCloudTrack(sourceQueue[index]);
    if (!track) continue;
    if (index === input.currentIndex) currentIndex = queue.length;
    queue.push(track);
  }

  const snapshot = {
    version: QUEUE_PERSISTENCE_VERSION,
    queue,
    currentIndex,
    repeat: REPEAT_MODE_SET.has(input.repeat) ? input.repeat : "off",
    shuffle: input.shuffle === true,
  };
  let serialized = JSON.stringify(snapshot);
  while (utf8ByteLength(serialized) > MAX_QUEUE_PERSISTENCE_BYTES && snapshot.queue.length) {
    const removalIndex = snapshot.currentIndex === snapshot.queue.length - 1
      ? 0
      : snapshot.queue.length - 1;
    snapshot.queue.splice(removalIndex, 1);
    if (snapshot.currentIndex > removalIndex) snapshot.currentIndex -= 1;
    else if (snapshot.currentIndex === removalIndex) snapshot.currentIndex = -1;
    serialized = JSON.stringify(snapshot);
  }
  return serialized;
}

/**
 * Restore a v2 snapshot without playback state or side effects. Corrupt,
 * oversized, unsupported, and non-canonical input safely becomes empty state.
 */
export function deserializeQueueState(serialized) {
  if (typeof serialized !== "string" || utf8ByteLength(serialized) > MAX_QUEUE_PERSISTENCE_BYTES) {
    return emptySnapshotState();
  }

  let snapshot;
  try {
    snapshot = JSON.parse(serialized);
  } catch {
    return emptySnapshotState();
  }
  if (!isRecord(snapshot) || snapshot.version !== QUEUE_PERSISTENCE_VERSION || !Array.isArray(snapshot.queue)) {
    return emptySnapshotState();
  }

  const queue = [];
  let currentIndex = -1;
  const inspectedLength = Math.min(snapshot.queue.length, MAX_QUEUE_INPUT_ENTRIES);
  for (let index = 0; index < inspectedLength && queue.length < MAX_QUEUE_LENGTH; index += 1) {
    const persisted = persistedSnapshotCloudTrack(snapshot.queue[index]);
    if (!persisted) continue;
    const path = canonicalCloudTrackPath(persisted.provider, persisted.id, persisted.quality);
    const id = canonicalCloudTrackId(persisted.provider, persisted.id, persisted.quality);
    if (!path || !id) continue;
    if (index === snapshot.currentIndex) currentIndex = queue.length;
    queue.push({
      id,
      name: persisted.name,
      type: "audio/mpeg",
      size: 0,
      path,
      provider: persisted.provider,
      quality: persisted.quality,
      sourceId: persisted.id,
    });
  }

  return createQueueState({
    queue,
    currentIndex,
    repeat: snapshot.repeat,
    shuffle: snapshot.shuffle,
  });
}
