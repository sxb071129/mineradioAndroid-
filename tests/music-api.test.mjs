import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMusicApi } from "../scripts/music-api.mjs";

function providerStub(overrides = {}) {
  return {
    cloudsearch: async () => ({ body: { result: { songs: [] } } }),
    song_url_v1: async () => ({ body: { data: [] } }),
    song_url: async () => ({ body: { data: [] } }),
    lyric_new: async () => ({ body: { lrc: { lyric: "" }, yrc: { lyric: "" } } }),
    lyric: async () => ({ body: { lrc: { lyric: "" }, tlyric: { lyric: "" } } }),
    login_qr_key: async () => ({ body: { data: { unikey: "test-key" } } }),
    login_qr_create: async () => ({ body: { data: { qrimg: "data:image/png;base64,AA==" } } }),
    login_qr_check: async () => ({ body: { code: 801, message: "waiting" } }),
    login_status: async () => ({ body: { data: {} } }),
    user_account: async () => ({ body: {} }),
    logout: async () => ({ body: { code: 200 } }),
    recommend_songs: async () => ({ body: { data: { dailySongs: [] } } }),
    recommend_resource: async () => ({ body: { recommend: [] } }),
    user_playlist: async () => ({ body: { playlist: [] } }),
    playlist_detail: async () => ({ body: { playlist: { tracks: [] } } }),
    playlist_track_all: async () => ({ body: { songs: [] } }),
    likelist: async () => ({ body: { ids: [] } }),
    like: async () => ({ body: { code: 200 } }),
    playlist_create: async () => ({ body: { code: 200, playlist: {} } }),
    playlist_tracks: async () => ({ body: { code: 200 } }),
    artist_detail: async () => ({ body: { data: { artist: {} } } }),
    artist_top_song: async () => ({ body: { songs: [] } }),
    artist_songs: async () => ({ body: { songs: [] } }),
    artists: async () => ({ body: { artist: {}, hotSongs: [] } }),
    comment_music: async () => ({ body: { comments: [] } }),
    dj_hot: async () => ({ body: { djRadios: [] } }),
    dj_detail: async () => ({ body: { data: {} } }),
    dj_program: async () => ({ body: { programs: [] } }),
    dj_sublist: async () => ({ body: { djRadios: [] } }),
    user_audio: async () => ({ body: { djRadios: [] } }),
    sati_resource_sub_list: async () => ({ body: { data: [] } }),
    record_recent_voice: async () => ({ body: { data: [] } }),
    ...overrides,
  };
}

function kugouProviderStub(overrides = {}) {
  return {
    loginStatus: async () => ({ provider: "kugou", loggedIn: false }),
    validateSession: async () => ({ provider: "kugou", loggedIn: false, ok: false }),
    loginCookie: async () => ({ provider: "kugou", loggedIn: false, saved: false }),
    loginQrKey: async () => ({
      provider: "kugou",
      key: "KUGOU_QR_TEST_KEY",
      img: "data:image/png;base64,AA==",
      url: "https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=KUGOU_QR_TEST_KEY",
    }),
    loginQrCheck: async () => ({ provider: "kugou", loggedIn: false, code: 801, status: 1 }),
    logout: async () => ({ provider: "kugou", ok: true, loggedIn: false }),
    userPlaylists: async () => ({ provider: "kugou", loggedIn: false, playlists: [] }),
    playlistTracks: async () => ({ provider: "kugou", loggedIn: false, tracks: [] }),
    lyric: async () => ({ provider: "kugou", lyric: "", tlyric: "", yrc: "" }),
    resolveStream: async () => ({ provider: "kugou", url: "", playable: false, reason: "login_required" }),
    ...overrides,
  };
}

async function fixture(t, options = {}) {
  const dataDir = options.dataDir || await mkdtemp(path.join(os.tmpdir(), "mineradio-music-api-"));
  if (options.cookie) {
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, "netease.cookie"), options.cookie, "utf8");
  }
  const api = await createMusicApi({
    port: 0,
    host: "127.0.0.1",
    dataDir,
    provider: options.provider || providerStub(),
    kugouProvider: options.kugouProvider || kugouProviderStub(),
    fetchImpl: options.fetchImpl,
    validateStreamUrl: options.validateStreamUrl,
    streamConnectTimeoutMs: options.streamConnectTimeoutMs,
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await api.close();
  };
  t.after(async () => {
    await close();
    if (!options.keepDataDir) await rm(dataDir, { recursive: true, force: true });
  });
  return { api, close, dataDir, base: `http://127.0.0.1:${api.port}` };
}

const APP_ORIGIN = "http://127.0.0.1:3000";
const APP_HEADERS = {
  origin: APP_ORIGIN,
  "content-type": "application/json; charset=utf-8",
  "x-mineradio-application": "mineradio-web-v1",
};

function postJson(url, body, options = {}) {
  return fetch(url, {
    method: "POST",
    headers: { ...APP_HEADERS, ...(options.headers || {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function rawRequest(urlValue, { method = "GET", headers = {}, body } = {}) {
  const target = new URL(urlValue);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

test("cover proxy accepts only bounded HTTPS raster images", async (t) => {
  const requests = [];
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  const { base } = await fixture(t, {
    validateStreamUrl: async (value) => new URL(value),
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), accept: init?.headers?.Accept });
      return new Response(imageBytes, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(imageBytes.length),
        },
      });
    },
  });

  const target = "https://images.example.test/artwork.png";
  const response = await fetch(`${base}/api/cover?url=${encodeURIComponent(target)}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "cross-origin");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), imageBytes);
  assert.deepEqual(requests, [{
    url: target,
    accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.8",
  }]);

  for (const value of [
    "http://images.example.test/artwork.png",
    "https://user:secret@images.example.test/artwork.png",
    "javascript:alert(1)",
    `https://images.example.test/${"a".repeat(2050)}`,
  ]) {
    const rejected = await fetch(`${base}/api/cover?url=${encodeURIComponent(value)}`);
    assert.equal(rejected.status, 400, value);
  }
  assert.equal(requests.length, 1);
});

test("public song and playlist payloads never expose unsafe cover strings", async (t) => {
  const provider = providerStub({
    cloudsearch: async () => ({
      body: {
        result: {
          songs: [{
            id: 1,
            name: "Unsafe artwork",
            ar: [{ id: 2, name: "Artist" }],
            al: { name: "Album", picUrl: "javascript:alert(1)" },
          }],
        },
      },
    }),
  });
  const { base } = await fixture(t, { provider });
  const response = await fetch(`${base}/api/search?keywords=artwork`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.songs[0].cover, "");
});

async function registerKugouTrack(base, overrides = {}) {
  const hash = overrides.hash || "A".repeat(32);
  const accountId = overrides.accountId || "7";
  const response = await fetch(`${base}/api/kugou/playlist/tracks?id=123`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.tracks.length, 1);
  assert.doesNotMatch(JSON.stringify(body), new RegExp(hash));
  assert.equal(body.userId, accountId);
  return body.tracks[0];
}

