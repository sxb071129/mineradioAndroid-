import assert from "node:assert/strict";
import test from "node:test";

await import("../public/classic/room-sync-core.js");

const core = globalThis.MineradioRoomSyncCore;

function mediaWithRanges(ranges, duration = 180) {
  return {
    duration,
    buffered: {
      length: ranges.length,
      start(index) {
        return ranges[index][0];
      },
      end(index) {
        return ranges[index][1];
      },
    },
  };
}

test("shared room sync core measures the range containing the target", () => {
  const media = mediaWithRanges([[0, 4], [10, 24]]);
  const measured = core.measureBufferedWindow(media, 12, { latencyMs: 0, jitterMs: 0 });
  assert.equal(measured.bufferedSeconds, 12);
  assert.equal(measured.bufferGoalSeconds, 4);
  assert.equal(measured.bufferProgress, 1);
  assert.equal(measured.ready, true);

  const gap = core.measureBufferedWindow(media, 7, { latencyMs: 0, jitterMs: 0 });
  assert.equal(gap.bufferedSeconds, 0);
  assert.equal(gap.ready, false);
});

test("shared room sync core adapts its goal to network timing and the remaining duration", () => {
  const slowNetwork = core.measureBufferedWindow(
    mediaWithRanges([[20, 29]], 200),
    20,
    { latencyMs: 500, jitterMs: 125 },
  );
  assert.equal(slowNetwork.bufferGoalSeconds, 5.25);
  assert.equal(slowNetwork.bufferProgress, 1);
  assert.equal(slowNetwork.ready, true);

  const shortEnding = core.measureBufferedWindow(
    mediaWithRanges([[0, 30]], 30),
    27.5,
    { latencyMs: 500, jitterMs: 125 },
  );
  assert.equal(shortEnding.bufferGoalSeconds, 2.5);
  assert.equal(shortEnding.ready, true);
});

test("shared room sync core tolerates malformed ranges without declaring readiness", () => {
  const media = {
    duration: Number.NaN,
    buffered: {
      length: 2,
      start(index) {
        if (index === 0) throw new Error("detached range");
        return 9;
      },
      end() {
        return 4;
      },
    },
  };
  const measured = core.measureBufferedWindow(media, 5);
  assert.equal(measured.bufferedSeconds, 0);
  assert.equal(measured.bufferGoalSeconds, 4);
  assert.equal(measured.ready, false);
});

test("shared room sync core keeps the final committed launch check short but data-backed", () => {
  const media = mediaWithRanges([[0, 1.4]], 200);
  const prepared = core.measureBufferedWindow(media, 0, { latencyMs: 120, jitterMs: 30 });
  const launch = core.measureLaunchWindow(media, 0, { latencyMs: 120, jitterMs: 30 });

  assert.equal(prepared.ready, false);
  assert.equal(launch.bufferGoalSeconds, 0.75);
  assert.equal(launch.ready, true);
  assert.equal(core.DEFAULT_BUFFER_GOAL_SECONDS, 4);
  assert.equal(core.MAX_BUFFER_GOAL_SECONDS, 8);
});
