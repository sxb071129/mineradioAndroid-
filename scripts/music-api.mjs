import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createKugouProvider } from "./kugou-provider.mjs";

const require = createRequire(import.meta.url);
const netease = require("NeteaseCloudMusicApi");

const DEFAULT_PORT = Number(process.env.MINERADIO_MUSIC_PORT || 8790);
const DEFAULT_HOST = process.env.MINERADIO_MUSIC_HOST || "0.0.0.0";
const WEB_PORT = String(process.env.MINERADIO_WEB_PORT || 3000);
const SONG_ID_RE = /^[1-9]\d{0,19}$/;
const PLAY_KEY_RE = /^[a-f0-9]{24}$/;
const PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const KUGOU_HASH_RE = /^[A-Fa-f0-9]{32}$/;
const QR_TTL_MS = 10 * 60 * 1000;
const STREAM_URL_TTL_MS = 5 * 60 * 1000;
const KUGOU_TRACK_TTL_MS = 24 * 60 * 60 * 1000;
const PROVIDER_TIMEOUT_MS = 12_000;
const QUALITY_LEVELS = ["jymaster", "hires", "lossless", "exhigh", "standard"];
const QUALITY_SET = new Set(QUALITY_LEVELS);
const NETEASE_QUALITY_CANDIDATES = [
  { level: "jymaster", br: 1_999_000 },
  { level: "hires", br: 1_999_000 },
  { level: "lossless", br: 1_411_000 },
  { level: "exhigh", br: 999_000 },
  { level: "standard", br: 128_000 },
];

function defaultDataDir() {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Mineradio", "accounts");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Mineradio", "accounts");
  }
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "mineradio", "accounts");
}

const DEFAULT_DATA_DIR = defaultDataDir();

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function responseBody(value) {
  return value?.body || value || {};
}

function normalizeCookie(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || "").split(";")[0].trim())
      .filter(Boolean)
      .join("; ");
  }
  if (value && typeof value === "object") {
    return Object.entries(value)
      .filter(([, item]) => item != null && item !== "")
      .map(([key, item]) => `${key}=${item}`)
      .join("; ");
  }
  const ignoredAttributes = new Set([
    "domain",
    "expires",
    "httponly",
    "max-age",
    "path",
    "samesite",
    "secure",
  ]);
  return String(value || "")
    .split(";")
    .map((item) => item.trim())
    .filter((item) => {
      const separator = item.indexOf("=");
      if (separator <= 0) return false;
      return !ignoredAttributes.has(item.slice(0, separator).trim().toLowerCase());
    })
    .join("; ");
}

function cookieFromResponse(value) {
  const body = responseBody(value);
  const candidates = [
    value?.cookie,
    body.cookie,
    body.data?.cookie,
    body.data?.cookies,
  ];
  for (const candidate of candidates) {
    const cookie = normalizeCookie(candidate);
    if (cookie) return cookie;
  }
  return "";
}

function mapSong(song) {
  const artists = (song?.ar || song?.artists || []).map((artist) => ({
    id: artist?.id || "",
    name: artist?.name || "",
  }));
  const album = song?.al || song?.album || {};
  return {
    provider: "netease",
    source: "netease",
    type: "song",
    id: String(song?.id || ""),
    name: String(song?.name || "未命名歌曲"),
    artist: artists.map((artist) => artist.name).filter(Boolean).join(" / "),
    artists,
    artistId: artists[0]?.id || "",
    album: String(album?.name || ""),
    cover: String(album?.picUrl || album?.coverUrl || ""),
    duration: Math.max(0, Number(song?.dt || song?.duration) || 0),
    fee: Number(song?.fee) || 0,
  };
}

function mapPlaylist(playlist) {
  return {
    id: String(playlist?.id || ""),
    name: String(playlist?.name || ""),
    cover: String(playlist?.picUrl || playlist?.coverImgUrl || ""),
    trackCount: Math.max(0, Number(playlist?.trackCount) || 0),
  };
}

