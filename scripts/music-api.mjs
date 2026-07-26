import { createRequire } from "node:module";
import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDescriptorStore } from "./descriptor-store.mjs";
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
const STREAM_CONNECT_TIMEOUT_MS = 15_000;
const MAX_PREPARE_BODY_BYTES = 8 * 1024;
const MAX_KUGOU_COOKIE_BODY_BYTES = 36 * 1024;
const MAX_LYRIC_BYTES = 512 * 1024;
const MAX_LYRIC_LINES = 5_000;
const MAX_USER_PLAYLISTS = 100;
const MAX_PLAYLIST_TRACKS = 500;
const MAX_LIKE_CHECK_IDS = 500;
const MAX_ARTIST_SONGS = 50;
const MAX_SONG_COMMENTS = 30;
const MAX_PLAYLIST_NAME_CHARS = 40;
const MAX_PODCAST_RESULTS = 30;
const MAX_PODCAST_PROGRAMS = 60;
const MAX_PODCAST_KEYWORDS = 80;
const MAX_PODCAST_OFFSET = 10_000;
const PODCAST_COLLECTION_KEYS = new Set(["collect", "created", "liked"]);
const APPLICATION_HEADER = "x-mineradio-application";
const APPLICATION_ID = "mineradio-web-v1";
const CORS_METHODS = ["GET", "POST", "OPTIONS"];
const CORS_HEADERS = ["content-type", "range", APPLICATION_HEADER];
const RETRYABLE_STREAM_STATUSES = new Set([401, 403, 404, 410]);
const RESTRICTION_CODES = new Set([
  "login_required",
  "stale_session",
  "device_registration_failed",
  "paid_required",
  "copyright_unavailable",
  "region_restricted",
  "quality_unavailable",
  "stream_host_rejected",
  "provider_contract_changed",
  "provider_unavailable",
]);
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

function safeHttpsImage(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 2_048) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function cleanPublicText(value, maxLength) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, maxLength);
}

function mapUserPlaylist(playlist) {
  return {
    provider: "netease",
    source: "netease",
    id: String(playlist?.id || ""),
    name: cleanPublicText(playlist?.name, 160),
    cover: safeHttpsImage(playlist?.picUrl || playlist?.coverImgUrl),
    trackCount: Math.max(0, Math.min(1_000_000, Number(playlist?.trackCount) || 0)),
    subscribed: Boolean(playlist?.subscribed),
    specialType: Math.max(0, Math.min(10_000, Number(playlist?.specialType) || 0)),
  };
}

function mapArtist(artist, fallbackId) {
  const id = validSongId(artist?.id) || fallbackId;
  return {
    id,
    name: cleanPublicText(artist?.name, 160),
    avatar: safeHttpsImage(
      artist?.cover || artist?.avatar || artist?.picUrl || artist?.img1v1Url,
    ),
    description: cleanPublicText(artist?.briefDesc || artist?.description, 2_000),
    aliases: (Array.isArray(artist?.alias) ? artist.alias : [])
      .map((item) => cleanPublicText(item, 80))
      .filter(Boolean)
      .slice(0, 12),
  };
}

function mapComment(comment) {
  const user = comment?.user || {};
  const rawTime = Number(comment?.time);
  const rawLikedCount = Number(comment?.likedCount);
  return {
    id: validSongId(comment?.commentId || comment?.id),
    content: cleanPublicText(comment?.content, 2_000),
    time: Number.isSafeInteger(rawTime) && rawTime >= 0 ? rawTime : 0,
    likedCount: Number.isSafeInteger(rawLikedCount) && rawLikedCount >= 0
      ? Math.min(rawLikedCount, 1_000_000_000)
      : 0,
    user: {
      userId: validSongId(user?.userId || user?.id),
      nickname: cleanPublicText(user?.nickname, 80),
      avatar: safeHttpsImage(user?.avatarUrl || user?.avatar),
    },
  };
}

function cleanPodcastText(value, maxLength) {
  return cleanPublicText(value, maxLength * 2)
    .replace(/https?:\/\/[^\s<>"']+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, maxLength);
}

function boundedPublicInteger(value, max = 1_000_000_000) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? Math.min(number, max) : 0;
}

function boundedPodcastQueryInteger(value, fallback, min, max) {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  if (!/^\d{1,10}$/.test(raw)) return fallback;
  return Math.max(min, Math.min(max, Number(raw)));
}

function mapPodcastArtists(value) {
  return (Array.isArray(value) ? value : [])
    .map((artist) => ({
      id: validSongId(artist?.id),
      name: cleanPodcastText(artist?.name, 160),
    }))
    .filter((artist) => artist.name)
    .slice(0, 12);
}

function mapPodcastRadio(value) {
  const radio = value && typeof value === "object" ? value : {};
  const dj = radio.dj || radio.djSimple || radio.djUser || radio.creator || {};
  const id = validSongId(radio.id || radio.rid || radio.radioId);
  return {
    provider: "netease",
    id,
    rid: id,
    name: cleanPodcastText(radio.name || radio.radioName, 160),
    cover: safeHttpsImage(
      radio.picUrl || radio.picURL || radio.coverUrl || radio.coverImgUrl || radio.avatarUrl,
    ),
    desc: cleanPodcastText(radio.desc || radio.description || radio.rcmdText, 2_000),
    djName: cleanPodcastText(dj.nickname || radio.djName || radio.nickname, 80),
    category: cleanPodcastText(radio.category || radio.categoryName, 80),
    programCount: boundedPublicInteger(
      radio.programCount || radio.programNum || radio.programCnt,
      10_000_000,
    ),
    subCount: boundedPublicInteger(
      radio.subCount || radio.subedCount || radio.subscriberCount,
      1_000_000_000,
    ),
  };
}

function mapPodcastProgram(value, fallbackRadio = {}) {
  const program = value && typeof value === "object" ? value : {};
  const mainSong = program.mainSong || program.song || program.mainTrack || {};
  const radio = mapPodcastRadio(program.radio || fallbackRadio);
  const artists = mapPodcastArtists(mainSong.ar || mainSong.artists);
  const album = mainSong.al || mainSong.album || {};
  const dj = program.dj || program.radio?.dj || {};
  const playableId = validSongId(
    mainSong.id || program.mainSongId || program.mainTrackId || program.songId,
  );
  const programId = validSongId(program.id || program.programId || program.voiceId);
  return {
    provider: "netease",
    type: "podcast",
    source: "podcast",
    id: playableId,
    programId,
    radioId: radio.id,
    name: cleanPodcastText(program.name || mainSong.name, 200),
    artist: cleanPodcastText(
      radio.name || dj.nickname || artists.map((artist) => artist.name).join(" / ") || radio.djName,
      200,
    ),
    artists,
    artistId: artists[0]?.id || "",
    album: cleanPodcastText(radio.name || album.name || "Podcast", 200),
    cover: safeHttpsImage(
      program.coverUrl || program.cover || program.blurCoverUrl || radio.cover || album.picUrl,
    ),
    duration: boundedPublicInteger(program.duration || mainSong.dt || mainSong.duration, 604_800_000),
    fee: boundedPublicInteger(mainSong.fee, 10_000),
    djName: cleanPodcastText(radio.djName || dj.nickname, 80),
    radioName: radio.name,
    desc: cleanPodcastText(program.description || program.desc, 2_000),
    createTime: boundedPublicInteger(program.createTime, Number.MAX_SAFE_INTEGER),
    serialNum: boundedPublicInteger(program.serialNum || program.serial, 10_000_000),
  };
}

function firstArrayFrom(value, keys) {
  if (Array.isArray(value)) return value;
  const source = value && typeof value === "object" ? value : {};
  for (const key of keys) {
    const candidate = source[key];
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === "object") {
      for (const nestedKey of ["list", "data", "resources", "items", "programs", "djRadios"]) {
        if (Array.isArray(candidate[nestedKey])) return candidate[nestedKey];
      }
    }
  }
  return [];
}

