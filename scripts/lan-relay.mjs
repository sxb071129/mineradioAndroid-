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
const ROOM_BROADCAST_INTERVAL_MS = 1000;
// Hi-Res / lossless streams can need more than 12 seconds to reach a
// playable buffer on the first LAN request. Keep the barrier long enough for
// slow devices to finish instead of racing the timeout by a few milliseconds.
const PLAYBACK_PREPARE_TIMEOUT_MS = 30_000;
const PLAYBACK_START_LEAD_MS = 1_200;
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
  return Math.max(0, state.position + Math.max(0, now - state.updatedAt) / 1000);
}

function publicState(room) {
  return {
    ...room.state,
    deviceCount: room.clients.size,
    readyCount: room.state.preparing ? room.readyClients.size : 0,
    requiredCount: room.state.preparing ? room.prepareParticipants.size : 0,
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

function cancelPlaybackPreparation(room, now = Date.now(), error = "") {
  room.readyClients.clear();
  room.readyTiming.clear();
  room.prepareParticipants.clear();
  room.prepareDeadline = 0;
  room.state.preparing = false;
  room.state.prepareId = "";
  room.state.prepareError = error;
  room.state.scheduledAt = 0;
  room.state.playing = false;
  room.state.updatedAt = now;
}

function beginPlaybackPreparation(room, now = Date.now()) {
  room.readyClients.clear();
  room.readyTiming.clear();
  room.prepareParticipants = new Set(
    [...room.clients]
      .filter((client) => client.readyState === WebSocket.OPEN)
      .map((client) => client.clientId),
  );
  room.prepareDeadline = now + room.playbackPrepareTimeoutMs;
  room.state.playing = false;
  room.state.preparing = Boolean(room.state.track);
  room.state.prepareId = room.state.preparing ? randomUUID() : "";
  room.state.prepareError = "";
  room.state.scheduledAt = 0;
  room.state.updatedAt = now;
}

function schedulePreparedPlayback(room, now = Date.now()) {
  if (!room.state.preparing) return false;
  room.prepareDeadline = 0;
  room.state.preparing = false;
  room.state.prepareError = "";
  room.state.playing = Boolean(room.state.track);
  const networkLeadMs = Math.max(
    0,
    ...room.readyTiming.values().map(({ latencyMs, jitterMs }) => 2 * latencyMs + 4 * jitterMs),
  );
  const startLeadMs = Math.max(750, Math.min(2500, room.playbackStartLeadMs + networkLeadMs));
  room.state.scheduledAt = room.state.playing ? now + startLeadMs : 0;
  room.state.updatedAt = room.state.scheduledAt || now;
  room.state.revision += 1;
  broadcastRoom(room);
  return true;
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

function parseSingleByteRange(value, size) {
  if (typeof value !== "string" || size <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value);
  if (!match || (!match[1] && !match[2])) return null;

  const sizeBigInt = BigInt(size);
  if (!match[1]) {
    const suffixLength = BigInt(match[2]);
    if (suffixLength === 0n) return null;
    const start = suffixLength >= sizeBigInt ? 0n : sizeBigInt - suffixLength;
    return { start: Number(start), end: size - 1 };
  }

  const start = BigInt(match[1]);
  if (start >= sizeBigInt) return null;
  const requestedEnd = match[2] ? BigInt(match[2]) : sizeBigInt - 1n;
  if (start > requestedEnd) return null;
  const end = requestedEnd >= sizeBigInt ? sizeBigInt - 1n : requestedEnd;
  return { start: Number(start), end: Number(end) };
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

  const parsedRange = parseSingleByteRange(range, fileStat.size);
  if (!parsedRange) {
    res.writeHead(416, {
      ...baseHeaders,
      "Content-Range": `bytes */${fileStat.size}`,
    });
    res.end();
    return;
  }

  const { start, end } = parsedRange;

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
        const statusCode = response.statusCode || 502;
        const isAudioResponse = statusCode >= 200 && statusCode < 300;
        const headers = corsHeaders({
          "Content-Type": response.headers["content-type"] || "audio/mpeg",
          "Cache-Control": isAudioResponse ? "private, max-age=300" : "no-store",
          ...(isAudioResponse
            ? { "Accept-Ranges": response.headers["accept-ranges"] || "bytes" }
            : {}),
        });
        for (const name of ["content-length", ...(isAudioResponse ? ["content-range"] : [])]) {
          const value = response.headers[name];
          if (value) headers[name] = value;
        }
        res.writeHead(statusCode, headers);
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
  playbackPrepareTimeoutMs = PLAYBACK_PREPARE_TIMEOUT_MS,
  playbackStartLeadMs = PLAYBACK_START_LEAD_MS,
} = {}) {
  await mkdir(dataDir, { recursive: true });
  const rooms = new Map();

  function detachClientFromRoom(ws, now = Date.now()) {
    const room = rooms.get(ws.roomCode);
    ws.roomCode = "";
    if (!room || !room.clients.delete(ws)) return;
    room.readyClients.delete(ws.clientId);
    room.readyTiming.delete(ws.clientId);
    room.prepareParticipants.delete(ws.clientId);
    if (!room.clients.size) {
      rooms.delete(room.code);
      return;
    }
    if (room.leaderId === ws.clientId) {
      room.leaderId = room.clients.values().next().value.clientId;
      if (room.state.preparing) {
        if (room.readyClients.size >= room.prepareParticipants.size) {
          schedulePreparedPlayback(room, now);
        } else {
          room.state.revision += 1;
          broadcastRoom(room);
        }
        return;
      }
      if (room.state.playing && room.state.scheduledAt > now) {
        room.state.revision += 1;
        broadcastRoom(room);
        return;
      }
      if (room.state.playing) {
        room.state.position = currentPosition(room.state, now);
        room.readyClients.clear();
        room.readyTiming.clear();
        room.prepareParticipants.clear();
        room.prepareDeadline = 0;
        room.state.preparing = false;
        room.state.prepareId = "";
        room.state.prepareError = "";
        room.state.scheduledAt = 0;
        room.state.updatedAt = now;
      }
      room.state.revision += 1;
      broadcastRoom(room);
      return;
    }
    if (room.state.preparing && room.readyClients.size >= room.prepareParticipants.size) {
      schedulePreparedPlayback(room, now);
      return;
    }
    broadcastRoom(room);
  }

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
    ws.messageChain = Promise.resolve();
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    send(ws, {
      type: "welcome",
      clientId: ws.clientId,
      serverTime: Date.now(),
      addresses: networkAddresses(),
    });

    const processMessage = async (raw, receivedAt) => {
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
          serverReceivedAt: Number(receivedAt) || Date.now(),
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
        const currentRoom = rooms.get(ws.roomCode);
        if (ws.roomCode === code && currentRoom?.clients.has(ws)) {
          ws.displayName = cleanName(message.name || "设备").slice(0, 32);
          send(ws, {
            type: "joined",
            room: code,
            clientId: ws.clientId,
            leader: currentRoom.leaderId === ws.clientId,
            state: publicState(currentRoom),
          });
          return;
        }
        if (ws.roomCode) detachClientFromRoom(ws, receivedAt);
        let room = rooms.get(code);
        if (!room) {
          room = {
            code,
            leaderId: ws.clientId,
            clients: new Set(),
            readyClients: new Set(),
            readyTiming: new Map(),
            prepareParticipants: new Set(),
            prepareDeadline: 0,
            playbackPrepareTimeoutMs: Math.max(100, Number(playbackPrepareTimeoutMs) || PLAYBACK_PREPARE_TIMEOUT_MS),
            playbackStartLeadMs: Math.max(0, Number(playbackStartLeadMs) || PLAYBACK_START_LEAD_MS),
            state: {
              revision: 0,
              track: null,
              playing: false,
              preparing: false,
              prepareId: "",
              prepareError: "",
              scheduledAt: 0,
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
        const joinedAt = Date.now();
        if (room.state.preparing) {
          room.prepareParticipants.add(ws.clientId);
          room.prepareDeadline = Math.max(
            room.prepareDeadline,
            joinedAt + room.playbackPrepareTimeoutMs,
          );
        } else if (room.state.playing
          && room.state.scheduledAt > joinedAt
          && room.state.prepareId) {
          beginPlaybackPreparation(room, joinedAt);
          room.state.revision += 1;
        }
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
      if (action === "ready") {
        const prepareId = String(message.prepareId || "");
        if (!prepareId || prepareId !== state.prepareId || !room.prepareParticipants.has(ws.clientId)) return;
        const ready = message.ready !== false;
        if (!state.preparing) {
          if (!ready && state.playing && state.scheduledAt > now) {
            room.readyClients.delete(ws.clientId);
            room.readyTiming.delete(ws.clientId);
            state.playing = false;
            state.preparing = true;
            state.scheduledAt = 0;
            state.prepareError = "";
            state.updatedAt = now;
            room.prepareDeadline = now + room.playbackPrepareTimeoutMs;
            state.revision += 1;
            broadcastRoom(room);
          }
          return;
        }
        if (!ready) {
          if (!room.readyClients.delete(ws.clientId)) return;
          room.readyTiming.delete(ws.clientId);
          state.revision += 1;
          broadcastRoom(room);
          return;
        }
        if (room.readyClients.has(ws.clientId)) return;
        room.readyClients.add(ws.clientId);
        room.readyTiming.set(ws.clientId, {
          latencyMs: Math.max(0, Math.min(Number(message.latencyMs) || 0, 5000)),
          jitterMs: Math.max(0, Math.min(Number(message.jitterMs) || 0, 1000)),
        });
        if (room.readyClients.size >= room.prepareParticipants.size) {
          schedulePreparedPlayback(room, now);
        } else {
          state.revision += 1;
          broadcastRoom(room);
        }
        return;
      }
      if (action === "start-failed") {
        const prepareId = String(message.prepareId || "");
        if (prepareId
          && prepareId === state.prepareId
          && room.prepareParticipants.has(ws.clientId)
          && state.playing
          && state.scheduledAt
          && now <= state.scheduledAt + 5000) {
          cancelPlaybackPreparation(room, now, "start_failed");
          state.revision += 1;
          broadcastRoom(room);
        }
        return;
      }
      if (room.leaderId !== ws.clientId) {
        send(ws, { type: "error", code: "leader_only" });
        return;
      }

      if (action === "play") {
        state.position = currentPosition(state, now);
        beginPlaybackPreparation(room, now);
      } else if (action === "pause") {
        state.position = currentPosition(state, now);
        cancelPlaybackPreparation(room, now);
      } else if (action === "seek") {
        const restartPreparation = state.preparing || (state.playing && state.scheduledAt > now);
        state.position = Math.max(0, Math.min(Number(message.position) || 0, 86400));
        if (restartPreparation) beginPlaybackPreparation(room, now);
        else state.scheduledAt = 0;
      } else if (action === "progress") {
        const sampledServerTime = Number(message.sampledServerTime);
        if (!Number.isFinite(sampledServerTime)
          || sampledServerTime < now - 5000
          || sampledServerTime > now + 1000) return;
        const sampleAgeMs = Math.max(0, Math.min(now - sampledServerTime, 5000));
        const reportedPosition = Math.max(0, Math.min(Number(message.position) || 0, 86400));
        state.position = Math.min(
          86400,
          reportedPosition + (message.advancing !== false && state.playing && now >= state.updatedAt ? sampleAgeMs / 1000 : 0),
        );
      } else if (action === "volume") {
        state.position = currentPosition(state, now);
        state.volume = Math.max(0, Math.min(Number(message.volume) || 0, 1));
      } else if (action === "quality") {
        const quality = String(message.quality || "").toLowerCase();
        const cloud = parseCloudTrackId(state.track?.id);
        if (!cloud || !QUALITY_VALUES.has(quality)) {
          send(ws, { type: "error", code: "quality_unavailable" });
          return;
        }
        const shouldResume = state.playing || state.preparing;
        state.position = currentPosition(state, now);
        const id = `cloud-v2-${cloud.provider}-${cloud.sourceId}-${quality}`;
        state.track = cloudTrackDescriptor(state.track, {
          id,
          provider: cloud.provider,
          sourceId: cloud.sourceId,
          quality,
          legacy: false,
        });
        if (shouldResume) beginPlaybackPreparation(room, now);
      } else if (action === "track") {
        const track = normalizeTrack(message.track);
        if (!track || (isLocalTrack(track) && !(await readTrackMeta(dataDir, track.id)))) {
          send(ws, { type: "error", code: "invalid_track" });
          return;
        }
        if (rooms.get(ws.roomCode) !== room || room.leaderId !== ws.clientId) return;
        cancelPlaybackPreparation(room, now);
        state.track = track;
        state.position = 0;
      } else {
        send(ws, { type: "error", code: "invalid_command" });
        return;
      }
      state.updatedAt = state.playing && state.scheduledAt > now ? state.scheduledAt : now;
      state.revision += 1;
      broadcastRoom(room);
    };

    ws.on("message", (raw) => {
      const receivedAt = Date.now();
      ws.messageChain = ws.messageChain.then(() => processMessage(raw, receivedAt)).catch(() => {
        send(ws, { type: "error", code: "command_failed" });
      });
    });

    ws.on("close", () => {
      detachClientFromRoom(ws);
    });
  });

  const tick = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      if (room.state.preparing && room.prepareDeadline && now >= room.prepareDeadline) {
        cancelPlaybackPreparation(room, now, "timeout");
        room.state.revision += 1;
      }
      broadcastRoom(room);
    }
  }, ROOM_BROADCAST_INTERVAL_MS);
  tick.unref();

  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (!client.isAlive) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, 15000);
  heartbeat.unref();

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
      clearInterval(heartbeat);
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
