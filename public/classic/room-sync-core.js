(function installMineradioRoomSyncCore(root) {
  "use strict";

  var DEFAULT_BUFFER_GOAL_SECONDS = 8;
  var MAX_BUFFER_GOAL_SECONDS = 16;

  function finiteNumber(value, fallback) {
    var number = Number(value);
    return Number.isFinite(number) ? number : (fallback == null ? 0 : fallback);
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(finiteNumber(value, minimum), maximum));
  }

  function adaptiveBufferGoal(options) {
    var input = options || {};
    var target = Math.max(0, finiteNumber(input.target, 0));
    var duration = finiteNumber(input.duration, Number.POSITIVE_INFINITY);
    var latencyMs = clamp(input.latencyMs, 0, 5000);
    var jitterMs = clamp(input.jitterMs, 0, 1000);
    var networkAllowance = Math.min(8, latencyMs / 250 + jitterMs / 125);
    var desired = clamp(
      DEFAULT_BUFFER_GOAL_SECONDS + networkAllowance,
      DEFAULT_BUFFER_GOAL_SECONDS,
      MAX_BUFFER_GOAL_SECONDS
    );
    desired = Math.round(desired * 4) / 4;
    if (Number.isFinite(duration)) {
      desired = Math.min(desired, Math.max(0, duration - target));
    }
    return desired;
  }

  function bufferedSecondsAt(media, target) {
    if (!media || !media.buffered) return 0;
    var ranges = media.buffered;
    var point = Math.max(0, finiteNumber(target, 0));
    for (var index = 0; index < ranges.length; index += 1) {
      var start;
      var end;
      try {
        start = finiteNumber(ranges.start(index), Number.NaN);
        end = finiteNumber(ranges.end(index), Number.NaN);
      } catch {
        continue;
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
      if (start <= point + 0.08 && end >= point - 0.02) {
        return Math.max(0, end - point);
      }
    }
    return 0;
  }

  function measureBufferedWindow(media, target, network) {
    var input = network || {};
    var duration = media ? finiteNumber(media.duration, Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
    var point = Math.max(0, finiteNumber(target, 0));
    var bufferGoalSeconds = adaptiveBufferGoal({
      target: point,
      duration: duration,
      latencyMs: input.latencyMs,
      jitterMs: input.jitterMs
    });
    var bufferedSeconds = bufferedSecondsAt(media, point);
    var bufferProgress = bufferGoalSeconds <= 0.08
      ? 1
      : clamp(bufferedSeconds / bufferGoalSeconds, 0, 1);
    return {
      bufferedSeconds: bufferedSeconds,
      bufferGoalSeconds: bufferGoalSeconds,
      bufferProgress: bufferProgress,
      ready: bufferGoalSeconds <= 0.08 || bufferedSeconds + 0.05 >= bufferGoalSeconds
    };
  }

  root.MineradioRoomSyncCore = Object.freeze({
    DEFAULT_BUFFER_GOAL_SECONDS: DEFAULT_BUFFER_GOAL_SECONDS,
    MAX_BUFFER_GOAL_SECONDS: MAX_BUFFER_GOAL_SECONDS,
    adaptiveBufferGoal: adaptiveBufferGoal,
    bufferedSecondsAt: bufferedSecondsAt,
    measureBufferedWindow: measureBufferedWindow
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
