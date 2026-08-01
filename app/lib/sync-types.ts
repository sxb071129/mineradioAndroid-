export type TrackDescriptor = {
  id: string;
  name: string;
  type: string;
  size: number;
  path: string;
  provider?: "netease" | "kugou";
  quality?: PlaybackQuality;
  artist?: string;
  album?: string;
  cover?: string;
};

export type PlaybackQuality = "jymaster" | "hires" | "lossless" | "exhigh" | "standard";

export const ROOM_SYNC_PROTOCOL_VERSION = 3;

export type RoomSyncCapabilities = {
  bufferContract: true;
  armedPlayback: true;
};

export type RoomJoinMessage = {
  type: "join";
  room: string;
  name: string;
  protocolVersion?: number;
  capabilities?: Partial<RoomSyncCapabilities>;
};

export type RoomCommitState = "" | "tentative" | "committed";

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
  protocolVersion: number;
  strictParticipant: boolean;
  participant: boolean;
  ready: boolean;
  armed: boolean;
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
  protocolVersion: number;
  strictSync: boolean;
  revision: number;
  track: TrackDescriptor | null;
  playing: boolean;
  preparing: boolean;
  prepareId: string;
  prepareError: "" | "timeout" | "start_failed";
  commitId: string;
  commitState: RoomCommitState;
  scheduledAt: number;
  readyCount: number;
  requiredCount: number;
  armedCount: number;
  strictRequiredCount: number;
  bufferProgress: number;
  prepareDeadline: number;
  prepareMaxDeadline: number;
  commitDeadline: number;
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
  | {
      action: "armed";
      prepareId: string;
      commitId: string;
      armed?: boolean;
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
  | { action: "start-failed"; prepareId: string; commitId?: string }
  | {
      action: "device-calibration";
      targetClientId: string;
      volumeTrimDb: number;
      delayMs: number;
    }
  | { action: "volume"; volume: number }
  | { action: "quality"; quality: PlaybackQuality }
  | { action: "track"; track: TrackDescriptor };