function loginInfoFromResponse(value) {
  const body = responseBody(value);
  const data = body.data || body;
  const profile = data.profile || body.profile || {};
  const account = data.account || body.account || {};
  const userId = profile.userId || profile.id || account.id || "";
  if (!(userId || userId === 0)) return { loggedIn: false };
  return {
    loggedIn: true,
    userId: String(userId),
    nickname: String(profile.nickname || profile.userName || "网易云用户"),
    avatar: String(profile.avatarUrl || profile.avatar || ""),
  };
}

function isPrivateV4(hostname) {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isLanHostname(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    isPrivateV4(normalized) ||
    /^(?:fc|fd|fe8|fe9|fea|feb)/i.test(normalized)
  );
}

function isBlockedAddress(address) {
  const normalized = String(address || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (isPrivateV4(normalized)) return true;
  if (normalized.startsWith("::ffff:")) return isPrivateV4(normalized.slice(7));
  return (
    normalized === "::" ||
    normalized === "::1" ||
    /^(?:fc|fd|fe8|fe9|fea|feb)/i.test(normalized)
  );
}

async function assertSafeProviderUrl(value) {
  const resolved = new URL(value);
  if (!/^https?:$/.test(resolved.protocol) || resolved.username || resolved.password) {
    throw Object.assign(new Error("unsafe_provider_url"), { statusCode: 502 });
  }
  if (isIP(resolved.hostname)) {
    if (isBlockedAddress(resolved.hostname)) {
      throw Object.assign(new Error("unsafe_provider_url"), { statusCode: 502 });
    }
    return resolved;
  }
  const addresses = await lookup(resolved.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => isBlockedAddress(entry.address))) {
    throw Object.assign(new Error("unsafe_provider_url"), { statusCode: 502 });
  }
  return resolved;
}

async function withTimeout(promise, timeoutMs = PROVIDER_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error("provider_timeout"), { statusCode: 504 })),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchProviderStream(fetchImpl, validateUrl, value, init, redirects = 0) {
  const safeUrl = await validateUrl(value);
  const response = await fetchImpl(safeUrl, { ...init, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location || redirects >= 3) {
      throw Object.assign(new Error("provider_redirect_rejected"), { statusCode: 502 });
    }
    return fetchProviderStream(fetchImpl, validateUrl, new URL(location, safeUrl).toString(), init, redirects + 1);
  }
  return response;
}

function allowedOrigin(origin) {
  if (!origin) return "";
  try {
    const value = new URL(origin);
    if (value.protocol !== "http:" || value.port !== WEB_PORT) return "";
    return isLanHostname(value.hostname) ? value.origin : "";
  } catch {
    return "";
  }
}

function corsHeaders(origin, extra = {}) {
  const allowed = allowedOrigin(origin);
  return {
    ...(allowed ? { "Access-Control-Allow-Origin": allowed } : {}),
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "range,content-type",
    "Access-Control-Expose-Headers": "accept-ranges,content-length,content-range,x-mineradio-provider,x-mineradio-quality",
    "Cross-Origin-Resource-Policy": "cross-origin",
    Vary: "Origin",
    ...extra,
  };
}

function sendJson(req, res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(
    status,
    corsHeaders(req.headers.origin, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
    }),
  );
  res.end(body);
}

function publicError(error, fallback) {
  const message = String(error?.message || "");
  if (/timeout|timed out|abort/i.test(message)) return "third_party_timeout";
  if ([
    "track_unavailable",
    "track_trial_only",
    "track_key_expired",
    "kugou_login_required",
  ].includes(message)) return message;
  return fallback;
}

function validSongId(value) {
  const id = String(value || "");
  return SONG_ID_RE.test(id) ? id : "";
}

function validQuality(value, fallback = "hires") {
  const quality = String(value || fallback).trim().toLowerCase();
  return QUALITY_SET.has(quality) ? quality : "";
}