test("music API only allows LAN web origins", async (t) => {
  let searches = 0;
  const provider = providerStub({
    cloudsearch: async () => {
      searches += 1;
      return { body: { result: { songs: [] } } };
    },
  });
  const { base } = await fixture(t, { provider });

  const preflight = await fetch(`${base}/api/search`, {
    method: "OPTIONS",
    headers: { origin: "http://127.0.0.1:3000" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "http://127.0.0.1:3000");
  assert.match(preflight.headers.get("access-control-allow-methods") || "", /GET/);
  assert.match(preflight.headers.get("access-control-allow-headers") || "", /range/i);
  assert.equal(preflight.headers.get("vary"), "Origin");
  assert.equal(preflight.headers.get("access-control-allow-credentials"), null);

  for (const origin of ["http://evil.example:3000", "http://127.0.0.1:3001"]) {
    const rejected = await fetch(`${base}/api/search?keywords=x`, { headers: { origin } });
    assert.equal(rejected.status, 403);
    assert.deepEqual(await rejected.json(), { error: "origin_not_allowed" });
    assert.equal(rejected.headers.get("access-control-allow-origin"), null);
  }
  assert.equal(searches, 0);
});

test("stream rejects non-canonical song ids before provider access", async (t) => {
  let resolves = 0;
  let fetches = 0;
  const provider = providerStub({
    song_url_v1: async () => {
      resolves += 1;
      return { body: { data: [{ url: "https://media.example.test/song.mp3" }] } };
    },
  });
  const { base } = await fixture(t, {
    provider,
    fetchImpl: async () => {
      fetches += 1;
      return new Response(new Uint8Array([1]), { status: 200 });
    },
    validateStreamUrl: async (value) => new URL(value),
  });

  for (const id of ["", "0", "01", "-1", "+1", "1.0", "1e3", "abc", "123/456", "123456789012345678901"]) {
    const response = await fetch(`${base}/api/stream?id=${encodeURIComponent(id)}`);
    assert.equal(response.status, 400, id);
    assert.deepEqual(await response.json(), { error: "invalid_song_id" });
  }
  assert.equal(resolves, 0);
  assert.equal(fetches, 0);
});

test("stream forwards Range without leaking browser or account cookies", async (t) => {
  const providerCalls = [];
  const fetchCalls = [];
  const provider = providerStub({
    song_url_v1: async (options) => {
      providerCalls.push(options);
      return { body: { data: [{ url: "https://media.example.test/song.mp3" }] } };
    },
  });
  const { base } = await fixture(t, {
    cookie: "MUSIC_U=SERVER_SECRET",
    provider,
    validateStreamUrl: async (value) => new URL(value),
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      return new Response(new Uint8Array([10, 11, 12, 13]), {
        status: 206,
        headers: {
          "content-type": "audio/mpeg",
          "accept-ranges": "bytes",
          "content-length": "4",
          "content-range": "bytes 10-13/100",
        },
      });
    },
  });

  const response = await fetch(`${base}/api/stream?id=123456`, {
    headers: {
      origin: "http://127.0.0.1:3000",
      range: "bytes=10-13",
      cookie: "ATTACKER_COOKIE=1",
    },
  });
  assert.equal(response.status, 206);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([10, 11, 12, 13]));
  assert.equal(response.headers.get("content-range"), "bytes 10-13/100");
  assert.equal(response.headers.get("content-length"), "4");
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.match(response.headers.get("access-control-expose-headers") || "", /content-range/i);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(providerCalls[0].cookie, "MUSIC_U=SERVER_SECRET");
  assert.equal(fetchCalls[0].init.headers.Range, "bytes=10-13");
  assert.equal(fetchCalls[0].init.headers.Cookie, undefined);
  assert.doesNotMatch(JSON.stringify(fetchCalls), /SERVER_SECRET|ATTACKER_COOKIE/);
});

test("stream timeout covers response headers without aborting a slow audio body", async (t) => {
  let upstreamSignal;
  const provider = providerStub({
    song_url_v1: async () => ({
      body: { data: [{ url: "https://media.example.test/slow-song.mp3" }] },
    }),
  });
  const { base } = await fixture(t, {
    provider,
    streamConnectTimeoutMs: 10,
    validateStreamUrl: async (value) => new URL(value),
    fetchImpl: async (_url, init) => {
      upstreamSignal = init.signal;
      return new Response(new ReadableStream({
        start(controller) {
          setTimeout(() => {
            controller.enqueue(new Uint8Array([42]));
            controller.close();
          }, 35);
        },
      }), {
        status: 200,
        headers: { "content-type": "audio/mpeg", "content-length": "1" },
      });
    },
  });

  const response = await fetch(`${base}/api/stream?id=123456`);
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([42]));
  assert.equal(upstreamSignal.aborted, false);
});

test("stream response-header timeout still aborts an unresponsive provider", async (t) => {
  const provider = providerStub({
    song_url_v1: async () => ({
      body: { data: [{ url: "https://media.example.test/hanging-song.mp3" }] },
    }),
  });
  const { base } = await fixture(t, {
    provider,
    streamConnectTimeoutMs: 10,
    validateStreamUrl: async (value) => new URL(value),
    fetchImpl: async (_url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }),
  });

  const response = await fetch(`${base}/api/stream?id=123456`);
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: "third_party_timeout" });
});

test("failed upstream streams clear the provider-quality cache before retry", async (t) => {
  let resolves = 0;
  let fetches = 0;
  const provider = providerStub({
    song_url_v1: async () => {
      resolves += 1;
      return { body: { data: [{ url: `https://media.example.test/song-${resolves}.mp3` }] } };
    },
  });
  const { base } = await fixture(t, {
    provider,
    validateStreamUrl: async (value) => new URL(value),
    fetchImpl: async () => {
      fetches += 1;
      if (fetches === 1) return new Response("unavailable", { status: 503 });
      return new Response(new Uint8Array([7]), {
        status: 200,
        headers: { "content-type": "audio/mpeg", "content-length": "1" },
      });
    },
  });

  const first = await fetch(`${base}/api/stream?provider=netease&id=123456&quality=lossless`);
  assert.equal(first.status, 502);
  assert.deepEqual(await first.json(), { error: "provider_stream_failed" });

  const second = await fetch(`${base}/api/stream?provider=netease&id=123456&quality=lossless`);
  assert.equal(second.status, 200);
  assert.deepEqual(new Uint8Array(await second.arrayBuffer()), new Uint8Array([7]));
  assert.equal(resolves, 2);
  assert.equal(fetches, 2);
});

test("QR login stores its cookie only on the server", async (t) => {
  const loginStatusCalls = [];
  const provider = providerStub({
    login_qr_check: async () => ({
      body: { code: 803, message: "ok", cookie: "MUSIC_U=QR_TOP_SECRET; Path=/; HttpOnly" },
    }),
    login_status: async (options) => {
      loginStatusCalls.push(options);
      return {
        body: {
          data: {
            profile: { userId: 7, nickname: "测试用户", avatarUrl: "" },
            account: { id: 7 },
          },
        },
      };
    },
  });
  const { base, dataDir } = await fixture(t, { provider });

  const key = await fetch(`${base}/api/login/qr/key`).then((response) => response.json());
  const checked = await fetch(`${base}/api/login/qr/check?key=${encodeURIComponent(key.key)}`, {
    headers: { cookie: "CLIENT_FORGED=1" },
  });
  const body = await checked.text();
  assert.equal(checked.status, 200);
  assert.doesNotMatch(body, /QR_TOP_SECRET|CLIENT_FORGED/);
  assert.equal(checked.headers.get("set-cookie"), null);
  assert.match(await readFile(path.join(dataDir, "netease.cookie"), "utf8"), /MUSIC_U=QR_TOP_SECRET/);
  assert.match(loginStatusCalls.at(-1).cookie, /MUSIC_U=QR_TOP_SECRET/);
  assert.doesNotMatch(JSON.stringify(loginStatusCalls), /CLIENT_FORGED/);
});

