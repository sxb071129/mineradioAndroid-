import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import QRCode from "qrcode";
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
const PLAYBACK_PREPARE_PROGRESS_GRACE_MS = 10_000;
const PLAYBACK_START_LEAD_MS = 1_200;
const PLAYBACK_PREPARE_COMPLETION_RETENTION_MS = 5_000;
const MAX_ROOM_CLIENTS = 64;
const JOIN_WINDOW_MS = 10_000;
const MAX_JOINS_PER_WINDOW = 12;
const MAX_ROOM_QR_TEXT_BYTES = 2048;
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

function cleanDisplayText(value, maxLength = 160) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, maxLength);
}

function cleanCover(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 2_048) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function cleanMime(value) {
  const mime = String(value || "audio/mpeg").toLowerCase();
  return /^audio\/[a-z0-9.+-]+$/.test(mime) ? mime : "application/octet-stream";
}

function normalizeRoom(value) {
  const room = String(value || "").trim().toUpperCase();
  return ROOM_RE.test(room) ? room : "";
}

function validRoomQrText(value) {
  if (typeof value !== "string"
    || !value
    || value !== value.trim()
    || Buffer.byteLength(value, "utf8") > MAX_ROOM_QR_TEXT_BYTES
    || /[\u0000-\u001f\u007f]/.test(value)) {
    return "";
  }
  try {
    const target = new URL(value);
    if (!/^(?:http|https):$/.test(target.protocol)
      || !target.hostname
      || target.username
      || target.password) {
      return "";
    }
    return value;
  } catch {
    return "";
  }
}

async function serveRoomQr(res, text) {
  try {
    const body = await QRCode.toBuffer(text, {
      type: "png",
      errorCorrectionLevel: "M",
      margin: 2,
      width: 320,
    });
    res.writeHead(
      200,
      corsHeaders({
        "Content-Type": "image/png",
        "Content-Length": body.length,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      }),
    );
    res.end(body);
  } catch {
    json(res, 500, { error: "qr_generation_failed" });
  }
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
  const artist = cleanDisplayText(value.artist);
  const album = cleanDisplayText(value.album);
  const cover = cleanCover(value.cover);
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
    ...(artist ? { artist } : {}),
    ...(album ? { album } : {}),
    ...(cover ? { cover } : {}),
  };
}

