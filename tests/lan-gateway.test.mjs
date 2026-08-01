import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import {
  classifyGatewayRoute,
  createLanGateway,
  enrollmentHtml,
  isAllowedGatewayHost,
  isAllowedGatewayOrigin,
  safeRequestHost,
} from "../scripts/lan-gateway.mjs";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

function textServer(service) {
  return http.createServer((req, res) => {
    const payload = JSON.stringify({
      ok: true,
      service,
      path: req.url,
      rooms: service === "relay" ? 1 : undefined,
      devices: service === "relay" ? 2 : undefined,
      providers: service === "music" ? ["netease", "kugou"] : undefined,
    });
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
  });
}

async function jsonAt(url, init) {
  const response = await fetch(url, init);
  return { response, payload: await response.json() };
}

function requestStatus(port, hostHeader) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: "/",
        headers: { Host: hostHeader },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      },
    );
    request.once("error", reject);
  });
}

test("gateway route table keeps relay media separate from the music API", () => {
  assert.equal(classifyGatewayRoute("/"), "web");
  assert.equal(classifyGatewayRoute("/classic/index.html"), "web");
  assert.equal(classifyGatewayRoute("/api/search"), "music");
  assert.equal(classifyGatewayRoute("/api/v2/stream/abc"), "music");
  assert.equal(classifyGatewayRoute("/api/room/qr"), "relay");
  assert.equal(classifyGatewayRoute("/api/tracks/0123456789abcdef01234567"), "relay");
  assert.equal(classifyGatewayRoute("/api/cloud/v2/kugou/abc/hires"), "relay");
  assert.equal(classifyGatewayRoute("/.well-known/mr-room/health/relay"), "relay-health");
  assert.equal(classifyGatewayRoute("/.well-known/mr-room/health/music"), "music-health");
});

test("gateway host and origin guards reject DNS rebinding and mixed origins", () => {
  const hosts = ["localhost", "127.0.0.1", "::1", "192.168.31.144"];
  assert.equal(safeRequestHost("192.168.31.144:3443"), "192.168.31.144");
  assert.equal(safeRequestHost("[::1]:3443"), "::1");
  assert.equal(safeRequestHost("evil.test/path"), "localhost");
  assert.equal(isAllowedGatewayHost("192.168.31.144:3443", hosts, 3443), true);
  assert.equal(isAllowedGatewayHost("192.168.31.144:443", hosts, 3443), false);
  assert.equal(isAllowedGatewayHost("example.com:3443", hosts, 3443), false);
  assert.equal(
    isAllowedGatewayOrigin("https://192.168.31.144:3443", hosts, 3443),
    true,
  );
  assert.equal(
    isAllowedGatewayOrigin("http://192.168.31.144:3000", hosts, 3443),
    false,
  );
  assert.equal(isAllowedGatewayOrigin("https://example.com:3443", hosts, 3443), false);
});

test("certificate enrollment copy escapes the request host", () => {
  const html = enrollmentHtml("192.168.31.144", 3443);
  assert.match(html, /https:\/\/192\.168\.31\.144:3443/);
  assert.match(html, /下载根证书/);
  assert.doesNotMatch(enrollmentHtml('"><script>alert(1)<\/script>', 3443), /<script>/);
});

test("gateway proxies web, APIs, health routes, and WebSocket through one origin", async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mineradio-gateway-"));
  const caPath = path.join(tempDir, "root.cer");
  await writeFile(caPath, Buffer.from("test-certificate"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));

  const web = textServer("web");
  const relay = textServer("relay");
  const music = textServer("music");
  const relayWss = new WebSocketServer({ server: relay, path: "/ws" });
  relayWss.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "welcome", clientId: "test-client" }));
  });
  const [webPort, relayPort, musicPort] = await Promise.all([
    listen(web),
    listen(relay),
    listen(music),
  ]);
  t.after(async () => {
    for (const client of relayWss.clients) client.terminate();
    await new Promise((resolve) => relayWss.close(resolve));
    await Promise.all([close(web), close(relay), close(music)]);
  });

  const gateway = await createLanGateway({
    insecureTestMode: true,
    host: "127.0.0.1",
    httpsPort: 0,
    enrollPort: 0,
    webPort,
    relayPort,
    musicPort,
    caPath,
    allowedHosts: ["127.0.0.1"],
  });
  t.after(() => gateway.close());
  const base = `http://127.0.0.1:${gateway.httpsPort}`;

  assert.equal((await jsonAt(`${base}/`)).payload.service, "web");
  assert.equal((await jsonAt(`${base}/api/search?q=test`)).payload.service, "music");
  assert.equal((await jsonAt(`${base}/api/tracks/0123456789abcdef01234567`)).payload.service, "relay");
  assert.equal(
    (await jsonAt(`${base}/.well-known/mr-room/health/relay`)).payload.service,
    "relay",
  );
  assert.equal(
    (await jsonAt(`${base}/.well-known/mr-room/health/music`)).payload.service,
    "music",
  );
  assert.equal((await jsonAt(`${base}/health`)).payload.ok, true);

  assert.equal(
    await requestStatus(gateway.httpsPort, `example.com:${gateway.httpsPort}`),
    421,
  );
  const invalidOrigin = await fetch(`${base}/api/search`, {
    method: "POST",
    headers: { Origin: `https://example.com:${gateway.httpsPort}` },
  });
  assert.equal(invalidOrigin.status, 403);

  const certificate = await fetch(
    `http://127.0.0.1:${gateway.enrollPort}/__mineradio/ca.cer`,
  );
  assert.equal(certificate.status, 200);
  assert.equal(await certificate.text(), "test-certificate");

  const welcome = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${gateway.httpsPort}/sync`, {
      origin: `https://127.0.0.1:${gateway.httpsPort}`,
    });
    const timeout = setTimeout(() => reject(new Error("websocket_timeout")), 3000);
    socket.once("message", (data) => {
      clearTimeout(timeout);
      resolve(JSON.parse(String(data)));
      socket.close();
    });
    socket.once("error", reject);
  });
  assert.equal(welcome.type, "welcome");
  assert.equal(welcome.clientId, "test-client");
});