test("Kugou cookie login is an authenticated local mutation, redacts secrets, and invalidates old tracks", async (t) => {
  const hash = "9".repeat(32);
  const secret = "KUGOU_COOKIE_LOGIN_SECRET";
  const loginCalls = [];
  const kugouProvider = kugouProviderStub({
    loginCookie: async (cookie) => {
      loginCalls.push(cookie);
      return {
        provider: "kugou",
        loggedIn: true,
        hasLocalSession: true,
        accountValidated: true,
        validationState: "valid",
        playbackReady: true,
        playbackKeyReady: true,
        userId: "42",
        nickname: "Cookie User",
        token: secret,
        cookie,
      };
    },
    playlistTracks: async () => ({
      provider: "kugou",
      loggedIn: true,
      userId: "7",
      playlist: { id: "123", trackCount: 1 },
      tracks: [{ hash, qualityHashes: { standard: hash }, name: "old account song" }],
    }),
  });
  const { base } = await fixture(t, { kugouProvider });
  const oldTrack = await registerKugouTrack(base, { hash });
  const endpoint = `${base}/api/kugou/login/cookie`;

  const rejected = await postJson(endpoint, { cookie: `userid=42; token=${secret}` }, {
    headers: { "x-mineradio-application": "" },
  });
  assert.equal(rejected.status, 403);
  assert.deepEqual(await rejected.json(), { error: "application_header_required" });
  assert.equal(loginCalls.length, 0);

  const response = await postJson(endpoint, { cookie: `userid=42; token=${secret}` });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.doesNotMatch(text, new RegExp(secret));
  const body = JSON.parse(text);
  assert.equal(body.loggedIn, true);
  assert.equal(body.userId, "42");
  assert.equal(body.saved, true);
  assert.deepEqual(loginCalls, [`userid=42; token=${secret}`]);

  const legacyResponse = await postJson(endpoint, { data: `userid=42; token=${secret}` });
  assert.equal(legacyResponse.status, 200);
  assert.equal((await legacyResponse.json()).saved, true);
  assert.equal(loginCalls.length, 2);

  const stale = await fetch(`${base}/api/v2/stream/${oldTrack.playKey}?quality=standard`);
  assert.equal(stale.status, 404);
  assert.deepEqual(await stale.json(), { error: "track_key_expired" });

  const unknownField = await postJson(endpoint, { cookie: "userid=42; token=x", token: "x" });
  assert.equal(unknownField.status, 400);
  assert.deepEqual(await unknownField.json(), { error: "invalid_kugou_cookie_request" });
});

test("Kugou QR, playlist tokens, qualities, and streams stay server constrained", async (t) => {
  const hash = "A".repeat(32);
  const losslessHash = "B".repeat(32);
  const resolveCalls = [];
  const streamFetches = [];
  const kugouProvider = kugouProviderStub({
    loginQrCheck: async () => ({
      provider: "kugou",
      loggedIn: true,
      code: 803,
      status: 4,
      userId: "7",
      nickname: "测试酷狗用户",
      token: "KUGOU_TOP_SECRET",
      cookie: "KUGOU_COOKIE_SECRET",
    }),
    userPlaylists: async () => ({
      provider: "kugou",
      loggedIn: true,
      userId: "7",
      nickname: "测试酷狗用户",
      playlists: [{ id: "123", name: "我的酷狗歌单", cover: "https://imge.kugou.com/test.jpg", trackCount: 1 }],
    }),
    playlistTracks: async () => ({
      provider: "kugou",
      loggedIn: true,
      playlist: { id: "123", name: "我的酷狗歌单", trackCount: 1 },
      tracks: [{
        hash,
        qualityHashes: { standard: hash, lossless: losslessHash },
        albumAudioId: "99",
        albumId: "88",
        name: "测试歌曲",
        artist: "测试歌手",
        album: "测试专辑",
        cover: "https://imge.kugou.com/test.jpg",
        duration: 180000,
      }],
    }),
    resolveStream: async (track, quality) => {
      resolveCalls.push({ track, quality });
      return { url: `https://media.kugou.com/${quality}.mp3`, level: quality, playable: true };
    },
  });
  const { base } = await fixture(t, {
    kugouProvider,
    validateStreamUrl: async (value) => new URL(value),
    fetchImpl: async (url, init) => {
      streamFetches.push({ url: String(url), init });
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 206,
        headers: {
          "content-type": "audio/mpeg",
          "content-length": "3",
          "content-range": "bytes 0-2/3",
          "accept-ranges": "bytes",
        },
      });
    },
  });

  const qr = await fetch(`${base}/api/kugou/login/qr/key`).then((response) => response.json());
  assert.equal(qr.key, "KUGOU_QR_TEST_KEY");
  assert.match(qr.img, /^data:image\/png;base64,/);
  const checkedResponse = await fetch(`${base}/api/kugou/login/qr/check?key=${encodeURIComponent(qr.key)}`);
  const checkedText = await checkedResponse.text();
  assert.equal(checkedResponse.status, 200);
  assert.doesNotMatch(checkedText, /KUGOU_TOP_SECRET|KUGOU_COOKIE_SECRET/);
  assert.equal(checkedResponse.headers.get("set-cookie"), null);

  const playlists = await fetch(`${base}/api/kugou/user/playlists`).then((response) => response.json());
  assert.deepEqual(playlists.playlists.map((playlist) => playlist.id), ["123"]);
  const tracks = await fetch(`${base}/api/kugou/playlist/tracks?id=123`).then((response) => response.json());
  assert.equal(tracks.tracks.length, 1);
  const publicTrack = tracks.tracks[0];
  assert.match(publicTrack.playKey, /^[a-f0-9]{24}$/);
  assert.equal(publicTrack.playable, true);
  assert.doesNotMatch(JSON.stringify(publicTrack), new RegExp(`${hash}|${losslessHash}`));

  for (const quality of ["lossless", "standard"]) {
    const response = await fetch(`${base}/api/stream?provider=kugou&id=${publicTrack.playKey}&quality=${quality}`, {
      headers: { range: "bytes=0-2", cookie: "LAN_FORGED=1" },
    });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("x-mineradio-provider"), "kugou");
    assert.equal(response.headers.get("x-mineradio-quality"), quality);
    await response.arrayBuffer();
  }
  assert.deepEqual(resolveCalls.map((call) => call.quality), ["lossless", "standard"]);
  assert.equal(resolveCalls[0].track.hash, hash);
  assert.equal(resolveCalls[0].track.qualityHashes.lossless, losslessHash);
  assert.equal(streamFetches[0].init.headers.Range, "bytes=0-2");
  assert.equal(streamFetches[0].init.headers.Cookie, undefined);
  assert.doesNotMatch(JSON.stringify(streamFetches), /LAN_FORGED|KUGOU_TOP_SECRET/);

  const callsBeforeInvalid = resolveCalls.length;
  for (const path of [
    `/api/stream?provider=kugou&id=${publicTrack.playKey}&quality=ultra`,
    "/api/stream?provider=kugou&id=not-a-play-key&quality=hires",
    `/api/stream?provider=unknown&id=${publicTrack.playKey}&quality=hires`,
  ]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 400, path);
  }
  assert.equal(resolveCalls.length, callsBeforeInvalid);
});

test("NetEase lyric uses the server session, falls back safely, and returns parsed timeline lines", async (t) => {
  const hash = "A".repeat(32);
  const audioUrl = "https://media.example/private.mp3";
  const calls = [];
  const provider = providerStub({
    lyric_new: async (options) => {
      calls.push({ method: "lyric_new", options });
      return { body: { lrc: { lyric: "" }, yrc: { lyric: "" } } };
    },
    lyric: async (options) => {
      calls.push({ method: "lyric", options });
      return {
        body: {
          lrc: { lyric: `[00:01.00]hello\n[00:02.50]${audioUrl} ${hash} token=LYRIC_SECRET` },
          tlyric: { lyric: "[00:01.00]你好" },
          yrc: { lyric: "" },
          privateUrl: audioUrl,
          token: "LYRIC_SECRET",
        },
      };
    },
  });
  const { base } = await fixture(t, { provider, cookie: "MUSIC_U=SERVER_SECRET" });

  const invalid = await fetch(`${base}/api/lyric?id=01`);
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, "invalid_song_id");
  assert.equal(calls.length, 0);

  const response = await fetch(`${base}/api/lyric?id=123456`, {
    headers: { cookie: "MUSIC_U=CLIENT_FORGED" },
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.doesNotMatch(text, /private\.mp3|LYRIC_SECRET|CLIENT_FORGED/);
  assert.doesNotMatch(text, new RegExp(hash));
  const body = JSON.parse(text);
  assert.equal(body.provider, "netease");
  assert.equal(body.id, "123456");
  assert.equal(body.source, "lyric");
  assert.deepEqual(body.lines, [
    { timeMs: 1_000, durationMs: 0, text: "hello" },
    { timeMs: 2_500, durationMs: 0, text: "[redacted-url] [redacted-hash] token=[redacted]" },
  ]);
  assert.deepEqual(calls.map((call) => call.method), ["lyric_new", "lyric"]);
  assert.equal(calls[1].options.cookie, "MUSIC_U=SERVER_SECRET");
});

test("NetEase enhanced lyric returns word-timed YRC lines without calling the fallback", async (t) => {
  let fallbackCalls = 0;
  const provider = providerStub({
    lyric_new: async () => ({
      body: {
        lrc: { lyric: "[00:01.00]hello world" },
        tlyric: { lyric: "" },
        yrc: { lyric: "[1000,1500](1000,500,0)hello (1500,500,0)world" },
      },
    }),
    lyric: async () => {
      fallbackCalls += 1;
      throw new Error("must not call fallback");
    },
  });
  const { base } = await fixture(t, { provider });
  const response = await fetch(`${base}/api/lyric?id=9`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.source, "lyric_new");
  assert.deepEqual(body.lines, [{ timeMs: 1_000, durationMs: 1_500, text: "hello world" }]);
  assert.equal(fallbackCalls, 0);
});

test("lyric payloads are size bounded before they reach LAN clients", async (t) => {
  const provider = providerStub({
    lyric_new: async () => ({ body: { lrc: { lyric: `[00:00.00]${"x".repeat(600 * 1024)}` } } }),
  });
  const { base } = await fixture(t, { provider });
  const response = await fetch(`${base}/api/lyric?id=1`);
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "third_party_unavailable" });
});

