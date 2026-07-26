import assert from "node:assert/strict";
import test from "node:test";
import {
  createClockSample,
  playbackCorrection,
  targetRoomPosition,
  updateClockEstimate,
} from "../app/lib/room-sync-timing.mjs";

test("clock samples remove server processing time and estimate offset", () => {
  const sample = createClockSample(1000, 1104, 1100, 1104);
  assert.deepEqual(sample, { rttMs: 100, latencyMs: 50, offsetMs: 50 });
  assert.equal(createClockSample(1100, 1000, 1100, 1100), null);
});

test("clock estimates prefer low-RTT samples and smooth latency", () => {
  const slow = { rttMs: 300, latencyMs: 150, offsetMs: 90 };
  const fast = { rttMs: 40, latencyMs: 20, offsetMs: 52 };
  const first = updateClockEstimate([], slow);
  const second = updateClockEstimate(first.samples, fast, first);
  assert.equal(first.offsetMs, 90);
  assert.equal(second.offsetMs, 52);
  assert.ok(second.latencyMs < 150 && second.latencyMs > 20);
});

test("high-RTT outliers do not pull the clock away from low-RTT samples", () => {
  let estimate = updateClockEstimate([], { rttMs: 30, latencyMs: 15, offsetMs: 50 });
  estimate = updateClockEstimate(
    estimate.samples,
    { rttMs: 36, latencyMs: 18, offsetMs: 52 },
    estimate,
  );
  estimate = updateClockEstimate(
    estimate.samples,
    { rttMs: 500, latencyMs: 250, offsetMs: 240 },
    estimate,
  );
  assert.ok(estimate.offsetMs >= 49 && estimate.offsetMs <= 53);
});

test("target position uses the measured server clock and never rewinds for negative elapsed time", () => {
  const state = { position: 10, playing: true, updatedAt: 2000 };
  assert.equal(targetRoomPosition(state, 2100, 50), 10.15);
  assert.equal(targetRoomPosition(state, 1800, 0), 10);
  assert.equal(targetRoomPosition({ ...state, playing: false }, 9999, 500), 10);
});

test("playback correction holds small drift, rate-corrects medium drift, and seeks large drift", () => {
  assert.equal(playbackCorrection(10.04, 10, { latencyMs: 20 }).mode, "hold");
  const catchUp = playbackCorrection(10.2, 10, { latencyMs: 20 });
  assert.equal(catchUp.mode, "rate");
  assert.ok(catchUp.rate > 1 && catchUp.rate <= 1.04);
  const slowDown = playbackCorrection(9.8, 10, { latencyMs: 20 });
  assert.equal(slowDown.mode, "rate");
  assert.ok(slowDown.rate >= 0.96 && slowDown.rate < 1);
  assert.equal(playbackCorrection(11, 10, { latencyMs: 20 }).mode, "seek");
  assert.equal(playbackCorrection(10.2, 10, { latencyMs: 300 }).mode, "rate");
  assert.equal(playbackCorrection(10.5, 10, { latencyMs: 300 }).mode, "seek");
  assert.equal(playbackCorrection(10.2, 10, { latencyMs: 20, playing: false }).mode, "seek");
});

test("rate correction converges a 200 ms drift into the deadband within five seconds", () => {
  let drift = 0.2;
  for (let elapsed = 0; elapsed < 5; elapsed += 0.25) {
    const correction = playbackCorrection(drift, 0, { playing: true });
    drift -= (correction.rate - 1) * 0.25;
  }
  assert.ok(Math.abs(drift) <= 0.055, `remaining drift ${drift}`);
  assert.equal(playbackCorrection(drift, 0, { playing: true }).mode, "hold");
});
