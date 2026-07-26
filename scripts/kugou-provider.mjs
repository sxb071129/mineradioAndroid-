import {
  constants as cryptoConstants,
  createCipheriv,
  createDecipheriv,
  createHash,
  publicEncrypt,
  randomInt,
  randomUUID,
} from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

const PROVIDER = "kugou";
const APP_ID = "3116";
const CLIENT_VERSION = "11440";
const QR_APP_ID = "1001";
const QR_SOURCE_APP_ID = "2919";
const ANDROID_SIGNATURE_KEY = "LnT6xpN3khm36zse0QzvmgTZ3waWdRSA";
const WEB_SIGNATURE_KEY = "NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt";
const PLAY_KEY_SALT = "kgcloudv2";
const ANDROID_USER_AGENT = "Android15-1070-11440-46-0-DiscoveryDRADProtocol-wifi";
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const GATEWAY_ORIGIN = "https://gateway.kugou.com";
const LOGIN_ORIGIN = "https://login-user.kugou.com";
const USER_SERVICE_ORIGIN = "https://userservice.kugou.com";
const VIP_ORIGIN = "https://kugouvip.kugou.com";
const TRACKER_ORIGIN = "https://trackercdn.kugou.com";
const LYRICS_ORIGIN = "https://lyrics.kugou.com";
const FIXED_API_ORIGINS = new Set([
  GATEWAY_ORIGIN,
  LOGIN_ORIGIN,
  USER_SERVICE_ORIGIN,
  VIP_ORIGIN,
  TRACKER_ORIGIN,
  LYRICS_ORIGIN,
]);
const STREAM_HOST_SUFFIXES = ["kugou.com", "kgimg.com", "kugou.net"];

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_LYRIC_BYTES = 512 * 1024;
const MAX_AUTH_FILE_BYTES = 64 * 1024;
const MAX_COOKIE_INPUT_BYTES = 32 * 1024;
const QUALITY_METADATA_TTL_MS = 60 * 60 * 1000;
const QR_TTL_MS = 10 * 60 * 1000;
const MAX_QR_SESSIONS = 16;
const MAX_PLAYLIST_PAGES = 10;
const PLAYLIST_PAGE_SIZE = 200;

const HASH_RE = /^[a-fA-F0-9]{32}$/;
const IDENTIFIER_RE = /^[A-Za-z0-9_-]{1,128}$/;
const QR_KEY_RE = /^[A-Za-z0-9_-]{8,256}$/;
const USER_ID_RE = /^\d{1,24}$/;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEVICE_TOKEN_RE = /^[A-Z0-9]{8,64}$/;
const DFID_RE = /^[A-Za-z0-9_-]{0,128}$/;
const LYRIC_CANDIDATE_RE = /^[A-Za-z0-9._~+-]{1,256}$/;
const QUALITY_LEVELS = Object.freeze([
  "jymaster",
  "hires",
  "lossless",
  "exhigh",
  "standard",
]);
const QUALITY_SET = new Set(QUALITY_LEVELS);
const QUALITY_FALLBACKS = Object.freeze({
  jymaster: ["jymaster", "hires", "lossless", "exhigh", "standard"],
  hires: ["hires", "lossless", "exhigh", "standard"],
  lossless: ["lossless", "exhigh", "standard"],
  exhigh: ["exhigh", "standard"],
  standard: ["standard"],
});

const KUGOU_RSA_PUBLIC_KEY = [
  "-----BEGIN PUBLIC KEY-----",
  "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDECi0Np2UR87scwrvTr72L6oO01rBbbBPriSDFPxr3Z5syug0O24QyQO8bg27+0+4kBzTBTBOZ/WWU0WryL1JSXRTXLgFVxtzIY41Pe7lPOgsfTCn5kZcvKhYKJesKnnJDNr5/abvTGf+rHG3YRwsCHcQ08/q6ifSioBszvb3QiwIDAQAB",
  "-----END PUBLIC KEY-----",
].join("\n");

function makeError(code, statusCode = 502) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstNonEmpty(...values) {
  return values.find((value) => value != null && String(value).trim() !== "") ?? "";
}

function md5(value) {
  return createHash("md5").update(String(value ?? "")).digest("hex");
}

function randomUppercaseString(length) {
  const alphabet = "1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let output = "";
  for (let index = 0; index < length; index += 1) {
    output += alphabet[randomInt(0, alphabet.length)];
  }
  return output;
}

function randomLowercaseString(length) {
  return randomUppercaseString(length).toLowerCase();
}

function calculateMid(guid) {
  return BigInt(`0x${md5(guid)}`).toString(10);
}

function cleanText(value, maxLength = 256) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function decodeCookieValue(value) {
  const raw = String(value ?? "").trim();
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function parseKugouCookieInput(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw makeError("invalid_kugou_cookie", 400);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_COOKIE_INPUT_BYTES ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw makeError("invalid_kugou_cookie", 400);
  }

  const fields = new Map();
  for (const line of value.split(/\r?\n/)) {
    const normalizedLine = line.replace(/^\s*cookie\s*:\s*/i, "");
    for (const part of normalizedLine.split(";")) {
      const separator = part.indexOf("=");
      if (separator <= 0) continue;
      const key = part.slice(0, separator).trim().toLowerCase();
      const rawValue = part.slice(separator + 1).trim();
      if (!key || !rawValue) continue;
      fields.set(key, decodeCookieValue(rawValue));
    }
  }

  function firstField(...names) {
    for (const name of names) {
      const field = fields.get(name);
      if (field != null && String(field).trim()) return String(field).trim();
    }
    return "";
  }

  const userId = firstField(
    "userid", "user_id", "uid", "kugooid", "kugou_id", "kugouid", "kg_uid",
  );
  const token = firstField("token", "user_token", "access_token", "key", "kugoo", "t");
  if (!USER_ID_RE.test(userId) || !token || token.length > 2_048 ||
      /[\u0000-\u001f\u007f]/.test(token)) {
    throw makeError("invalid_kugou_cookie", 400);
  }

  function boundedNumber(raw) {
    if (/^(?:true|yes)$/i.test(raw)) return 1;
    return Math.max(0, Math.min(1_000_000, Number(raw) || 0));
  }

  const device = {};
  const guid = firstField("kugou_api_guid", "guid");
  const mid = firstField("kugou_api_mid", "kg_mid", "mid");
  const mac = firstField("kugou_api_mac", "mac");
  const dev = firstField("kugou_api_dev", "dev");
  const dfid = firstField("dfid");
  if (GUID_RE.test(guid)) device.guid = guid;
  if (/^\d{1,64}$/.test(mid)) device.mid = mid;
  if (DEVICE_TOKEN_RE.test(mac)) device.mac = mac;
  if (DEVICE_TOKEN_RE.test(dev)) device.dev = dev;
  if (dfid === "-" || (dfid && DFID_RE.test(dfid))) device.dfid = dfid;

  return {
    session: {
      userId,
      token,
      nickname: cleanText(firstField("nickname", "nick", "username", "user_name", "uname"), 128),
      avatar: safePublicUrl(
        firstField(
          "avatar", "pic", "img", "icon", "headpic", "head_img", "headimg", "user_pic", "userpic",
        ),
        { providerOnly: true },
      ),
      vipType: boundedNumber(firstField("viptype", "vip_type", "isvip", "is_vip", "vip")),
      svipLevel: boundedNumber(firstField("svip_level", "sviplevel")),
    },
    device,
  };
}

function cleanTrackText(value) {
  return cleanText(value, 300)
    .replace(/\.(mp3|flac|m4a|aac|ogg|wav)$/i, "")
    .trim();
}

function cleanIdentifier(value, label = "identifier") {
  const normalized = String(value ?? "").trim();
  if (!IDENTIFIER_RE.test(normalized)) throw makeError(`invalid_${label}`, 400);
  return normalized;
}

function optionalNumericIdentifier(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  if (!/^\d{1,24}$/.test(normalized)) throw makeError(`invalid_${label}`, 400);
  return normalized;
}

function normalizeHash(value, { optional = false, label = "hash" } = {}) {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (!normalized && optional) return "";
  if (!HASH_RE.test(normalized)) throw makeError(`invalid_${label}`, 400);
  return normalized;
}

function normalizeQuality(value) {
  if (value == null || value === "") return "hires";
  const normalized = String(value).trim().toLowerCase();
  if (!QUALITY_SET.has(normalized)) throw makeError("invalid_quality", 400);
  return normalized;
}