test("Kugou lyric resolves only through an opaque descriptor and never exposes provider secrets", async (t) => {
  const hash = "B".repeat(32);
  const providerUrl = "https://trackercdn.kugou.com/private.flac";
  const lyricCalls = [];
  const kugouProvider = kugouProviderStub({
    playlistTracks: async () => ({
      provider: "kugou",
      loggedIn: true,
      userId: "7",
      playlist: { id: "123", trackCount: 1 },
      tracks: [{ hash, qualityHashes: { standard: hash }, name: "lyric song" }],
    }),
    lyric: async (descriptor) => {
      lyricCalls.push(descriptor);
      return {
        provider: "kugou",
        lyric: `[00:00.25]开始\n[00:03.00]${providerUrl} ${hash} token=KUGOU_LYRIC_SECRET`,
        tlyric: "",
        yrc: "",
        hash,
        token: "KUGOU_LYRIC_SECRET",
        url: providerUrl,
      };
    },
  });
  const { base } = await fixture(t, { kugouProvider });
  const track = await registerKugouTrack(base, { hash });

  const response = await fetch(`${base}/api/kugou/lyric?id=${track.playKey}`);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.doesNotMatch(text, new RegExp(hash));
  assert.doesNotMatch(text, /private\.flac|KUGOU_LYRIC_SECRET/);
  const body = JSON.parse(text);
  assert.equal(body.provider, "kugou");
  assert.equal(body.id, track.playKey);
  assert.equal(body.source, "kugou-lyrics");
  assert.deepEqual(body.lines[0], { timeMs: 250, durationMs: 0, text: "开始" });
  assert.equal(lyricCalls.length, 1);
  assert.equal(lyricCalls[0].hash, hash);

  const invalid = await fetch(`${base}/api/kugou/lyric?id=${hash}`);
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, "invalid_play_key");
  const expired = await fetch(`${base}/api/kugou/lyric?id=${"f".repeat(24)}`);
  assert.equal(expired.status, 404);
  assert.deepEqual(await expired.json(), { error: "track_key_expired" });
});

test("successful Kugou QR account switch invalidates old descriptors and cached streams", async (t) => {
  const hash = "C".repeat(32);
  let resolveCalls = 0;
  const kugouProvider = kugouProviderStub({
    loginQrCheck: async () => ({
      provider: "kugou",
      loggedIn: true,
      code: 803,
      status: 4,
      userId: "8",
    }),
    playlistTracks: async () => ({
      provider: "kugou",
      loggedIn: true,
      userId: "7",
      playlist: { id: "123", trackCount: 1 },
      tracks: [{ hash, qualityHashes: { standard: hash }, name: "old account song" }],
    }),
    resolveStream: async () => {
      resolveCalls += 1;
      return { playable: true, url: "https://media.kugou.com/account-switch.mp3", level: "standard" };
    },
  });
  const { base, dataDir } = await fixture(t, {
    kugouProvider,
    validateStreamUrl: async (value) => new URL(value),
    fetchImpl: async () => new Response(new Uint8Array([1]), {
      status: 200,
      headers: { "content-type": "audio/mpeg", "content-length": "1" },
    }),
  });
  const track = await registerKugouTrack(base, { hash });
  const first = await fetch(`${base}/api/v2/stream/${track.playKey}?quality=standard`);
  assert.equal(first.status, 200);
  await first.arrayBuffer();
  assert.equal(resolveCalls, 1);

  const qr = await fetch(`${base}/api/kugou/login/qr/key`).then((response) => response.json());
  const switched = await fetch(`${base}/api/kugou/login/qr/check?key=${encodeURIComponent(qr.key)}`);
  assert.equal(switched.status, 200);
  assert.equal((await switched.json()).code, 803);
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, "kugou-descriptors.json"), "utf8")).records, []);

  const stale = await fetch(`${base}/api/v2/stream/${track.playKey}?quality=standard`);
  assert.equal(stale.status, 404);
  assert.deepEqual(await stale.json(), { error: "track_key_expired" });
  assert.equal(resolveCalls, 1);
});

test("Kugou descriptors persist across API restart and logout invalidates them durably", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mineradio-music-api-restart-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const hash = "C".repeat(32);
  const token = "KUGOU_NEVER_PERSIST_THIS_TOKEN";
  const providerUrl = "https://media.kugou.com/restart-private.mp3";
  const calls = [];
  const kugouProvider = kugouProviderStub({
    playlistTracks: async () => ({
      provider: "kugou",
      loggedIn: true,
      userId: "42",
      playlist: { id: "123", name: "durable", trackCount: 1 },
      tracks: [{
        hash,
        qualityHashes: { standard: hash },
        albumAudioId: "99",
        albumId: "88",
        name: "durable song",
      }],
    }),
    resolveStream: async (track, quality) => {
      calls.push({ track, quality, token });
      return { playable: true, url: providerUrl, level: quality };
    },
  });
  const fetchImpl = async () => new Response(new Uint8Array([9]), {
    status: 200,
    headers: { "content-type": "audio/mpeg", "content-length": "1" },
  });
  const common = {
    dataDir,
    keepDataDir: true,
    kugouProvider,
    fetchImpl,
    validateStreamUrl: async (value) => new URL(value),
  };

  const first = await fixture(t, common);
  const track = await registerKugouTrack(first.base, { hash, accountId: "42" });
  const storeText = await readFile(path.join(dataDir, "kugou-descriptors.json"), "utf8");
  assert.match(storeText, new RegExp(hash));
  assert.doesNotMatch(storeText, new RegExp(`${token}|${providerUrl}|cookie`, "i"));
  await first.close();

  const restarted = await fixture(t, common);
  const resumed = await fetch(`${restarted.base}/api/v2/stream/${track.playKey}?quality=standard`);
  assert.equal(resumed.status, 200);
  assert.deepEqual(new Uint8Array(await resumed.arrayBuffer()), new Uint8Array([9]));
  assert.equal(calls.at(-1).track.hash, hash);

  const logout = await fetch(`${restarted.base}/api/kugou/logout`);
  assert.equal(logout.status, 200);
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, "kugou-descriptors.json"), "utf8")).records, []);
  await restarted.close();

  const afterLogout = await fixture(t, common);
  const expired = await fetch(`${afterLogout.base}/api/v2/stream/${track.playKey}?quality=standard`);
  assert.equal(expired.status, 404);
  assert.deepEqual(await expired.json(), { error: "track_key_expired" });
});