function validPlayKey(value) {
  const key = String(value || "").trim().toLowerCase();
  return PLAY_KEY_RE.test(key) ? key : "";
}

function safeAccountInfo(value, provider) {
  const info = value && typeof value === "object" ? value : {};
  return {
    provider,
    loggedIn: Boolean(info.loggedIn),
    userId: info.userId == null ? "" : String(info.userId).slice(0, 32),
    nickname: String(info.nickname || (provider === "kugou" ? "酷狗音乐" : "网易云音乐")).slice(0, 80),
    avatar: /^https:\/\//i.test(String(info.avatar || "")) ? String(info.avatar) : "",
    vipType: Math.max(0, Number(info.vipType) || 0),
    vipLevel: String(info.vipLevel || "none").slice(0, 16),
    isVip: Boolean(info.isVip),
    vipLabel: String(info.vipLabel || "").slice(0, 40),
    playbackKeyReady: Boolean(info.playbackKeyReady),
  };
}

function cleanKugouHash(value) {
  const hash = String(value || "").trim().toUpperCase();
  return KUGOU_HASH_RE.test(hash) ? hash : "";
}

function cleanProviderId(value) {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9_-]{0,64}$/.test(id) ? id : "";
}

function normalizeKugouTrack(raw) {
  const qualityHashes = {};
  for (const quality of QUALITY_LEVELS) {
    const hash = cleanKugouHash(raw?.qualityHashes?.[quality]);
    if (hash) qualityHashes[quality] = hash;
  }
  const hash = cleanKugouHash(raw?.hash) || Object.values(qualityHashes)[0] || "";
  if (!hash) return null;
  const descriptor = {
    hash,
    qualityHashes,
    albumAudioId: cleanProviderId(raw?.albumAudioId),
    albumId: cleanProviderId(raw?.albumId),
  };
  const playKey = createHash("sha256")
    .update(JSON.stringify(descriptor))
    .digest("hex")
    .slice(0, 24);
  return {
    descriptor,
    publicTrack: {
      provider: "kugou",
      source: "kugou",
      type: "song",
      id: playKey,
      playKey,
      name: String(raw?.name || "未命名歌曲").slice(0, 160),
      artist: String(raw?.artist || "").slice(0, 160),
      album: String(raw?.album || "").slice(0, 160),
      cover: /^https:\/\//i.test(String(raw?.cover || "")) ? String(raw.cover) : "",
      duration: Math.max(0, Number(raw?.duration) || 0),
      qualities: QUALITY_LEVELS.filter((quality) => Boolean(qualityHashes[quality])),
    },
  };
}

function pruneTimedMap(map, maxEntries) {
  const now = Date.now();
  for (const [key, value] of map) {
    const expiresAt = typeof value === "number" ? value : value?.expiresAt;
    if (!expiresAt || expiresAt <= now) map.delete(key);
  }
  while (map.size >= maxEntries) map.delete(map.keys().next().value);
}

async function readCookieFile(cookieFile) {
  try {
    return normalizeCookie(await readFile(cookieFile, "utf8"));
  } catch {
    return "";
  }
}

