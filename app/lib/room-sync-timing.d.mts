export type ClockSample = {
  rttMs: number;
  latencyMs: number;
  offsetMs: number;
};

export type ClockEstimate = {
  samples: ClockSample[];
  offsetMs: number;
  latencyMs: number;
  jitterMs: number;
  initialized: boolean;
};

export function createClockSample(
  sentAt: number,
  receivedAt: number,
  serverReceivedAt: number,
  serverSentAt?: number,
): ClockSample | null;

export function updateClockEstimate(
  history: ClockSample[],
  sample: ClockSample | null,
  previous?: Partial<ClockEstimate>,
): ClockEstimate;

export function targetRoomPosition(
  state: { position?: number; playing?: boolean; updatedAt?: number } | null | undefined,
  nowMs?: number,
  offsetMs?: number,
): number;

export function playbackCorrection(
  targetPosition: number,
  currentPosition: number,
  options?: { latencyMs?: number; jitterMs?: number; playing?: boolean; forceSeek?: boolean },
): {
  mode: "hold" | "rate" | "seek";
  rate: number;
  drift: number;
  hardThreshold: number;
  softThreshold: number;
};