test("v2 prepare returns sanitized success and structured restrictions", async (t) => {
  const hash = "D".repeat(32);
  const token = "KUGOU_PREPARE_SECRET_TOKEN";
  const providerUrl = "https://media.kugou.com/private-prepare.mp3";
  let outcome = { playable: true, url: providerUrl, level: "lossless", token, resolvedHash: hash };
  const kugouProvider = kugouProviderStub({
    playlistTracks: async () => ({
      loggedIn: true,
      userId: "7",
      playlist: { id: "123", trackCount: 1 },
      tracks: [{ hash, qualityHashes: { lossless: hash }, name: "prepare" }],
    }),
    resolveStream: async () => outcome,
  });
  const { base, dataDir } = await fixture(t, {
    kugouProvider,
    validateStreamUrl: async (value) => new URL(value),
  });
  const track = await registerKugouTrack(base, { hash });

  const successResponse = await postJson(`${base}/api/v2/playback/prepare`, {
    provider: "kugou",
    trackRef: track.playKey,
    quality: "lossless",
  });
  assert.equal(successResponse.status, 200);
  assert.equal(successResponse.headers.get("cache-control"), "no-store");
  const successText = await successResponse.text();
  assert.doesNotMatch(successText, new RegExp(`${hash}|${token}|media\\.kugou\\.com|https?:`, "i"));
  const success = JSON.parse(successText);
  assert.deepEqual(Object.keys(success).sort(), [
    "attemptId", "playable", "provider", "requestedQuality", "resolvedQuality",
    "restriction", "streamPath", "trackRef",
  ]);
  assert.equal(success.playable, true);
  assert.equal(success.provider, "kugou");
  assert.equal(success.trackRef, track.playKey);
  assert.equal(success.requestedQuality, "lossless");
  assert.equal(success.resolvedQuality, "lossless");
  assert.match(success.attemptId, /^[a-f0-9]{24}$/);
  assert.equal(success.streamPath, `/api/v2/stream/${track.playKey}?quality=lossless`);
  assert.equal(success.restriction, null);

  outcome = {
    playable: false,
    url: "",
    reason: "paid_required",
    resolvedHash: hash,
    token,
    restriction: {
      category: "paid_required",
      action: "upgrade",
      code: 6,
      rawMessage: `${token} ${providerUrl}`,
    },
  };
  const restrictedResponse = await postJson(`${base}/api/v2/playback/prepare`, {
    provider: "kugou",
    id: track.playKey,
    quality: "hires",
  });
  assert.equal(restrictedResponse.status, 200);
  const restrictedText = await restrictedResponse.text();
  assert.doesNotMatch(restrictedText, new RegExp(`${hash}|${token}|media\\.kugou\\.com|https?:`, "i"));
  const restricted = JSON.parse(restrictedText);
  assert.equal(restricted.playable, false);
  assert.equal(restricted.streamPath, undefined);
  assert.equal(restricted.resolvedQuality, null);
  assert.deepEqual(restricted.restriction, {
    category: "paid_required",
    code: 6,
    action: "upgrade",
    message: "Account playback rights are required",
  });

  const persisted = await readFile(path.join(dataDir, "kugou-descriptors.json"), "utf8");
  assert.doesNotMatch(persisted, new RegExp(`${token}|${providerUrl}|https?:|cookie`, "i"));
});

test("old and v2 Kugou streams expose sanitized structured restrictions", async (t) => {
  const hash = "E".repeat(32);
  const secret = "KUGOU_RESTRICTION_SECRET";
  const kugouProvider = kugouProviderStub({
    playlistTracks: async () => ({
      loggedIn: true,
      userId: "7",
      playlist: { id: "123", trackCount: 1 },
      tracks: [{ hash, qualityHashes: { standard: hash }, name: "restricted" }],
    }),
    resolveStream: async () => ({
      playable: false,
      url: "",
      reason: "region_restricted",
      resolvedHash: hash,
      restriction: {
        category: "region_restricted",
        action: "none",
        code: 9,
        rawMessage: `${secret} https://media.kugou.com/private.mp3`,
      },
    }),
  });
  const { base } = await fixture(t, { kugouProvider });
  const track = await registerKugouTrack(base, { hash });

  for (const route of [
    `/api/stream?provider=kugou&id=${track.playKey}&quality=standard`,
    `/api/v2/stream/${track.playKey}?quality=standard`,
  ]) {
    const response = await fetch(`${base}${route}`);
    assert.equal(response.status, 403);
    const text = await response.text();
    assert.doesNotMatch(text, new RegExp(`${hash}|${secret}|https?:|media\\.kugou\\.com`, "i"));
    assert.deepEqual(JSON.parse(text), {
      error: "region_restricted",
      restriction: {
        category: "region_restricted",
        code: 9,
        action: "none",
        message: "Track is unavailable in this region",
      },
    });
  }
});

test("old and v2 streams re-resolve and retry the identical Range once on stale upstream statuses", async (t) => {
  for (const status of [401, 403, 404, 410]) {
    for (const routeType of ["old", "v2"]) {
      let resolves = 0;
      const ranges = [];
      const bodies = [];
      const provider = providerStub({
        song_url_v1: async () => {
          resolves += 1;
          return { body: { data: [{ url: `https://media.example.test/retry-${resolves}.mp3` }] } };
        },
      });
      const kugouProvider = kugouProviderStub({
        playlistTracks: async () => ({
          loggedIn: true,
          userId: "7",
          playlist: { id: "123", trackCount: 1 },
          tracks: [{ hash: "F".repeat(32), qualityHashes: { standard: "F".repeat(32) }, name: "retry" }],
        }),
        resolveStream: async (_track, quality) => {
          resolves += 1;
          return { playable: true, url: `https://media.kugou.com/retry-${resolves}.mp3`, level: quality };
        },
      });
      const { base } = await fixture(t, {
        provider,
        kugouProvider,
        validateStreamUrl: async (value) => new URL(value),
        fetchImpl: async (_url, init) => {
          ranges.push(init.headers.Range);
          if (ranges.length === 1) {
            const response = new Response("stale-private-body", { status });
            bodies.push(response.body);
            return response;
          }
          return new Response(new Uint8Array([status % 256]), {
            status: 206,
            headers: {
              "content-type": "audio/mpeg",
              "content-length": "1",
              "content-range": "bytes 10-10/100",
            },
          });
        },
      });
      let route;
      if (routeType === "old") {
        route = "/api/stream?provider=netease&id=123456&quality=lossless";
      } else {
        const track = await registerKugouTrack(base, { hash: "F".repeat(32) });
        route = `/api/v2/stream/${track.playKey}?quality=standard`;
      }
      const response = await fetch(`${base}${route}`, { headers: { range: "bytes=10-10" } });
      assert.equal(response.status, 206, `${routeType} ${status}`);
      await response.arrayBuffer();
      assert.equal(resolves, 2, `${routeType} ${status}`);
      assert.deepEqual(ranges, ["bytes=10-10", "bytes=10-10"]);
      assert.equal(bodies[0].locked, true);
    }
  }
});

test("Kugou stream falls through to the next available quality after a stale high-quality CDN", async (t) => {
  const hash = "8".repeat(32);
  const resolves = [];
  const fetches = [];
  const kugouProvider = kugouProviderStub({
    playlistTracks: async () => ({
      loggedIn: true,
      userId: "7",
      playlist: { id: "123", trackCount: 1 },
      tracks: [{
        hash,
        qualityHashes: { jymaster: hash, hires: "7".repeat(32), lossless: "6".repeat(32) },
        name: "quality fallback",
      }],
    }),
    resolveStream: async (_track, quality) => {
      resolves.push(quality);
      return {
        playable: true,
        url: `https://media.kugou.com/${quality}-${resolves.length}.flac`,
        level: quality,
      };
    },
  });
  const { base } = await fixture(t, {
    kugouProvider,
    validateStreamUrl: async (value) => new URL(value),
    fetchImpl: async (url, init) => {
      fetches.push({ url: String(url), range: init.headers.Range });
      if (String(url).includes("jymaster")) return new Response("stale", { status: 403 });
      return new Response(new Uint8Array([4, 2]), {
        status: 206,
        headers: {
          "content-type": "audio/flac",
          "content-length": "2",
          "content-range": "bytes 20-21/100",
        },
      });
    },
  });
  const track = await registerKugouTrack(base, { hash });
  const response = await fetch(`${base}/api/v2/stream/${track.playKey}?quality=jymaster`, {
    headers: { range: "bytes=20-21" },
  });

  assert.equal(response.status, 206);
  assert.equal(response.headers.get("x-mineradio-quality"), "hires");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([4, 2]));
  assert.deepEqual(resolves, ["jymaster", "jymaster", "hires"]);
  assert.deepEqual(fetches.map((item) => item.range), ["bytes=20-21", "bytes=20-21", "bytes=20-21"]);
});