function normalizeTrack(value) {
  if (!value) return null;
  const id = String(value.id || "");
  const cloud = parseCloudTrackId(id);
  if (cloud) return cloudTrackDescriptor(value, cloud);
  if (!TRACK_ID_RE.test(id)) return null;
  const artist = cleanDisplayText(value.artist);
  const album = cleanDisplayText(value.album);
  const cover = cleanCover(value.cover);
  return {
    id,
    name: cleanName(value.name),
    type: cleanMime(value.type),
    size: Math.max(0, Number(value.size) || 0),
    path: `/api/tracks/${value.id}`,
    ...(artist ? { artist } : {}),
    ...(album ? { album } : {}),
    ...(cover ? { cover } : {}),
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

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampNumber(value, minimum, maximum, fallback = 0) {
  return Math.max(minimum, Math.min(finiteNumber(value, fallback), maximum));
}

function validDeviceCalibration(volumeTrimDb, delayMs) {
  if (typeof volumeTrimDb !== "number"
    || !Number.isFinite(volumeTrimDb)
    || volumeTrimDb < -24
    || volumeTrimDb > 12
    || typeof delayMs !== "number"
    || !Number.isFinite(delayMs)
    || delayMs < 0
    || delayMs > 500) {
    return null;
  }
  // The UI applies and displays 0.5 dB / 5 ms steps. Normalize the wire
  // protocol to the same discrete values so a hand-crafted frame cannot make
  // Relay diagnostics disagree with what a browser actually applies.
  return {
    volumeTrimDb: Math.round(volumeTrimDb * 2) / 2,
    delayMs: Math.round(delayMs / 5) * 5,
  };
}

function emptyDeviceStatus(now = Date.now()) {
  return {
    prepareId: "",
    bufferContractPrepareId: "",
    bufferedSeconds: 0,
    bufferGoalSeconds: 0,
    latencyMs: 0,
    jitterMs: 0,
    driftMs: 0,
    quality: "",
    bufferState: "",
    volumeTrimDb: 0,
    delayMs: 0,
    calibrationRevision: 0,
    explicitCalibration: false,
    updatedAt: now,
    extensionBufferedSeconds: 0,
    extensionProgress: 0,
  };
}

function ensureDeviceStatus(room, clientId, now = Date.now()) {
  let status = room.deviceStatus.get(clientId);
  if (!status) {
    status = emptyDeviceStatus(now);
    room.deviceStatus.set(clientId, status);
  }
  return status;
}

function deviceBufferProgress(status) {
  const goal = clampNumber(status?.bufferGoalSeconds, 0, 120);
  if (!goal) return 0;
  return clampNumber(status?.bufferedSeconds / goal, 0, 1);
}

function resetDeviceTrackStatus(room, now = Date.now(), clearQuality = false) {
  for (const [clientId, status] of room.deviceStatus) {
    room.deviceStatus.set(clientId, {
      ...status,
      prepareId: "",
      bufferContractPrepareId: "",
      bufferedSeconds: 0,
      bufferGoalSeconds: 0,
      quality: clearQuality ? "" : status.quality,
      bufferState: "",
      updatedAt: now,
      extensionBufferedSeconds: 0,
      extensionProgress: 0,
    });
  }
}

function publicDevices(room) {
  const failedIds = new Set(room.prepareErrorClientIds);
  const barrierVisible = room.state.preparing
    || (room.state.playing && room.state.scheduledAt > Date.now());
  return [...room.clients]
    .map((client) => {
      const status = ensureDeviceStatus(room, client.clientId);
      const participant = barrierVisible && room.prepareParticipants.has(client.clientId);
      return {
        clientId: client.clientId,
        name: client.displayName,
        leader: room.leaderId === client.clientId,
        participant,
        ready: participant && room.readyClients.has(client.clientId),
        prepared: !room.state.preparing && participant && room.readyClients.has(client.clientId),
        blocked: failedIds.has(client.clientId),
        bufferedSeconds: status.bufferedSeconds,
        bufferGoalSeconds: status.bufferGoalSeconds,
        bufferProgress: deviceBufferProgress(status),
        latencyMs: status.latencyMs,
        jitterMs: status.jitterMs,
        driftMs: status.driftMs,
        quality: status.quality,
        bufferState: status.bufferState,
        volumeTrimDb: status.volumeTrimDb,
        delayMs: status.delayMs,
        updatedAt: status.updatedAt,
      };
    })
    .sort((left, right) => Number(right.leader) - Number(left.leader)
      || left.name.localeCompare(right.name, "zh-CN"));
}

function publicState(room) {
  const devices = publicDevices(room);
  const participants = room.state.preparing
    || (room.state.playing && room.state.scheduledAt > Date.now())
    ? devices.filter((device) => device.participant)
    : [];
  const bufferProgress = participants.length
    ? participants.reduce((total, device) => total + device.bufferProgress, 0) / participants.length
    : 0;
  return {
    ...room.state,
    deviceCount: room.clients.size,
    readyCount: room.state.preparing ? room.readyClients.size : 0,
    requiredCount: room.state.preparing ? room.prepareParticipants.size : 0,
    bufferProgress,
    prepareDeadline: room.state.preparing ? room.prepareDeadline : 0,
    prepareMaxDeadline: room.state.preparing ? room.prepareMaxDeadline : 0,
    prepareErrorClientIds: [...room.prepareErrorClientIds],
    devices,
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

function cancelPlaybackPreparation(room, now = Date.now(), error = "", errorClientIds = []) {
  room.prepareErrorClientIds = error
    ? [...new Set(
        errorClientIds.length
          ? errorClientIds
          : [...room.prepareParticipants].filter((clientId) => !room.readyClients.has(clientId)),
      )]
    : [];
  room.readyClients.clear();
  room.readyTiming.clear();
  room.prepareParticipants.clear();
  room.prepareDeadline = 0;
  room.prepareMaxDeadline = 0;
  room.prepareStartedAt = 0;
  room.state.preparing = false;
  room.state.prepareId = "";
  room.state.prepareError = error;
  room.state.scheduledAt = 0;
  room.state.playing = false;
  room.state.updatedAt = now;
  if (!error) resetDeviceTrackStatus(room, now);
}

function beginPlaybackPreparation(room, now = Date.now()) {
  room.readyClients.clear();
  room.readyTiming.clear();
  room.prepareErrorClientIds = [];
  room.prepareParticipants = new Set(
    [...room.clients]
      .filter((client) => client.readyState === WebSocket.OPEN)
      .map((client) => client.clientId),
  );
  room.state.playing = false;
  room.state.preparing = Boolean(room.state.track);
  room.state.prepareId = room.state.preparing ? randomUUID() : "";
  if (!room.state.preparing) room.prepareParticipants.clear();
  room.prepareStartedAt = room.state.preparing ? now : 0;
  room.prepareDeadline = room.state.preparing ? now + room.playbackPrepareTimeoutMs : 0;
  room.prepareMaxDeadline = room.state.preparing ? now + room.playbackPrepareMaxTimeoutMs : 0;
  room.state.prepareError = "";
  room.state.scheduledAt = 0;
  room.state.updatedAt = now;
  for (const clientId of room.prepareParticipants) {
    const previous = ensureDeviceStatus(room, clientId, now);
    room.deviceStatus.set(clientId, {
      ...previous,
      prepareId: room.state.prepareId,
      bufferContractPrepareId: "",
      bufferedSeconds: 0,
      bufferGoalSeconds: 0,
      bufferState: "loading",
      updatedAt: now,
      extensionBufferedSeconds: 0,
      extensionProgress: 0,
    });
  }
}

function schedulePreparedPlayback(room, now = Date.now()) {
  if (!room.state.preparing) return false;
  room.prepareDeadline = 0;
  room.prepareErrorClientIds = [];
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

function updateDeviceStatus(
  room,
  clientId,
  message,
  now = Date.now(),
  allowCalibrationInitialization = false,
) {
  const previous = ensureDeviceStatus(room, clientId, now);
  const bufferedSeconds = clampNumber(message.bufferedSeconds, 0, 86400, previous.bufferedSeconds);
  const bufferGoalSeconds = clampNumber(message.bufferGoalSeconds, 0, 120, previous.bufferGoalSeconds);
  const latencyMs = clampNumber(message.latencyMs, 0, 5000, previous.latencyMs);
  const jitterMs = clampNumber(message.jitterMs, 0, 1000, previous.jitterMs);
  const driftMs = clampNumber(message.driftMs, -10000, 10000, previous.driftMs);
  const requestedQuality = String(message.quality || "").toLowerCase();
  const quality = QUALITY_VALUES.has(requestedQuality) ? requestedQuality : previous.quality;
  const requestedBufferState = String(message.bufferState || "").toLowerCase();
  const bufferState = /^(loading|buffering|ready|stalled|error|unlock_required)$/.test(requestedBufferState)
    ? requestedBufferState
    : previous.bufferState;
  const reportedCalibration = validDeviceCalibration(message.volumeTrimDb, message.delayMs);
  const initializeCalibration = allowCalibrationInitialization
    && !previous.explicitCalibration
    && reportedCalibration;
  const prepareId = String(message.prepareId || "");
  const activePreparation = room.state.preparing
    && prepareId
    && prepareId === room.state.prepareId
    && room.prepareParticipants.has(clientId);
  const nextProgress = bufferGoalSeconds > 0
    ? clampNumber(bufferedSeconds / bufferGoalSeconds, 0, 1)
    : 0;
  const meaningfulAdvance = activePreparation && (
    bufferedSeconds >= previous.extensionBufferedSeconds + 0.25
    || nextProgress >= previous.extensionProgress + 0.02
  );
  const next = {
    ...previous,
    prepareId: activePreparation ? prepareId : previous.prepareId,
    bufferContractPrepareId: activePreparation && bufferGoalSeconds > 0
      ? prepareId
      : previous.bufferContractPrepareId,
    bufferedSeconds,
    bufferGoalSeconds,
    latencyMs,
    jitterMs,
    driftMs,
    quality,
    bufferState,
    volumeTrimDb: initializeCalibration ? reportedCalibration.volumeTrimDb : previous.volumeTrimDb,
    delayMs: initializeCalibration ? reportedCalibration.delayMs : previous.delayMs,
    updatedAt: now,
    extensionBufferedSeconds: meaningfulAdvance ? bufferedSeconds : previous.extensionBufferedSeconds,
    extensionProgress: meaningfulAdvance ? nextProgress : previous.extensionProgress,
  };
  room.deviceStatus.set(clientId, next);
  if (meaningfulAdvance) {
    room.prepareDeadline = Math.min(
      room.prepareMaxDeadline,
      Math.max(room.prepareDeadline, now + room.playbackPrepareProgressGraceMs),
    );
  }
  return next;
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
  playbackPrepareMaxTimeoutMs = Math.max(
    100,
    Number(playbackPrepareTimeoutMs) || PLAYBACK_PREPARE_TIMEOUT_MS,
  ) * 3,
  playbackPrepareProgressGraceMs = Math.max(
    100,
    Math.min(
      PLAYBACK_PREPARE_PROGRESS_GRACE_MS,
      Number(playbackPrepareTimeoutMs) || PLAYBACK_PREPARE_TIMEOUT_MS,
    ),
  ),
  playbackStartLeadMs = PLAYBACK_START_LEAD_MS,
  playbackPrepareCompletionRetentionMs = PLAYBACK_PREPARE_COMPLETION_RETENTION_MS,
  roomBroadcastIntervalMs = ROOM_BROADCAST_INTERVAL_MS,
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
    room.deviceStatus.delete(ws.clientId);
    room.prepareErrorClientIds = room.prepareErrorClientIds.filter(
      (clientId) => clientId !== ws.clientId,
    );
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
        room.prepareMaxDeadline = 0;
        room.prepareStartedAt = 0;
        room.prepareErrorClientIds = [];
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
        devices: [...rooms.values()].reduce((total, room) => total + room.clients.size, 0),
        addresses: networkAddresses(),
        port: server.address()?.port || port,
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/room/qr") {
      const values = url.searchParams.getAll("text");
      const text = values.length === 1 ? validRoomQrText(values[0]) : "";
      if (!text) {
        json(res, 400, { error: "invalid_qr_text" });
        return;
      }
      await serveRoomQr(res, text);
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
    ws.joinWindow = { startedAt: Date.now(), count: 0 };
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
        if (receivedAt - ws.joinWindow.startedAt > JOIN_WINDOW_MS) {
          ws.joinWindow = { startedAt: receivedAt, count: 0 };
        }
        ws.joinWindow.count += 1;
        if (ws.joinWindow.count > MAX_JOINS_PER_WINDOW) {
          send(ws, { type: "error", code: "rate_limited" });
          return;
        }
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
        const targetRoom = rooms.get(code);
        if (targetRoom && targetRoom.clients.size >= MAX_ROOM_CLIENTS) {
          send(ws, { type: "error", code: "room_full" });
          return;
        }
        if (ws.roomCode) detachClientFromRoom(ws, receivedAt);
        let room = targetRoom;
        if (!room) {
          room = {
            code,
            leaderId: ws.clientId,
            clients: new Set(),
            readyClients: new Set(),
            readyTiming: new Map(),
            deviceStatus: new Map(),
            prepareParticipants: new Set(),
            prepareDeadline: 0,
            prepareMaxDeadline: 0,
            prepareStartedAt: 0,
            prepareErrorClientIds: [],
            playbackPrepareTimeoutMs: Math.max(100, Number(playbackPrepareTimeoutMs) || PLAYBACK_PREPARE_TIMEOUT_MS),
            playbackPrepareMaxTimeoutMs: Math.max(
              Math.max(100, Number(playbackPrepareTimeoutMs) || PLAYBACK_PREPARE_TIMEOUT_MS),
              Number(playbackPrepareMaxTimeoutMs)
                || Math.max(100, Number(playbackPrepareTimeoutMs) || PLAYBACK_PREPARE_TIMEOUT_MS) * 3,
            ),
            playbackPrepareProgressGraceMs: Math.max(
              100,
              Number(playbackPrepareProgressGraceMs) || PLAYBACK_PREPARE_PROGRESS_GRACE_MS,
            ),
            playbackStartLeadMs: Math.max(0, Number(playbackStartLeadMs) || PLAYBACK_START_LEAD_MS),
            playbackPrepareCompletionRetentionMs: Math.max(
              20,
              Number(playbackPrepareCompletionRetentionMs) || PLAYBACK_PREPARE_COMPLETION_RETENTION_MS,
            ),
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
        ensureDeviceStatus(room, ws.clientId, joinedAt);
        if (room.state.preparing) {
          room.prepareParticipants.add(ws.clientId);
          const status = ensureDeviceStatus(room, ws.clientId, joinedAt);
          room.deviceStatus.set(ws.clientId, {
            ...status,
            prepareId: room.state.prepareId,
            bufferContractPrepareId: "",
            bufferedSeconds: 0,
            bufferGoalSeconds: 0,
            bufferState: "loading",
            updatedAt: joinedAt,
            extensionBufferedSeconds: 0,
            extensionProgress: 0,
          });
          room.prepareDeadline = Math.min(
            room.prepareMaxDeadline,
            Math.max(room.prepareDeadline, joinedAt + room.playbackPrepareTimeoutMs),
          );
        } else if (room.state.playing
          && room.state.scheduledAt > joinedAt
          && room.state.prepareId
          && room.prepareMaxDeadline > joinedAt) {
          room.prepareParticipants.add(ws.clientId);
          const status = ensureDeviceStatus(room, ws.clientId, joinedAt);
          room.deviceStatus.set(ws.clientId, {
            ...status,
            prepareId: room.state.prepareId,
            bufferContractPrepareId: "",
            bufferedSeconds: 0,
            bufferGoalSeconds: 0,
            bufferState: "loading",
            updatedAt: joinedAt,
            extensionBufferedSeconds: 0,
            extensionProgress: 0,
          });
          room.state.playing = false;
          room.state.preparing = true;
          room.state.scheduledAt = 0;
          room.state.prepareError = "";
          room.state.updatedAt = joinedAt;
          room.prepareDeadline = Math.min(
            room.prepareMaxDeadline,
            joinedAt + room.playbackPrepareTimeoutMs,
          );
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
      if (action === "device-status") {
        const prepareId = String(message.prepareId || "");
        if (prepareId && prepareId !== state.prepareId) return;
        if (state.preparing && (!prepareId || !room.prepareParticipants.has(ws.clientId))) return;
        updateDeviceStatus(room, ws.clientId, message, now, true);
        return;
      }
      if (action === "ready") {
        const prepareId = String(message.prepareId || "");
        if (!prepareId || prepareId !== state.prepareId || !room.prepareParticipants.has(ws.clientId)) return;
        const deviceStatus = updateDeviceStatus(room, ws.clientId, message, now);
        const hasBufferFields = Object.hasOwn(message, "bufferedSeconds")
          || Object.hasOwn(message, "bufferGoalSeconds");
        const hasBufferContract = hasBufferFields
          || deviceStatus.bufferContractPrepareId === prepareId;
        const bufferReady = !hasBufferContract
          || (deviceStatus.bufferGoalSeconds > 0
            && deviceStatus.bufferedSeconds + 0.05 >= deviceStatus.bufferGoalSeconds);
        const ready = message.ready !== false && bufferReady;
        if (!state.preparing) {
          if (!ready && state.playing && state.scheduledAt > now) {
            room.readyClients.delete(ws.clientId);
            room.readyTiming.delete(ws.clientId);
            if (!room.prepareMaxDeadline || now >= room.prepareMaxDeadline) {
              cancelPlaybackPreparation(room, now, "timeout", [ws.clientId]);
              state.revision += 1;
              broadcastRoom(room);
              return;
            }
            state.playing = false;
            state.preparing = true;
            state.scheduledAt = 0;
            state.prepareError = "";
            state.updatedAt = now;
            room.prepareDeadline = Math.min(
              room.prepareMaxDeadline,
              now + room.playbackPrepareTimeoutMs,
            );
            room.prepareErrorClientIds = [];
            room.deviceStatus.set(ws.clientId, {
              ...deviceStatus,
              prepareId,
              bufferState: deviceStatus.bufferState || "buffering",
              updatedAt: now,
              extensionBufferedSeconds: 0,
              extensionProgress: 0,
            });
            state.revision += 1;
            broadcastRoom(room);
          }
          return;
        }
        if (!ready) {
          const wasReady = room.readyClients.delete(ws.clientId);
          room.readyTiming.delete(ws.clientId);
          room.deviceStatus.set(ws.clientId, {
            ...deviceStatus,
            bufferState: message.ready === false
              ? deviceStatus.bufferState || "buffering"
              : deviceStatus.bufferState,
            extensionBufferedSeconds: 0,
            extensionProgress: 0,
          });
          if (wasReady) {
            state.revision += 1;
            broadcastRoom(room);
          }
          return;
        }
        if (room.readyClients.has(ws.clientId)) {
          room.readyTiming.set(ws.clientId, {
            latencyMs: deviceStatus.latencyMs,
            jitterMs: deviceStatus.jitterMs,
          });
          return;
        }
        room.readyClients.add(ws.clientId);
        room.readyTiming.set(ws.clientId, {
          latencyMs: deviceStatus.latencyMs,
          jitterMs: deviceStatus.jitterMs,
        });
        room.deviceStatus.set(ws.clientId, {
          ...deviceStatus,
          bufferState: "ready",
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
          cancelPlaybackPreparation(room, now, "start_failed", [ws.clientId]);
          state.revision += 1;
          broadcastRoom(room);
        }
        return;
      }
      if (room.leaderId !== ws.clientId) {
        send(ws, { type: "error", code: "leader_only" });
        return;
      }

      if (action === "device-calibration") {
        const targetClientId = typeof message.targetClientId === "string"
          ? message.targetClientId
          : "";
        const target = [...room.clients].find((client) => client.clientId === targetClientId);
        if (!target) {
          send(ws, { type: "error", code: "device_not_found" });
          return;
        }
        const calibration = validDeviceCalibration(message.volumeTrimDb, message.delayMs);
        if (!calibration) {
          send(ws, { type: "error", code: "invalid_calibration" });
          return;
        }
        const targetStatus = ensureDeviceStatus(room, targetClientId, now);
        room.deviceStatus.set(targetClientId, {
          ...targetStatus,
          volumeTrimDb: calibration.volumeTrimDb,
          delayMs: calibration.delayMs,
          calibrationRevision: targetStatus.calibrationRevision + 1,
          explicitCalibration: true,
          updatedAt: now,
        });
        broadcastRoom(room);
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
        resetDeviceTrackStatus(room, now, true);
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
        resetDeviceTrackStatus(room, now, true);
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
      if (room.state.preparing
        && ((room.prepareDeadline && now >= room.prepareDeadline)
          || (room.prepareMaxDeadline && now >= room.prepareMaxDeadline))) {
        cancelPlaybackPreparation(room, now, "timeout");
        room.state.revision += 1;
      } else if (!room.state.preparing
        && room.state.playing
        && room.state.scheduledAt
        && now > room.state.scheduledAt + room.playbackPrepareCompletionRetentionMs
        && room.prepareMaxDeadline) {
        room.readyClients.clear();
        room.readyTiming.clear();
        room.prepareParticipants.clear();
        room.prepareDeadline = 0;
        room.prepareMaxDeadline = 0;
        room.prepareStartedAt = 0;
        room.state.prepareId = "";
        resetDeviceTrackStatus(room, now);
      }
      broadcastRoom(room);
    }
  }, Math.max(20, Number(roomBroadcastIntervalMs) || ROOM_BROADCAST_INTERVAL_MS));
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
