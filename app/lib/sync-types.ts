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
  | { action: "volume"; volume: number }
  | { action: "quality"; quality: PlaybackQuality }
  | { action: "track"; track: TrackDescriptor };