function safePublicUrl(value, { allowHttp = true, providerOnly = false } = {}) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > 2_048) return "";
  let resolved;
  try {
    resolved = new URL(raw);
  } catch {
    return "";
  }
  if ((!allowHttp && resolved.protocol !== "https:") ||
      (allowHttp && resolved.protocol !== "https:" && resolved.protocol !== "http:") ||
      resolved.username || resolved.password || resolved.port) {
    return "";
  }
  if (providerOnly) {
    const hostname = resolved.hostname.toLowerCase().replace(/\.$/, "");
    const allowed = STREAM_HOST_SUFFIXES.some(
      (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
    );
    if (!allowed) return "";
  }
  return resolved.toString();
}

function safeProviderStreamUrl(value) {
  const raw = String(value ?? "").trim();
  let resolved;
  try {
    resolved = new URL(raw);
  } catch {
    return "";
  }

  if (resolved.protocol === "http:") {
    const allowlistedHttpUrl = safePublicUrl(resolved.toString(), {
      allowHttp: true,
      providerOnly: true,
    });
    if (!allowlistedHttpUrl) return "";
    resolved = new URL(allowlistedHttpUrl);
    resolved.protocol = "https:";
  }

  return safePublicUrl(resolved.toString(), { allowHttp: false, providerOnly: true });
}

function browserUnsupportedAudioFormat(data, streamUrl) {
  const declared = cleanText(
    data?.extName ?? data?.extname ?? data?.fileExt ?? data?.file_ext,
    24,
  ).toLowerCase().replace(/^\./, "");
  let pathnameExt = "";
  try {
    const match = /\.([a-z0-9]{2,8})$/i.exec(new URL(streamUrl).pathname);
    pathnameExt = String(match?.[1] || "").toLowerCase();
  } catch {
    pathnameExt = "";
  }
  const unsupported = new Set(["ape", "dsf", "dff", "wv", "wavpack"]);
  return unsupported.has(declared) || unsupported.has(pathnameExt);
}

function safeProviderMessage(value) {
  return cleanText(value, 300)
    .replace(/https?:\/\/[^\s,;]+/gi, "[redacted-url]")
    .replace(/\b[a-f0-9]{32}\b/gi, "[redacted-hash]")
    .replace(/((?:access[_-]?token|refresh[_-]?token|token|cookie|kugoo|authorization)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]");
}

function normalizeLyricText(value) {
  const normalized = String(value ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
  if (Buffer.byteLength(normalized) > MAX_LYRIC_BYTES) {
    throw makeError("provider_lyric_too_large");
  }
  return normalized;
}

function decodeKugouLyricContent(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) throw makeError("provider_response_too_large");
  const compact = raw.replace(/\s+/g, "");
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(compact) && compact.length >= 8) {
    try {
      const decoded = Buffer.from(compact, "base64").toString("utf8");
      if (decoded && (decoded.includes("[") || /[\u4e00-\u9fff]/.test(decoded))) {
        return normalizeLyricText(decoded);
      }
    } catch {
      // Some provider responses already contain plain-text LRC despite the content field name.
    }
  }
  return normalizeLyricText(raw);
}

