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

export type RoomBufferState =
  | ""
  | "loading"
  | "buffering"
  | "ready"
  | "stalled"
  | "error"
  | "unlock_required";

export type RoomDeviceState = {
  clientId: string;
  name: string;
  leader: boolean;
  participant: boolean;
  ready: boolean;
  prepared: boolean;
  blocked: boolean;
  bufferedSeconds: number;
  bufferGoalSeconds: number;
  bufferProgress: number;
  latencyMs: number;
  jitterMs: number;
  driftMs: number;
  quality: PlaybackQuality | "";
  bufferState: RoomBufferState;
  volumeTrimDb: number;
  delayMs: number;
  updatedAt: number;
};

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
  bufferProgress: number;
  prepareDeadline: number;
  prepareMaxDeadline: number;
  prepareErrorClientIds: string[];
  position: number;
  volume: number;
  updatedAt: number;
  serverTime: number;
  deviceCount: number;
  devices: RoomDeviceState[];
  leaderId: string;
};

export type SyncStatus = "idle" | "connecting" | "connected" | "reconnecting" | "error";

export type RoomCommand =
  | { action: "play" }
  | { action: "pause" }
  | { action: "seek"; position: number }
  | { action: "progress"; position: number; advancing?: boolean }
  | {
      action: "ready";
      prepareId: string;
      ready?: boolean;
      bufferedSeconds?: number;
      bufferGoalSeconds?: number;
      bufferState?: RoomBufferState;
      latencyMs?: number;
      jitterMs?: number;
      driftMs?: number;
      quality?: PlaybackQuality;
      volumeTrimDb?: number;
      delayMs?: number;
    }
  | {
      action: "device-status";
      prepareId?: string;
      bufferedSeconds?: number;
      bufferGoalSeconds?: number;
      bufferState?: RoomBufferState;
      latencyMs?: number;
      jitterMs?: number;
      driftMs?: number;
      quality?: PlaybackQuality;
      volumeTrimDb?: number;
      delayMs?: number;
    }
  | { action: "start-failed"; prepareId: string }
  | {
      action: "device-calibration";
      targetClientId: string;
      volumeTrimDb: number;
      delayMs: number;
    }
  | { action: "volume"; volume: number }
  | { action: "quality"; quality: PlaybackQuality }
  | { action: "track"; track: TrackDescriptor };