test("non-retryable stream failures do not retry within the same request", async (t) => {
  for (const status of [400, 429, 500, 503]) {
    let resolves = 0;
    let fetches = 0;
    const provider = providerStub({
      song_url_v1: async () => {
        resolves += 1;
        return { body: { data: [{ url: "https://media.example.test/no-retry.mp3" }] } };
      },
    });
    const { base } = await fixture(t, {
      provider,
      validateStreamUrl: async (value) => new URL(value),
      fetchImpl: async () => {
        fetches += 1;
        return new Response("failed", { status });
      },
    });
    const response = await fetch(`${base}/api/stream?id=123456`);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "provider_stream_failed" });
    assert.equal(resolves, 1, String(status));
    assert.equal(fetches, 1, String(status));
  }
});

test("prepare mutation and request framing safeguards reject malformed traffic", async (t) => {
  const { base } = await fixture(t);
  const endpoint = `${base}/api/v2/playback/prepare`;
  const validBody = { provider: "kugou", trackRef: "a".repeat(24), quality: "standard" };

  const cases = [
    ["malformed JSON", await postJson(endpoint, "{broken"), 400, "invalid_json"],
    ["wrong content type", await postJson(endpoint, validBody, { headers: { "content-type": "text/plain" } }), 415, "unsupported_media_type"],
    ["missing app header", await postJson(endpoint, validBody, { headers: { "x-mineradio-application": "" } }), 403, "application_header_required"],
    ["bad app header", await postJson(endpoint, validBody, { headers: { "x-mineradio-application": "wrong-app" } }), 403, "application_header_required"],
    ["invalid origin", await postJson(endpoint, validBody, { headers: { origin: "http://evil.example:3000" } }), 403, "origin_not_allowed"],
    ["missing origin", await postJson(endpoint, validBody, { headers: { origin: "" } }), 403, "origin_required"],
    ["unknown private field", await postJson(endpoint, { ...validBody, hash: "A".repeat(32) }), 400, "invalid_prepare_request"],
  ];
  for (const [label, response, status, error] of cases) {
    assert.equal(response.status, status, label);
    assert.deepEqual(await response.json(), { error }, label);
  }

  const oversized = await rawRequest(endpoint, {
    method: "POST",
    headers: {
      ...APP_HEADERS,
      "content-length": String(9 * 1024),
    },
    body: "x".repeat(9 * 1024),
  });
  assert.equal(oversized.status, 413);
  assert.deepEqual(JSON.parse(oversized.body), { error: "request_body_too_large" });

  const invalidMethod = await fetch(endpoint, { method: "PUT" });
  assert.equal(invalidMethod.status, 405);
  assert.deepEqual(await invalidMethod.json(), { error: "method_not_allowed" });

  const getWithBody = await rawRequest(`${base}/api/v2/stream/${"a".repeat(24)}?quality=standard`, {
    headers: { "content-length": "1" },
    body: "x",
  });
  assert.equal(getWithBody.status, 400);
  assert.deepEqual(JSON.parse(getWithBody.body), { error: "request_body_not_allowed" });

  for (const [headers, error] of [
    [{
      origin: APP_ORIGIN,
      "access-control-request-method": "DELETE",
      "access-control-request-headers": "content-type",
    }, "cors_method_not_allowed"],
    [{
      origin: APP_ORIGIN,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type,x-evil-header",
    }, "cors_headers_not_allowed"],
  ]) {
    const preflight = await fetch(endpoint, { method: "OPTIONS", headers });
    assert.equal(preflight.status, 403);
    assert.deepEqual(await preflight.json(), { error });
  }
  const allowedPreflight = await fetch(endpoint, {
    method: "OPTIONS",
    headers: {
      origin: APP_ORIGIN,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type,x-mineradio-application",
    },
  });
  assert.equal(allowedPreflight.status, 204);
  assert.equal(allowedPreflight.headers.get("access-control-allow-methods"), "GET,POST,OPTIONS");
  assert.equal(
    allowedPreflight.headers.get("access-control-allow-headers"),
    "content-type,range,x-mineradio-application",
  );
});

test("Kugou status exposes sanitized readiness fields without implicit validation", async (t) => {
  let statusCalls = 0;
  let validations = 0;
  const secret = "KUGOU_STATUS_SECRET";
  const kugouProvider = kugouProviderStub({
    loginStatus: async () => {
      statusCalls += 1;
      return {
        provider: "kugou",
        loggedIn: true,
        hasLocalSession: true,
        userId: "7",
        nickname: "ready",
        accountValidated: false,
        validationState: "stale",
        validationCode: secret,
        deviceRegistered: true,
        deviceRegistrationState: "registered",
        playbackReady: false,
        playbackKeyReady: false,
        restrictionCode: "stale_session",
        token: secret,
      };
    },
    validateSession: async () => {
      validations += 1;
      return {};
    },
  });
  const { base } = await fixture(t, { kugouProvider });
  const response = await fetch(`${base}/api/kugou/login/status`);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.doesNotMatch(text, new RegExp(secret));
  const status = JSON.parse(text);
  assert.equal(status.hasLocalSession, true);
  assert.equal(status.accountValidated, false);
  assert.equal(status.validationState, "stale");
  assert.equal(status.deviceRegistered, true);
  assert.equal(status.deviceRegistrationState, "registered");
  assert.equal(status.playbackReady, false);
  assert.equal(status.restrictionCode, "stale_session");
  assert.equal(statusCalls, 1);
  assert.equal(validations, 0);
});

test("Kugou refresh explicitly validates a saved session and sanitizes the result", async (t) => {
  const secret = "KUGOU_REFRESH_SECRET";
  let validations = 0;
  const kugouProvider = kugouProviderStub({
    validateSession: async () => {
      validations += 1;
      return {
        provider: "kugou",
        loggedIn: true,
        hasLocalSession: true,
        userId: "7",
        nickname: "ready",
        accountValidated: true,
        validationState: "valid",
        deviceRegistered: false,
        deviceRegistrationState: "failed",
        playbackReady: true,
        playbackKeyReady: true,
        restrictionCode: "",
        token: secret,
      };
    },
  });
  const { base } = await fixture(t, { kugouProvider });

  const response = await fetch(`${base}/api/kugou/login/refresh`);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.doesNotMatch(text, new RegExp(secret));
  const status = JSON.parse(text);
  assert.equal(status.loggedIn, true);
  assert.equal(status.accountValidated, true);
  assert.equal(status.validationState, "valid");
  assert.equal(status.deviceRegistered, false);
  assert.equal(status.deviceRegistrationState, "failed");
  assert.equal(status.playbackReady, true);
  assert.equal(validations, 1);
});

