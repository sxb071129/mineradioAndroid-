const CLOCK_SAMPLE_LIMIT = 12;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function createClockSample(sentAt, receivedAt, serverReceivedAt, serverSentAt = serverReceivedAt) {
  const sent = finiteNumber(sentAt);
  const received = finiteNumber(receivedAt);
  const serverReceived = finiteNumber(serverReceivedAt);
  const serverSent = finiteNumber(serverSentAt);
  if (sent === null || received === null || serverReceived === null || serverSent === null) return null;
  if (received < sent || serverSent < serverReceived) return null;

  const serverProcessingMs = clamp(serverSent - serverReceived, 0, 30_000);
  const rttMs = Math.max(0, received - sent - serverProcessingMs);
  if (rttMs > 30_000) return null;
  const offsetMs = ((serverReceived - sent) + (serverSent - received)) / 2;
  return { rttMs, latencyMs: rttMs / 2, offsetMs };
}

export function updateClockEstimate(history, sample, previous = {}) {
  const validHistory = Array.isArray(history)
    ? history.filter((entry) => entry && Number.isFinite(entry.rttMs) && Number.isFinite(entry.offsetMs))
    : [];
  if (!sample || !Number.isFinite(sample.rttMs) || !Number.isFinite(sample.offsetMs)) {
    return {
      samples: validHistory.slice(-CLOCK_SAMPLE_LIMIT),
      offsetMs: Number(previous.offsetMs) || 0,
      latencyMs: Math.max(0, Number(previous.latencyMs) || 0),
      jitterMs: Math.max(0, Number(previous.jitterMs) || 0),
      initialized: previous.initialized === true,
    };
  }

  const samples = [...validHistory, sample].slice(-CLOCK_SAMPLE_LIMIT);
  const sortedByRtt = [...samples]
    .sort((left, right) => left.rttMs - right.rttMs)
  const fastest = sortedByRtt.slice(0, samples.length >= 3 ? 3 : 1);
  const offsets = fastest.map((entry) => entry.offsetMs).sort((left, right) => left - right);
  const middle = Math.floor(offsets.length / 2);
  const selectedOffset = offsets.length % 2
    ? offsets[middle]
    : (offsets[middle - 1] + offsets[middle]) / 2;
  const initialized = previous.initialized === true;
  const previousOffset = Number(previous.offsetMs) || 0;
  const previousLatency = Math.max(0, Number(previous.latencyMs) || 0);
  const previousBestRtt = validHistory.length
    ? Math.min(...validHistory.map((entry) => entry.rttMs))
    : Infinity;
  const qualityImproved = sample.rttMs + 1 < previousBestRtt * 0.8;
  const meanOffset = offsets.reduce((total, value) => total + value, 0) / offsets.length;
  const jitterMs = Math.sqrt(offsets.reduce((total, value) => total + (value - meanOffset) ** 2, 0) / offsets.length);

  return {
    samples,
    offsetMs: initialized && !qualityImproved ? previousOffset * 0.72 + selectedOffset * 0.28 : selectedOffset,
    latencyMs: initialized ? previousLatency * 0.68 + sample.latencyMs * 0.32 : sample.latencyMs,
    jitterMs,
    initialized: true,
  };
}

export function targetRoomPosition(state, nowMs = Date.now(), offsetMs = 0) {
  const position = Math.max(0, Number(state?.position) || 0);
  if (!state?.playing) return position;
  const now = finiteNumber(nowMs) ?? Date.now();
  const updatedAt = finiteNumber(state?.updatedAt);
  if (updatedAt === null) return position;
  const elapsedSeconds = Math.max(0, (now + (Number(offsetMs) || 0) - updatedAt) / 1000);
  return Math.min(86_400, position + elapsedSeconds);
}

export function playbackCorrection(targetPosition, currentPosition, options = {}) {
  const target = finiteNumber(targetPosition);
  const current = finiteNumber(currentPosition);
  if (target === null || current === null) {
    return { mode: "hold", rate: 1, drift: 0, hardThreshold: 0.3, softThreshold: 0.05 };
  }

  const drift = target - current;
  const absoluteDrift = Math.abs(drift);
  const jitterSeconds = clamp((Number(options.jitterMs) || 0) / 1000, 0, 0.05);
  const hardThreshold = 0.3 + jitterSeconds;
  const softThreshold = 0.05 + jitterSeconds * 0.5;
  const playing = options.playing !== false;

  if (options.forceSeek === true || (!playing && absoluteDrift > softThreshold)) {
    return { mode: "seek", rate: 1, drift, hardThreshold, softThreshold };
  }
  if (!playing || absoluteDrift <= softThreshold) {
    return { mode: "hold", rate: 1, drift, hardThreshold, softThreshold };
  }
  if (absoluteDrift > hardThreshold) {
    return { mode: "seek", rate: 1, drift, hardThreshold, softThreshold };
  }

  return {
    mode: "rate",
    rate: clamp(1 + drift * 0.3, 0.96, 1.04),
    drift,
    hardThreshold,
    softThreshold,
  };
}
