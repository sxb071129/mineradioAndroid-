export const MAX_QUEUE_LENGTH: 100;
export const QUEUE_PERSISTENCE_VERSION: 2;
export const MAX_QUEUE_PERSISTENCE_BYTES: number;
export const MAX_QUEUE_TRACK_NAME_LENGTH: number;

export const REPEAT_MODES: readonly ["off", "all", "one"];
export const CLOUD_PROVIDERS: readonly ["netease", "kugou"];
export const PLAYBACK_QUALITIES: readonly ["jymaster", "hires", "lossless", "exhigh", "standard"];

export type RepeatMode = (typeof REPEAT_MODES)[number];
export type CloudProvider = (typeof CLOUD_PROVIDERS)[number];
export type PlaybackQuality = (typeof PLAYBACK_QUALITIES)[number];

export type QueueTrack = Readonly<object>;

export type QueueState<T extends QueueTrack = QueueTrack> = Readonly<{
  queue: readonly T[];
  currentIndex: number;
  repeat: RepeatMode;
  shuffle: boolean;
  /** Internal deterministic traversal order. Consumers should treat this as opaque. */
  shuffleOrder: readonly number[];
  /** Internal cursor into shuffleOrder, or -1 when nothing is selected. */
  shuffleIndex: number;
}>;

export type QueueStateInput<T extends QueueTrack = QueueTrack> = Partial<{
  queue: readonly T[];
  currentIndex: number;
  repeat: RepeatMode;
  shuffle: boolean;
  shuffleOrder: readonly number[];
  shuffleIndex: number;
}>;

export type QueueAction<T extends QueueTrack = QueueTrack> =
  | { readonly type: "replace"; readonly queue?: readonly T[]; readonly tracks?: readonly T[]; readonly currentIndex?: number }
  | { readonly type: "append"; readonly track?: T; readonly tracks?: readonly T[] }
  | { readonly type: "play-next"; readonly track?: T; readonly tracks?: readonly T[] }
  | { readonly type: "remove"; readonly index: number }
  | { readonly type: "clear" }
  | { readonly type: "select"; readonly index: number }
  | { readonly type: "previous" }
  | { readonly type: "next" }
  | { readonly type: "ended" }
  | { readonly type: "set-repeat"; readonly repeat: RepeatMode }
  | { readonly type: "set-shuffle"; readonly shuffle: boolean };

export type CloudQueueTrack = Readonly<{
  id: string;
  name: string;
  type: "audio/mpeg";
  size: 0;
  path: string;
  provider: CloudProvider;
  quality: PlaybackQuality;
  sourceId: string;
}>;

export type PersistedCloudQueueTrack = Readonly<{
  provider: CloudProvider;
  id: string;
  name: string;
  quality: PlaybackQuality;
}>;

export type QueuePersistenceV2 = Readonly<{
  version: 2;
  queue: readonly PersistedCloudQueueTrack[];
  currentIndex: number;
  repeat: RepeatMode;
  shuffle: boolean;
}>;

export type QueueRng = () => number;

export function normalizeQueueState<T extends QueueTrack = QueueTrack>(
  value?: QueueStateInput<T> | unknown,
): QueueState<T>;

export function createQueueState<T extends QueueTrack = QueueTrack>(
  initial?: QueueStateInput<T>,
): QueueState<T>;

export function getCurrentTrack<T extends QueueTrack>(state: QueueState<T>): T | null;

export function queueReducer<T extends QueueTrack>(
  previousState: QueueStateInput<T>,
  action: QueueAction<T>,
  rng?: QueueRng,
): QueueState<T>;

export function canonicalCloudTrackPath(
  provider: CloudProvider | string,
  identity: string,
  quality: PlaybackQuality | string,
): string | null;

export function canonicalCloudTrackId(
  provider: CloudProvider | string,
  identity: string,
  quality: PlaybackQuality | string,
): string | null;

export function serializeQueueState<T extends QueueTrack>(state: QueueStateInput<T>): string;

export function deserializeQueueState(serialized: unknown): QueueState<CloudQueueTrack>;