function signValue(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function androidSignature(params, dataString = "") {
  const body = Object.keys(params)
    .sort()
    .map((key) => `${key}=${signValue(params[key])}`)
    .join("");
  return md5(ANDROID_SIGNATURE_KEY + body + dataString + ANDROID_SIGNATURE_KEY);
}

function webSignature(params) {
  const body = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key] == null ? "" : params[key]}`)
    .join("");
  return md5(WEB_SIGNATURE_KEY + body + WEB_SIGNATURE_KEY);
}

function createDeviceIdentity(existing = {}) {
  if (!isPlainObject(existing)) throw makeError("invalid_auth_device", 500);
  const guid = existing.guid || randomUUID();
  const mid = existing.mid || calculateMid(guid);
  const mac = existing.mac || randomUppercaseString(12);
  const dev = existing.dev || randomUppercaseString(16);
  const dfid = existing.dfid || "-";
  if (!GUID_RE.test(guid) || !/^\d{1,64}$/.test(String(mid)) ||
      !DEVICE_TOKEN_RE.test(mac) || !DEVICE_TOKEN_RE.test(dev) ||
      !(dfid === "-" || DFID_RE.test(dfid))) {
    throw makeError("invalid_auth_device", 500);
  }
  return {
    guid: String(guid),
    mid: String(mid),
    mac: String(mac),
    dev: String(dev),
    dfid: String(dfid),
  };
}

function normalizeSession(existing) {
  if (existing == null) return null;
  if (!isPlainObject(existing)) throw makeError("invalid_auth_session", 500);
  const userId = String(existing.userId ?? existing.userid ?? "").trim();
  const token = String(existing.token ?? "").trim();
  if (!userId && !token) return null;
  if (!USER_ID_RE.test(userId) || !token || token.length > 2_048 ||
      /[\u0000-\u001f\u007f]/.test(token)) {
    throw makeError("invalid_auth_session", 500);
  }
  const vipType = Math.max(0, Math.min(1_000_000, Number(existing.vipType) || 0));
  const svipLevel = Math.max(0, Math.min(1_000_000, Number(existing.svipLevel) || 0));
  return {
    userId,
    token,
    nickname: cleanText(existing.nickname, 128),
    avatar: safePublicUrl(existing.avatar, { providerOnly: true }),
    vipType,
    svipLevel,
  };
}

function normalizeIsoTime(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function normalizeValidation(existing, hasSession) {
  const value = isPlainObject(existing) ? existing : {};
  const allowedStates = new Set(["unvalidated", "valid", "stale", "unavailable"]);
  let validationState = allowedStates.has(value.validationState)
    ? value.validationState
    : (allowedStates.has(value.state) ? value.state : "unvalidated");
  if (!hasSession) validationState = "unvalidated";
  return {
    validationState,
    validatedAt: normalizeIsoTime(value.validatedAt),
    lastAttemptAt: normalizeIsoTime(value.lastAttemptAt),
    code: cleanText(value.code, 80),
  };
}

function normalizeDeviceRegistration(existing, device) {
  const value = isPlainObject(existing) ? existing : {};
  const allowedStates = new Set(["unregistered", "registered", "failed"]);
  let registrationState = allowedStates.has(value.registrationState)
    ? value.registrationState
    : (allowedStates.has(value.state) ? value.state : "unregistered");
  if (registrationState === "unregistered" && device.dfid && device.dfid !== "-") {
    registrationState = "registered";
  }
  return {
    registrationState,
    attemptedAt: normalizeIsoTime(value.attemptedAt),
    registeredAt: normalizeIsoTime(value.registeredAt),
    code: cleanText(value.code, 80),
  };
}

function serializeState(state) {
  return JSON.stringify(
    {
      version: 1,
      device: state.device,
      session: state.session,
      validation: state.validation,
      deviceRegistration: state.deviceRegistration,
      updatedAt: new Date().toISOString(),
    },
    null,
    2,
  ) + "\n";
}

async function loadAuthState(authFile) {
  try {
    const details = await stat(authFile);
    if (!details.isFile() || details.size > MAX_AUTH_FILE_BYTES) {
      throw makeError("invalid_auth_file", 500);
    }
    const parsed = JSON.parse(await readFile(authFile, "utf8"));
    if (!isPlainObject(parsed) || (parsed.version != null && parsed.version !== 1)) {
      throw makeError("invalid_auth_file", 500);
    }
    const device = createDeviceIdentity(parsed.device);
    const session = normalizeSession(parsed.session);
    return {
      device,
      session,
      validation: normalizeValidation(parsed.validation, Boolean(session)),
      deviceRegistration: normalizeDeviceRegistration(parsed.deviceRegistration, device),
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      const device = createDeviceIdentity();
      return {
        device,
        session: null,
        validation: normalizeValidation(null, false),
        deviceRegistration: normalizeDeviceRegistration(null, device),
      };
    }
    if (error?.code && String(error.code).startsWith("invalid_")) throw error;
    throw makeError("invalid_auth_file", 500);
  }
}

function headerValue(response, name) {
  return response?.headers?.get?.(name) || "";
}

async function responseText(response) {
  const declaredLength = Number(headerValue(response, "content-length")) || 0;
  if (declaredLength > MAX_RESPONSE_BYTES) throw makeError("provider_response_too_large");
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw makeError("provider_response_too_large");
  return text;
}

async function responseBuffer(response) {
  const declaredLength = Number(headerValue(response, "content-length")) || 0;
  if (declaredLength > MAX_RESPONSE_BYTES) throw makeError("provider_response_too_large");
  const value = Buffer.from(await response.arrayBuffer());
  if (value.length > MAX_RESPONSE_BYTES) throw makeError("provider_response_too_large");
  return value;
}

function parseJson(text) {
  try {
    const parsed = JSON.parse(String(text || "{}"));
    if (!isPlainObject(parsed) && !Array.isArray(parsed)) throw new Error("invalid");
    return parsed;
  } catch {
    throw makeError("invalid_provider_response");
  }
}

function deepFind(value, names, depth = 0) {
  if (depth > 8 || value == null || typeof value !== "object") return "";
  for (const name of names) {
    if (value[name] != null && String(value[name]) !== "") return value[name];
  }
  for (const child of Object.values(value)) {
    const result = deepFind(child, names, depth + 1);
    if (result != null && String(result) !== "") return result;
  }
  return "";
}

function safeGet(value, keys, fallback = "") {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== "object" || !(key in current)) return fallback;
    current = current[key];
  }
  return current == null ? fallback : current;
}

function asArrayDeep(value, keys, depth = 0) {
  if (Array.isArray(value)) return value;
  if (depth > 8 || !value || typeof value !== "object") return [];
  for (const key of keys) {
    if (Array.isArray(value[key])) return value[key];
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      const result = asArrayDeep(child, keys, depth + 1);
      if (result.length) return result;
    }
  }
  return [];
}

function replaceCoverSize(value, size) {
  const raw = String(value ?? "").replace(/\{size\}/g, String(size));
  return safePublicUrl(raw);
}

function mapPlaylist(raw) {
  if (!isPlainObject(raw)) return null;
  const id = String(
    firstNonEmpty(raw.listid, raw.list_id, raw.global_collection_id, raw.specialid, raw.id),
  ).trim();
  if (!IDENTIFIER_RE.test(id)) return null;
  const name = cleanText(
    firstNonEmpty(raw.name, raw.listname, raw.list_name, raw.specialname, raw.title, raw.collection_name),
    200,
  );
  if (!name) return null;
  return {
    provider: PROVIDER,
    source: PROVIDER,
    type: PROVIDER,
    id,
    name,
    cover: replaceCoverSize(
      firstNonEmpty(raw.pic, raw.img, raw.cover, raw.sizable_cover, raw.list_pic, raw.avatar),
      240,
    ),
    trackCount: Math.max(
      0,
      Math.min(
        1_000_000,
        Number(raw.count ?? raw.song_count ?? raw.total ?? raw.file_count ?? raw.songcount) || 0,
      ),
    ),
    creator: cleanText(raw.username ?? raw.nickname ?? raw.user_name ?? "酷狗音乐", 128),
  };
}

function extractQualityHashes(raw, trans) {
  const candidates = {
    standard: firstNonEmpty(raw["128hash"], raw.hash, raw.Hash, raw.file_hash, trans.ogg_128_hash),
    exhigh: firstNonEmpty(raw["320hash"], raw.HQFileHash, trans.ogg_320_hash),
    lossless: firstNonEmpty(raw.sqhash, raw.SQFileHash, raw.flac_hash),
    hires: firstNonEmpty(raw.hrhash, raw.high_hash),
    jymaster: firstNonEmpty(raw.masterhash, raw.jymaster_hash),
  };
  return Object.fromEntries(
    QUALITY_LEVELS.map((level) => {
      const candidate = String(candidates[level] ?? "").trim().toUpperCase();
      return [level, HASH_RE.test(candidate) ? candidate : ""];
    }),
  );
}

function normalizeSimpleTitle(value) {
  return cleanTrackText(value).toLowerCase().replace(/\s+/g, "");
}

function mapTrack(raw) {
  if (!isPlainObject(raw)) return null;
  const trans = isPlainObject(raw.trans_param)
    ? raw.trans_param
    : (isPlainObject(raw.transParam) ? raw.transParam : {});
  const qualityHashes = extractQualityHashes(raw, trans);
  const rawHash = firstNonEmpty(
    raw.hash,
    raw.Hash,
    raw.file_hash,
    raw.FileHash,
    raw.audio_hash,
    raw["320hash"],
    raw["128hash"],
    raw.sqhash,
    raw.SQFileHash,
    raw.HQFileHash,
    trans.ogg_320_hash,
    trans.ogg_128_hash,
  );
  const hash = String(rawHash).trim().toUpperCase();
  const safeHash = HASH_RE.test(hash) ? hash : "";
  const albumAudioId = String(
    firstNonEmpty(
      raw.album_audio_id,
      raw.albumAudioId,
      raw.audio_id,
      raw.audioid,
      raw.Audioid,
      raw.mixsongid,
      raw.songid,
      raw.id,
    ),
  ).trim();
  const safeAlbumAudioId = /^\d{1,24}$/.test(albumAudioId) ? albumAudioId : "";
  const filename = cleanTrackText(firstNonEmpty(raw.filename, raw.FileName));
  let name = cleanTrackText(firstNonEmpty(raw.songname, raw.song_name, raw.name, raw.title));
  let artist = cleanTrackText(
    firstNonEmpty(raw.singername, raw.singer_name, raw.author_name, raw.singer, raw.artist),
  );
  if (!artist && Array.isArray(raw.singerinfo)) {
    artist = raw.singerinfo
      .map((item) => cleanTrackText(item?.name))
      .filter(Boolean)
      .join(" / ");
  }
  if (filename) {
    const parts = filename.split(" - ");
    if (parts.length >= 2) {
      const filenameArtist = cleanTrackText(parts.shift());
      const filenameTitle = cleanTrackText(parts.join(" - "));
      artist ||= filenameArtist;
      if (!name || normalizeSimpleTitle(name) === normalizeSimpleTitle(filename)) name = filenameTitle;
    } else {
      name ||= filename;
    }
  }
  if (name && artist && name.includes(" - ")) {
    const parts = name.split(" - ");
    const possibleArtist = cleanTrackText(parts.shift());
    const possibleTitle = cleanTrackText(parts.join(" - "));
    if (possibleTitle && normalizeSimpleTitle(possibleArtist) === normalizeSimpleTitle(artist)) {
      name = possibleTitle;
    }
  }
  name = cleanTrackText(name).replace(/\s*-\s*$/, "");
  if (!name || (!safeHash && !safeAlbumAudioId)) return null;

  const albumInfo = isPlainObject(raw.albuminfo)
    ? raw.albuminfo
    : (isPlainObject(raw.albumInfo) ? raw.albumInfo : {});
  const albumId = String(firstNonEmpty(raw.album_id, raw.albumid, raw.AlbumID, raw.albumId)).trim();
  const safeAlbumId = /^\d{1,24}$/.test(albumId) ? albumId : "";
  const rawDuration = Math.max(
    0,
    Number(raw.timelength ?? raw.time_length ?? raw.timelen ?? raw.duration ?? raw.interval) || 0,
  );
  const duration = Math.min(24 * 60 * 60 * 1_000, rawDuration > 1_000 ? rawDuration : rawDuration * 1_000);
  const position = Math.max(0, Number(raw.fsort ?? raw.sort ?? raw.position ?? raw.pos) || 0);
  return {
    provider: PROVIDER,
    source: PROVIDER,
    type: PROVIDER,
    id: safeHash || safeAlbumAudioId,
    hash: safeHash,
    qualityHashes,
    albumAudioId: safeAlbumAudioId,
    albumId: safeAlbumId,
    name,
    artist,
    artists: artist ? [{ name: artist }] : [],
    album: cleanText(firstNonEmpty(raw.album_name, raw.albumname, raw.album, albumInfo.name), 200),
    cover: replaceCoverSize(
      firstNonEmpty(raw.pic, raw.img, raw.image, raw.cover, raw.sizable_cover, trans.union_cover),
      300,
    ),
    duration,
    fee: Math.max(
      0,
      Number(raw.privilege ?? raw.media_privilege ?? raw.media_pay_type ?? raw.pay_type) || 0,
    ),
    fsort: position,
    position,
    sort: position,
    playable: Boolean(safeHash),
  };
}

function sortCloudTracks(tracks) {
  return tracks.slice().sort((left, right) => {
    const leftPosition = Number(left?.fsort ?? left?.sort ?? left?.position ?? left?.pos) || 0;
    const rightPosition = Number(right?.fsort ?? right?.sort ?? right?.position ?? right?.pos) || 0;
    if (leftPosition || rightPosition) return leftPosition - rightPosition;
    const leftCollected = Number(left?.collecttime ?? left?.collect_time) || 0;
    const rightCollected = Number(right?.collecttime ?? right?.collect_time) || 0;
    return leftCollected - rightCollected;
  });
}

function normalizeQualityHashes(value) {
  if (value == null) return {};
  if (!isPlainObject(value)) throw makeError("invalid_quality_hashes", 400);
  for (const key of Object.keys(value)) {
    if (!QUALITY_SET.has(key)) throw makeError("invalid_quality_hashes", 400);
  }
  const result = {};
  for (const level of QUALITY_LEVELS) {
    const raw = String(value[level] ?? "").trim();
    result[level] = raw ? normalizeHash(raw, { label: "quality_hash" }) : "";
  }
  return result;
}

function selectQualityHash(baseHash, quality, hashes) {
  for (const level of QUALITY_FALLBACKS[quality]) {
    if (hashes[level]) return { hash: hashes[level], level };
  }
  return { hash: baseHash, level: quality };
}

function pruneQrSessions(sessions) {
  const now = Date.now();
  for (const [key, value] of sessions) {
    if (!value || value.expiresAt <= now) sessions.delete(key);
  }
  while (sessions.size >= MAX_QR_SESSIONS) sessions.delete(sessions.keys().next().value);
}

export async function createKugouProvider({
  authFile,
  fetchImpl = fetch,
  qrCode,
} = {}) {
  if (typeof fetchImpl !== "function") throw makeError("invalid_fetch_implementation", 500);
  if (typeof authFile !== "string" || !authFile.trim() || authFile.includes("\u0000")) {
    throw makeError("auth_file_required", 500);
  }
  const resolvedAuthFile = path.resolve(authFile);
  await mkdir(path.dirname(resolvedAuthFile), { recursive: true });

  const qrLibrary = qrCode ?? require("qrcode");
  const toDataUrl = typeof qrLibrary === "function"
    ? qrLibrary
    : qrLibrary?.toDataURL?.bind(qrLibrary);
  if (typeof toDataUrl !== "function") throw makeError("invalid_qr_code_implementation", 500);

  let state = await loadAuthState(resolvedAuthFile);
  let saveTail = Promise.resolve();
  const qrSessions = new Map();
  const qualityMetadataCache = new Map();

  function persistState() {
    const snapshot = serializeState(state);
    saveTail = saveTail.catch(() => {}).then(async () => {
      const temporaryFile = `${resolvedAuthFile}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryFile, snapshot, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await chmod(temporaryFile, 0o600);
        await rename(temporaryFile, resolvedAuthFile);
        await chmod(resolvedAuthFile, 0o600);
      } catch (error) {
        await unlink(temporaryFile).catch(() => {});
        throw error;
      }
    });
    return saveTail;
  }

  function publicProviderMessage(value) {
    let message = safeProviderMessage(value);
    const secrets = [
      state.session?.token,
      state.device?.guid,
      state.device?.mid,
      state.device?.mac,
      state.device?.dev,
      state.device?.dfid === "-" ? "" : state.device?.dfid,
    ].filter(Boolean);
    for (const secret of secrets) message = message.split(secret).join("[redacted]");
    return message;
  }

  function safeOutcomeCode(value, fallback = "") {
    const normalized = cleanText(value, 80).toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
    return normalized.replace(/^_+|_+$/g, "") || fallback;
  }

  function responseCode(value) {
    for (const candidate of [value?.error_code, value?.errcode, value?.status, value?.code]) {
      const code = Number(candidate);
      if (Number.isFinite(code) && code !== 0) return code;
    }
    return 0;
  }

  function providerAuthRejected(value) {
    const code = responseCode(value);
    if ([401, 403, 1001, 1002, 20001, 20002].includes(code)) return true;
    const message = cleanText(value?.error || value?.errmsg || value?.message, 200).toLowerCase();
    return /(?:token|session|login|auth).*(?:invalid|expired|rejected)|(?:invalid|expired).*(?:token|session)/i.test(message);
  }

  function accountRestriction() {
    if (!state.session) return "login_required";
    if (state.validation.validationState === "stale") return "stale_session";
    return "";
  }

  function classifyProviderRestriction(response, data, requestedQuality) {
    const code = responseCode(response);
    const message = publicProviderMessage(
      response?.error || response?.errmsg || response?.message ||
      data?.error || data?.errmsg || data?.message,
    );
    const normalized = message.toLowerCase();
    if (providerAuthRejected(response) || providerAuthRejected(data)) return "stale_session";
    if (/region|geo|地区|区域|海外|所在国家/.test(normalized)) return "region_restricted";
    if (/copyright|版权|下架|已失效|not available/.test(normalized)) return "copyright_unavailable";
    if (/quality|音质|码率|hash/.test(normalized) || (code === 404 && requestedQuality !== "standard")) {
      return "quality_unavailable";
    }
    if (/vip|paid|pay|会员|付费|购买|权益/.test(normalized) || [3, 6, 8, 20010, 20011].includes(code)) {
      return "paid_required";
    }
    return state.session ? "provider_contract_changed" : "login_required";
  }

  function restrictionDetails(category, { code = 0, rawMessage = "" } = {}) {
    const details = {
      login_required: ["login", "酷狗歌曲需要登录后获取播放地址"],
      stale_session: ["login", "酷狗登录会话已失效，请重新登录"],
      device_registration_failed: ["retry", "酷狗设备注册失败，播放尚未就绪"],
      paid_required: ["upgrade", "当前酷狗账号没有该歌曲的播放权限，可能需要会员或购买"],
      copyright_unavailable: ["none", "该歌曲因版权原因暂不可播放"],
      region_restricted: ["none", "该歌曲在当前地区不可播放"],
      quality_unavailable: ["change_quality", "请求的音质暂不可用"],
      stream_host_rejected: ["none", "酷狗返回了不受信任的播放地址"],
      provider_contract_changed: ["retry", "酷狗响应格式已变化，暂时无法解析播放地址"],
      provider_unavailable: ["retry", "酷狗服务暂时不可用，请稍后重试"],
    };
    const [action, message] = details[category] || details.provider_contract_changed;
    return {
      provider: PROVIDER,
      category,
      action,
      message,
      code: Number(code) || 0,
      rawMessage: publicProviderMessage(rawMessage),
    };
  }

  await persistState();

  function cookieHeader() {
    const session = state.session;
    const pairs = [
      ["userid", session?.userId],
      ["token", session?.token],
      ["dfid", state.device.dfid],
      ["KUGOU_API_MID", state.device.mid],
      ["KUGOU_API_GUID", state.device.guid],
      ["KUGOU_API_MAC", state.device.mac],
      ["KUGOU_API_DEV", state.device.dev],
    ];
    return pairs
      .filter(([, value]) => value != null && String(value) !== "")
      .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
      .join("; ");
  }

  function cloudlistCookieHeader() {
    const pairs = [
      ["userid", state.session?.userId],
      ["token", state.session?.token],
      ["KUGOU_API_MID", state.device.mid],
    ];
    return pairs
      .filter(([, value]) => value != null && String(value) !== "")
      .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
      .join("; ");
  }

  async function fetchFixed(urlValue, init = {}, responseType = "json", redirectCount = 0) {
    const target = new URL(urlValue);
    if (!FIXED_API_ORIGINS.has(target.origin) || target.username || target.password || target.port) {
      throw makeError("provider_origin_rejected");
    }
    const controller = new AbortController();
    let timer;
    try {
      const request = Promise.resolve().then(() => fetchImpl(target, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
      }));
      const response = await Promise.race([
        request,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(makeError("provider_timeout", 504));
          }, REQUEST_TIMEOUT_MS);
        }),
      ]);
      const statusCode = Number(response?.status) || 0;
      if (statusCode >= 300 && statusCode < 400) {
        const location = headerValue(response, "location");
        if (!location || redirectCount >= 2) throw makeError("provider_redirect_rejected");
        const next = new URL(location, target);
        if (next.origin !== target.origin) throw makeError("provider_cross_origin_redirect_rejected");
        return fetchFixed(next, init, responseType, redirectCount + 1);
      }
      if (!(response?.ok ?? (statusCode >= 200 && statusCode < 300))) {
        const error = makeError(
          statusCode === 401 || statusCode === 403
            ? "provider_auth_rejected"
            : "provider_request_failed",
          statusCode || 502,
        );
        error.providerStatus = statusCode;
        throw error;
      }
      if (responseType === "buffer") return responseBuffer(response);
      const text = await responseText(response);
      if (responseType === "text") return text;
      return parseJson(text);
    } catch (error) {
      if (error?.code && (String(error.code).startsWith("provider_") ||
          String(error.code).startsWith("invalid_provider_"))) {
        throw error;
      }
      if (error?.name === "AbortError") throw makeError("provider_timeout", 504);
      throw makeError("provider_unavailable");
    } finally {
      clearTimeout(timer);
    }
  }

  async function gatewayRequest(pathname, options = {}) {
    if (typeof pathname !== "string" || !pathname.startsWith("/") || pathname.includes("\\")) {
      throw makeError("invalid_provider_path", 500);
    }
    const origin = options.origin || GATEWAY_ORIGIN;
    if (!FIXED_API_ORIGINS.has(origin)) throw makeError("provider_origin_rejected");
    const clientTime = String(Math.floor(Date.now() / 1_000));
    const params = {
      dfid: state.device.dfid,
      mid: state.device.mid,
      uuid: "-",
      appid: APP_ID,
      clientver: CLIENT_VERSION,
      clienttime: clientTime,
      ...(options.params || {}),
    };
    if (state.session?.token && !params.token) params.token = state.session.token;
    if (state.session?.userId && !params.userid) params.userid = state.session.userId;

    const hasBody = options.data != null;
    const dataString = hasBody
      ? (typeof options.data === "string" ? options.data : JSON.stringify(options.data))
      : "";
    if (!options.noSignature && !params.signature) {
      params.signature = options.signatureType === "web"
        ? webSignature(params)
        : androidSignature(params, dataString);
    }
    const target = new URL(pathname, origin);
    for (const [key, value] of Object.entries(params)) {
      if (value != null) target.searchParams.set(key, String(value));
    }
    const headers = {
      "User-Agent": ANDROID_USER_AGENT,
      "kg-rc": "1",
      "kg-thash": "5d816a0",
      "kg-rec": "1",
      "kg-rf": "B9EDA08A64250DEFFBCADDEE00F8F25F",
      dfid: state.device.dfid,
      mid: state.device.mid,
      clienttime: clientTime,
      ...(options.headers || {}),
    };
    const cookie = cookieHeader();
    if (cookie) headers.Cookie = cookie;
    if (hasBody && typeof options.data !== "string") headers["Content-Type"] = "application/json";
    return fetchFixed(
      target,
      {
        method: String(options.method || "GET").toUpperCase(),
        headers,
        ...(hasBody ? { body: dataString } : {}),
      },
      options.responseType || "json",
    );
  }

  async function fetchVipProfile() {
    const response = await gatewayRequest("/v1/get_union_vip", {
      origin: VIP_ORIGIN,
      params: { busi_type: "concept" },
    });
    if (providerAuthRejected(response)) throw makeError("provider_auth_rejected", 401);
    const errorCode = Number(response?.error_code ?? response?.errcode) || 0;
    const status = Number(response?.status ?? response?.code) || 0;
    if (errorCode > 0 || status <= 0) throw makeError("provider_unavailable");
    const data = isPlainObject(response?.data) ? response.data : response;
    const isVip = Number(data?.is_vip ?? data?.isVip) > 0 || data?.is_vip === true || data?.isVip === true;
    const vipType = Math.max(
      isVip ? 1 : 0,
      Math.min(1_000_000, Math.max(0, Number(data?.vip_type ?? data?.vipType ?? data?.viptype) || 0)),
    );
    const svipLevel = Math.min(
      1_000_000,
      Math.max(0, Number(data?.svip_level ?? data?.svipLevel ?? data?.sviplevel) || 0),
    );
    return { vipType, svipLevel };
  }

  async function fetchAudioQualityHashes(baseHash) {
    const cached = qualityMetadataCache.get(baseHash);
    if (cached && cached.expiresAt > Date.now()) return cached.hashes;
    const requestTime = Date.now();
    const response = await gatewayRequest("/v1/audio/audio", {
      method: "POST",
      headers: { "x-router": "kmr.service.kugou.com" },
      data: {
        appid: Number(APP_ID),
        clienttime: requestTime,
        clientver: Number(CLIENT_VERSION),
        data: [{ hash: baseHash, audio_id: 0 }],
        dfid: state.device.dfid,
        key: md5(`${APP_ID}${ANDROID_SIGNATURE_KEY}${CLIENT_VERSION}${requestTime}`),
        mid: state.device.mid,
        ...(state.session?.token ? { token: state.session.token } : {}),
        ...(state.session?.userId ? { userid: state.session.userId } : {}),
      },
    });
    if (providerAuthRejected(response)) throw makeError("provider_auth_rejected", 401);
    const errorCode = Number(response?.error_code ?? response?.errcode) || 0;
    const status = Number(response?.status ?? response?.code) || 0;
    if (errorCode > 0 || status <= 0) throw makeError("provider_unavailable");
    const rows = Array.isArray(response?.data)
      ? response.data
      : (Array.isArray(response?.data?.data) ? response.data.data : []);
    const row = rows.find((value) => isPlainObject(value)) || {};
    function safeHash(...values) {
      const value = firstNonEmpty(...values);
      try {
        return normalizeHash(value, { optional: true, label: "quality_hash" });
      } catch {
        return "";
      }
    }
    const hashes = {
      // `hash_super` is Kugou's DSD/super source, not the Viper master source.
      // Keep the master tier truthful and only accept fields explicitly marked as master.
      jymaster: safeHash(row.masterhash, row.jymaster_hash),
      hires: safeHash(row.hash_high, row.high_hash, row.hrhash),
      lossless: safeHash(row.hash_flac, row.flac_hash, row.hash_ape, row.sqhash),
      exhigh: safeHash(row.hash_320, row["320hash"], row.HQFileHash),
      standard: safeHash(row.hash_128, row["128hash"], row.hash, baseHash),
    };
    while (qualityMetadataCache.size >= 512) {
      qualityMetadataCache.delete(qualityMetadataCache.keys().next().value);
    }
    qualityMetadataCache.set(baseHash, {
      hashes,
      expiresAt: Date.now() + QUALITY_METADATA_TTL_MS,
    });
    return hashes;
  }

  async function cloudlistRequest(pathname, params, data) {
    const clientTime = String(Math.floor(Date.now() / 1_000));
    const finalParams = {
      dfid: state.device.dfid,
      mid: state.device.mid,
      uuid: "-",
      appid: APP_ID,
      clientver: CLIENT_VERSION,
      clienttime: clientTime,
      userid: state.session?.userId || "",
      token: state.session?.token || "",
      ...(params || {}),
    };
    const dataString = data == null ? "" : JSON.stringify(data);
    finalParams.signature = androidSignature(finalParams, dataString);
    const target = new URL(pathname, GATEWAY_ORIGIN);
    for (const [key, value] of Object.entries(finalParams)) {
      if (value != null) target.searchParams.set(key, String(value));
    }
    return fetchFixed(target, {
      method: dataString ? "POST" : "GET",
      headers: {
        "User-Agent": ANDROID_USER_AGENT,
        "x-router": "cloudlist.service.kugou.com",
        "kg-rc": "1",
        "kg-thash": "5d816a0",
        "kg-rec": "1",
        "kg-rf": "B9EDA08A64250DEFFBCADDEE00F8F25F",
        dfid: state.device.dfid,
        mid: state.device.mid,
        clienttime: clientTime,
        "Content-Type": "application/json",
        Cookie: cloudlistCookieHeader(),
      },
      ...(dataString ? { body: dataString } : {}),
    });
  }

  async function registerDevice() {
    if (!state.session) return false;
    const attemptedAt = new Date().toISOString();
    const dataMap = {
      availableRamSize: 4_983_533_568,
      availableRomSize: 48_114_719,
      availableSDSize: 48_114_717,
      basebandVer: "",
      batteryLevel: 100,
      batteryStatus: 3,
      brand: "Redmi",
      buildSerial: "unknown",
      device: "marble",
      imei: state.device.guid,
      imsi: "",
      manufacturer: "Xiaomi",
      uuid: state.device.guid,
      accelerometerValue: "",
      gravity: false,
      gravityValue: "",
      gyroscope: false,
      gyroscopeValue: "",
      light: false,
      lightValue: "",
      magnetic: false,
      magneticValue: "",
      orientation: false,
      orientationValue: "",
      pressure: false,
      pressureValue: "",
      step_counter: false,
      step_counterValue: "",
      temperature: false,
      temperatureValue: "",
      accelerometer: false,
    };
    const aesKey = randomLowercaseString(6);
    const digest = md5(aesKey);
    const key = Buffer.from(digest.slice(0, 16), "utf8");
    const iv = Buffer.from(digest.slice(16, 32), "utf8");
    const cipher = createCipheriv("aes-128-cbc", key, iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(dataMap), "utf8"),
      cipher.final(),
    ]).toString("base64");
    const rsaPayload = JSON.stringify({
      aes: aesKey,
      uid: state.session.userId,
      token: state.session.token,
    });
    const encryptedParams = publicEncrypt(
      { key: KUGOU_RSA_PUBLIC_KEY, padding: cryptoConstants.RSA_PKCS1_PADDING },
      Buffer.from(rsaPayload),
    ).toString("hex");
    try {
      const response = await gatewayRequest("/risk/v2/r_register_dev", {
        origin: USER_SERVICE_ORIGIN,
        method: "POST",
        responseType: "buffer",
        params: { part: 1, platid: 1, p: encryptedParams },
        data: encrypted,
        headers: { "x-router": "userservice.kugou.com" },
      });
      let parsed;
      const plain = response.toString("utf8").trim();
      if (plain.startsWith("{")) {
        parsed = parseJson(plain);
      } else {
        const decipher = createDecipheriv("aes-128-cbc", key, iv);
        const decrypted = Buffer.concat([decipher.update(response), decipher.final()]).toString("utf8");
        parsed = parseJson(decrypted);
      }
      const dfid = String(safeGet(parsed, ["data", "dfid"], "")).trim();
      const code = responseCode(parsed);
      if (!dfid || !DFID_RE.test(dfid) || (code && code !== 1 && code !== 200)) {
        throw makeError(code ? `device_registration_${code}` : "device_registration_rejected");
      }
      state = {
        ...state,
        device: { ...state.device, dfid },
        deviceRegistration: {
          registrationState: "registered",
          attemptedAt,
          registeredAt: new Date().toISOString(),
          code: code ? String(code) : "ok",
        },
      };
      await persistState();
      return true;
    } catch (error) {
      state = {
        ...state,
        deviceRegistration: {
          registrationState: "failed",
          attemptedAt,
          registeredAt: "",
          code: safeOutcomeCode(error?.code, "provider_unavailable"),
        },
      };
      await persistState();
      return false;
    }
  }

  async function loginStatus() {
    const session = state.session;
    const hasLocalSession = Boolean(session?.userId && session?.token);
    const accountValidated = hasLocalSession && state.validation.validationState === "valid";
    const deviceRegistered = state.deviceRegistration.registrationState === "registered";
    const restrictionCode = accountRestriction();
    const playbackReady = hasLocalSession && state.validation.validationState !== "stale";
    const vipType = hasLocalSession ? Math.max(0, Number(session.vipType) || 0) : 0;
    const svipLevel = hasLocalSession ? Math.max(0, Number(session.svipLevel) || 0) : 0;
    const isSvip = svipLevel > 0;
    const isVip = isSvip || vipType > 0;
    return {
      provider: PROVIDER,
      loggedIn: hasLocalSession,
      hasCookie: hasLocalSession,
      hasLocalSession,
      storedLocalSession: hasLocalSession,
      accountValidated,
      validationState: state.validation.validationState,
      validatedAt: state.validation.validatedAt,
      validationAttemptedAt: state.validation.lastAttemptAt,
      validationCode: publicProviderMessage(state.validation.code),
      deviceRegistered,
      deviceRegistrationState: state.deviceRegistration.registrationState,
      deviceRegistrationAttemptedAt: state.deviceRegistration.attemptedAt,
      deviceRegisteredAt: state.deviceRegistration.registeredAt,
      deviceRegistrationCode: publicProviderMessage(state.deviceRegistration.code),
      playbackReady,
      playbackKeyReady: playbackReady,
      restrictionCode,
      userId: hasLocalSession ? session.userId : "",
      nickname: hasLocalSession ? (session.nickname || "酷狗音乐用户") : "酷狗音乐",
      avatar: hasLocalSession ? session.avatar : "",
      vipType,
      svipLevel,
      vipLevel: isSvip ? "svip" : (isVip ? "vip" : "none"),
      isVip,
      isSvip,
      vipLabel: isSvip ? "Kugou SVIP" : (isVip ? "Kugou VIP" : "无 VIP"),
      preview: !playbackReady,
      message: !hasLocalSession
        ? "未登录酷狗音乐"
        : (restrictionCode === "stale_session"
          ? "酷狗本机会话已失效，请重新登录"
          : (accountValidated
            ? (deviceRegistered ? "酷狗账号已验证" : "酷狗账号已验证；设备注册未完成，将直接尝试播放")
            : "已保存酷狗网页登录会话；播放时将继续确认账号与歌曲权限")),
    };
  }

  async function validateSession() {
    if (!state.session) return { ...(await loginStatus()), ok: false };
    const lastAttemptAt = new Date().toISOString();
    try {
      const data = await gatewayRequest("/v7/get_all_list", {
        method: "POST",
        params: {
          total_ver: 979,
          type: 2,
          page: 1,
          pagesize: 1,
          userid: state.session.userId,
          token: state.session.token,
        },
        data: {
          total_ver: 979,
          type: 2,
          page: 1,
          pagesize: 1,
          userid: Number(state.session.userId) || state.session.userId,
          token: state.session.token,
        },
        headers: { "x-router": "cloudlist.service.kugou.com" },
      });
      if (providerAuthRejected(data)) throw makeError("provider_auth_rejected", 401);
      const providerErrorCode = [data?.error_code, data?.errcode]
        .map(Number)
        .find((code) => Number.isFinite(code) && code > 0) || 0;
      const providerSuccessCode = [data?.status, data?.code]
        .map(Number)
        .find((code) => Number.isFinite(code) && code > 0) || 0;
      if (providerErrorCode > 0 || providerSuccessCode <= 0) {
        throw makeError("provider_unavailable");
      }
      let vipProfile = null;
      try {
        vipProfile = await fetchVipProfile();
      } catch {
        // VIP metadata is useful for tracker authorization and display, but a
        // temporary VIP endpoint failure must not invalidate a proven session.
      }
      state = {
        ...state,
        session: vipProfile ? { ...state.session, ...vipProfile } : state.session,
        validation: {
          validationState: "valid",
          validatedAt: new Date().toISOString(),
          lastAttemptAt,
          code: "ok",
        },
      };
      await persistState();
      return { ...(await loginStatus()), ok: true };
    } catch (error) {
      const rejected = error?.code === "provider_auth_rejected";
      state = {
        ...state,
        validation: {
          ...state.validation,
          validationState: rejected ? "stale" : "unavailable",
          lastAttemptAt,
          code: safeOutcomeCode(error?.code, rejected ? "auth_rejected" : "provider_unavailable"),
        },
      };
      await persistState();
      return { ...(await loginStatus()), ok: false };
    }
  }

  async function loginCookie(rawCookie) {
    const imported = parseKugouCookieInput(rawCookie);
    const previousState = {
      ...state,
      device: { ...state.device },
      session: state.session ? { ...state.session } : null,
      validation: { ...state.validation },
      deviceRegistration: { ...state.deviceRegistration },
    };
    const identityChanged = ["guid", "mid", "mac", "dev"].some(
      (key) => imported.device[key] && imported.device[key] !== state.device[key],
    );
    const deviceInput = { ...state.device, ...imported.device };
    if (imported.device.guid && !imported.device.mid) {
      deviceInput.mid = calculateMid(imported.device.guid);
    }
    if (identityChanged && !Object.hasOwn(imported.device, "dfid")) deviceInput.dfid = "-";
    const device = createDeviceIdentity(deviceInput);
    const importedDfid = Object.hasOwn(imported.device, "dfid") && imported.device.dfid !== "-";
    const keepRegistration = !identityChanged && !Object.hasOwn(imported.device, "dfid");
    const now = new Date().toISOString();

    state = {
      ...state,
      device,
      session: normalizeSession(imported.session),
      validation: normalizeValidation(null, true),
      deviceRegistration: importedDfid
        ? {
            registrationState: "registered",
            attemptedAt: now,
            registeredAt: now,
            code: "imported",
          }
        : (keepRegistration
          ? { ...state.deviceRegistration }
          : normalizeDeviceRegistration(null, device)),
    };
    await persistState();

    const validated = await validateSession();
    if (validated.validationState === "stale" || validated.restrictionCode === "stale_session") {
      state = previousState;
      await persistState();
      throw makeError("invalid_provider_credentials", 401);
    }

    if (state.deviceRegistration.registrationState !== "registered") {
      void registerDevice().catch(() => {});
    }
    return {
      ...(await loginStatus()),
      saved: true,
    };
  }

  async function loginQrKey() {
    pruneQrSessions(qrSessions);
    const qrPrefix = `https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=${APP_ID}&`;
    const data = await gatewayRequest("/v2/qrcode", {
      origin: LOGIN_ORIGIN,
      signatureType: "web",
      params: {
        appid: QR_APP_ID,
        type: 1,
        plat: 4,
        qrcode_txt: qrPrefix,
        srcappid: QR_SOURCE_APP_ID,
      },
      headers: {
        "User-Agent": BROWSER_USER_AGENT,
        "x-router": "login-user.kugou.com",
      },
    });
    const rawKey = safeGet(data, ["data", "qrcode"], "") || data.qrcode || data.key || "";
    const key = String(rawKey).trim();
    if (!QR_KEY_RE.test(key)) throw makeError("kugou_qr_key_failed");
    const url = `https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=${encodeURIComponent(key)}`;
    const img = await toDataUrl(url, {
      margin: 1,
      width: 220,
      errorCorrectionLevel: "M",
    });
    if (typeof img !== "string" || !img.startsWith("data:image/") || img.length > 1_000_000) {
      throw makeError("kugou_qr_image_failed");
    }
    qrSessions.set(key, {
      expiresAt: Date.now() + QR_TTL_MS,
      deviceGuid: state.device.guid,
    });
    return {
      provider: PROVIDER,
      key,
      qrcode: key,
      url,
      img,
      deviceId: state.device.guid,
    };
  }

  async function loginQrCheck(keyValue) {
    const key = String(keyValue ?? "").trim();
    if (!QR_KEY_RE.test(key)) throw makeError("invalid_qr_key", 400);
    pruneQrSessions(qrSessions);
    const issued = qrSessions.get(key);
    if (!issued || issued.expiresAt <= Date.now() || issued.deviceGuid !== state.device.guid) {
      qrSessions.delete(key);
      return {
        provider: PROVIDER,
        loggedIn: false,
        code: 800,
        status: 0,
        rawStatus: 0,
        message: "Kugou QR key expired",
      };
    }
    const data = await gatewayRequest("/v2/get_userinfo_qrcode", {
      origin: LOGIN_ORIGIN,
      signatureType: "web",
      params: {
        plat: 4,
        appid: APP_ID,
        srcappid: QR_SOURCE_APP_ID,
        qrcode: key,
      },
      headers: {
        "User-Agent": BROWSER_USER_AGENT,
        "x-router": "login-user.kugou.com",
      },
    });
    const status = Math.max(
      0,
      Number(safeGet(data, ["data", "status"], data.status || deepFind(data, ["status"]))) || 0,
    );
    const token = String(
      safeGet(data, ["data", "token"], "") ||
      deepFind(data, ["token", "user_token", "access_token", "key"]) ||
      data.token || "",
    ).trim();
    const userId = String(
      safeGet(data, ["data", "userid"], "") ||
      deepFind(data, ["userid", "user_id", "uid", "kugooid", "kugouid"]) ||
      data.userid || "",
    ).replace(/\D/g, "");
    const message = publicProviderMessage(data.message || data.msg || data.error_msg);

    if (!(token && userId)) {
      if (status !== 4) {
        const code = status === 2 ? 802 : (status === 3 ? 800 : 801);
        if (code === 800) qrSessions.delete(key);
        return {
          provider: PROVIDER,
          loggedIn: false,
          code,
          status,
          rawStatus: status,
          message,
        };
      }
      qrSessions.delete(key);
      return {
        provider: PROVIDER,
        loggedIn: false,
        code: 803,
        status,
        rawStatus: status,
        error: "KUGOU_TOKEN_MISSING",
        message: "Kugou login confirmed but token was not returned",
      };
    }

    if (!USER_ID_RE.test(userId) || token.length > 2_048 || /[\u0000-\u001f\u007f]/.test(token)) {
      qrSessions.delete(key);
      throw makeError("invalid_provider_credentials");
    }
    const nickname = cleanText(
      safeGet(data, ["data", "nickname"], "") ||
      safeGet(data, ["data", "username"], "") ||
      deepFind(data, ["nickname", "nick", "username", "user_name", "uname"]),
      128,
    );
    const avatar = safePublicUrl(
      safeGet(data, ["data", "pic"], "") ||
      safeGet(data, ["data", "avatar"], "") ||
      safeGet(data, ["data", "img"], "") ||
      safeGet(data, ["data", "user_pic"], "") ||
      deepFind(data, ["avatar", "pic", "img", "icon", "headpic", "head_img", "headimg", "user_pic", "userpic"]),
      { providerOnly: true },
    );
    const vipType = Math.max(
      0,
      Math.min(
        1_000_000,
        Number(
          safeGet(data, ["data", "vip_type"], 0) ||
          safeGet(data, ["data", "vipType"], 0) ||
          safeGet(data, ["data", "viptype"], 0) ||
          deepFind(data, ["vip_type", "vipType", "viptype", "isvip", "is_vip", "vip"]),
        ) || 0,
      ),
    );
    const svipLevel = Math.max(
      0,
      Math.min(
        1_000_000,
        Number(
          safeGet(data, ["data", "svip_level"], 0) ||
          safeGet(data, ["data", "svipLevel"], 0) ||
          deepFind(data, ["svip_level", "svipLevel", "sviplevel"]),
        ) || 0,
      ),
    );
    state = {
      ...state,
      session: { userId, token, nickname, avatar, vipType, svipLevel },
      validation: {
        validationState: "unvalidated",
        validatedAt: "",
        lastAttemptAt: "",
        code: "",
      },
      deviceRegistration: {
        registrationState: "unregistered",
        attemptedAt: "",
        registeredAt: "",
        code: "",
      },
    };
    await persistState();
    qrSessions.delete(key);
    // Device registration is a best-effort compatibility hint. The session is
    // already durable at this point, so a slow registration endpoint must not
    // turn a successful QR login into a client-side timeout.
    void registerDevice().catch(() => {});
    void validateSession().catch(() => {});
    return {
      ...(await loginStatus()),
      code: 803,
      status,
      rawStatus: status,
      saved: true,
    };
  }

  async function logout() {
    state = {
      ...state,
      session: null,
      validation: normalizeValidation(null, false),
      deviceRegistration: normalizeDeviceRegistration(null, state.device),
    };
    qrSessions.clear();
    await persistState();
    return { provider: PROVIDER, ok: true, loggedIn: false };
  }

  async function userPlaylists() {
    const info = await loginStatus();
    if (!info.loggedIn) return { loggedIn: false, provider: PROVIDER, playlists: [] };
    const data = await gatewayRequest("/v7/get_all_list", {
      method: "POST",
      params: {
        total_ver: 979,
        type: 2,
        page: 1,
        pagesize: 200,
        userid: state.session.userId,
        token: state.session.token,
      },
      data: {
        total_ver: 979,
        type: 2,
        page: 1,
        pagesize: 200,
        userid: Number(state.session.userId) || state.session.userId,
        token: state.session.token,
      },
      headers: { "x-router": "cloudlist.service.kugou.com" },
    });
    const rawPlaylists = asArrayDeep(
      data,
      ["lists", "list", "info", "data", "listinfo", "collection_list", "playlist"],
    );
    const seen = new Set();
    const playlists = [];
    for (const raw of rawPlaylists) {
      const playlist = mapPlaylist(raw);
      if (!playlist || seen.has(playlist.id)) continue;
      seen.add(playlist.id);
      playlists.push(playlist);
    }
    return {
      ...info,
      loggedIn: true,
      provider: PROVIDER,
      userId: info.userId,
      playlists,
      rawStatus: Number(data.status ?? data.errcode ?? data.error_code) || 0,
    };
  }

  async function playlistTracks(idValue) {
    const info = await loginStatus();
    if (!info.loggedIn) return { loggedIn: false, provider: PROVIDER, tracks: [] };
    const id = cleanIdentifier(idValue, "playlist_id");
    let detail;
    let rawTracks = [];
    try {
      let page = 1;
      let total = 0;
      do {
        detail = await cloudlistRequest(
          "/v4/get_list_all_file",
          { listid: id, page, pagesize: PLAYLIST_PAGE_SIZE },
          {
            listid: id,
            page,
            pagesize: PLAYLIST_PAGE_SIZE,
            area_code: 1,
            show_relate_goods: 0,
            allplatform: 1,
            show_cover: 1,
            type: 0,
            userid: Number(state.session.userId) || state.session.userId,
            token: state.session.token,
          },
        );
        if (!detail || Number(detail.status) === 0 ||
            Number(detail.error_code ?? detail.errcode) > 0) {
          throw makeError("kugou_cloudlist_failed");
        }
        const pageTracks = asArrayDeep(
          detail,
          ["songs", "songlist", "list", "info", "files", "data"],
        );
        rawTracks.push(...pageTracks);
        total = Math.max(
          rawTracks.length,
          Number(detail?.data?.count ?? detail?.data?.total) || rawTracks.length,
        );
        if (!pageTracks.length || rawTracks.length >= total) break;
        page += 1;
      } while (page <= MAX_PLAYLIST_PAGES);
    } catch {
      detail = await gatewayRequest("/pubsongs/v2/get_other_list_file_nofilt", {
        params: {
          id,
          global_collection_id: id,
          page: 1,
          pagesize: 500,
          area_code: 1,
          plat: 1,
          type: 1,
          mode: 1,
          personal_switch: 1,
          extend_fields: "abtags,hot_cmt,popularization",
        },
        headers: { "x-router": "pubsongscdn.kugou.com" },
      });
      rawTracks = asArrayDeep(
        detail,
        ["songs", "songlist", "list", "info", "files", "data"],
      );
    }
    const tracks = sortCloudTracks(rawTracks).map(mapTrack).filter(Boolean);
    return {
      loggedIn: true,
      provider: PROVIDER,
      playlist: { provider: PROVIDER, id, name: "", trackCount: tracks.length },
      tracks,
    };
  }

  async function lyric(trackValue) {
    if (!isPlainObject(trackValue)) throw makeError("invalid_track", 400);
    const hash = normalizeHash(trackValue.hash);
    const duration = Math.min(
      24 * 60 * 60 * 1_000,
      Math.max(0, Math.round(Number(trackValue.duration) || 0)),
    );
    const searchUrl = new URL("/search", LYRICS_ORIGIN);
    searchUrl.searchParams.set("ver", "1");
    searchUrl.searchParams.set("man", "yes");
    searchUrl.searchParams.set("client", "pc");
    searchUrl.searchParams.set("hash", hash);
    if (duration > 0) searchUrl.searchParams.set("duration", String(duration));
    const search = await fetchFixed(searchUrl, {
      headers: { "User-Agent": BROWSER_USER_AGENT },
    });
    const candidates = Array.isArray(search?.candidates) ? search.candidates : [];
    const candidate = candidates.find((value) => {
      const id = String(value?.id ?? "").trim();
      const accessKey = String(value?.accesskey ?? value?.access_key ?? "").trim();
      return LYRIC_CANDIDATE_RE.test(id) && LYRIC_CANDIDATE_RE.test(accessKey);
    });
    if (!candidate) {
      return {
        provider: PROVIDER,
        lyric: "",
        tlyric: "",
        yrc: "",
        source: "kugou-empty",
      };
    }

    const candidateId = String(candidate.id).trim();
    const accessKey = String(candidate.accesskey ?? candidate.access_key).trim();
    const downloadUrl = new URL("/download", LYRICS_ORIGIN);
    downloadUrl.searchParams.set("ver", "1");
    downloadUrl.searchParams.set("client", "pc");
    downloadUrl.searchParams.set("id", candidateId);
    downloadUrl.searchParams.set("accesskey", accessKey);
    downloadUrl.searchParams.set("fmt", "lrc");
    downloadUrl.searchParams.set("charset", "utf8");
    const body = await fetchFixed(downloadUrl, {
      headers: { "User-Agent": BROWSER_USER_AGENT },
    });
    const text = decodeKugouLyricContent(body?.content);
    return {
      provider: PROVIDER,
      lyric: text,
      tlyric: "",
      yrc: "",
      source: text ? "kugou-lyrics" : "kugou-empty",
    };
  }

  async function trackerPlayUrl(hash, { albumAudioId, albumId } = {}) {
    const session = state.session;
    const params = {
      cmd: "26",
      hash,
      behavior: "play",
      appid: APP_ID,
      pid: "2",
      mid: state.device.mid,
      userid: session?.userId || "0",
      version: CLIENT_VERSION,
      vipType: String(session?.vipType || 0),
      token: session?.token || "0",
      key: md5(hash + PLAY_KEY_SALT + APP_ID + state.device.mid + (session?.userId || "0")),
    };
    if (albumAudioId) params.album_audio_id = albumAudioId;
    if (albumId) params.album_id = albumId;
    const target = new URL("/i/v2/", TRACKER_ORIGIN);
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, String(value));
    const response = await fetchFixed(
      target,
      {
        headers: {
          "User-Agent": ANDROID_USER_AGENT,
          Cookie: cloudlistCookieHeader(),
        },
      },
      "text",
    );
    return parseJson(
      response
        .replace("<!--KG_TAG_RES_START-->", "")
        .replace("<!--KG_TAG_RES_END-->", "")
        .trim(),
    );
  }

  async function resolveStream(trackValue, qualityValue) {
    if (!isPlainObject(trackValue)) throw makeError("invalid_track", 400);
    const quality = normalizeQuality(qualityValue);
    const baseHash = normalizeHash(trackValue.hash ?? trackValue.id, { label: "track_hash" });
    const accountCategory = accountRestriction();
    if (accountCategory) {
      const info = await loginStatus();
      const restriction = restrictionDetails(accountCategory);
      return {
        provider: PROVIDER,
        url: "",
        playable: false,
        loggedIn: info.loggedIn,
        vipType: info.vipType,
        vipLevel: info.vipLevel,
        level: quality,
        quality: "",
        requestedQuality: quality,
        resolvedHash: "",
        downgraded: false,
        trial: false,
        message: restriction.message,
        reason: restriction.category,
        restriction,
        kugouCode: 0,
      };
    }
    const hashes = normalizeQualityHashes(trackValue.qualityHashes);
    const shouldEnrichQuality = quality !== "standard" && QUALITY_FALLBACKS[quality]
      .some((level) => level !== "standard" && !hashes[level]);
    if (shouldEnrichQuality) {
      try {
        const enrichedHashes = await fetchAudioQualityHashes(baseHash);
        for (const level of QUALITY_LEVELS) {
          if (!hashes[level] && enrichedHashes[level]) hashes[level] = enrichedHashes[level];
        }
      } catch {
        // Keep the hashes embedded in the playlist entry and use the existing
        // quality fallback chain when the metadata service is unavailable.
      }
    }
    const albumAudioId = optionalNumericIdentifier(
      trackValue.albumAudioId ?? trackValue.album_audio_id,
      "album_audio_id",
    );
    const albumId = optionalNumericIdentifier(trackValue.albumId ?? trackValue.album_id, "album_id");
    const seenHashes = new Set();
    const candidates = [];
    for (const level of QUALITY_FALLBACKS[quality]) {
      const hash = hashes[level] || (level === "standard" ? baseHash : "");
      if (!hash || seenHashes.has(hash)) continue;
      seenHashes.add(hash);
      candidates.push({ hash, level });
    }
    if (!candidates.length) candidates.push(selectQualityHash(baseHash, quality, hashes));

    let lastResponse = {};
    let lastData = {};
    let lastSelected = candidates.at(-1);
    let lastError = null;
    for (const selected of candidates) {
      try {
        const response = await trackerPlayUrl(selected.hash, { albumAudioId, albumId });
        const data = isPlainObject(response.data) ? response.data : response;
        const rawUrl = firstNonEmpty(
          data.play_url,
          data.play_backup_url,
          data.url,
          data.src,
          data.backup_url,
        );
        const firstUrl = Array.isArray(rawUrl) ? rawUrl[0] : rawUrl;
        const backupUrl = Array.isArray(data.backup_url) ? data.backup_url[0] : data.backup_url;
        const candidateUrl = firstUrl || backupUrl || "";
        const url = safeProviderStreamUrl(candidateUrl);
        lastResponse = response;
        lastData = data;
        lastSelected = selected;
        if (candidateUrl && !url) throw makeError("stream_host_rejected");
        if (url && browserUnsupportedAudioFormat(data, url)) {
          lastError = makeError("unsupported_audio_format");
          continue;
        }
        if (url) {
          const info = await loginStatus();
          return {
            provider: PROVIDER,
            url,
            playable: true,
            loggedIn: info.loggedIn,
            vipType: info.vipType,
            vipLevel: info.vipLevel,
            level: selected.level,
            quality: cleanText(data.fileName ?? data.songName ?? data.extName, 200),
            requestedQuality: quality,
            resolvedHash: selected.hash,
            downgraded: selected.level !== quality,
            trial: false,
            message: "",
            reason: "",
            restriction: null,
            kugouCode: Number(response.error_code ?? response.errcode ?? response.status) || 0,
          };
        }
      } catch (error) {
        lastError = error;
        if (error?.code === "stream_host_rejected") break;
      }
    }
    const statusCode = responseCode(lastResponse);
    const info = await loginStatus();
    let category;
    if (lastError?.code === "stream_host_rejected") {
      category = "stream_host_rejected";
    } else if (!Object.keys(lastResponse).length && lastError) {
      category = lastError?.code === "invalid_provider_response"
        ? "provider_contract_changed"
        : "provider_unavailable";
    } else {
      category = classifyProviderRestriction(lastResponse, lastData, quality);
    }
    if (category === "stale_session") {
      state = {
        ...state,
        validation: {
          ...state.validation,
          validationState: "stale",
          lastAttemptAt: new Date().toISOString(),
          code: "provider_auth_rejected",
        },
      };
      await persistState();
    }
    const restriction = restrictionDetails(category, {
      code: statusCode,
      rawMessage: lastResponse.error || lastResponse.errmsg || lastResponse.message || lastError?.code,
    });
    return {
      provider: PROVIDER,
      url: "",
      playable: false,
      loggedIn: info.loggedIn,
      vipType: info.vipType,
      vipLevel: info.vipLevel,
      level: lastSelected.level,
      quality: cleanText(lastData.fileName ?? lastData.songName ?? lastData.extName, 200),
      requestedQuality: quality,
      resolvedHash: "",
      downgraded: lastSelected.level !== quality,
      trial: false,
      message: restriction.message,
      reason: restriction.category,
      restriction,
      kugouCode: statusCode,
    };
  }

  return Object.freeze({
    loginStatus,
    validateSession,
    refreshAccount: validateSession,
    loginCookie,
    loginQrKey,
    loginQrCheck,
    logout,
    userPlaylists,
    playlistTracks,
    lyric,
    resolveStream,
  });
}