test("classic NetEase library, artist, like-status, and comment routes return bounded public data", async (t) => {
  const calls = [];
  const song = (id, name) => ({
    id,
    name,
    ar: [{ id: 77, name: "Test Artist" }],
    al: { name: "Test Album", picUrl: "https://p1.music.126.net/test-cover.jpg" },
    dt: 123_000,
    privateUrl: "https://private.example.test/audio.flac",
  });
  const provider = providerStub({
    login_status: async (options) => {
      calls.push(["login_status", options]);
      return {
        body: {
          data: {
            profile: {
              userId: 42,
              nickname: "Library User",
              avatarUrl: "https://p1.music.126.net/avatar.jpg",
            },
          },
        },
      };
    },
    user_playlist: async (options) => {
      calls.push(["user_playlist", options]);
      return {
        body: {
          playlist: [{
            id: 900,
            name: "My Playlist",
            coverImgUrl: "https://p1.music.126.net/playlist.jpg",
            trackCount: 2,
            subscribed: false,
            specialType: 5,
            cookie: "UPSTREAM_PLAYLIST_SECRET",
          }],
        },
      };
    },
    playlist_detail: async (options) => {
      calls.push(["playlist_detail", options]);
      return {
        body: {
          code: 200,
          playlist: {
            id: 900,
            name: "My Playlist",
            coverImgUrl: "https://p1.music.126.net/playlist.jpg",
            trackCount: 2,
            tracks: [song(11, "First"), song(12, "Second")],
            cookie: "UPSTREAM_PLAYLIST_SECRET",
          },
        },
      };
    },
    likelist: async (options) => {
      calls.push(["likelist", options]);
      return { body: { code: 200, ids: [11, 99], cookie: "UPSTREAM_LIKE_SECRET" } };
    },
    artist_detail: async (options) => {
      calls.push(["artist_detail", options]);
      return {
        body: {
          code: 200,
          data: {
            artist: {
              id: 77,
              name: "Test Artist",
              cover: "https://p1.music.126.net/artist.jpg",
              briefDesc: "Artist bio",
              alias: ["Alias"],
              token: "UPSTREAM_ARTIST_SECRET",
            },
          },
        },
      };
    },
    artist_top_song: async (options) => {
      calls.push(["artist_top_song", options]);
      return { body: { code: 200, songs: [song(11, "First"), song(12, "Second"), song(13, "Third")] } };
    },
    comment_music: async (options) => {
      calls.push(["comment_music", options]);
      return {
        body: {
          code: 200,
          total: 3,
          hotComments: [{
            commentId: 501,
            content: "Hot comment",
            time: 1_700_000_000_000,
            likedCount: 9,
            user: { userId: 61, nickname: "Listener", avatarUrl: "https://p1.music.126.net/u.jpg" },
            cookie: "UPSTREAM_COMMENT_SECRET",
          }],
          comments: [{
            commentId: 502,
            content: "Recent comment",
            time: 1_700_000_001_000,
            likedCount: 1,
            user: { userId: 62, nickname: "Second", avatarUrl: "http://unsafe.example/avatar.jpg" },
          }],
        },
      };
    },
  });
  const { base } = await fixture(t, { cookie: "MUSIC_U=SERVER_SECRET", provider });

  const playlists = await fetch(`${base}/api/user/playlists`).then((response) => response.json());
  assert.equal(playlists.loggedIn, true);
  assert.deepEqual(playlists.playlists, [{
    provider: "netease",
    source: "netease",
    id: "900",
    name: "My Playlist",
    cover: "https://p1.music.126.net/playlist.jpg",
    trackCount: 2,
    subscribed: false,
    specialType: 5,
  }]);

  const tracks = await fetch(`${base}/api/playlist/tracks?id=900`).then((response) => response.json());
  assert.equal(tracks.provider, "netease");
  assert.deepEqual(tracks.tracks.map((item) => item.id), ["11", "12"]);
  assert.equal(tracks.playlist.id, "900");

  const liked = await fetch(`${base}/api/song/like/check?ids=11,12,11`).then((response) => response.json());
  assert.deepEqual(liked.liked, { 11: true, 12: false });

  const artist = await fetch(`${base}/api/artist/detail?id=77&limit=2`).then((response) => response.json());
  assert.deepEqual(artist.artist, {
    id: "77",
    name: "Test Artist",
    avatar: "https://p1.music.126.net/artist.jpg",
    description: "Artist bio",
    aliases: ["Alias"],
  });
  assert.deepEqual(artist.songs.map((item) => item.id), ["11", "12"]);

  const comments = await fetch(`${base}/api/song/comments?id=11&limit=2`).then((response) => response.json());
  assert.equal(comments.comments.length, 2);
  assert.equal(comments.comments[0].user.nickname, "Listener");
  assert.equal(comments.comments[1].user.avatar, "");

  const publicPayload = JSON.stringify({ playlists, tracks, liked, artist, comments });
  assert.doesNotMatch(publicPayload, /SERVER_SECRET|UPSTREAM_|private\.example|audio\.flac/);
  for (const [, options] of calls) {
    assert.equal(options.cookie, "MUSIC_U=SERVER_SECRET");
  }
  assert.equal(calls.find(([name]) => name === "user_playlist")[1].uid, "42");
  assert.equal(calls.find(([name]) => name === "comment_music")[1].limit, 2);
});

test("classic NetEase mutations require trusted JSON intent and expose only operation results", async (t) => {
  const calls = [];
  const provider = providerStub({
    like: async (options) => {
      calls.push(["like", options]);
      return { body: { code: 200, cookie: "MUTATION_SECRET", url: "https://private.example.test" } };
    },
    playlist_create: async (options) => {
      calls.push(["playlist_create", options]);
      return {
        body: {
          code: 200,
          playlist: { id: 901, name: options.name, coverImgUrl: "https://p1.music.126.net/new.jpg" },
          cookie: "MUTATION_SECRET",
        },
      };
    },
    playlist_tracks: async (options) => {
      calls.push(["playlist_tracks", options]);
      return { body: { code: 200, cookie: "MUTATION_SECRET" } };
    },
  });
  const { base } = await fixture(t, { cookie: "MUSIC_U=SERVER_SECRET", provider });

  const likedResponse = await postJson(`${base}/api/song/like`, { id: "11", like: true });
  assert.equal(likedResponse.status, 200);
  assert.deepEqual(await likedResponse.json(), {
    provider: "netease",
    ok: true,
    id: "11",
    liked: true,
  });

  const compatibilityLike = await postJson(`${base}/api/song/like?id=12&like=false`, {});
  assert.equal(compatibilityLike.status, 200);
  assert.equal((await compatibilityLike.json()).liked, false);

  const createdResponse = await postJson(`${base}/api/playlist/create`, { name: "New Playlist" });
  assert.equal(createdResponse.status, 200);
  const createdText = await createdResponse.text();
  assert.doesNotMatch(createdText, /SERVER_SECRET|MUTATION_SECRET|private\.example/);
  assert.equal(JSON.parse(createdText).playlist.id, "901");

  const addedResponse = await postJson(`${base}/api/playlist/add-song`, { pid: "901", id: "11" });
  assert.equal(addedResponse.status, 200);
  assert.deepEqual(await addedResponse.json(), {
    provider: "netease",
    success: true,
    playlistId: "901",
    songId: "11",
  });

  assert.deepEqual(calls.map(([name]) => name), ["like", "like", "playlist_create", "playlist_tracks"]);
  for (const [, options] of calls) assert.equal(options.cookie, "MUSIC_U=SERVER_SECRET");
  assert.deepEqual(calls[0][1], {
    id: "11",
    like: "true",
    cookie: "MUSIC_U=SERVER_SECRET",
    timestamp: calls[0][1].timestamp,
  });
  assert.equal(calls[1][1].like, "false");
  assert.equal(calls[2][1].privacy, 0);
  assert.deepEqual(
    { op: calls[3][1].op, pid: calls[3][1].pid, tracks: calls[3][1].tracks },
    { op: "add", pid: "901", tracks: "11" },
  );

  for (const route of ["/api/song/like", "/api/playlist/create", "/api/playlist/add-song"]) {
    const getResponse = await fetch(`${base}${route}`);
    assert.equal(getResponse.status, 405, route);
    assert.deepEqual(await getResponse.json(), { error: "method_not_allowed" });
  }
  const missingIntent = await postJson(`${base}/api/song/like`, { id: "11", like: true }, {
    headers: { "x-mineradio-application": "" },
  });
  assert.equal(missingIntent.status, 403);
  assert.deepEqual(await missingIntent.json(), { error: "application_header_required" });

  const unknownField = await postJson(`${base}/api/playlist/add-song`, {
    pid: "901",
    id: "11",
    cookie: "attacker-value",
  });
  assert.equal(unknownField.status, 400);
  assert.deepEqual(await unknownField.json(), { error: "invalid_playlist_add_request" });
});

