import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { createLanRelay } from "../scripts/lan-relay.mjs";

function connect(url) {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const value = JSON.parse(raw.toString());
    const index = waiters.findIndex((waiter) => waiter.predicate(value));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    } else {
      queue.push(value);
    }
  });
  const opened = new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return {
    ws,
    opened,
    next(predicate, timeoutMs = 2500) {
      const index = queue.findIndex(predicate);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: undefined };
        waiter.timer = setTimeout(() => {
          const waiterIndex = waiters.indexOf(waiter);
          if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
          reject(new Error("Timed out waiting for relay message"));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

test("relay uploads ranged audio and synchronizes a room", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mineradio-relay-"));
  const relay = await createLanRelay({
    port: 0,
    host: "127.0.0.1",
    dataDir,
    roomBroadcastIntervalMs: 100,
    playbackPrepareCompletionRetentionMs: 80,
  });
  t.after(async () => {
    await relay.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${relay.port}`;
  const health = await fetch(`${base}/health`).then((response) => response.json());
  assert.equal(health.ok, true);

  const roomLink = "http://192.168.1.23:3000/classic/index.html?room=ROOM42";
  const roomQr = await fetch(
    `${base}/api/room/qr?text=${encodeURIComponent(roomLink)}`,
  );
  assert.equal(roomQr.status, 200);
  assert.equal(roomQr.headers.get("content-type"), "image/png");
  assert.equal(roomQr.headers.get("cache-control"), "no-store");
  assert.equal(roomQr.headers.get("x-content-type-options"), "nosniff");
  const roomQrBytes = Buffer.from(await roomQr.arrayBuffer());
  assert.deepEqual(
    roomQrBytes.subarray(0, 8),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  assert.ok(roomQrBytes.length > 500);
  const secureRoomQr = await fetch(
    `${base}/api/room/qr?text=${encodeURIComponent("https://example.test/room?room=ROOM42")}`,
  );
  assert.equal(secureRoomQr.status, 200);
  assert.equal(secureRoomQr.headers.get("cache-control"), "no-store");
  await secureRoomQr.arrayBuffer();

  const invalidRoomQrUrls = [
    `${base}/api/room/qr`,
    `${base}/api/room/qr?text=${encodeURIComponent("/classic/index.html?room=ROOM42")}`,
    `${base}/api/room/qr?text=${encodeURIComponent("ftp://example.test/room")}`,
    `${base}/api/room/qr?text=${encodeURIComponent("javascript:alert(1)")}`,
    `${base}/api/room/qr?text=${encodeURIComponent(" https://example.test/room")}`,
    `${base}/api/room/qr?text=${encodeURIComponent("https://user:secret@example.test/room")}`,
    `${base}/api/room/qr?text=${encodeURIComponent("https://example.test/room\n")}`,
    `${base}/api/room/qr?text=${encodeURIComponent(`https://example.test/${"a".repeat(2050)}`)}`,
    `${base}/api/room/qr?text=${encodeURIComponent(roomLink)}&text=${encodeURIComponent(roomLink)}`,
  ];
  for (const invalidUrl of invalidRoomQrUrls) {
    const response = await fetch(invalidUrl);
    assert.equal(response.status, 400, invalidUrl);
    assert.deepEqual(await response.json(), { error: "invalid_qr_text" });
  }

  const audioBytes = Buffer.from("RIFF-mineradio-test-audio");
  const upload = await fetch(
    `${base}/api/tracks?name=Relay%20Test&type=audio%2Fwav`,
    { method: "POST", body: audioBytes },
  );
  assert.equal(upload.status, 201);
  const track = await upload.json();
  assert.match(track.id, /^[a-f0-9]{24}$/);

  const ranged = await fetch(`${base}${track.path}`, {
    headers: { range: "bytes=0-3" },
  });
  assert.equal(ranged.status, 206);
  assert.equal(await ranged.text(), "RIFF");

  const suffix = await fetch(`${base}${track.path}`, {
    headers: { range: "bytes=-5" },
  });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers.get("content-range"), `bytes ${audioBytes.length - 5}-${audioBytes.length - 1}/${audioBytes.length}`);
  assert.equal(await suffix.text(), "audio");

  const oversizedSuffix = await fetch(`${base}${track.path}`, {
    headers: { range: "bytes=-9999" },
  });
  assert.equal(oversizedSuffix.status, 206);
  assert.equal(oversizedSuffix.headers.get("content-range"), `bytes 0-${audioBytes.length - 1}/${audioBytes.length}`);
  assert.deepEqual(Buffer.from(await oversizedSuffix.arrayBuffer()), audioBytes);

  const clampedEnd = await fetch(`${base}${track.path}`, {
    headers: { range: "bytes=5-9999" },
  });
  assert.equal(clampedEnd.status, 206);
  assert.equal(clampedEnd.headers.get("content-range"), `bytes 5-${audioBytes.length - 1}/${audioBytes.length}`);
  assert.deepEqual(Buffer.from(await clampedEnd.arrayBuffer()), audioBytes.subarray(5));

  for (const invalidRange of ["bytes=-", "bytes=-0", `bytes=${audioBytes.length}-`]) {
    const rejected = await fetch(`${base}${track.path}`, {
      headers: { range: invalidRange },
    });
    assert.equal(rejected.status, 416, invalidRange);
    assert.equal(rejected.headers.get("content-range"), `bytes */${audioBytes.length}`);
  }

  const leader = connect(`ws://127.0.0.1:${relay.port}/ws`);
  const follower = connect(`ws://127.0.0.1:${relay.port}/ws`);
  await Promise.all([leader.opened, follower.opened]);
  const [leaderWelcome, followerWelcome] = await Promise.all([
    leader.next((message) => message.type === "welcome"),
    follower.next((message) => message.type === "welcome"),
  ]);
  assert.notEqual(leaderWelcome.clientId, followerWelcome.clientId);

  const clockSentAt = Date.now();
  leader.ws.send(JSON.stringify({ type: "ping", clientTime: clockSentAt }));
  const clockPong = await leader.next((message) => message.type === "pong");
  const clockReceivedAt = Date.now();
  assert.equal(clockPong.clientTime, clockSentAt);
  assert.ok(clockPong.serverReceivedAt >= clockSentAt);
  assert.ok(clockPong.serverTime >= clockPong.serverReceivedAt);
  assert.ok(clockPong.serverTime <= clockReceivedAt);

  leader.ws.send(JSON.stringify({ type: "join", room: "ROOM42", name: "Leader" }));
  const leaderJoined = await leader.next((message) => message.type === "joined");
  assert.equal(leaderJoined.leader, true);

  follower.ws.send(JSON.stringify({ type: "join", room: "ROOM42", name: "Follower" }));
  const followerJoined = await follower.next((message) => message.type === "joined");
  assert.equal(followerJoined.leader, false);
  assert.deepEqual(
    followerJoined.state.devices.map((device) => ({
      name: device.name,
      leader: device.leader,
    })),
    [
      { name: "Leader", leader: true },
      { name: "Follower", leader: false },
    ],
  );
  const joinedHealth = await fetch(`${base}/health`).then((response) => response.json());
  assert.equal(joinedHealth.devices, 2);

  // These frames intentionally arrive without waits. The relay must finish the
  // asynchronous local-track validation before applying seek/play.
  leader.ws.send(JSON.stringify({ type: "command", action: "track", track }));
  leader.ws.send(JSON.stringify({ type: "command", action: "seek", position: 12.5 }));
  leader.ws.send(JSON.stringify({ type: "command", action: "play" }));
  const preparingState = await follower.next(
    (message) => message.type === "state"
      && message.state?.track?.id === track.id
      && message.state?.preparing === true
      && message.state?.position === 12.5,
  );
  assert.equal(preparingState.state.track.name, "Relay Test");
  assert.equal(preparingState.state.readyCount, 0);
  assert.equal(preparingState.state.requiredCount, 2);

  leader.ws.send(JSON.stringify({
    type: "command",
    action: "ready",
    prepareId: preparingState.state.prepareId,
    ready: true,
    latencyMs: 20,
    jitterMs: 3,
  }));
  const oneReady = await follower.next(
    (message) => message.type === "state"
      && message.state?.prepareId === preparingState.state.prepareId
      && message.state?.readyCount === 1,
  );
  assert.equal(oneReady.state.playing, false);
  follower.ws.send(JSON.stringify({
    type: "command",
    action: "ready",
    prepareId: preparingState.state.prepareId,
    ready: true,
    latencyMs: 35,
    jitterMs: 5,
  }));
  const scheduledState = await follower.next(
    (message) => message.type === "state"
      && message.state?.prepareId === preparingState.state.prepareId
      && message.state?.playing === true
      && message.state?.scheduledAt > message.state?.serverTime,
  );
  assert.equal(scheduledState.state.preparing, false);
  assert.equal(scheduledState.state.updatedAt, scheduledState.state.scheduledAt);
  const scheduledHardDeadline = relay.rooms.get("ROOM42").prepareMaxDeadline;

  follower.ws.send(JSON.stringify({
    type: "command",
    action: "ready",
    prepareId: preparingState.state.prepareId,
    ready: false,
  }));
  const rescheduledPreparation = await follower.next(
    (message) => message.type === "state"
      && message.state?.preparing === true
      && message.state?.prepareId === preparingState.state.prepareId
      && message.state?.readyCount === 1,
  );
  assert.equal(rescheduledPreparation.state.playing, false);
  assert.equal(relay.rooms.get("ROOM42").prepareMaxDeadline, scheduledHardDeadline);
  follower.ws.send(JSON.stringify({
    type: "command",
    action: "ready",
    prepareId: preparingState.state.prepareId,
    ready: true,
    latencyMs: 35,
    jitterMs: 5,
  }));
  await follower.next(
    (message) => message.type === "state"
      && message.state?.playing === true
      && message.state?.scheduledAt > message.state?.serverTime
      && message.state?.revision > scheduledState.state.revision,
  );

  follower.ws.send(JSON.stringify({
    type: "command",
    action: "start-failed",
    prepareId: preparingState.state.prepareId,
  }));
  const failedStart = await follower.next(
    (message) => message.type === "state"
      && message.state?.prepareError === "start_failed"
      && message.state?.playing === false,
  );
  assert.equal(failedStart.state.scheduledAt, 0);

  leader.ws.send(JSON.stringify({ type: "command", action: "play" }));
  const retryPreparation = await follower.next(
    (message) => message.type === "state"
      && message.state?.preparing === true
      && message.state?.prepareId !== preparingState.state.prepareId,
  );
  for (const client of [leader, follower]) {
    client.ws.send(JSON.stringify({
      type: "command",
      action: "ready",
      prepareId: retryPreparation.state.prepareId,
      ready: true,
      latencyMs: 25,
      jitterMs: 4,
    }));
  }
  const finalSchedule = await follower.next(
    (message) => message.type === "state"
      && message.state?.playing === true
      && message.state?.prepareId === retryPreparation.state.prepareId
      && message.state?.scheduledAt > message.state?.serverTime,
  );

  await new Promise((resolve) => setTimeout(
    resolve,
    Math.max(0, finalSchedule.state.scheduledAt - Date.now() + 25),
  ));

  const sampledServerTime = Date.now() - 120;
  leader.ws.send(JSON.stringify({
    type: "command",
    action: "progress",
    position: 20,
    sampledServerTime,
  }));
  const progressBarrier = Date.now();
  leader.ws.send(JSON.stringify({ type: "ping", clientTime: progressBarrier }));
  await leader.next(
    (message) => message.type === "pong" && message.clientTime === progressBarrier,
  );
  assert.ok(relay.rooms.get("ROOM42").state.position >= 20.1);
  const projectedProgress = await follower.next(
    (message) => message.type === "state"
      && message.state?.revision > finalSchedule.state.revision
      && message.state?.position >= 20.1,
  );
  assert.ok(projectedProgress.state.position < 21);

  const clearedPreparation = await follower.next(
    (message) => message.type === "state"
      && message.state?.playing === true
      && message.state?.prepareId === ""
      && message.state?.scheduledAt === finalSchedule.state.scheduledAt,
  );
  assert.equal(relay.rooms.get("ROOM42").prepareParticipants.size, 0);
  assert.equal(clearedPreparation.state.devices.every((device) => device.bufferState === ""), true);

  leader.ws.send(JSON.stringify({ type: "command", action: "volume", volume: 0.42 }));
  const volumeState = await follower.next(
    (message) => message.type === "state" && message.state?.volume === 0.42,
  );
  assert.equal(volumeState.state.deviceCount, 2);
  const heartbeatState = await follower.next(
    (message) => message.type === "state"
      && message.state?.revision === volumeState.state.revision
      && message.state?.serverTime > volumeState.state.serverTime,
  );
  assert.equal(heartbeatState.state.position >= volumeState.state.position, true);

  follower.ws.send(JSON.stringify({ type: "command", action: "pause" }));
  const denied = await follower.next(
    (message) => message.type === "error" && message.code === "leader_only",
  );
  assert.equal(denied.code, "leader_only");

  leader.ws.close();
  const promoted = await follower.next(
    (message) => message.type === "state" && message.state?.leaderId === followerWelcome.clientId,
  );
  assert.equal(promoted.state.playing, true);
  assert.equal(promoted.state.preparing, false);
  assert.equal(promoted.state.scheduledAt, 0);
  assert.ok(promoted.state.position >= volumeState.state.position);

  follower.ws.send(JSON.stringify({ type: "command", action: "volume", volume: 0.58 }));
  const controlledByNewLeader = await follower.next(
    (message) => message.type === "state"
      && message.state?.leaderId === followerWelcome.clientId
      && message.state?.volume === 0.58,
  );
  assert.equal(controlledByNewLeader.state.playing, true);
  follower.ws.close();
});

test("leader controls bounded per-device calibration and disconnected devices are cleared", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mineradio-device-calibration-"));
  const relay = await createLanRelay({
    port: 0,
    host: "127.0.0.1",
    dataDir,
  });
  const leader = connect(`ws://127.0.0.1:${relay.port}/ws`);
  const follower = connect(`ws://127.0.0.1:${relay.port}/ws`);
  const outsider = connect(`ws://127.0.0.1:${relay.port}/ws`);
  t.after(async () => {
    leader.ws.close();
    follower.ws.close();
    outsider.ws.close();
    await relay.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await Promise.all([leader.opened, follower.opened, outsider.opened]);
  const [leaderWelcome, followerWelcome, outsiderWelcome] = await Promise.all([
    leader.next((message) => message.type === "welcome"),
    follower.next((message) => message.type === "welcome"),
    outsider.next((message) => message.type === "welcome"),
  ]);

  leader.ws.send(JSON.stringify({ type: "join", room: "CAL42", name: "Controller" }));
  await leader.next((message) => message.type === "joined" && message.room === "CAL42");
  follower.ws.send(JSON.stringify({ type: "join", room: "CAL42", name: "Speaker" }));
  const followerJoined = await follower.next(
    (message) => message.type === "joined" && message.room === "CAL42",
  );
  outsider.ws.send(JSON.stringify({ type: "join", room: "AWAY42", name: "Other room" }));
  await outsider.next((message) => message.type === "joined" && message.room === "AWAY42");

  const defaultSpeaker = followerJoined.state.devices.find(
    (device) => device.clientId === followerWelcome.clientId,
  );
  assert.equal(defaultSpeaker.volumeTrimDb, 0);
  assert.equal(defaultSpeaker.delayMs, 0);
  const room = relay.rooms.get("CAL42");
  const revisionBeforeCalibration = room.state.revision;

  follower.ws.send(JSON.stringify({
    type: "command",
    action: "device-status",
    volumeTrimDb: -3,
    delayMs: 40,
  }));
  const initializationBarrier = Date.now();
  follower.ws.send(JSON.stringify({ type: "ping", clientTime: initializationBarrier }));
  await follower.next(
    (message) => message.type === "pong" && message.clientTime === initializationBarrier,
  );
  assert.equal(room.deviceStatus.get(followerWelcome.clientId).volumeTrimDb, -3);
  assert.equal(room.deviceStatus.get(followerWelcome.clientId).delayMs, 40);
  assert.equal(room.deviceStatus.get(followerWelcome.clientId).explicitCalibration, false);

  follower.ws.send(JSON.stringify({
    type: "command",
    action: "device-calibration",
    targetClientId: followerWelcome.clientId,
    volumeTrimDb: -6,
    delayMs: 80,
  }));
  const denied = await follower.next(
    (message) => message.type === "error" && message.code === "leader_only",
  );
  assert.equal(denied.code, "leader_only");
  assert.equal(room.deviceStatus.get(followerWelcome.clientId).volumeTrimDb, -3);

  leader.ws.send(JSON.stringify({
    type: "command",
    action: "device-calibration",
    targetClientId: outsiderWelcome.clientId,
    volumeTrimDb: -6,
    delayMs: 80,
  }));
  const missingTarget = await leader.next(
    (message) => message.type === "error" && message.code === "device_not_found",
  );
  assert.equal(missingTarget.code, "device_not_found");

  const invalidCalibrations = [
    { volumeTrimDb: -24.01, delayMs: 0 },
    { volumeTrimDb: 12.01, delayMs: 0 },
    { volumeTrimDb: 0, delayMs: -0.01 },
    { volumeTrimDb: 0, delayMs: 500.01 },
    { volumeTrimDb: "0", delayMs: 0 },
    { volumeTrimDb: 0, delayMs: "0" },
    { volumeTrimDb: 0 },
    { delayMs: 0 },
  ];
  for (const calibration of invalidCalibrations) {
    leader.ws.send(JSON.stringify({
      type: "command",
      action: "device-calibration",
      targetClientId: followerWelcome.clientId,
      ...calibration,
    }));
    const invalid = await leader.next(
      (message) => message.type === "error" && message.code === "invalid_calibration",
    );
    assert.equal(invalid.code, "invalid_calibration");
  }

  leader.ws.send(JSON.stringify({
    type: "command",
    action: "device-calibration",
    targetClientId: followerWelcome.clientId,
    volumeTrimDb: -24,
    delayMs: 500,
  }));
  const calibrated = await follower.next(
    (message) => message.type === "state"
      && message.state?.devices?.some(
        (device) => device.clientId === followerWelcome.clientId
          && device.volumeTrimDb === -24
          && device.delayMs === 500,
      ),
  );
  assert.equal(room.state.revision, revisionBeforeCalibration);
  const calibratedSpeaker = calibrated.state.devices.find(
    (device) => device.clientId === followerWelcome.clientId,
  );
  assert.equal(calibratedSpeaker.volumeTrimDb, -24);
  assert.equal(calibratedSpeaker.delayMs, 500);
  assert.equal(room.deviceStatus.get(followerWelcome.clientId).calibrationRevision, 1);
  assert.equal(room.deviceStatus.get(followerWelcome.clientId).explicitCalibration, true);

  follower.ws.send(JSON.stringify({
    type: "command",
    action: "device-status",
    volumeTrimDb: -3,
    delayMs: 40,
  }));
  const staleStatusBarrier = Date.now();
  follower.ws.send(JSON.stringify({ type: "ping", clientTime: staleStatusBarrier }));
  await follower.next(
    (message) => message.type === "pong" && message.clientTime === staleStatusBarrier,
  );
  assert.equal(room.deviceStatus.get(followerWelcome.clientId).volumeTrimDb, -24);
  assert.equal(room.deviceStatus.get(followerWelcome.clientId).delayMs, 500);
  assert.equal(room.deviceStatus.get(followerWelcome.clientId).calibrationRevision, 1);

  leader.ws.send(JSON.stringify({
    type: "command",
    action: "device-calibration",
    targetClientId: followerWelcome.clientId,
    volumeTrimDb: -6.26,
    delayMs: 83,
  }));
  const normalizedCalibration = await follower.next(
    (message) => message.type === "state"
      && message.state?.devices?.some(
        (device) => device.clientId === followerWelcome.clientId
          && device.volumeTrimDb === -6.5
          && device.delayMs === 85,
      ),
  );
  const normalizedSpeaker = normalizedCalibration.state.devices.find(
    (device) => device.clientId === followerWelcome.clientId,
  );
  assert.equal(normalizedSpeaker.volumeTrimDb, -6.5);
  assert.equal(normalizedSpeaker.delayMs, 85);
  assert.equal(room.deviceStatus.get(followerWelcome.clientId).calibrationRevision, 2);

  leader.ws.send(JSON.stringify({
    type: "command",
    action: "device-calibration",
    targetClientId: followerWelcome.clientId,
    volumeTrimDb: 12,
    delayMs: 0,
  }));
  await leader.next(
    (message) => message.type === "state"
      && message.state?.devices?.some(
        (device) => device.clientId === followerWelcome.clientId
          && device.volumeTrimDb === 12
          && device.delayMs === 0,
      ),
  );
  assert.equal(room.deviceStatus.get(followerWelcome.clientId).calibrationRevision, 3);

  follower.ws.send(JSON.stringify({ type: "join", room: "CAL42", name: "Renamed speaker" }));
  const rejoined = await follower.next(
    (message) => message.type === "joined"
      && message.room === "CAL42"
      && message.state?.devices?.some(
        (device) => device.clientId === followerWelcome.clientId
          && device.name === "Renamed speaker"
          && device.volumeTrimDb === 12
          && device.delayMs === 0,
      ),
  );
  assert.equal(rejoined.clientId, followerWelcome.clientId);

  follower.ws.close();
  const removed = await leader.next(
    (message) => message.type === "state"
      && message.state?.serverTime > rejoined.state.serverTime
      && message.state?.deviceCount === 1
      && !message.state?.devices?.some(
        (device) => device.clientId === followerWelcome.clientId,
      ),
  );
  assert.equal(removed.state.leaderId, leaderWelcome.clientId);
  assert.equal(room.deviceStatus.has(followerWelcome.clientId), false);

  leader.ws.send(JSON.stringify({
    type: "command",
    action: "device-calibration",
    targetClientId: followerWelcome.clientId,
    volumeTrimDb: 0,
    delayMs: 0,
  }));
  const removedTarget = await leader.next(
    (message) => message.type === "error" && message.code === "device_not_found",
  );
  assert.equal(removedTarget.code, "device_not_found");
});

test("room preparation timeout stays paused instead of skipping an unready device", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mineradio-barrier-timeout-"));
  const relay = await createLanRelay({
    port: 0,
    host: "127.0.0.1",
    dataDir,
    playbackPrepareTimeoutMs: 100,
  });
  const client = connect(`ws://127.0.0.1:${relay.port}/ws`);
  t.after(async () => {
    client.ws.close();
    await relay.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await client.opened;
  await client.next((message) => message.type === "welcome");
  client.ws.send(JSON.stringify({ type: "join", room: "WAIT42", name: "Slow device" }));
  await client.next((message) => message.type === "joined");
  client.ws.send(JSON.stringify({
    type: "command",
    action: "track",
    track: {
      id: "cloud-123456",
      name: "Barrier Test",
      type: "audio/mpeg",
      size: 0,
      path: "/api/cloud/123456",
    },
  }));
  client.ws.send(JSON.stringify({ type: "command", action: "play" }));
  const preparing = await client.next(
    (message) => message.type === "state" && message.state?.preparing === true,
  );
  assert.equal(preparing.state.requiredCount, 1);
  const timedOut = await client.next(
    (message) => message.type === "state" && message.state?.prepareError === "timeout",
  );
  assert.equal(timedOut.state.playing, false);
  assert.equal(timedOut.state.scheduledAt, 0);
  assert.deepEqual(timedOut.state.prepareErrorClientIds, [
    timedOut.state.devices[0].clientId,
  ]);
  assert.equal(timedOut.state.devices[0].name, "Slow device");
  assert.equal(timedOut.state.devices[0].blocked, true);
});

test("device buffer telemetry is visible, validated, and extends only within the hard deadline", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mineradio-device-status-"));
  const relay = await createLanRelay({
    port: 0,
    host: "127.0.0.1",
    dataDir,
    playbackPrepareTimeoutMs: 400,
    playbackPrepareMaxTimeoutMs: 1200,
    playbackPrepareProgressGraceMs: 500,
  });
  const leader = connect(`ws://127.0.0.1:${relay.port}/ws`);
  const follower = connect(`ws://127.0.0.1:${relay.port}/ws`);
  t.after(async () => {
    leader.ws.close();
    follower.ws.close();
    await relay.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await Promise.all([leader.opened, follower.opened]);
  const [leaderWelcome, followerWelcome] = await Promise.all([
    leader.next((message) => message.type === "welcome"),
    follower.next((message) => message.type === "welcome"),
  ]);
  leader.ws.send(JSON.stringify({ type: "join", room: "METER42", name: "Desktop" }));
  await leader.next((message) => message.type === "joined");
  follower.ws.send(JSON.stringify({ type: "join", room: "METER42", name: "Phone" }));
  await follower.next((message) => message.type === "joined");
  leader.ws.send(JSON.stringify({
    type: "command",
    action: "track",
    track: {
      id: "cloud-123456",
      name: "Telemetry Test",
      type: "audio/mpeg",
      size: 0,
      path: "/api/cloud/123456",
    },
  }));
  leader.ws.send(JSON.stringify({ type: "command", action: "play" }));
  const preparing = await follower.next(
    (message) => message.type === "state" && message.state?.preparing === true,
  );
  const room = relay.rooms.get("METER42");
  const initialDeadline = room.prepareDeadline;
  const hardDeadline = room.prepareMaxDeadline;

  follower.ws.send(JSON.stringify({
    type: "command",
    action: "device-status",
    prepareId: preparing.state.prepareId,
    bufferedSeconds: 0.5,
    bufferGoalSeconds: 8,
    bufferProgress: 0.99,
    latencyMs: 99999,
    jitterMs: 99999,
    driftMs: -99999,
    quality: "hires",
    bufferState: "buffering",
  }));
  const firstBarrier = Date.now();
  follower.ws.send(JSON.stringify({ type: "ping", clientTime: firstBarrier }));
  await follower.next((message) => message.type === "pong" && message.clientTime === firstBarrier);
  assert.ok(room.prepareDeadline > initialDeadline);
  assert.ok(room.prepareDeadline <= hardDeadline);
  const extendedDeadline = room.prepareDeadline;

  follower.ws.send(JSON.stringify({
    type: "command",
    action: "device-status",
    prepareId: preparing.state.prepareId,
    bufferedSeconds: 0.5,
    bufferGoalSeconds: 8,
  }));
  const repeatedBarrier = Date.now();
  follower.ws.send(JSON.stringify({ type: "ping", clientTime: repeatedBarrier }));
  await follower.next((message) => message.type === "pong" && message.clientTime === repeatedBarrier);
  assert.equal(room.prepareDeadline, extendedDeadline);

  leader.ws.send(JSON.stringify({ type: "command", action: "volume", volume: 0.61 }));
  const visibleStatus = await leader.next(
    (message) => message.type === "state" && message.state?.volume === 0.61,
  );
  const phone = visibleStatus.state.devices.find((device) => device.clientId === followerWelcome.clientId);
  assert.equal(phone.name, "Phone");
  assert.equal(phone.bufferedSeconds, 0.5);
  assert.equal(phone.bufferGoalSeconds, 8);
  assert.equal(phone.bufferProgress, 0.0625);
  assert.equal(phone.latencyMs, 5000);
  assert.equal(phone.jitterMs, 1000);
  assert.equal(phone.driftMs, -10000);
  assert.equal(phone.quality, "hires");
  assert.equal(visibleStatus.state.prepareDeadline, extendedDeadline);
  assert.equal(visibleStatus.state.devices.find((device) => device.clientId === leaderWelcome.clientId).leader, true);

  follower.ws.send(JSON.stringify({
    type: "command",
    action: "ready",
    prepareId: preparing.state.prepareId,
    ready: true,
    bufferedSeconds: 1,
    bufferGoalSeconds: 8,
  }));
  const insufficientBarrier = Date.now();
  follower.ws.send(JSON.stringify({ type: "ping", clientTime: insufficientBarrier }));
  await follower.next((message) => message.type === "pong" && message.clientTime === insufficientBarrier);
  assert.equal(room.readyClients.has(followerWelcome.clientId), false);

  follower.ws.send(JSON.stringify({
    type: "command",
    action: "ready",
    prepareId: preparing.state.prepareId,
    ready: true,
  }));
  const compatibilityBarrier = Date.now();
  follower.ws.send(JSON.stringify({ type: "ping", clientTime: compatibilityBarrier }));
  await follower.next((message) => message.type === "pong" && message.clientTime === compatibilityBarrier);
  assert.equal(room.readyClients.has(followerWelcome.clientId), false);

  follower.ws.send(JSON.stringify({
    type: "command",
    action: "device-status",
    prepareId: preparing.state.prepareId,
    bufferedSeconds: 1,
    bufferGoalSeconds: 0,
  }));
  follower.ws.send(JSON.stringify({
    type: "command",
    action: "ready",
    prepareId: preparing.state.prepareId,
    ready: true,
  }));
  const downgradeBarrier = Date.now();
  follower.ws.send(JSON.stringify({ type: "ping", clientTime: downgradeBarrier }));
  await follower.next((message) => message.type === "pong" && message.clientTime === downgradeBarrier);
  assert.equal(room.readyClients.has(followerWelcome.clientId), false);
  assert.equal(
    room.deviceStatus.get(followerWelcome.clientId).bufferContractPrepareId,
    preparing.state.prepareId,
  );

  follower.ws.send(JSON.stringify({
    type: "command",
    action: "ready",
    prepareId: preparing.state.prepareId,
    ready: true,
    bufferedSeconds: 8,
    bufferGoalSeconds: 8,
    latencyMs: 40,
    jitterMs: 5,
  }));
  const readyState = await leader.next(
    (message) => message.type === "state"
      && message.state?.prepareId === preparing.state.prepareId
      && message.state?.readyCount === 1,
  );
  assert.equal(readyState.state.devices.find((device) => device.clientId === followerWelcome.clientId).ready, true);
  assert.ok(room.prepareDeadline <= room.prepareMaxDeadline);

  leader.ws.send(JSON.stringify({
    type: "command",
    action: "track",
    track: {
      id: "cloud-654321",
      name: "Next Track",
      type: "audio/mpeg",
      size: 0,
      path: "/api/cloud/654321",
    },
  }));
  const nextTrack = await leader.next(
    (message) => message.type === "state" && message.state?.track?.id === "cloud-654321",
  );
  const resetPhone = nextTrack.state.devices.find((device) => device.clientId === followerWelcome.clientId);
  assert.equal(resetPhone.bufferedSeconds, 0);
  assert.equal(resetPhone.bufferGoalSeconds, 0);
  assert.equal(resetPhone.bufferState, "");
  assert.equal(resetPhone.quality, "");

  follower.ws.close();
  const disconnected = await leader.next(
    (message) => message.type === "state"
      && message.state?.deviceCount === 1
      && message.state?.track?.id === "cloud-654321",
  );
  assert.equal(disconnected.state.devices.some((device) => device.clientId === followerWelcome.clientId), false);
  assert.equal(room.deviceStatus.has(followerWelcome.clientId), false);
});

test("real buffer progress can cross the soft deadline but never the hard deadline", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mineradio-hard-deadline-"));
  const relay = await createLanRelay({
    port: 0,
    host: "127.0.0.1",
    dataDir,
    playbackPrepareTimeoutMs: 200,
    playbackPrepareMaxTimeoutMs: 700,
    playbackPrepareProgressGraceMs: 250,
    roomBroadcastIntervalMs: 25,
  });
  const client = connect(`ws://127.0.0.1:${relay.port}/ws`);
  t.after(async () => {
    client.ws.close();
    await relay.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await client.opened;
  await client.next((message) => message.type === "welcome");
  client.ws.send(JSON.stringify({ type: "join", room: "CAPS42", name: "Progressing device" }));
  await client.next((message) => message.type === "joined");
  client.ws.send(JSON.stringify({
    type: "command",
    action: "track",
    track: {
      id: "cloud-123456",
      name: "Hard Deadline",
      type: "audio/mpeg",
      size: 0,
      path: "/api/cloud/123456",
    },
  }));
  client.ws.send(JSON.stringify({ type: "command", action: "play" }));
  const preparing = await client.next(
    (message) => message.type === "state" && message.state?.preparing === true,
  );
  const room = relay.rooms.get("CAPS42");
  const initialSoftDeadline = room.prepareDeadline;
  const hardDeadline = room.prepareMaxDeadline;

  for (let index = 1; index <= 5; index += 1) {
    client.ws.send(JSON.stringify({
      type: "command",
      action: "device-status",
      prepareId: preparing.state.prepareId,
      bufferedSeconds: index * 0.3,
      bufferGoalSeconds: 8,
      bufferState: "buffering",
    }));
    const barrier = Date.now();
    client.ws.send(JSON.stringify({ type: "ping", clientTime: barrier }));
    await client.next((message) => message.type === "pong" && message.clientTime === barrier);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  assert.ok(Date.now() > initialSoftDeadline);
  assert.equal(room.state.preparing, true);
  assert.equal(room.prepareMaxDeadline, hardDeadline);
  assert.ok(room.prepareDeadline <= hardDeadline);
  const timedOut = await client.next(
    (message) => message.type === "state" && message.state?.prepareError === "timeout",
  );
  assert.equal(timedOut.state.playing, false);
  assert.equal(timedOut.state.prepareErrorClientIds.length, 1);
});

test("leader handoff preserves an already-buffered future start", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mineradio-scheduled-handoff-"));
  const relay = await createLanRelay({
    port: 0,
    host: "127.0.0.1",
    dataDir,
    playbackStartLeadMs: 1200,
  });
  const leader = connect(`ws://127.0.0.1:${relay.port}/ws`);
  const follower = connect(`ws://127.0.0.1:${relay.port}/ws`);
  t.after(async () => {
    leader.ws.close();
    follower.ws.close();
    await relay.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await Promise.all([leader.opened, follower.opened]);
  const [, followerWelcome] = await Promise.all([
    leader.next((message) => message.type === "welcome"),
    follower.next((message) => message.type === "welcome"),
  ]);
  leader.ws.send(JSON.stringify({ type: "join", room: "FUTURE", name: "Leader" }));
  await leader.next((message) => message.type === "joined");
  follower.ws.send(JSON.stringify({ type: "join", room: "FUTURE", name: "Follower" }));
  await follower.next((message) => message.type === "joined");
  leader.ws.send(JSON.stringify({
    type: "command",
    action: "track",
    track: { id: "cloud-7654321", name: "Future handoff" },
  }));
  leader.ws.send(JSON.stringify({ type: "command", action: "play" }));
  const preparing = await follower.next(
    (message) => message.type === "state" && message.state?.preparing === true,
  );
  for (const client of [leader, follower]) {
    client.ws.send(JSON.stringify({
      type: "command",
      action: "ready",
      prepareId: preparing.state.prepareId,
      ready: true,
      latencyMs: 20,
      jitterMs: 2,
    }));
  }
  const scheduled = await follower.next(
    (message) => message.type === "state"
      && message.state?.playing === true
      && message.state?.scheduledAt > message.state?.serverTime,
  );
  leader.ws.close();
  const promoted = await follower.next(
    (message) => message.type === "state"
      && message.state?.leaderId === followerWelcome.clientId
      && message.state?.revision > scheduled.state.revision,
  );
  assert.equal(promoted.state.playing, true);
  assert.equal(promoted.state.preparing, false);
  assert.equal(promoted.state.prepareId, scheduled.state.prepareId);
  assert.equal(promoted.state.scheduledAt, scheduled.state.scheduledAt);
  assert.equal(promoted.state.position, scheduled.state.position);
});

test("seeking starts a new attempt while late joins reopen the same bounded barrier", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mineradio-barrier-restart-"));
  const relay = await createLanRelay({
    port: 0,
    host: "127.0.0.1",
    dataDir,
    playbackStartLeadMs: 2000,
  });
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.ws.close();
    await relay.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const leader = connect(`ws://127.0.0.1:${relay.port}/ws`);
  const follower = connect(`ws://127.0.0.1:${relay.port}/ws`);
  clients.push(leader, follower);
  await Promise.all([leader.opened, follower.opened]);
  await Promise.all([
    leader.next((message) => message.type === "welcome"),
    follower.next((message) => message.type === "welcome"),
  ]);

  leader.ws.send(JSON.stringify({ type: "join", room: "EDGE42", name: "Leader" }));
  await leader.next((message) => message.type === "joined");
  follower.ws.send(JSON.stringify({ type: "join", room: "EDGE42", name: "Follower" }));
  await follower.next((message) => message.type === "joined");

  leader.ws.send(JSON.stringify({
    type: "command",
    action: "track",
    track: {
      id: "cloud-123456",
      name: "Barrier Edge Test",
      type: "audio/mpeg",
      size: 0,
      path: "/api/cloud/123456",
    },
  }));
  leader.ws.send(JSON.stringify({ type: "command", action: "play" }));
  const initialPreparation = await follower.next(
    (message) => message.type === "state"
      && message.state?.preparing === true
      && message.state?.requiredCount === 2,
  );

  leader.ws.send(JSON.stringify({ type: "command", action: "seek", position: 14.25 }));
  const preparationAfterSeek = await follower.next(
    (message) => message.type === "state"
      && message.state?.preparing === true
      && message.state?.prepareId !== initialPreparation.state.prepareId
      && message.state?.position === 14.25,
  );
  assert.equal(preparationAfterSeek.state.playing, false);
  assert.equal(preparationAfterSeek.state.scheduledAt, 0);
  assert.equal(preparationAfterSeek.state.readyCount, 0);
  assert.equal(preparationAfterSeek.state.requiredCount, 2);

  for (const client of [leader, follower]) {
    client.ws.send(JSON.stringify({
      type: "command",
      action: "ready",
      prepareId: preparationAfterSeek.state.prepareId,
      ready: true,
      latencyMs: 20,
      jitterMs: 2,
    }));
  }
  const firstSchedule = await follower.next(
    (message) => message.type === "state"
      && message.state?.prepareId === preparationAfterSeek.state.prepareId
      && message.state?.playing === true
      && message.state?.scheduledAt > message.state?.serverTime,
  );

  leader.ws.send(JSON.stringify({ type: "command", action: "seek", position: 31.5 }));
  const scheduledSeekPreparation = await follower.next(
    (message) => message.type === "state"
      && message.state?.preparing === true
      && message.state?.prepareId !== firstSchedule.state.prepareId
      && message.state?.position === 31.5,
  );
  assert.equal(scheduledSeekPreparation.state.playing, false);
  assert.equal(scheduledSeekPreparation.state.scheduledAt, 0);
  assert.equal(scheduledSeekPreparation.state.readyCount, 0);
  assert.equal(scheduledSeekPreparation.state.requiredCount, 2);

  for (const client of [leader, follower]) {
    client.ws.send(JSON.stringify({
      type: "command",
      action: "ready",
      prepareId: scheduledSeekPreparation.state.prepareId,
      ready: true,
      latencyMs: 25,
      jitterMs: 3,
    }));
  }
  const scheduleBeforeLateJoin = await follower.next(
    (message) => message.type === "state"
      && message.state?.prepareId === scheduledSeekPreparation.state.prepareId
      && message.state?.playing === true
      && message.state?.scheduledAt > message.state?.serverTime,
  );
  const hardDeadlineBeforeLateJoin = relay.rooms.get("EDGE42").prepareMaxDeadline;

  const lateDevice = connect(`ws://127.0.0.1:${relay.port}/ws`);
  clients.push(lateDevice);
  await lateDevice.opened;
  await lateDevice.next((message) => message.type === "welcome");
  lateDevice.ws.send(JSON.stringify({ type: "join", room: "EDGE42", name: "Late device" }));
  const lateJoin = await lateDevice.next((message) => message.type === "joined");
  assert.equal(lateJoin.state.prepareId, scheduleBeforeLateJoin.state.prepareId);
  assert.equal(lateJoin.state.preparing, true);
  assert.equal(lateJoin.state.playing, false);
  assert.equal(lateJoin.state.scheduledAt, 0);
  assert.equal(lateJoin.state.readyCount, 2);
  assert.equal(lateJoin.state.requiredCount, 3);
  assert.equal(relay.rooms.get("EDGE42").prepareMaxDeadline, hardDeadlineBeforeLateJoin);

  for (const client of [leader, follower, lateDevice]) {
    client.ws.send(JSON.stringify({
      type: "command",
      action: "ready",
      prepareId: lateJoin.state.prepareId,
      ready: true,
      latencyMs: 40,
      jitterMs: 6,
    }));
  }
  const rescheduledForAllDevices = await lateDevice.next(
    (message) => message.type === "state"
      && message.state?.prepareId === lateJoin.state.prepareId
      && message.state?.playing === true
      && message.state?.scheduledAt > message.state?.serverTime,
  );
  assert.equal(rescheduledForAllDevices.state.preparing, false);
  assert.equal(relay.rooms.get("EDGE42").readyClients.size, 3);
  assert.equal(relay.rooms.get("EDGE42").prepareParticipants.size, 3);
});

test("moving one socket to another room fully detaches it and promotes the old room follower", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mineradio-room-move-"));
  const relay = await createLanRelay({
    port: 0,
    host: "127.0.0.1",
    dataDir,
    playbackPrepareTimeoutMs: 2000,
  });
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.ws.close();
    await relay.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const movingLeader = connect(`ws://127.0.0.1:${relay.port}/ws`);
  const oldRoomFollower = connect(`ws://127.0.0.1:${relay.port}/ws`);
  clients.push(movingLeader, oldRoomFollower);
  await Promise.all([movingLeader.opened, oldRoomFollower.opened]);
  const [leaderWelcome, followerWelcome] = await Promise.all([
    movingLeader.next((message) => message.type === "welcome"),
    oldRoomFollower.next((message) => message.type === "welcome"),
  ]);

  movingLeader.ws.send(JSON.stringify({ type: "join", room: "OLD42", name: "Moving leader" }));
  await movingLeader.next((message) => message.type === "joined" && message.room === "OLD42");
  oldRoomFollower.ws.send(JSON.stringify({ type: "join", room: "OLD42", name: "Old follower" }));
  await oldRoomFollower.next((message) => message.type === "joined" && message.room === "OLD42");

  movingLeader.ws.send(JSON.stringify({
    type: "command",
    action: "track",
    track: {
      id: "cloud-987654",
      name: "Room Move Test",
      type: "audio/mpeg",
      size: 0,
      path: "/api/cloud/987654",
    },
  }));
  movingLeader.ws.send(JSON.stringify({ type: "command", action: "play" }));
  const preparing = await oldRoomFollower.next(
    (message) => message.type === "state"
      && message.state?.preparing === true
      && message.state?.requiredCount === 2,
  );
  movingLeader.ws.send(JSON.stringify({
    type: "command",
    action: "ready",
    prepareId: preparing.state.prepareId,
    ready: true,
    latencyMs: 30,
    jitterMs: 4,
  }));
  await oldRoomFollower.next(
    (message) => message.type === "state"
      && message.state?.prepareId === preparing.state.prepareId
      && message.state?.readyCount === 1,
  );

  const oldRoomBeforeMove = relay.rooms.get("OLD42");
  assert.equal(oldRoomBeforeMove.readyClients.has(leaderWelcome.clientId), true);
  assert.equal(oldRoomBeforeMove.readyTiming.has(leaderWelcome.clientId), true);
  assert.equal(oldRoomBeforeMove.prepareParticipants.has(leaderWelcome.clientId), true);

  movingLeader.ws.send(JSON.stringify({ type: "join", room: "NEW42", name: "New-room leader" }));
  const joinedNewRoom = await movingLeader.next(
    (message) => message.type === "joined" && message.room === "NEW42",
  );
  assert.equal(joinedNewRoom.leader, true);
  const promoted = await oldRoomFollower.next(
    (message) => message.type === "state"
      && message.state?.leaderId === followerWelcome.clientId
      && message.state?.preparing === true,
  );
  assert.equal(promoted.state.playing, false);
  assert.equal(promoted.state.prepareId, preparing.state.prepareId);
  assert.equal(promoted.state.readyCount, 0);
  assert.equal(promoted.state.requiredCount, 1);

  const oldRoomAfterMove = relay.rooms.get("OLD42");
  assert.equal(oldRoomAfterMove.clients.size, 1);
  assert.equal(oldRoomAfterMove.leaderId, followerWelcome.clientId);
  assert.equal(oldRoomAfterMove.readyClients.size, 0);
  assert.equal(oldRoomAfterMove.readyTiming.size, 0);
  assert.deepEqual([...oldRoomAfterMove.prepareParticipants], [followerWelcome.clientId]);
  assert.ok(oldRoomAfterMove.prepareDeadline > Date.now());
  assert.equal(relay.rooms.get("NEW42").clients.size, 1);
  assert.equal(relay.rooms.get("NEW42").leaderId, leaderWelcome.clientId);

  oldRoomFollower.ws.send(JSON.stringify({
    type: "command",
    action: "ready",
    prepareId: promoted.state.prepareId,
    ready: true,
  }));
  const resumedByPromotedLeader = await oldRoomFollower.next(
    (message) => message.type === "state"
      && message.state?.leaderId === followerWelcome.clientId
      && message.state?.playing === true
      && message.state?.prepareId === promoted.state.prepareId,
  );
  assert.equal(resumedByPromotedLeader.state.preparing, false);
});

test("joining the current room again is idempotent during playback preparation", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mineradio-room-rejoin-"));
  const relay = await createLanRelay({
    port: 0,
    host: "127.0.0.1",
    dataDir,
    playbackPrepareTimeoutMs: 2000,
  });
  const client = connect(`ws://127.0.0.1:${relay.port}/ws`);
  t.after(async () => {
    client.ws.close();
    await relay.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await client.opened;
  const welcome = await client.next((message) => message.type === "welcome");
  client.ws.send(JSON.stringify({ type: "join", room: "SAME42", name: "First name" }));
  await client.next((message) => message.type === "joined" && message.room === "SAME42");
  client.ws.send(JSON.stringify({
    type: "command",
    action: "track",
    track: {
      id: "cloud-456789",
      name: "Idempotent Join Test",
      type: "audio/mpeg",
      size: 0,
      path: "/api/cloud/456789",
    },
  }));
  client.ws.send(JSON.stringify({ type: "command", action: "play" }));
  const preparing = await client.next(
    (message) => message.type === "state" && message.state?.preparing === true,
  );
  const room = relay.rooms.get("SAME42");
  const prepareIdBefore = room.state.prepareId;
  const prepareDeadlineBefore = room.prepareDeadline;
  const revisionBefore = room.state.revision;
  assert.equal(prepareIdBefore, preparing.state.prepareId);
  assert.deepEqual([...room.prepareParticipants], [welcome.clientId]);

  await new Promise((resolve) => setTimeout(resolve, 30));
  client.ws.send(JSON.stringify({ type: "join", room: "SAME42", name: "Renamed device" }));
  const rejoined = await client.next(
    (message) => message.type === "joined" && message.room === "SAME42",
  );
  assert.equal(rejoined.leader, true);
  assert.equal(rejoined.state.preparing, true);
  assert.equal(rejoined.state.prepareId, prepareIdBefore);
  assert.equal(room.state.prepareId, prepareIdBefore);
  assert.equal(room.prepareDeadline, prepareDeadlineBefore);
  assert.equal(room.state.revision, revisionBefore);
  assert.deepEqual([...room.prepareParticipants], [welcome.clientId]);
  assert.equal(room.readyClients.size, 0);
  assert.equal(room.readyTiming.size, 0);

  for (let index = 0; index < 11; index += 1) {
    client.ws.send(JSON.stringify({ type: "join", room: "SAME42", name: "Join flood" }));
  }
  const limited = await client.next(
    (message) => message.type === "error" && message.code === "rate_limited",
  );
  assert.equal(limited.code, "rate_limited");
  assert.equal(room.clients.size, 1);
});
