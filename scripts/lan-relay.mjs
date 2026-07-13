import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { WebSocketServer, WebSocket } from "ws";

const DEFAULT_PORT = Number(process.env.MINERADIO_SYNC_PORT || 8787);
const DEFAULT_HOST = process.env.MINERADIO_SYNC_HOST || "0.0.0.0";
const MUSIC_API_PORT = Number(process.env.MINERADIO_MUSIC_PORT || 8790);
const DEFAULT_DATA_DIR = path.resolve(".mineradio-lan", "tracks");
const MAX_TRACK_BYTES = Number(
  process.env.MINERADIO_MAX_TRACK_BYTES || 512 * 1024 * 1024,
);
const MAX_WS_PAYLOAD = 64 * 1024;
const ROOM_RE = /^[A-Z0-9]{4,8}$/;
const TRACK_ID_RE = /^[a-f0-9]{24}$/;
const CLOUD_TRACK_RE = /^cloud-([1-9]\d{0,19})$/;
const QUALITY_VALUES = new Set(["jymaster", "hires", "lossless", "exhigh", "standard"]);
const CLOUD_V2_RE = /^cloud-v2-(netease|kugou)-([A-Za-z0-9]+)-(jymaster|hires|lossless|exhigh|standard)$/;

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type,range",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Expose-Headers": "accept-ranges,content-length,content-range",
    "Cross-Origin-Resource-Policy": "cross-origin",
    ...extra,
  };
}

function json(res, status, value, extra = {}) {
  const body = JSON.stringify(value);
  res.writeHead(
    status,
    corsHeaders({
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
      ...extra,
    }),
  );
  res.end(body);
}

function cleanName(value) {
  const normalized = String(value || "未命名音频")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return normalized.slice(0, 160) || "未命名音频";
}

function cleanMime(value) {
  const mime = String(value || "audio/mpeg").toLowerCase();
  return /^audio\/[a-z0-9.+-]+$/.test(mime) ? mime : "application/octet-stream";
}

function normalizeRoom(value) {
  const room = String(value || "").trim().toUpperCase();
  return ROOM_RE.test(room) ? room : "";
}

function parseCloudTrackId(value) {
  const id = String(value || "");
  const legacy = CLOUD_TRACK_RE.exec(id);
  if (legacy) {
    return { id, provider: "netease", sourceId: legacy[1], quality: "standard", legacy: true };
  }
  const match = CLOUD_V2_RE.exec(id);
  if (!match) return null;
  const [, provider, sourceId, quality] = match;
  if (provider === "netease" && !/^[1-9]\d{0,19}$/.test(sourceId)) return null;
  if (provider === "kugou" && !/^[a-f0-9]{24}$/.test(sourceId)) return null;
  return { id, provider, sourceId, quality, legacy: false };
}

function cloudTrackDescriptor(value, cloud) {
  return {
    id: cloud.id,
    name: cleanName(value.name),
    type: "audio/mpeg",
    size: 0,
    path: cloud.legacy
      ? `/api/cloud/${cloud.sourceId}`
      : `/api/cloud/v2/${cloud.provider}/${cloud.sourceId}/${cloud.quality}`,
    provider: cloud.provider,
    quality: cloud.quality,
  };
}

function normalizeTrack(value) {
  if (!value) return null;
  const id = String(value.id || "");
  const cloud = parseCloudTrackId(id);
  if (cloud) return cloudTrackDescriptor(value, cloud);
  if (!TRACK_ID_RE.test(id)) return null;
  return {
    id,
    name: cleanName(value.name),
    type: cleanMime(value.type),
    size: Math.max(0, Number(value.size) || 0),
    path: `/api/tracks/${value.id}`,
  };
}

function isLocalTrack(track) {
  return Boolean(track && TRACK_ID_RE.test(track.id));
}

function networkAddresses() {
  const values = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) values.push(entry.address);
    }
  }
  return [...new Set(values)];
}