export async function createMusicApi({
  port = DEFAULT_PORT,
  host = DEFAULT_HOST,
  dataDir = DEFAULT_DATA_DIR,
  provider = netease,
  kugouProvider,
  fetchImpl = fetch,
  validateStreamUrl = assertSafeProviderUrl,
} = {}) {
  await mkdir(dataDir, { recursive: true });
  const cookieFile = path.join(dataDir, "netease.cookie");
  let userCookie = await readCookieFile(cookieFile);
  const qrKeys = new Map();
  const kugouQrKeys = new Map();
  const streamUrls = new Map();
  const kugouTracks = new Map();
  const kugou = kugouProvider || await createKugouProvider({
    authFile: path.join(dataDir, "kugou.auth.json"),
  });

  const callProvider = (name, options) => {
    if (typeof provider[name] !== "function") {
      return Promise.reject(Object.assign(new Error("provider_method_missing"), { statusCode: 502 }));
    }
    return withTimeout(Promise.resolve().then(() => provider[name](options)));
  };

  async function saveCookie(value) {
    userCookie = normalizeCookie(value);
    await writeFile(cookieFile, userCookie, { encoding: "utf8", mode: 0o600 });
  }

  async function getLoginInfo() {
    if (!userCookie) return { loggedIn: false };
    try {
      const value = await callProvider("login_status", {
        cookie: userCookie,
        timestamp: Date.now(),
      });
      const info = loginInfoFromResponse(value);
      if (info.loggedIn) return info;
    } catch {
      // Try the older account endpoint below.
    }
    try {
      const value = await callProvider("user_account", {
        cookie: userCookie,
        timestamp: Date.now(),
      });
      return loginInfoFromResponse(value);
    } catch {
      return { loggedIn: false };
    }
  }

  function registerKugouTracks(rawTracks) {
    const tracks = [];
    for (const raw of Array.isArray(rawTracks) ? rawTracks : []) {
      const normalized = normalizeKugouTrack(raw);
      if (!normalized) continue;
      pruneTimedMap(kugouTracks, 2048);
      kugouTracks.set(normalized.publicTrack.playKey, {
        ...normalized.descriptor,
        expiresAt: Date.now() + KUGOU_TRACK_TTL_MS,
      });
      tracks.push(normalized.publicTrack);
    }
    return tracks;
  }

  async function resolveNeteaseStream(songId, quality) {
    const candidates = NETEASE_QUALITY_CANDIDATES.slice(QUALITY_LEVELS.indexOf(quality));
    let lastData = null;
    for (const candidate of candidates) {
      let value;
      try {
        value = await callProvider("song_url_v1", {
          id: songId,
          level: candidate.level,
          cookie: userCookie || undefined,
        });
      } catch {
        try {
          value = await callProvider("song_url", {
            id: songId,
            br: candidate.br,
            cookie: userCookie || undefined,
          });
        } catch {
          continue;
        }
      }
      const data = responseBody(value).data?.[0] || {};
      lastData = data;
      if (data.url) return { url: data.url, level: candidate.level };
    }
    const reason = lastData?.freeTrialInfo ? "track_trial_only" : "track_unavailable";
    throw Object.assign(new Error(reason), { statusCode: 403 });
  }

  async function resolveKugouStream(playKey, quality) {
    const track = kugouTracks.get(playKey);
    if (!track || track.expiresAt <= Date.now()) {
      kugouTracks.delete(playKey);
      throw Object.assign(new Error("track_key_expired"), { statusCode: 404 });
    }
    track.expiresAt = Date.now() + KUGOU_TRACK_TTL_MS;
    const value = await withTimeout(kugou.resolveStream(track, quality));
    if (!value?.url) {
      const reason = value?.reason === "login_required" ? "kugou_login_required" : "track_unavailable";
      throw Object.assign(new Error(reason), { statusCode: 403 });
    }
    return { url: value.url, level: validQuality(value.level, quality) || quality };
  }

  async function resolveStream(providerName, sourceId, quality) {
    const cacheKey = `${providerName}:${sourceId}:${quality}`;
    const cached = streamUrls.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached;
    const value = providerName === "kugou"
      ? await resolveKugouStream(sourceId, quality)
      : await resolveNeteaseStream(sourceId, quality);
    const resolved = await validateStreamUrl(value.url);
    pruneTimedMap(streamUrls, 512);
    const entry = {
      url: resolved.toString(),
      level: value.level,
      expiresAt: Date.now() + STREAM_URL_TTL_MS,
    };
    streamUrls.set(cacheKey, entry);
    return entry;
  }

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || "/", "http://music.local");
    const origin = req.headers.origin;
    if (origin && !allowedOrigin(origin)) {
      sendJson(req, res, 403, { error: "origin_not_allowed" });
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(origin));
      res.end();
      return;
    }
    if (req.method !== "GET") {
      sendJson(req, res, 405, { error: "method_not_allowed" });
      return;
    }

    try {
      if (requestUrl.pathname === "/health") {
        sendJson(req, res, 200, {
          ok: true,
          providers: ["netease", "kugou"],
          neteaseLoggedIn: Boolean(userCookie),
        });
        return;
      }

      if (requestUrl.pathname === "/api/kugou/login/status") {
        sendJson(req, res, 200, safeAccountInfo(await withTimeout(kugou.loginStatus()), "kugou"));
        return;
      }

      if (requestUrl.pathname === "/api/kugou/login/qr/key") {
        const value = await withTimeout(kugou.loginQrKey());
        const key = String(value?.key || "").trim();
        const img = String(value?.img || "");
        const loginUrl = String(value?.url || "");
        const parsedLoginUrl = new URL(loginUrl);
        if (!/^[A-Za-z0-9._~-]{8,256}$/.test(key) ||
            !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(img) ||
            parsedLoginUrl.protocol !== "https:" || parsedLoginUrl.hostname !== "h5.kugou.com") {
          throw new Error("kugou_qr_invalid");
        }
        pruneTimedMap(kugouQrKeys, 32);
        kugouQrKeys.set(key, Date.now() + QR_TTL_MS);
        sendJson(req, res, 200, { provider: "kugou", key, img, url: parsedLoginUrl.toString() });
        return;
      }

      if (requestUrl.pathname === "/api/kugou/login/qr/check") {
        const key = String(requestUrl.searchParams.get("key") || "").trim();
        if (!kugouQrKeys.has(key) || kugouQrKeys.get(key) < Date.now()) {
          kugouQrKeys.delete(key);
          sendJson(req, res, 400, { provider: "kugou", loggedIn: false, code: 800, error: "invalid_qr_key" });
          return;
        }
        const value = await withTimeout(kugou.loginQrCheck(key));
        const code = Number(value?.code) || 0;
        if (code === 800 || code === 803) kugouQrKeys.delete(key);
        sendJson(req, res, 200, {
          ...safeAccountInfo(value, "kugou"),
          code,
          status: Number(value?.status) || 0,
          message: String(value?.message || "").slice(0, 160),
        });
        return;
      }

      if (requestUrl.pathname === "/api/kugou/logout") {
        await withTimeout(kugou.logout());
        kugouTracks.clear();
        for (const key of streamUrls.keys()) {
          if (key.startsWith("kugou:")) streamUrls.delete(key);
        }
        sendJson(req, res, 200, { provider: "kugou", ok: true, loggedIn: false });
        return;
      }

      if (requestUrl.pathname === "/api/kugou/user/playlists") {
        const value = await withTimeout(kugou.userPlaylists());
        const playlists = (Array.isArray(value?.playlists) ? value.playlists : [])
          .map((item) => ({
            provider: "kugou",
            id: String(item?.id || "").slice(0, 64),
            name: String(item?.name || "酷狗歌单").slice(0, 160),
            cover: /^https:\/\//i.test(String(item?.cover || "")) ? String(item.cover) : "",
            trackCount: Math.max(0, Number(item?.trackCount) || 0),
          }))
          .filter((item) => PLAYLIST_ID_RE.test(item.id));
        sendJson(req, res, 200, {
          ...safeAccountInfo(value, "kugou"),
          playlists: playlists.slice(0, 100),
        });
        return;
      }

      if (requestUrl.pathname === "/api/kugou/playlist/tracks") {
        const playlistId = String(requestUrl.searchParams.get("id") || "").trim();
        if (!PLAYLIST_ID_RE.test(playlistId)) {
          sendJson(req, res, 400, { error: "invalid_playlist_id", tracks: [] });
          return;
        }
        const value = await withTimeout(kugou.playlistTracks(playlistId));
        sendJson(req, res, 200, {
          ...safeAccountInfo(value, "kugou"),
          playlist: {
            provider: "kugou",
            id: playlistId,
            name: String(value?.playlist?.name || "酷狗歌单").slice(0, 160),
            trackCount: Math.max(0, Number(value?.playlist?.trackCount) || 0),
          },
          tracks: registerKugouTracks(value?.tracks).slice(0, 500),
        });
        return;
      }

      if (requestUrl.pathname === "/api/search") {
        const keywords = String(requestUrl.searchParams.get("keywords") || "").trim().slice(0, 80);
        if (!keywords) {
          sendJson(req, res, 400, { error: "keywords_required", songs: [] });
          return;
        }
        const limit = clamp(requestUrl.searchParams.get("limit") || 16, 1, 30);
        const value = await callProvider("cloudsearch", {
          keywords,
          limit,
          cookie: userCookie || undefined,
        });
        const songs = responseBody(value).result?.songs || [];
        sendJson(req, res, 200, {
          provider: "netease",
          songs: songs.map(mapSong).filter((song) => validSongId(song.id)),
        });
        return;
      }

      if (requestUrl.pathname === "/api/discover/home") {
        const info = await getLoginInfo();
        if (!info.loggedIn) {
          sendJson(req, res, 200, {
            loggedIn: false,
            user: null,
            dailySongs: [],
            playlists: [],
            updatedAt: Date.now(),
          });
          return;
        }
        const [songResult, resourceResult] = await Promise.allSettled([
          callProvider("recommend_songs", { cookie: userCookie, timestamp: Date.now() }),
          callProvider("recommend_resource", { cookie: userCookie, timestamp: Date.now() }),
        ]);
        const songBody = songResult.status === "fulfilled" ? responseBody(songResult.value) : {};
        const resourceBody = resourceResult.status === "fulfilled" ? responseBody(resourceResult.value) : {};
        const rawSongs = songBody.data?.dailySongs || songBody.data?.recommend || songBody.recommend || [];
        const rawPlaylists = resourceBody.recommend || resourceBody.data || [];
        sendJson(req, res, 200, {
          loggedIn: true,
          user: info,
          dailySongs: rawSongs.map(mapSong).filter((song) => validSongId(song.id)).slice(0, 20),
          playlists: rawPlaylists.map(mapPlaylist).filter((item) => item.id && item.name).slice(0, 12),
          updatedAt: Date.now(),
        });
        return;
      }

      if (requestUrl.pathname === "/api/login/status") {
        sendJson(req, res, 200, await getLoginInfo());
        return;
      }

      if (requestUrl.pathname === "/api/login/qr/key") {
        const value = await callProvider("login_qr_key", { timestamp: Date.now() });
        const key = String(responseBody(value).data?.unikey || "");
        if (!key) throw new Error("qr_key_failed");
        pruneTimedMap(qrKeys, 32);
        qrKeys.set(key, Date.now() + QR_TTL_MS);
        sendJson(req, res, 200, { key });
        return;
      }

      if (requestUrl.pathname === "/api/login/qr/create") {
        const key = String(requestUrl.searchParams.get("key") || "");
        if (!qrKeys.has(key) || qrKeys.get(key) < Date.now()) {
          sendJson(req, res, 400, { error: "invalid_qr_key" });
          return;
        }
        const value = await callProvider("login_qr_create", { key, qrimg: true, timestamp: Date.now() });
        const data = responseBody(value).data || {};
        sendJson(req, res, 200, { img: String(data.qrimg || ""), url: String(data.qrurl || "") });
        return;
      }

      if (requestUrl.pathname === "/api/login/qr/check") {
        const key = String(requestUrl.searchParams.get("key") || "");
        if (!qrKeys.has(key) || qrKeys.get(key) < Date.now()) {
          qrKeys.delete(key);
          sendJson(req, res, 400, { error: "invalid_qr_key", code: 800 });
          return;
        }
        let value = await callProvider("login_qr_check", { key, noCookie: true, timestamp: Date.now() });
        let body = responseBody(value);
        const code = Number(body.code || value?.code) || 0;
        if (code === 803) {
          let cookie = cookieFromResponse(value);
          if (!cookie) {
            value = await callProvider("login_qr_check", { key, timestamp: Date.now() });
            body = responseBody(value);
            cookie = cookieFromResponse(value);
          }
          if (cookie) await saveCookie(cookie);
          qrKeys.delete(key);
        }
        sendJson(req, res, 200, {
          code,
          message: String(body.message || value?.message || ""),
          ...(code === 803 ? await getLoginInfo() : {}),
        });
        return;
      }

      if (requestUrl.pathname === "/api/logout") {
        if (userCookie) {
          try {
            await callProvider("logout", { cookie: userCookie });
          } catch {
            // Local logout must still clear the stored credential.
          }
        }
        await saveCookie("");
        sendJson(req, res, 200, { ok: true });
        return;
      }

      if (requestUrl.pathname === "/api/stream") {
        const providerName = String(requestUrl.searchParams.get("provider") || "netease").toLowerCase();
        const quality = validQuality(requestUrl.searchParams.get("quality"), "hires");
        const sourceId = providerName === "kugou"
          ? validPlayKey(requestUrl.searchParams.get("id"))
          : validSongId(requestUrl.searchParams.get("id"));
        if (!quality) {
          sendJson(req, res, 400, { error: "invalid_quality" });
          return;
        }
        if (!sourceId || !["netease", "kugou"].includes(providerName)) {
          sendJson(req, res, 400, {
            error: providerName === "kugou" ? "invalid_play_key" : "invalid_song_id",
          });
          return;
        }
        const stream = await resolveStream(providerName, sourceId, quality);
        const upstream = await fetchProviderStream(fetchImpl, validateStreamUrl, stream.url, {
          headers: {
            Accept: "*/*",
            Referer: providerName === "kugou" ? "https://www.kugou.com/" : "https://music.163.com/",
            "User-Agent": "MR-ROOM/1.0",
            ...(req.headers.range ? { Range: req.headers.range } : {}),
          },
          signal: AbortSignal.timeout(15_000),
        });
        if (!upstream.ok || !upstream.body) {
          streamUrls.delete(`${providerName}:${sourceId}:${quality}`);
          sendJson(req, res, 502, { error: "provider_stream_failed" });
          return;
        }
        const headers = corsHeaders(origin, {
          "Content-Type": upstream.headers.get("content-type") || "audio/mpeg",
          "Accept-Ranges": upstream.headers.get("accept-ranges") || "bytes",
          "X-Mineradio-Provider": providerName,
          "X-Mineradio-Quality": stream.level,
          "Cache-Control": "private, max-age=300",
        });
        for (const name of ["content-length", "content-range"]) {
          const value = upstream.headers.get(name);
          if (value) headers[name] = value;
        }
        res.writeHead(upstream.status, headers);
        await pipeline(Readable.fromWeb(upstream.body), res);
        return;
      }

      sendJson(req, res, 404, { error: "not_found" });
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(req, res, error?.statusCode || 502, {
        error: publicError(error, "third_party_unavailable"),
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  return {
    server,
    port: server.address().port,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const currentFile = fileURLToPath(import.meta.url);
const isMain =
  process.argv[1] &&
  path.resolve(currentFile) === path.resolve(fileURLToPath(pathToFileURL(process.argv[1])));

if (isMain) {
  const musicApi = await createMusicApi();
  console.log(`Mineradio music API listening on http://localhost:${musicApi.port}`);
  console.log("Providers: NetEase Cloud Music + Kugou Music (restricted local adapters)");
}