function mapPodcastVoice(value) {
  const wrapper = value && typeof value === "object" ? value : {};
  const voice = wrapper.resource || wrapper.voice || wrapper.data || wrapper.program || wrapper;
  const mainSong = voice.mainSong || voice.song || voice.track || {};
  const baseInfo = voice.baseInfo || {};
  const radio = voice.radio || voice.djRadio || voice.voiceList || voice.podcast || {};
  const playableId = validSongId(
    voice.trackId || voice.mainTrackId || voice.songId || voice.mainSongId ||
      baseInfo.mainTrackId || baseInfo.resourceId || mainSong.id || voice.resourceId || voice.id,
  );
  const programId = validSongId(voice.programId || voice.voiceId || voice.id || voice.resourceId);
  const radioId = validSongId(
    radio.id || radio.radioId || radio.voiceListId || voice.radioId || voice.voiceListId,
  );
  const radioName = cleanPodcastText(
    radio.name || radio.radioName || radio.voiceListName || voice.podcastName,
    200,
  );
  return {
    provider: "netease",
    type: "podcast",
    source: "podcast",
    sourceType: "podcast-voice",
    id: playableId,
    programId,
    radioId,
    name: cleanPodcastText(voice.name || voice.songName || voice.title || mainSong.name, 200),
    artist: cleanPodcastText(radioName || voice.djName || "Voice", 200),
    album: cleanPodcastText(radioName || "Podcast", 200),
    cover: safeHttpsImage(
      voice.coverUrl || voice.cover || voice.picUrl || voice.coverImgUrl || radio.picUrl || radio.coverUrl,
    ),
    duration: boundedPublicInteger(
      voice.duration || voice.durationMs || mainSong.dt || mainSong.duration,
      604_800_000,
    ),
    djName: cleanPodcastText(voice.djName || radio.dj?.nickname, 80),
    radioName,
    desc: cleanPodcastText(voice.desc || voice.description, 2_000),
  };
}

function mapPodcastCollectionRadio(value, key) {
  const radio = mapPodcastRadio(value);
  return {
    ...radio,
    type: "podcast-radio",
    sourceType: "podcast-radio",
    collectionKey: PODCAST_COLLECTION_KEYS.has(key) ? key : "",
    radioId: radio.id,
    artist: radio.djName || radio.category || "Podcast",
    album: radio.category || "Podcast",
  };
}

function podcastCollectionMeta(key, items) {
  const metadata = {
    collect: { key: "collect", title: "收藏播客", sub: "你收藏的播客", itemType: "radio" },
    created: { key: "created", title: "创建播客", sub: "你创建的播客", itemType: "radio" },
    liked: { key: "liked", title: "喜欢的声音", sub: "收藏或最近喜欢的声音", itemType: "voice" },
  }[key];
  const safeItems = Array.isArray(items) ? items : [];
  return {
    ...metadata,
    count: safeItems.length,
    cover: safeHttpsImage(safeItems[0]?.cover),
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

async function fetchProviderStream(
  fetchImpl,
  validateUrl,
  value,
  init,
  redirects = 0,
  connectTimeoutMs = STREAM_CONNECT_TIMEOUT_MS,
) {
  const safeUrl = await validateUrl(value);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(Object.assign(new Error("provider_timeout"), { statusCode: 504 })),
    Math.max(1, Number(connectTimeoutMs) || STREAM_CONNECT_TIMEOUT_MS),
  );
  timeout.unref?.();
  let response;
  try {
    response = await fetchImpl(safeUrl, {
      ...init,
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw Object.assign(new Error("provider_timeout"), { statusCode: 504 });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location || redirects >= 3) {
      throw Object.assign(new Error("provider_redirect_rejected"), { statusCode: 502 });
    }
    return fetchProviderStream(
      fetchImpl,
      validateUrl,
      new URL(location, safeUrl).toString(),
      init,
      redirects + 1,
      connectTimeoutMs,
    );
  }
  return response;
}

function allowedOrigin(origin) {
  if (!origin) return "";
  try {
    const raw = String(origin);
    const value = new URL(raw);
    if (raw !== value.origin || value.protocol !== "http:" || value.port !== WEB_PORT) return "";
    return isLanHostname(value.hostname) ? value.origin : "";
  } catch {
    return "";
  }
}

function corsHeaders(origin, extra = {}) {
  const allowed = allowedOrigin(origin);
  return {
    ...(allowed ? { "Access-Control-Allow-Origin": allowed } : {}),
    "Access-Control-Allow-Methods": CORS_METHODS.join(","),
    "Access-Control-Allow-Headers": CORS_HEADERS.join(","),
    "Access-Control-Expose-Headers": "accept-ranges,content-length,content-range,x-mineradio-provider,x-mineradio-quality",
    "Cross-Origin-Resource-Policy": "cross-origin",
    Vary: "Origin",
    ...extra,
  };
}

function preflightError(req) {
  const requestedMethod = String(req.headers["access-control-request-method"] || "").trim();
  if (requestedMethod && !CORS_METHODS.includes(requestedMethod)) return "cors_method_not_allowed";
  const requestedHeaders = String(req.headers["access-control-request-headers"] || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (requestedHeaders.some((value) => !CORS_HEADERS.includes(value))) {
    return "cors_headers_not_allowed";
  }
  return "";
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
    "invalid_json",
    "request_body_too_large",
  ].includes(message) || RESTRICTION_CODES.has(message)) return message;
  return fallback;
}

function restrictionMessage(category) {
  return {
    login_required: "Kugou login is required",
    stale_session: "Kugou session is stale",
    device_registration_failed: "Kugou device registration failed",
    paid_required: "Account playback rights are required",
    copyright_unavailable: "Track is unavailable for copyright reasons",
    region_restricted: "Track is unavailable in this region",
    quality_unavailable: "Requested quality is unavailable",
    stream_host_rejected: "Provider stream host was rejected",
    provider_contract_changed: "Provider response is unsupported",
    provider_unavailable: "Provider is unavailable",
  }[category] || "Provider playback is unavailable";
}

function sanitizedRestriction(value, fallback = "provider_unavailable") {
  const rawCategory = String(value?.category || value?.reason || fallback).toLowerCase();
  const safeFallback = RESTRICTION_CODES.has(fallback) ? fallback : "provider_unavailable";
  const category = RESTRICTION_CODES.has(rawCategory) ? rawCategory : safeFallback;
  const actions = new Set(["login", "retry", "upgrade", "none", "change_quality"]);
  const directAction = value?.restriction?.action ?? value?.action;
  const finalAction = actions.has(directAction)
    ? directAction
    : (category === "login_required" || category === "stale_session" ? "login"
      : (category === "quality_unavailable" ? "change_quality"
        : (["provider_unavailable", "provider_contract_changed", "device_registration_failed"].includes(category)
          ? "retry"
          : "none")));
  const codeValue = Number(value?.restriction?.code ?? value?.code);
  return {
    category,
    code: Number.isSafeInteger(codeValue) && codeValue >= 0 && codeValue <= 999_999 ? codeValue : 0,
    action: finalAction,
    message: restrictionMessage(category),
  };
}

function streamRestrictionError(restriction, statusCode = 403) {
  const error = Object.assign(new Error(restriction.category), {
    statusCode,
    restriction,
  });
  return error;
}

function errorPayload(error, fallback = "third_party_unavailable") {
  const code = publicError(error, fallback);
  if (error?.restriction) {
    return { error: code, restriction: sanitizedRestriction(error.restriction, code) };
  }
  return { error: code };
}

function requestHasBody(req) {
  const contentLength = req.headers["content-length"];
  if (contentLength !== undefined) {
    if (!/^\d+$/.test(String(contentLength))) return true;
    if (Number(contentLength) > 0) return true;
  }
  return req.headers["transfer-encoding"] !== undefined;
}

function drainRequest(req) {
  if (!req.readableEnded && !req.destroyed) req.resume();
}

function rejectRequest(req, res, status, error) {
  drainRequest(req);
  sendJson(req, res, status, { error });
}

function isJsonMediaType(value) {
  return /^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?\s*$/i.test(String(value || ""));
}

async function readBoundedJson(req, maxBytes = MAX_PREPARE_BODY_BYTES) {
  const tooLargeError = () => Object.assign(new Error("request_body_too_large"), {
    statusCode: 413,
    closeConnection: true,
  });
  const contentLength = String(req.headers["content-length"] || "");
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)) {
    req.shouldKeepAlive = false;
    drainRequest(req);
    throw tooLargeError();
  }
  const source = await new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
    };
    const fail = (error, { discard = false } = {}) => {
      cleanup();
      if (discard) {
        req.shouldKeepAlive = false;
        req.once("error", () => {});
        req.resume();
      }
      reject(error);
    };
    const onData = (chunk) => {
      received += chunk.length;
      if (received > maxBytes) {
        fail(tooLargeError(), { discard: true });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onError = () => fail(Object.assign(new Error("invalid_request_body"), { statusCode: 400 }));
    const onAborted = () => fail(Object.assign(new Error("invalid_request_body"), { statusCode: 400 }));
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
  });
  try {
    return JSON.parse(source);
  } catch {
    throw Object.assign(new Error("invalid_json"), { statusCode: 400 });
  }
}

