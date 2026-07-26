import "../../public/classic/room-sync-core.js";

export type BufferReadiness = {
  bufferedSeconds: number;
  bufferGoalSeconds: number;
  bufferProgress: number;
  ready: boolean;
};

type MediaBufferSource = {
  duration: number;
  buffered: TimeRanges;
};

type RoomSyncCore = {
  DEFAULT_BUFFER_GOAL_SECONDS: number;
  MAX_BUFFER_GOAL_SECONDS: number;
  measureBufferedWindow(
    media: MediaBufferSource | null,
    target: number,
    network?: { latencyMs?: number; jitterMs?: number },
  ): BufferReadiness;
};

const sharedGlobal = globalThis as typeof globalThis & {
  MineradioRoomSyncCore?: RoomSyncCore;
};

if (!sharedGlobal.MineradioRoomSyncCore) {
  throw new Error("Mineradio room sync core failed to initialize");
}

export const roomSyncCore = sharedGlobal.MineradioRoomSyncCore;

export function measureBufferedWindow(
  media: MediaBufferSource | null,
  target: number,
  network?: { latencyMs?: number; jitterMs?: number },
) {
  return roomSyncCore.measureBufferedWindow(media, target, network);
}
