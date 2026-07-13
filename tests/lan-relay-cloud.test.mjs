import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
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
    } else queue.push(value);
  });
  return {
    ws,
    opened: new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    }),
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

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

test("cloud proxy forwards Range and only accepts canonical song ids", async (t) => {
  const upstreamRequests = [];
  const music = http.createServer((req, res) => {
    upstreamRequests.push({ url: req.url, range: req.headers.range, cookie: req.headers.cookie });
    const bytes = Buffer.from([4, 5, 6, 7]);
    res.writeHead(206, {
      "Content-Type": "audio/mpeg",
      "Content-Length": bytes.length,
      "Content-Range": "bytes 4-7/100",
      "Accept-Ranges": "bytes",
    });
    res.end(bytes);
  });
  const musicPort = await listen(music);
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mineradio-cloud-relay-"));
  const relay = await createLanRelay({
    port: 0,
    host: "127.0.0.1",
    dataDir,
    musicApiHost: "127.0.0.1",
    musicApiPort: musicPort,
  });
  t.after(async () => {
    await relay.close();
    await new Promise((resolve) => music.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${relay.port}`;
  const response = await fetch(`${base}/api/cloud/123456`, {
    headers: { range: "bytes=4-7", cookie: "LAN_CLIENT_SECRET=1" },
  });
  assert.equal(response.status, 206);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([4, 5, 6, 7]));
  assert.equal(response.headers.get("content-range"), "bytes 4-7/100");
  assert.equal(response.headers.get("content-length"), "4");
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.match(response.headers.get("access-control-allow-headers") || "", /range/i);
  assert.match(response.headers.get("access-control-expose-headers") || "", /content-range/i);
  assert.deepEqual(upstreamRequests, [{
    url: "/api/stream?id=123456",
    range: "bytes=4-7",
    cookie: undefined,
  }]);

  for (const pathname of [
    "/api/cloud/0",
    "/api/cloud/01",
    "/api/cloud/-1",
    "/api/cloud/abc",
    "/api/cloud/123456789012345678901",
    "/api/cloud?url=http://127.0.0.1:9999/",
  ]) {
    const rejected = await fetch(`${base}${pathname}`);
    assert.equal(rejected.status, 404, pathname);
  }
  assert.equal(upstreamRequests.length, 1);
});

test("room canonicalizes cloud tracks and ignores client transport fields", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mineradio-cloud-room-"));
  const relay = await createLanRelay({ port: 0, host: "127.0.0.1", dataDir });
  const leader = connect(`ws://127.0.0.1:${relay.port}/ws`);
  const follower = connect(`ws://127.0.0.1:${relay.port}/ws`);
  t.after(async () => {
    leader.ws.close();
    follower.ws.close();
    await relay.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await Promise.all([leader.opened, follower.opened]);
  await Promise.all([
    leader.next((message) => message.type === "welcome"),
    follower.next((message) => message.type === "welcome"),
  ]);
  leader.ws.send(JSON.stringify({ type: "join", room: "ROOM42", name: "Leader" }));
  await leader.next((message) => message.type === "joined");
  follower.ws.send(JSON.stringify({ type: "join", room: "ROOM42", name: "Follower" }));
  await follower.next((message) => message.type === "joined");

  leader.ws.send(JSON.stringify({
    type: "command",
    action: "track",
    track: {
      id: "cloud-123456",
      name: "  Cloud\u0000 Song  ",
      type: "text/html",
      size: 999999,
      path: "http://evil.example/audio",
    },
  }));
  const stateMessage = await follower.next(
    (message) => message.type === "state" && message.state?.track?.id === "cloud-123456",
  );
  assert.deepEqual(stateMessage.state.track, {
    id: "cloud-123456",
    name: "Cloud Song",
    type: "audio/mpeg",
    size: 0,
    path: "/api/cloud/123456",
  });
  assert.equal(stateMessage.state.position, 0);
  assert.equal(stateMessage.state.playing, false);

  const revision = relay.rooms.get("ROOM42").state.revision;
  leader.ws.send(JSON.stringify({
    type: "command",
    action: "track",
    track: { id: "cloud-01", name: "Invalid", type: "audio/mpeg", size: 0, path: "/api/cloud/1" },
  }));
  const denied = await leader.next((message) => message.type === "error" && message.code === "invalid_track");
  assert.equal(denied.code, "invalid_track");
  assert.equal(relay.rooms.get("ROOM42").state.revision, revision);
  assert.equal(relay.rooms.get("ROOM42").state.track.id, "cloud-123456");
});