function isPlainObject(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parsePrepareBody(value) {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.some((key) => !["provider", "trackRef", "id", "quality"].includes(key))) return null;
  if (value.provider !== "kugou") return null;
  if (Object.hasOwn(value, "trackRef") && Object.hasOwn(value, "id")) return null;
  const trackRef = validPlayKey(value.trackRef ?? value.id);
  const quality = validQuality(value.quality, "hires");
  if (!trackRef || !quality) return null;
  return { provider: "kugou", trackRef, quality };
}

function parseKugouCookieBody(value) {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  const field = keys.length === 1 && ["cookie", "data", "text"].includes(keys[0]) ? keys[0] : "";
  if (!field || typeof value[field] !== "string") return null;
  const cookie = value[field].trim();
  if (!cookie || Buffer.byteLength(cookie) > 32 * 1024) return null;
  return cookie;
}

function mutationFields(value, requestUrl, allowedKeys) {
  if (!isPlainObject(value)) return null;
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) return null;
  const fields = {};
  for (const key of allowedKeys) {
    fields[key] = Object.hasOwn(value, key) ? value[key] : requestUrl.searchParams.get(key);
  }
  return fields;
}

function parseLikeBody(value, requestUrl) {
  const fields = mutationFields(value, requestUrl, ["id", "like"]);
  if (!fields) return null;
  const id = validSongId(fields.id);
  const like = fields.like === true || fields.like === "true"
    ? true
    : (fields.like === false || fields.like === "false" ? false : null);
  return id && like !== null ? { id, like } : null;
}

function parsePlaylistCreateBody(value, requestUrl) {
  const fields = mutationFields(value, requestUrl, ["name"]);
  if (!fields || typeof fields.name !== "string") return null;
  const name = cleanPublicText(fields.name, MAX_PLAYLIST_NAME_CHARS + 1);
  if (!name || name.length > MAX_PLAYLIST_NAME_CHARS || Buffer.byteLength(name) > 160) return null;
  return { name };
}

function parsePlaylistAddBody(value, requestUrl) {
  const fields = mutationFields(value, requestUrl, ["pid", "id"]);
  if (!fields) return null;
  const pid = validSongId(fields.pid);
  const id = validSongId(fields.id);
  return pid && id ? { pid, id } : null;
}

function parseSongIds(value) {
  const raw = String(value || "");
  if (!raw) return [];
  const parts = raw.split(",");
  if (parts.length > MAX_LIKE_CHECK_IDS || parts.some((id) => !validSongId(id))) return null;
  return [...new Set(parts)];
}

