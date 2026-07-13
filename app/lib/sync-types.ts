export type TrackDescriptor = {
  id: string;
  name: string;
  type: string;
  size: number;
  path: string;
};

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
  | { action: "track"; track: TrackDescriptor };