test("classic NetEase compatibility routes reject invalid identifiers and logged-out writes", async (t) => {
  let providerCalls = 0;
  const provider = providerStub({
    playlist_detail: async () => {
      providerCalls += 1;
      return {};
    },
    likelist: async () => {
      providerCalls += 1;
      return {};
    },
    artist_detail: async () => {
      providerCalls += 1;
      return {};
    },
    comment_music: async () => {
      providerCalls += 1;
      return {};
    },
    like: async () => {
      providerCalls += 1;
      return {};
    },
  });
  const { base } = await fixture(t, { provider });

  for (const [route, error] of [
    ["/api/playlist/tracks?id=abc", "invalid_playlist_id"],
    ["/api/song/like/check?ids=11,bad", "invalid_song_ids"],
    ["/api/artist/detail?id=0", "invalid_artist_id"],
    ["/api/song/comments?id=bad", "invalid_song_id"],
  ]) {
    const response = await fetch(`${base}${route}`);
    assert.equal(response.status, 400, route);
    assert.equal((await response.json()).error, error, route);
  }
  const mutation = await postJson(`${base}/api/song/like`, { id: "11", like: true });
  assert.equal(mutation.status, 401);
  assert.deepEqual(await mutation.json(), { error: "login_required" });

  const loggedOutPlaylists = await fetch(`${base}/api/user/playlists`).then((response) => response.json());
  assert.deepEqual(loggedOutPlaylists, { loggedIn: false, user: null, playlists: [] });
  assert.equal(providerCalls, 0);
});

test("classic NetEase podcast routes return playable, bounded, public-only data", async (t) => {
  const calls = [];
  const radio = {
    id: 7001,
    name: "Test Podcast",
    picUrl: "https://p1.music.126.net/podcast.jpg",
    desc: "Public description https://private.example.test/description",
    dj: { nickname: "Test DJ" },
    programCount: 4,
    subCount: 12,
    cookie: "UPSTREAM_PODCAST_SECRET",
  };
  const program = {
    id: 9001,
    name: "Test Episode",
    radio,
    mainSong: {
      id: 8001,
      name: "Episode Audio",
      ar: [{ id: 6001, name: "Speaker" }],
      al: { name: "Test Podcast", picUrl: "https://p1.music.126.net/episode.jpg" },
      dt: 123_000,
      url: "https://private.example.test/audio.mp3",
    },
    description: "Episode description https://private.example.test/episode",
    coverUrl: "https://p1.music.126.net/episode.jpg",
    cookie: "UPSTREAM_PROGRAM_SECRET",
  };
  const voice = {
    resource: {
      id: 9101,
      mainTrackId: 8101,
      name: "Liked Voice",
      voiceList: { id: 7101, name: "Voice List" },
      coverUrl: "https://p1.music.126.net/voice.jpg",
      url: "https://private.example.test/voice.mp3",
    },
  };
  const provider = providerStub({
    login_status: async (options) => {
      calls.push(["login_status", options]);
      return { body: { data: { profile: { userId: 42, nickname: "Podcast User" } } } };
    },
    dj_hot: async (options) => {
      calls.push(["dj_hot", options]);
      return { body: { code: 200, djRadios: [radio], hasMore: true } };
    },
    cloudsearch: async (options) => {
      calls.push(["cloudsearch", options]);
      return { body: { code: 200, result: { djRadios: [radio], djRadiosCount: 1 } } };
    },
    dj_detail: async (options) => {
      calls.push(["dj_detail", options]);
      return { body: { code: 200, data: radio } };
    },
    dj_program: async (options) => {
      calls.push(["dj_program", options]);
      return { body: { code: 200, programs: [program], count: 1 } };
    },
    dj_sublist: async (options) => {
      calls.push(["dj_sublist", options]);
      return { body: { code: 200, djRadios: [radio] } };
    },
    user_audio: async (options) => {
      calls.push(["user_audio", options]);
      return { body: { code: 200, djRadios: [{ ...radio, id: 7002, name: "Created Podcast" }] } };
    },
    sati_resource_sub_list: async (options) => {
      calls.push(["sati_resource_sub_list", options]);
      return { body: { code: 200, data: { resources: [voice] } } };
    },
  });
  const { base } = await fixture(t, { provider, cookie: "MUSIC_U=SERVER_SECRET" });

  const hot = await fetch(`${base}/api/podcast/hot?limit=999&offset=999999`).then((res) => res.json());
  const search = await fetch(`${base}/api/podcast/search?keywords=${"x".repeat(120)}&limit=0`).then((res) => res.json());
  const detail = await fetch(`${base}/api/podcast/detail?id=7001`).then((res) => res.json());
  const programs = await fetch(`${base}/api/podcast/programs?id=7001&limit=999`).then((res) => res.json());
  const mine = await fetch(`${base}/api/podcast/my`).then((res) => res.json());
  const liked = await fetch(`${base}/api/podcast/my/items?key=liked&limit=36`).then((res) => res.json());

  assert.equal(hot.podcasts[0].id, "7001");
  assert.equal(search.podcasts[0].cover, "https://p1.music.126.net/podcast.jpg");
  assert.equal(detail.podcast.djName, "Test DJ");
  assert.equal(programs.programs[0].id, "8001");
  assert.equal(programs.programs[0].programId, "9001");
  assert.deepEqual(mine.collections.map((item) => item.key), ["collect", "created", "liked"]);
  assert.equal(liked.itemType, "voice");
  assert.equal(liked.items[0].id, "8101");
  assert.equal(calls.find(([name]) => name === "dj_hot")[1].limit, 30);
  assert.equal(calls.find(([name]) => name === "dj_hot")[1].offset, 10_000);
  assert.equal(calls.find(([name]) => name === "cloudsearch")[1].keywords.length, 80);
  assert.equal(calls.find(([name]) => name === "cloudsearch")[1].limit, 1);
  for (const [, options] of calls) assert.equal(options.cookie, "MUSIC_U=SERVER_SECRET");

  const publicPayload = JSON.stringify({ hot, search, detail, programs, mine, liked });
  assert.doesNotMatch(publicPayload, /SERVER_SECRET|UPSTREAM_|private\.example|audio\.mp3|voice\.mp3/);
});

test("podcast compatibility rejects unsafe identifiers and disables URL beatmap fetching", async (t) => {
  let providerCalls = 0;
  const provider = providerStub({
    dj_detail: async () => { providerCalls += 1; return {}; },
    dj_program: async () => { providerCalls += 1; return {}; },
    cloudsearch: async () => { providerCalls += 1; return {}; },
  });
  const { base } = await fixture(t, { provider });

  for (const route of [
    "/api/podcast/detail?id=abc",
    "/api/podcast/programs?id=01",
    "/api/podcast/search",
    "/api/podcast/my/items?key=paid",
  ]) {
    const response = await fetch(`${base}${route}`);
    assert.equal(response.status, 400, route);
  }
  const beatmap = await fetch(
    `${base}/api/podcast/dj-beatmap?url=${encodeURIComponent("https://private.example.test/audio.mp3")}`,
  );
  assert.equal(beatmap.status, 501);
  const beatmapText = await beatmap.text();
  assert.deepEqual(JSON.parse(beatmapText), {
    ok: false,
    disabled: true,
    error: "server_beatmap_disabled",
  });
  assert.doesNotMatch(beatmapText, /private\.example|audio\.mp3/);

  const mine = await fetch(`${base}/api/podcast/my`).then((response) => response.json());
  assert.equal(mine.loggedIn, false);
  assert.deepEqual(mine.collections.map((item) => item.key), ["collect", "created", "liked"]);
  assert.equal(providerCalls, 0);
});