function requireMutationIntent(req) {
  if (!req.headers.origin || !allowedOrigin(req.headers.origin)) return "origin_required";
  if (req.headers[APPLICATION_HEADER] !== APPLICATION_ID) return "application_header_required";
  return "";
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

function normalizeLyricText(value) {
  const normalized = String(value ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
  if (Buffer.byteLength(normalized) > MAX_LYRIC_BYTES) {
    throw Object.assign(new Error("provider_lyric_too_large"), { statusCode: 502 });
  }
  return normalized
    .replace(/https?:\/\/[^\s\]<>"']+/gi, "[redacted-url]")
    .replace(/\b[a-f0-9]{32}\b/gi, "[redacted-hash]")
    .replace(
      /((?:access[_-]?token|refresh[_-]?token|token|cookie|authorization)\s*[=:]\s*)[^\s\]]+/gi,
      "$1[redacted]",
    );
}

function lyricFields(value) {
  const body = responseBody(value);
  const lrc = typeof body?.lrc === "string" ? body.lrc : body?.lrc?.lyric;
  const translation = typeof body?.tlyric === "string" ? body.tlyric : body?.tlyric?.lyric;
  const enhanced = typeof body?.yrc === "string" ? body.yrc : body?.yrc?.lyric;
  return {
    lyric: normalizeLyricText(lrc ?? body?.lyric),
    tlyric: normalizeLyricText(translation),
    yrc: normalizeLyricText(enhanced),
  };
}

function parseLyricLines(lyric, yrc) {
  const lines = [];
  const addLine = (timeMs, durationMs, text) => {
    const safeTime = Math.round(Number(timeMs));
    const safeDuration = Math.max(0, Math.round(Number(durationMs) || 0));
    const safeText = String(text || "").trim();
    if (!safeText || !Number.isFinite(safeTime) || safeTime < 0 || safeTime > 24 * 60 * 60 * 1_000) return;
    lines.push({ timeMs: safeTime, durationMs: safeDuration, text: safeText.slice(0, 2_000) });
  };

  if (yrc) {
    for (const row of yrc.split("\n").slice(0, MAX_LYRIC_LINES * 2)) {
      const match = /^\[(\d{1,10}),(\d{1,10})\](.*)$/.exec(row.trim());
      if (!match) continue;
      addLine(match[1], match[2], match[3].replace(/\(\d{1,10},\d{1,10},\d{1,4}\)/g, ""));
      if (lines.length >= MAX_LYRIC_LINES) break;
    }
  }

  if (!lines.length && lyric) {
    for (const row of lyric.split("\n").slice(0, MAX_LYRIC_LINES * 2)) {
      const timestamps = [];
      const timestampPattern = /\[(\d{1,3}):(\d{1,2}(?:\.\d{1,3})?)\]/g;
      let match;
      while ((match = timestampPattern.exec(row)) && timestamps.length < 8) {
        const seconds = Number(match[1]) * 60 + Number(match[2]);
        if (Number.isFinite(seconds)) timestamps.push(Math.round(seconds * 1_000));
      }
      if (!timestamps.length) continue;
      const text = row.replace(timestampPattern, "").trim();
      for (const timeMs of timestamps) {
        addLine(timeMs, 0, text);
        if (lines.length >= MAX_LYRIC_LINES) break;
      }
      if (lines.length >= MAX_LYRIC_LINES) break;
    }
  }

  return lines
    .sort((left, right) => left.timeMs - right.timeMs)
    .slice(0, MAX_LYRIC_LINES);
}

function publicLyricPayload(providerName, id, value, source) {
  const fields = lyricFields(value);
  return {
    provider: providerName,
    id,
    ...fields,
    lines: parseLyricLines(fields.lyric, fields.yrc),
    source,
  };
}

function safeAccountInfo(value, provider) {
  const info = value && typeof value === "object" ? value : {};
  const numericUserId = /^\d{1,24}$/.test(String(info.userId ?? "")) ? String(info.userId) : "";
  const publicInfo = {
    provider,
    loggedIn: Boolean(info.loggedIn),
    userId: numericUserId,
    nickname: String(info.nickname || (provider === "kugou" ? "酷狗音乐" : "网易云音乐")).slice(0, 80),
    avatar: /^https:\/\//i.test(String(info.avatar || "")) ? String(info.avatar) : "",
    vipType: Math.max(0, Number(info.vipType) || 0),
    svipLevel: Math.max(0, Number(info.svipLevel) || 0),
    vipLevel: String(info.vipLevel || "none").slice(0, 16),
    isVip: Boolean(info.isVip),
    isSvip: Boolean(info.isSvip),
    vipLabel: String(info.vipLabel || "").slice(0, 40),
    playbackKeyReady: Boolean(info.playbackKeyReady),
  };
  if (provider === "kugou") {
    const validationStates = new Set(["unvalidated", "valid", "stale", "unavailable"]);
    const registrationStates = new Set(["unregistered", "registered", "failed"]);
    const restrictionCode = String(info.restrictionCode || "");
    Object.assign(publicInfo, {
      hasLocalSession: Boolean(info.hasLocalSession ?? info.loggedIn),
      accountValidated: Boolean(info.accountValidated),
      validationState: validationStates.has(info.validationState) ? info.validationState : "unvalidated",
      deviceRegistered: Boolean(info.deviceRegistered),
      deviceRegistrationState: registrationStates.has(info.deviceRegistrationState)
        ? info.deviceRegistrationState
        : "unregistered",
      playbackReady: Boolean(info.playbackReady),
      restrictionCode: RESTRICTION_CODES.has(restrictionCode) ? restrictionCode : "",
    });
  }
  return publicInfo;
}

function cleanKugouHash(value) {
  const hash = String(value || "").trim().toUpperCase();
  return KUGOU_HASH_RE.test(hash) ? hash : "";
}

function normalizeKugouTrack(raw) {
  const qualityHashes = {};
  for (const quality of QUALITY_LEVELS) {
    const hash = cleanKugouHash(raw?.qualityHashes?.[quality]);
    if (hash) qualityHashes[quality] = hash;
  }
  const hash = cleanKugouHash(raw?.hash) || Object.values(qualityHashes)[0] || "";
  if (!hash) return null;
  const albumAudioId = /^\d{1,24}$/.test(String(raw?.albumAudioId || ""))
    ? String(raw.albumAudioId)
    : "";
  const albumId = /^\d{1,24}$/.test(String(raw?.albumId || ""))
    ? String(raw.albumId)
    : "";
  const descriptor = {
    hash,
    qualityHashes,
    ...(albumAudioId ? { albumAudioId } : {}),
    ...(albumId ? { albumId } : {}),
  };
  const legacyKeyDescriptor = { hash, qualityHashes, albumAudioId, albumId };
  const playKey = createHash("sha256")
    .update(JSON.stringify(legacyKeyDescriptor))
    .digest("hex")
    .slice(0, 24);
  return {
    descriptor,
    publicTrack: {
      provider: "kugou",
      source: "kugou",
      type: "song",
      playable: true,
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
  streamConnectTimeoutMs = STREAM_CONNECT_TIMEOUT_MS,
} = {}) {
  await mkdir(dataDir, { recursive: true });
  const cookieFile = path.join(dataDir, "netease.cookie");
  let userCookie = await readCookieFile(cookieFile);
  const qrKeys = new Map();
  const kugouQrKeys = new Map();
  const streamUrls = new Map();
  const descriptorStore = await createDescriptorStore({
    dataDir,
    ttlMs: KUGOU_TRACK_TTL_MS,
    maxRecords: 2_048,
  });
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

  function requireNeteaseCookie() {
    if (!userCookie) {
      throw Object.assign(new Error("login_required"), { statusCode: 401 });
    }
    return userCookie;
  }

  function assertProviderSuccess(value) {
    let body = responseBody(value);
    for (let depth = 0; depth < 3; depth += 1) {
      const code = Number(body?.code ?? (depth === 0 ? value?.status : body?.status));
      if (Number.isFinite(code) && code !== 200) {
        throw Object.assign(new Error("provider_operation_failed"), { statusCode: 502 });
      }
      if (!isPlainObject(body?.body)) break;
      body = body.body;
    }
    return body;
  }

  async function getUserPlaylists() {
    const info = await getLoginInfo();
    if (!info.loggedIn || !validSongId(info.userId)) {
      return { loggedIn: false, user: null, playlists: [] };
    }
    const value = await callProvider("user_playlist", {
      uid: info.userId,
      limit: MAX_USER_PLAYLISTS,
      offset: 0,
      cookie: userCookie,
      timestamp: Date.now(),
    });
    const playlists = (Array.isArray(responseBody(value).playlist) ? responseBody(value).playlist : [])
      .map(mapUserPlaylist)
      .filter((playlist) => validSongId(playlist.id) && playlist.name)
      .slice(0, MAX_USER_PLAYLISTS);
    return {
      loggedIn: true,
      user: {
        loggedIn: true,
        userId: info.userId,
        nickname: cleanPublicText(info.nickname, 80),
        avatar: safeHttpsImage(info.avatar),
      },
      playlists,
    };
  }

  async function getPlaylistTracks(playlistId) {
    const detailValue = await callProvider("playlist_detail", {
      id: playlistId,
      s: 0,
      cookie: userCookie || undefined,
      timestamp: Date.now(),
    });
    const detailBody = assertProviderSuccess(detailValue);
    const rawPlaylist = detailBody.playlist || {};
    let rawTracks = Array.isArray(rawPlaylist.tracks) ? rawPlaylist.tracks : [];
    const expectedTracks = Math.min(
      MAX_PLAYLIST_TRACKS,
      Math.max(rawTracks.length, Number(rawPlaylist.trackCount) || 0),
    );
    if (rawTracks.length < expectedTracks && typeof provider.playlist_track_all === "function") {
      try {
        const trackValue = await callProvider("playlist_track_all", {
          id: playlistId,
          limit: MAX_PLAYLIST_TRACKS,
          offset: 0,
          s: 0,
          cookie: userCookie || undefined,
          timestamp: Date.now(),
        });
        const completeTracks = responseBody(trackValue).songs;
        if (Array.isArray(completeTracks) && completeTracks.length) rawTracks = completeTracks;
      } catch {
        // The bounded detail response remains usable when the optional all-tracks call fails.
      }
    }
    const tracks = rawTracks
      .slice(0, MAX_PLAYLIST_TRACKS)
      .map(mapSong)
      .filter((song) => validSongId(song.id));
    return {
      provider: "netease",
      playlist: {
        ...mapUserPlaylist({ ...rawPlaylist, id: playlistId }),
        id: playlistId,
        trackCount: Math.max(
          tracks.length,
          Math.min(1_000_000, Number(rawPlaylist.trackCount) || 0),
        ),
      },
      tracks,
    };
  }

  async function getLikeStatus(songIds) {
    const info = await getLoginInfo();
    if (!info.loggedIn || !validSongId(info.userId)) {
      return { provider: "netease", loggedIn: false, liked: {} };
    }
    const value = await callProvider("likelist", {
      uid: info.userId,
      cookie: userCookie,
      timestamp: Date.now(),
    });
    const body = assertProviderSuccess(value);
    const likedIds = new Set(
      (Array.isArray(body.ids) ? body.ids : [])
        .map((id) => validSongId(id))
        .filter(Boolean),
    );
    return {
      provider: "netease",
      loggedIn: true,
      liked: Object.fromEntries(songIds.map((id) => [id, likedIds.has(id)])),
    };
  }

  async function getArtistPage(artistId, limit) {
    const common = {
      id: artistId,
      cookie: userCookie || undefined,
      timestamp: Date.now(),
    };
    const [detailResult, topSongsResult] = await Promise.allSettled([
      typeof provider.artist_detail === "function" ? callProvider("artist_detail", common) : null,
      typeof provider.artist_top_song === "function" ? callProvider("artist_top_song", common) : null,
    ]);
    const detailBody = detailResult.status === "fulfilled" && detailResult.value
      ? responseBody(detailResult.value)
      : {};
    const topBody = topSongsResult.status === "fulfilled" && topSongsResult.value
      ? responseBody(topSongsResult.value)
      : {};
    let rawArtist = detailBody.data?.artist || detailBody.artist || null;
    let rawSongs = topBody.songs || topBody.hotSongs || topBody.data?.songs || [];

    if ((!rawArtist || !Array.isArray(rawSongs) || !rawSongs.length) && typeof provider.artists === "function") {
      try {
        const legacyBody = responseBody(await callProvider("artists", common));
        rawArtist ||= legacyBody.artist || null;
        if (!Array.isArray(rawSongs) || !rawSongs.length) rawSongs = legacyBody.hotSongs || legacyBody.songs || [];
      } catch {
        // Fall through to artist_songs or the partial modern response.
      }
    }
    if ((!Array.isArray(rawSongs) || !rawSongs.length) && typeof provider.artist_songs === "function") {
      try {
        const songsBody = responseBody(await callProvider("artist_songs", {
          ...common,
          order: "hot",
          limit,
          offset: 0,
        }));
        rawSongs = songsBody.songs || songsBody.hotSongs || songsBody.data?.songs || [];
      } catch {
        rawSongs = [];
      }
    }

    if (!rawArtist && !rawSongs.length && detailResult.status === "rejected" && topSongsResult.status === "rejected") {
      throw Object.assign(new Error("provider_unavailable"), { statusCode: 502 });
    }
    const songs = (Array.isArray(rawSongs) ? rawSongs : [])
      .slice(0, limit)
      .map(mapSong)
      .filter((song) => validSongId(song.id));
    const artistFromSong = rawSongs?.[0]?.ar?.find?.((item) => validSongId(item?.id) === artistId);
    return {
      provider: "netease",
      artist: mapArtist(rawArtist || artistFromSong || {}, artistId),
      songs,
    };
  }

  async function getSongComments(songId, limit) {
    const value = await callProvider("comment_music", {
      id: songId,
      limit,
      offset: 0,
      cookie: userCookie || undefined,
      timestamp: Date.now(),
    });
    const body = assertProviderSuccess(value);
    const candidates = [
      ...(Array.isArray(body.hotComments) ? body.hotComments : []),
      ...(Array.isArray(body.comments) ? body.comments : []),
    ];
    const seen = new Set();
    const comments = [];
    for (const item of candidates) {
      const mapped = mapComment(item);
      const key = mapped.id || `${mapped.user.userId}:${mapped.time}:${mapped.content}`;
      if (!mapped.content || seen.has(key)) continue;
      seen.add(key);
      comments.push(mapped);
      if (comments.length >= limit) break;
    }
    return {
      provider: "netease",
      id: songId,
      comments,
      total: Math.max(comments.length, Math.min(1_000_000_000, Number(body.total) || 0)),
    };
  }

  async function getPodcastHot(limit, offset) {
    const body = assertProviderSuccess(await callProvider("dj_hot", {
      limit,
      offset,
      cookie: userCookie || undefined,
      timestamp: Date.now(),
    }));
    const raw = firstArrayFrom(body, ["djRadios", "djradios", "radios", "data"]);
    const podcasts = raw
      .slice(0, limit)
      .map(mapPodcastRadio)
      .filter((podcast) => podcast.id && podcast.name);
    return {
      provider: "netease",
      podcasts,
      more: Boolean(body.hasMore ?? body.more),
    };
  }

  async function searchPodcasts(keywords, limit, offset) {
    const body = assertProviderSuccess(await callProvider("cloudsearch", {
      keywords,
      type: 1009,
      limit,
      offset,
      cookie: userCookie || undefined,
      timestamp: Date.now(),
    }));
    const result = body.result && typeof body.result === "object" ? body.result : body;
    const raw = firstArrayFrom(result, ["djRadios", "djradios", "radios", "data"]);
    const podcasts = raw
      .slice(0, limit)
      .map(mapPodcastRadio)
      .filter((podcast) => podcast.id && podcast.name);
    return {
      provider: "netease",
      podcasts,
      total: Math.max(
        podcasts.length,
        boundedPublicInteger(
          result.djRadiosCount || result.djradiosCount || result.radioCount,
          1_000_000_000,
        ),
      ),
    };
  }

  async function getPodcastDetail(radioId) {
    const body = assertProviderSuccess(await callProvider("dj_detail", {
      rid: radioId,
      cookie: userCookie || undefined,
      timestamp: Date.now(),
    }));
    const podcast = mapPodcastRadio(body.data || body.djRadio || body.radio || body);
    if (!podcast.id) podcast.id = podcast.rid = radioId;
    return { provider: "netease", podcast };
  }

  async function getPodcastPrograms(radioId, limit, offset) {
    const body = assertProviderSuccess(await callProvider("dj_program", {
      rid: radioId,
      limit,
      offset,
      asc: false,
      cookie: userCookie || undefined,
      timestamp: Date.now(),
    }));
    const raw = firstArrayFrom(body, ["programs", "data", "list"]);
    let radio = mapPodcastRadio(raw[0]?.radio || body.radio || { id: radioId });
    if (!radio.id) radio = { ...radio, id: radioId, rid: radioId };
    const programs = raw
      .slice(0, limit)
      .map((program) => mapPodcastProgram(program, radio))
      .filter((program) => program.id && program.programId && program.name);
    return {
      provider: "netease",
      radio,
      programs,
      more: Boolean(body.more ?? body.hasMore),
      total: Math.max(programs.length, boundedPublicInteger(body.count || body.total, 100_000_000)),
    };
  }

  async function getMyPodcastItems(key, info, limit, offset) {
    if (key === "collect") {
      const body = assertProviderSuccess(await callProvider("dj_sublist", {
        limit,
        offset,
        cookie: userCookie,
        timestamp: Date.now(),
      }));
      const raw = firstArrayFrom(body, ["djRadios", "djradios", "radios", "data"]);
      return {
        itemType: "radio",
        items: raw
          .slice(0, limit)
          .map((item) => mapPodcastCollectionRadio(item, key))
          .filter((item) => item.id && item.name),
      };
    }
    if (key === "created") {
      const body = assertProviderSuccess(await callProvider("user_audio", {
        uid: info.userId,
        limit,
        offset,
        cookie: userCookie,
        timestamp: Date.now(),
      }));
      const raw = firstArrayFrom(body, ["data", "djRadios", "djradios", "radios"]);
      return {
        itemType: "radio",
        items: raw
          .slice(offset, offset + limit)
          .map((item) => mapPodcastCollectionRadio(item, key))
          .filter((item) => item.id && item.name),
      };
    }

    let raw = [];
    try {
      const body = assertProviderSuccess(await callProvider("sati_resource_sub_list", {
        cookie: userCookie,
        timestamp: Date.now(),
      }));
      raw = firstArrayFrom(body, ["data", "resources", "list"]);
    } catch {
      raw = [];
    }
    if (!raw.length) {
      try {
        const body = assertProviderSuccess(await callProvider("record_recent_voice", {
          limit,
          cookie: userCookie,
          timestamp: Date.now(),
        }));
        raw = firstArrayFrom(body, ["data", "list", "resources"]);
      } catch {
        raw = [];
      }
    }
    return {
      itemType: "voice",
      items: raw
        .slice(offset, offset + limit)
        .map(mapPodcastVoice)
        .filter((item) => item.id && item.programId && item.name),
    };
  }

  async function registerKugouTracks(rawTracks, accountId) {
    const tracks = [];
    const safeAccountId = /^\d{1,24}$/.test(String(accountId ?? "")) ? String(accountId) : undefined;
    for (const raw of Array.isArray(rawTracks) ? rawTracks : []) {
      const normalized = normalizeKugouTrack(raw);
      if (!normalized) continue;
      await descriptorStore.set(normalized.publicTrack.playKey, normalized.descriptor, {
        accountId: safeAccountId,
      });
      tracks.push(normalized.publicTrack);
    }
    return tracks;
  }

  async function getNeteaseLyric(songId) {
    let value = null;
    let source = "lyric_new";
    if (typeof provider.lyric_new === "function") {
      try {
        value = await callProvider("lyric_new", {
          id: songId,
          cookie: userCookie || undefined,
          timestamp: Date.now(),
        });
      } catch {
        value = null;
      }
    }
    const current = value ? responseBody(value) : null;
    const hasPrimaryLyric = Boolean(
      current?.lrc?.lyric ||
      current?.yrc?.lyric ||
      (typeof current?.lyric === "string" && current.lyric) ||
      (typeof current?.yrc === "string" && current.yrc),
    );
    if (!hasPrimaryLyric) {
      value = await callProvider("lyric", {
        id: songId,
        cookie: userCookie || undefined,
        timestamp: Date.now(),
      });
      source = "lyric";
    }
    return publicLyricPayload("netease", songId, value, source);
  }

  async function getKugouLyric(playKey) {
    const descriptor = await descriptorStore.get(playKey);
    if (!descriptor) {
      throw Object.assign(new Error("track_key_expired"), { statusCode: 404 });
    }
    if (typeof kugou.lyric !== "function") {
      throw Object.assign(new Error("provider_method_missing"), { statusCode: 502 });
    }
    const value = await withTimeout(Promise.resolve().then(() => kugou.lyric(descriptor)));
    const fields = lyricFields(value);
    const source = fields.lyric || fields.yrc ? "kugou-lyrics" : "kugou-empty";
    return {
      provider: "kugou",
      id: playKey,
      ...fields,
      lines: parseLyricLines(fields.lyric, fields.yrc),
      source,
    };
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
          streamUrls.delete(`${providerName}:${sourceId}:${fallbackQuality}`);
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
    const track = await descriptorStore.get(playKey);
    if (!track) {
      throw Object.assign(new Error("track_key_expired"), { statusCode: 404 });
    }
    const value = await withTimeout(kugou.resolveStream(track, quality));
    if (!value?.url) {
      const restriction = sanitizedRestriction(value, "provider_unavailable");
      throw streamRestrictionError(restriction, 403);
    }
    return { url: value.url, level: validQuality(value.level, quality) || quality };
  }

  async function resolveStream(providerName, sourceId, quality, { bypassCache = false } = {}) {
    const cacheKey = `${providerName}:${sourceId}:${quality}`;
    const cached = streamUrls.get(cacheKey);
    if (!bypassCache && cached && cached.expiresAt > Date.now()) return cached;
    if (bypassCache) streamUrls.delete(cacheKey);
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

  async function discardUpstream(response) {
    try {
      if (response?.body && !response.body.locked) {
        const reader = response.body.getReader();
        await reader.cancel();
      }
    } catch {
      // The first failed response is intentionally discarded before retrying.
    }
  }

  async function clearKugouPlaybackCache() {
    await descriptorStore.clear();
    for (const key of streamUrls.keys()) {
      if (key.startsWith("kugou:")) streamUrls.delete(key);
    }
  }

  async function openProviderStream(req, providerName, sourceId, quality) {
    const init = {
      headers: {
        Accept: "*/*",
        Referer: providerName === "kugou" ? "https://www.kugou.com/" : "https://music.163.com/",
        "User-Agent": "MR-ROOM/1.0",
        ...(req.headers.range ? { Range: req.headers.range } : {}),
      },
    };
    let stream = await resolveStream(providerName, sourceId, quality);
    let upstream = await fetchProviderStream(
      fetchImpl,
      validateStreamUrl,
      stream.url,
      init,
      0,
      streamConnectTimeoutMs,
    );
    if (RETRYABLE_STREAM_STATUSES.has(upstream.status)) {
      await discardUpstream(upstream);
      stream = await resolveStream(providerName, sourceId, quality, { bypassCache: true });
      upstream = await fetchProviderStream(
        fetchImpl,
        validateStreamUrl,
        stream.url,
        init,
        0,
        streamConnectTimeoutMs,
      );
    }
    if (providerName === "kugou"
        && (!upstream.ok || !upstream.body)
        && RETRYABLE_STREAM_STATUSES.has(upstream.status)) {
      await discardUpstream(upstream);
      streamUrls.delete(`${providerName}:${sourceId}:${quality}`);
      const effectiveIndex = QUALITY_LEVELS.indexOf(validQuality(stream.level, quality));
      const fallbackQualities = QUALITY_LEVELS.slice(effectiveIndex >= 0 ? effectiveIndex + 1 : 1);
      upstream = null;
      for (const fallbackQuality of fallbackQualities) {
        let fallbackResponse;
        try {
          stream = await resolveStream(providerName, sourceId, fallbackQuality, { bypassCache: true });
          fallbackResponse = await fetchProviderStream(
            fetchImpl,
            validateStreamUrl,
            stream.url,
            init,
            0,
            streamConnectTimeoutMs,
          );
        } catch {
          continue;
        }
        if (fallbackResponse.ok && fallbackResponse.body) {
          upstream = fallbackResponse;
          break;
        }
        streamUrls.delete(`${providerName}:${sourceId}:${fallbackQuality}`);
        await discardUpstream(fallbackResponse);
      }
    }
    if (!upstream?.ok || !upstream.body) {
      streamUrls.delete(`${providerName}:${sourceId}:${quality}`);
      await discardUpstream(upstream);
      return { stream, upstream: null };
    }
    return { stream, upstream };
  }

  async function serveProviderStream(req, res, origin, providerName, sourceId, quality) {
    try {
      const { stream, upstream } = await openProviderStream(req, providerName, sourceId, quality);
      if (!upstream) {
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
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendJson(req, res, error?.statusCode || 502, errorPayload(error));
    }
  }

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || "/", "http://music.local");
    const origin = req.headers.origin;
    if (origin && !allowedOrigin(origin)) {
      rejectRequest(req, res, 403, "origin_not_allowed");
      return;
    }
    if (req.method === "OPTIONS") {
      if (requestHasBody(req)) {
        rejectRequest(req, res, 400, "request_body_not_allowed");
        return;
      }
      const preflightFailure = preflightError(req);
      if (preflightFailure) {
        sendJson(req, res, 403, { error: preflightFailure });
        return;
      }
      res.writeHead(204, corsHeaders(origin));
      res.end();
      return;
    }
    if (!CORS_METHODS.includes(req.method || "")) {
      rejectRequest(req, res, 405, "method_not_allowed");
      return;
    }
    if (req.method === "GET" && requestHasBody(req)) {
      rejectRequest(req, res, 400, "request_body_not_allowed");
      return;
    }

    try {
      if (requestUrl.pathname === "/api/v2/playback/prepare") {
        if (req.method !== "POST") {
          rejectRequest(req, res, 405, "method_not_allowed");
          return;
        }
        const mutationError = requireMutationIntent(req);
        if (mutationError) {
          rejectRequest(req, res, 403, mutationError);
          return;
        }
        if (!isJsonMediaType(req.headers["content-type"])) {
          rejectRequest(req, res, 415, "unsupported_media_type");
          return;
        }
        const prepared = parsePrepareBody(await readBoundedJson(req));
        if (!prepared) {
          sendJson(req, res, 400, { error: "invalid_prepare_request" });
          return;
        }
        const attemptId = randomBytes(12).toString("hex");
        const baseResult = {
          provider: "kugou",
          trackRef: prepared.trackRef,
          requestedQuality: prepared.quality,
          attemptId,
        };
        try {
          const stream = await resolveStream("kugou", prepared.trackRef, prepared.quality);
          // Prepare response shape deliberately exposes only local routing metadata:
          // { playable, provider, trackRef, requestedQuality, resolvedQuality,
          //   attemptId, streamPath, restriction }. Provider URLs never cross this API.
          sendJson(req, res, 200, {
            playable: true,
            ...baseResult,
            resolvedQuality: stream.level,
            streamPath: `/api/v2/stream/${prepared.trackRef}?quality=${prepared.quality}`,
            restriction: null,
          });
        } catch (error) {
          if (!error?.restriction) throw error;
          sendJson(req, res, 200, {
            playable: false,
            ...baseResult,
            resolvedQuality: null,
            restriction: sanitizedRestriction(error.restriction),
          });
        }
        return;
      }

      const v2StreamMatch = /^\/api\/v2\/stream\/([a-f0-9]{24})$/.exec(requestUrl.pathname);
      if (v2StreamMatch) {
        if (req.method !== "GET") {
          rejectRequest(req, res, 405, "method_not_allowed");
          return;
        }
        const quality = validQuality(requestUrl.searchParams.get("quality"), "hires");
        if (!quality) {
          sendJson(req, res, 400, { error: "invalid_quality" });
          return;
        }
        await serveProviderStream(req, res, origin, "kugou", v2StreamMatch[1], quality);
        return;
      }

      if ([
        "/api/song/like",
        "/api/playlist/create",
        "/api/playlist/add-song",
      ].includes(requestUrl.pathname)) {
        if (req.method !== "POST") {
          rejectRequest(req, res, 405, "method_not_allowed");
          return;
        }
        const mutationError = requireMutationIntent(req);
        if (mutationError) {
          rejectRequest(req, res, 403, mutationError);
          return;
        }
        if (!isJsonMediaType(req.headers["content-type"])) {
          rejectRequest(req, res, 415, "unsupported_media_type");
          return;
        }
        const requestBody = await readBoundedJson(req);
        const cookie = requireNeteaseCookie();

        if (requestUrl.pathname === "/api/song/like") {
          const fields = parseLikeBody(requestBody, requestUrl);
          if (!fields) {
            sendJson(req, res, 400, { error: "invalid_like_request" });
            return;
          }
          const value = await callProvider("like", {
            id: fields.id,
            // NeteaseCloudMusicApi's adapter checks for the literal string "false".
            like: String(fields.like),
            cookie,
            timestamp: Date.now(),
          });
          assertProviderSuccess(value);
          sendJson(req, res, 200, {
            provider: "netease",
            ok: true,
            id: fields.id,
            liked: fields.like,
          });
          return;
        }

        if (requestUrl.pathname === "/api/playlist/create") {
          const fields = parsePlaylistCreateBody(requestBody, requestUrl);
          if (!fields) {
            sendJson(req, res, 400, { error: "invalid_playlist_create_request" });
            return;
          }
          const value = await callProvider("playlist_create", {
            name: fields.name,
            privacy: 0,
            cookie,
            timestamp: Date.now(),
          });
          const body = assertProviderSuccess(value);
          const playlist = mapUserPlaylist(body.playlist || body.data || {
            id: body.id,
            name: fields.name,
          });
          if (!validSongId(playlist.id)) {
            throw Object.assign(new Error("provider_operation_failed"), { statusCode: 502 });
          }
          sendJson(req, res, 200, {
            provider: "netease",
            ok: true,
            playlist: { ...playlist, name: playlist.name || fields.name },
          });
          return;
        }

        const fields = parsePlaylistAddBody(requestBody, requestUrl);
        if (!fields) {
          sendJson(req, res, 400, { error: "invalid_playlist_add_request" });
          return;
        }
        const value = await callProvider("playlist_tracks", {
          op: "add",
          pid: fields.pid,
          tracks: fields.id,
          cookie,
          timestamp: Date.now(),
        });
        assertProviderSuccess(value);
        sendJson(req, res, 200, {
          provider: "netease",
          success: true,
          playlistId: fields.pid,
          songId: fields.id,
        });
        return;
      }

      if (requestUrl.pathname === "/api/kugou/login/cookie") {
        if (req.method !== "POST") {
          rejectRequest(req, res, 405, "method_not_allowed");
          return;
        }
        const mutationError = requireMutationIntent(req);
        if (mutationError) {
          rejectRequest(req, res, 403, mutationError);
          return;
        }
        if (!isJsonMediaType(req.headers["content-type"])) {
          rejectRequest(req, res, 415, "unsupported_media_type");
          return;
        }
        if (typeof kugou.loginCookie !== "function") {
          throw Object.assign(new Error("provider_method_missing"), { statusCode: 502 });
        }
        const cookie = parseKugouCookieBody(await readBoundedJson(req, MAX_KUGOU_COOKIE_BODY_BYTES));
        if (!cookie) {
          sendJson(req, res, 400, { error: "invalid_kugou_cookie_request" });
          return;
        }
        const value = await withTimeout(kugou.loginCookie(cookie));
        await clearKugouPlaybackCache();
        sendJson(req, res, 200, {
          ...safeAccountInfo(value, "kugou"),
          saved: true,
        });
        return;
      }

      if (req.method !== "GET") {
        rejectRequest(req, res, 405, "method_not_allowed");
        return;
      }
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

      if (requestUrl.pathname === "/api/user/playlists") {
        sendJson(req, res, 200, await getUserPlaylists());
        return;
      }

      if (requestUrl.pathname === "/api/playlist/tracks") {
        const playlistId = validSongId(requestUrl.searchParams.get("id"));
        if (!playlistId) {
          sendJson(req, res, 400, { error: "invalid_playlist_id", tracks: [] });
          return;
        }
        sendJson(req, res, 200, await getPlaylistTracks(playlistId));
        return;
      }

      if (requestUrl.pathname === "/api/song/like/check") {
        const songIds = parseSongIds(requestUrl.searchParams.get("ids"));
        if (!songIds?.length) {
          sendJson(req, res, 400, { error: "invalid_song_ids", liked: {} });
          return;
        }
        sendJson(req, res, 200, await getLikeStatus(songIds));
        return;
      }

      if (requestUrl.pathname === "/api/artist/detail") {
        const artistId = validSongId(requestUrl.searchParams.get("id"));
        if (!artistId) {
          sendJson(req, res, 400, { error: "invalid_artist_id", artist: null, songs: [] });
          return;
        }
        const limit = Math.floor(clamp(requestUrl.searchParams.get("limit") || 36, 1, MAX_ARTIST_SONGS));
        sendJson(req, res, 200, await getArtistPage(artistId, limit));
        return;
      }

      if (requestUrl.pathname === "/api/song/comments") {
        const songId = validSongId(requestUrl.searchParams.get("id"));
        if (!songId) {
          sendJson(req, res, 400, { error: "invalid_song_id", comments: [] });
          return;
        }
        const limit = Math.floor(clamp(requestUrl.searchParams.get("limit") || 18, 1, MAX_SONG_COMMENTS));
        sendJson(req, res, 200, await getSongComments(songId, limit));
        return;
      }

      if (requestUrl.pathname === "/api/podcast/hot") {
        const limit = boundedPodcastQueryInteger(
          requestUrl.searchParams.get("limit"),
          18,
          1,
          MAX_PODCAST_RESULTS,
        );
        const offset = boundedPodcastQueryInteger(
          requestUrl.searchParams.get("offset"),
          0,
          0,
          MAX_PODCAST_OFFSET,
        );
        sendJson(req, res, 200, await getPodcastHot(limit, offset));
        return;
      }

      if (requestUrl.pathname === "/api/podcast/search") {
        const keywords = cleanPodcastText(
          requestUrl.searchParams.get("keywords"),
          MAX_PODCAST_KEYWORDS,
        );
        if (!keywords) {
          sendJson(req, res, 400, { error: "keywords_required", podcasts: [] });
          return;
        }
        const limit = boundedPodcastQueryInteger(
          requestUrl.searchParams.get("limit"),
          18,
          1,
          MAX_PODCAST_RESULTS,
        );
        const offset = boundedPodcastQueryInteger(
          requestUrl.searchParams.get("offset"),
          0,
          0,
          MAX_PODCAST_OFFSET,
        );
        sendJson(req, res, 200, await searchPodcasts(keywords, limit, offset));
        return;
      }

      if (requestUrl.pathname === "/api/podcast/detail") {
        const radioId = validSongId(
          requestUrl.searchParams.get("id") || requestUrl.searchParams.get("rid"),
        );
        if (!radioId) {
          sendJson(req, res, 400, { error: "invalid_podcast_id", podcast: null });
          return;
        }
        sendJson(req, res, 200, await getPodcastDetail(radioId));
        return;
      }

      if (requestUrl.pathname === "/api/podcast/programs") {
        const radioId = validSongId(
          requestUrl.searchParams.get("id") || requestUrl.searchParams.get("rid"),
        );
        if (!radioId) {
          sendJson(req, res, 400, { error: "invalid_podcast_id", programs: [] });
          return;
        }
        const limit = boundedPodcastQueryInteger(
          requestUrl.searchParams.get("limit"),
          30,
          1,
          MAX_PODCAST_PROGRAMS,
        );
        const offset = boundedPodcastQueryInteger(
          requestUrl.searchParams.get("offset"),
          0,
          0,
          MAX_PODCAST_OFFSET,
        );
        sendJson(req, res, 200, await getPodcastPrograms(radioId, limit, offset));
        return;
      }

      if (requestUrl.pathname === "/api/podcast/my") {
        const keys = [...PODCAST_COLLECTION_KEYS];
        const info = await getLoginInfo();
        if (!info.loggedIn || !validSongId(info.userId)) {
          sendJson(req, res, 200, {
            provider: "netease",
            loggedIn: false,
            collections: keys.map((key) => podcastCollectionMeta(key, [])),
          });
          return;
        }
        const collections = await Promise.all(keys.map(async (key) => {
          try {
            const data = await getMyPodcastItems(key, info, 12, 0);
            return podcastCollectionMeta(key, data.items);
          } catch {
            return podcastCollectionMeta(key, []);
          }
        }));
        sendJson(req, res, 200, { provider: "netease", loggedIn: true, collections });
        return;
      }

      if (requestUrl.pathname === "/api/podcast/my/items") {
        const key = String(requestUrl.searchParams.get("key") || "collect").trim();
        if (!PODCAST_COLLECTION_KEYS.has(key)) {
          sendJson(req, res, 400, { error: "invalid_podcast_collection", items: [] });
          return;
        }
        const limit = boundedPodcastQueryInteger(
          requestUrl.searchParams.get("limit"),
          36,
          1,
          MAX_PODCAST_PROGRAMS,
        );
        const offset = boundedPodcastQueryInteger(
          requestUrl.searchParams.get("offset"),
          0,
          0,
          MAX_PODCAST_OFFSET,
        );
        const info = await getLoginInfo();
        if (!info.loggedIn || !validSongId(info.userId)) {
          sendJson(req, res, 200, {
            provider: "netease",
            loggedIn: false,
            ...podcastCollectionMeta(key, []),
            items: [],
          });
          return;
        }
        const data = await getMyPodcastItems(key, info, limit, offset);
        sendJson(req, res, 200, {
          provider: "netease",
          loggedIn: true,
          ...podcastCollectionMeta(key, data.items),
          itemType: data.itemType,
          items: data.items,
        });
        return;
      }

      if (requestUrl.pathname === "/api/podcast/dj-beatmap") {
        sendJson(req, res, 501, {
          ok: false,
          disabled: true,
          error: "server_beatmap_disabled",
        });
        return;
      }

      if (requestUrl.pathname === "/api/kugou/login/refresh") {
        const refreshAccount = kugou.refreshAccount || kugou.validateSession;
        if (typeof refreshAccount !== "function") {
          throw Object.assign(new Error("provider_method_missing"), { statusCode: 502 });
        }
        sendJson(req, res, 200, safeAccountInfo(await withTimeout(refreshAccount()), "kugou"));
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
        if (code === 803) {
          await clearKugouPlaybackCache();
        }
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
        await clearKugouPlaybackCache();
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
          tracks: (await registerKugouTracks(value?.tracks, value?.userId)).slice(0, 500),
        });
        return;
      }

      if (requestUrl.pathname === "/api/kugou/lyric") {
        const playKey = validPlayKey(requestUrl.searchParams.get("id"));
        if (!playKey) {
          sendJson(req, res, 400, {
            error: "invalid_play_key",
            provider: "kugou",
            lyric: "",
            tlyric: "",
            yrc: "",
            lines: [],
          });
          return;
        }
        sendJson(req, res, 200, await getKugouLyric(playKey));
        return;
      }

      if (requestUrl.pathname === "/api/lyric") {
        const songId = validSongId(requestUrl.searchParams.get("id"));
        if (!songId) {
          sendJson(req, res, 400, {
            error: "invalid_song_id",
            provider: "netease",
            lyric: "",
            tlyric: "",
            yrc: "",
            lines: [],
          });
          return;
        }
        sendJson(req, res, 200, await getNeteaseLyric(songId));
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
        await serveProviderStream(req, res, origin, providerName, sourceId, quality);
        return;
      }

      sendJson(req, res, 404, { error: "not_found" });
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error?.closeConnection) res.setHeader("Connection", "close");
      sendJson(req, res, error?.statusCode || 502, errorPayload(error));
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
      await descriptorStore.flush();
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