function currentPosition(state, now = Date.now()) {
  if (!state.playing) return state.position;
  return Math.max(0, state.position + (now - state.updatedAt) / 1000);
}

function publicState(room) {
  return {
    ...room.state,
    deviceCount: room.clients.size,
    leaderId: room.leaderId,
    serverTime: Date.now(),
  };
}

function send(ws, value) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
}

function broadcast(room, value) {
  const serialized = JSON.stringify(value);
  for (const client of room.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(serialized);
  }
}

function broadcastRoom(room) {
  broadcast(room, { type: "state", state: publicState(room) });
}

async function readTrackMeta(dataDir, id) {
  if (!TRACK_ID_RE.test(id)) return null;
  try {
    const raw = await readFile(path.join(dataDir, `${id}.json`), "utf8");
    return normalizeTrack(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function serveTrack(req, res, dataDir, id) {
  const meta = await readTrackMeta(dataDir, id);
  if (!meta) return json(res, 404, { error: "track_not_found" });

  const filePath = path.join(dataDir, `${id}.bin`);
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    return json(res, 404, { error: "track_not_found" });
  }

  const range = req.headers.range;
  const baseHeaders = corsHeaders({
    "Content-Type": meta.type,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=86400, immutable",
  });

  if (!range) {
    res.writeHead(200, { ...baseHeaders, "Content-Length": fileStat.size });
    createReadStream(filePath).pipe(res);
    return;
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    res.writeHead(416, {
      ...baseHeaders,
      "Content-Range": `bytes */${fileStat.size}`,
    });
    res.end();
    return;
  }

  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : fileStat.size - 1;
  if (start > end || start >= fileStat.size || end >= fileStat.size) {
    res.writeHead(416, {
      ...baseHeaders,
      "Content-Range": `bytes */${fileStat.size}`,
    });
    res.end();
    return;
  }

  res.writeHead(206, {
    ...baseHeaders,
    "Content-Length": end - start + 1,
    "Content-Range": `bytes ${start}-${end}/${fileStat.size}`,
  });
  createReadStream(filePath, { start, end }).pipe(res);
}

async function uploadTrack(req, res, dataDir, url) {
  const declaredSize = Number(req.headers["content-length"] || 0);
  if (declaredSize > MAX_TRACK_BYTES) {
    return json(res, 413, { error: "track_too_large", maxBytes: MAX_TRACK_BYTES });
  }

  const tempPath = path.join(dataDir, `.upload-${randomUUID()}.tmp`);
  const hash = createHash("sha256");
  let received = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > MAX_TRACK_BYTES) {
        callback(Object.assign(new Error("track_too_large"), { statusCode: 413 }));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(req, meter, createWriteStream(tempPath, { flags: "wx" }));
    if (!received) throw Object.assign(new Error("empty_track"), { statusCode: 400 });

    const id = hash.digest("hex").slice(0, 24);
    const filePath = path.join(dataDir, `${id}.bin`);
    try {
      await rename(tempPath, filePath);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await unlink(tempPath).catch(() => {});
    }

    const meta = {
      id,
      name: cleanName(url.searchParams.get("name")),
      type: cleanMime(url.searchParams.get("type")),
      size: received,
      path: `/api/tracks/${id}`,
      createdAt: new Date().toISOString(),
    };
    await writeFile(
      path.join(dataDir, `${id}.json`),
      JSON.stringify(meta, null, 2),
      "utf8",
    );
    json(res, 201, meta);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    json(res, error?.statusCode || 500, {
      error: error?.message || "upload_failed",
    });
  }
}

async function proxyCloudTrack(req, res, provider, sourceId, quality, musicApiHost, musicApiPort) {
  await new Promise((resolve) => {
    const params = new URLSearchParams({ provider, id: sourceId, quality });
    const upstream = http.request(
      {
        hostname: musicApiHost,
        port: musicApiPort,
        path: `/api/stream?${params.toString()}`,
        method: "GET",
        headers: req.headers.range ? { range: req.headers.range } : {},
      },
      (response) => {
        const headers = corsHeaders({
          "Content-Type": response.headers["content-type"] || "audio/mpeg",
          "Accept-Ranges": response.headers["accept-ranges"] || "bytes",
          "Cache-Control": "private, max-age=300",
        });
        for (const name of ["content-length", "content-range"]) {
          const value = response.headers[name];
          if (value) headers[name] = value;
        }
        res.writeHead(response.statusCode || 502, headers);
        response.pipe(res);
        response.once("end", resolve);
        res.once("close", () => {
          if (!response.complete) response.destroy();
          resolve();
        });
        response.once("error", () => {
          res.destroy();
          resolve();
        });
      },
    );
    upstream.setTimeout(20_000, () => upstream.destroy(new Error("music_api_timeout")));
    upstream.once("error", () => {
      if (!res.headersSent) json(res, 502, { error: "music_api_unavailable" });
      else res.destroy();
      resolve();
    });
    upstream.end();
  });
}

export async function createLanRelay({
  port = DEFAULT_PORT,
  host = DEFAULT_HOST,
  dataDir = DEFAULT_DATA_DIR,
  musicApiHost = "127.0.0.1",
  musicApiPort = MUSIC_API_PORT,
} = {}) {
  await mkdir(dataDir, { recursive: true });
  const rooms = new Map();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://relay.local");
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, {
        ok: true,
        service: "mineradio-lan-relay",
        rooms: rooms.size,
        addresses: networkAddresses(),
        port: server.address()?.port || port,
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/tracks") {
      await uploadTrack(req, res, dataDir, url);
      return;
    }
    const trackMatch = /^\/api\/tracks\/([a-f0-9]{24})$/.exec(url.pathname);
    if (req.method === "GET" && trackMatch) {
      await serveTrack(req, res, dataDir, trackMatch[1]);
      return;
    }
    const cloudMatch = /^\/api\/cloud\/([1-9]\d{0,19})$/.exec(url.pathname);
    if (req.method === "GET" && cloudMatch) {
      await proxyCloudTrack(req, res, "netease", cloudMatch[1], "standard", musicApiHost, musicApiPort);
      return;
    }
    const cloudV2Match = /^\/api\/cloud\/v2\/(netease|kugou)\/([A-Za-z0-9]+)\/(jymaster|hires|lossless|exhigh|standard)$/.exec(url.pathname);
    if (req.method === "GET" && cloudV2Match) {
      const [, provider, sourceId, quality] = cloudV2Match;
      const validSource = provider === "netease"
        ? /^[1-9]\d{0,19}$/.test(sourceId)
        : /^[a-f0-9]{24}$/.test(sourceId);
      if (!validSource) {
        json(res, 404, { error: "not_found" });
        return;
      }
      await proxyCloudTrack(req, res, provider, sourceId, quality, musicApiHost, musicApiPort);
      return;
    }
    json(res, 404, { error: "not_found" });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://relay.local");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws) => {
    ws.clientId = randomUUID();
    ws.roomCode = "";
    ws.displayName = "设备";
    ws.commandWindow = { startedAt: Date.now(), count: 0 };

    send(ws, {
      type: "welcome",
      clientId: ws.clientId,
      serverTime: Date.now(),
      addresses: networkAddresses(),
    });

    ws.on("message", async (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: "error", code: "invalid_json" });
        return;
      }

      if (message.type === "ping") {
        send(ws, {
          type: "pong",
          clientTime: Number(message.clientTime) || 0,
          serverTime: Date.now(),
        });
        return;
      }

      if (message.type === "join") {
        const code = normalizeRoom(message.room);
        if (!code) {
          send(ws, { type: "error", code: "invalid_room" });
          return;
        }
        if (ws.roomCode && rooms.has(ws.roomCode)) {
          rooms.get(ws.roomCode).clients.delete(ws);
        }
        let room = rooms.get(code);
        if (!room) {
          room = {
            code,
            leaderId: ws.clientId,
            clients: new Set(),
            state: {
              revision: 0,
              track: null,
              playing: false,
              position: 0,
              volume: 0.72,
              updatedAt: Date.now(),
            },
          };
          rooms.set(code, room);
        }
        ws.roomCode = code;
        ws.displayName = cleanName(message.name || "设备").slice(0, 32);
        room.clients.add(ws);
        send(ws, {
          type: "joined",
          room: code,
          clientId: ws.clientId,
          leader: room.leaderId === ws.clientId,
          state: publicState(room),
        });
        broadcastRoom(room);
        return;
      }

      const room = rooms.get(ws.roomCode);
      if (!room) {
        send(ws, { type: "error", code: "not_joined" });
        return;
      }
      if (message.type !== "command") return;
      if (room.leaderId !== ws.clientId) {
        send(ws, { type: "error", code: "leader_only" });
        return;
      }

      const now = Date.now();
      if (now - ws.commandWindow.startedAt > 1000) {
        ws.commandWindow = { startedAt: now, count: 0 };
      }
      ws.commandWindow.count += 1;
      if (ws.commandWindow.count > 45) {
        send(ws, { type: "error", code: "rate_limited" });
        return;
      }

      const state = room.state;
      const action = String(message.action || "");
      if (action === "play") {
        state.position = currentPosition(state, now);
        state.playing = !!state.track;
      } else if (action === "pause") {
        state.position = currentPosition(state, now);
        state.playing = false;
      } else if (action === "seek") {
        state.position = Math.max(0, Math.min(Number(message.position) || 0, 86400));
      } else if (action === "volume") {
        state.volume = Math.max(0, Math.min(Number(message.volume) || 0, 1));
      } else if (action === "quality") {
        const quality = String(message.quality || "").toLowerCase();
        const cloud = parseCloudTrackId(state.track?.id);
        if (!cloud || !QUALITY_VALUES.has(quality)) {
          send(ws, { type: "error", code: "quality_unavailable" });
          return;
        }
        state.position = currentPosition(state, now);
        const id = `cloud-v2-${cloud.provider}-${cloud.sourceId}-${quality}`;
        state.track = cloudTrackDescriptor(state.track, {
          id,
          provider: cloud.provider,
          sourceId: cloud.sourceId,
          quality,
          legacy: false,
        });
      } else if (action === "track") {
        const track = normalizeTrack(message.track);
        if (!track || (isLocalTrack(track) && !(await readTrackMeta(dataDir, track.id)))) {
          send(ws, { type: "error", code: "invalid_track" });
          return;
        }
        state.track = track;
        state.position = 0;
        state.playing = false;
      } else {
        send(ws, { type: "error", code: "invalid_command" });
        return;
      }
      state.updatedAt = now;
      state.revision += 1;
      broadcastRoom(room);
    });

    ws.on("close", () => {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      room.clients.delete(ws);
      if (!room.clients.size) {
        rooms.delete(room.code);
        return;
      }
      if (room.leaderId === ws.clientId) {
        room.leaderId = room.clients.values().next().value.clientId;
        room.state.position = currentPosition(room.state);
        room.state.playing = false;
        room.state.updatedAt = Date.now();
        room.state.revision += 1;
      }
      broadcastRoom(room);
    });
  });

  const tick = setInterval(() => {
    for (const room of rooms.values()) broadcastRoom(room);
  }, 2000);
  tick.unref();

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;

  return {
    server,
    wss,
    rooms,
    port: actualPort,
    async close() {
      clearInterval(tick);
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const currentFile = fileURLToPath(import.meta.url);
const isMain =
  process.argv[1] &&
  path.resolve(currentFile) === path.resolve(fileURLToPath(pathToFileURL(process.argv[1])));

if (isMain) {
  const relay = await createLanRelay();
  const addresses = networkAddresses();
  console.log(`Mineradio LAN relay listening on http://localhost:${relay.port}`);
  for (const address of addresses) {
    console.log(`LAN relay: http://${address}:${relay.port}`);
  }
}
