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
  const relay = await createLanRelay({ port: 0, host: "127.0.0.1", dataDir });
  t.after(async () => {
    await relay.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${relay.port}`;
  const health = await fetch(`${base}/health`).then((response) => response.json());
  assert.equal(health.ok, true);

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

  const leader = connect(`ws://127.0.0.1:${relay.port}/ws`);
  const follower = connect(`ws://127.0.0.1:${relay.port}/ws`);
  await Promise.all([leader.opened, follower.opened]);
  await Promise.all([
    leader.next((message) => message.type === "welcome"),
    follower.next((message) => message.type === "welcome"),
  ]);

  leader.ws.send(JSON.stringify({ type: "join", room: "ROOM42", name: "Leader" }));
  const leaderJoined = await leader.next((message) => message.type === "joined");
  assert.equal(leaderJoined.leader, true);

  follower.ws.send(JSON.stringify({ type: "join", room: "ROOM42", name: "Follower" }));
  const followerJoined = await follower.next((message) => message.type === "joined");
  assert.equal(followerJoined.leader, false);

  leader.ws.send(JSON.stringify({ type: "command", action: "track", track }));
  const trackState = await follower.next(
    (message) => message.type === "state" && message.state?.track?.id === track.id,
  );
  assert.equal(trackState.state.track.name, "Relay Test");

  leader.ws.send(JSON.stringify({ type: "command", action: "volume", volume: 0.42 }));
  const volumeState = await follower.next(
    (message) => message.type === "state" && message.state?.volume === 0.42,
  );
  assert.equal(volumeState.state.deviceCount, 2);

  leader.ws.send(JSON.stringify({ type: "command", action: "seek", position: 12.5 }));
  const seekState = await follower.next(
    (message) => message.type === "state" && message.state?.position === 12.5,
  );
  assert.equal(seekState.state.position, 12.5);

  leader.ws.send(JSON.stringify({ type: "command", action: "play" }));
  const playState = await follower.next(
    (message) => message.type === "state" && message.state?.playing === true,
  );
  assert.equal(playState.state.playing, true);

  follower.ws.send(JSON.stringify({ type: "command", action: "pause" }));
  const denied = await follower.next(
    (message) => message.type === "error" && message.code === "leader_only",
  );
  assert.equal(denied.code, "leader_only");

  leader.ws.close();
  follower.ws.close();
});
