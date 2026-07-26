export type TrackDescriptor = {
  id: string;
  name: string;
  type: string;
  size: number;
  path: string;
  provider?: "netease" | "kugou";
  quality?: PlaybackQuality;
};

export type PlaybackQuality = "jymaster" | "hires" | "lossless" | "exhigh" | "standard";

export type RoomState = {
  revision: number;
  track: TrackDescriptor | null;
  playing: boolean;
  preparing: boolean;
  prepareId: string;
  prepareError: "" | "timeout" | "start_failed";
  scheduledAt: number;
  readyCount: number;
  requiredCount: number;
  position: number;
  volume: number;
  updatedAt: number;
  serverTime: number;
  deviceCount: number;
  leaderId: string;
};

export type SyncStatus = "idle" | "connecting" | "connected" | "reconnecting" | "error";

export type RoomCommand =
  | { action: "play" }
  | { action: "pause" }
  | { action: "seek"; position: number }
  | { action: "progress"; position: number; advancing?: boolean }
  | { action: "ready"; prepareId: string; ready?: boolean; latencyMs?: number; jitterMs?: number }
  | { action: "start-failed"; prepareId: string }
  | { action: "volume"; volume: number }
  | { action: "quality"; quality: PlaybackQuality }
  | { action: "track"; track: TrackDescriptor };
