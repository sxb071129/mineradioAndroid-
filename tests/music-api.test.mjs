import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMusicApi } from "../scripts/music-api.mjs";

function providerStub(overrides = {}) {
  return {
    cloudsearch: async () => ({ body: { result: { songs: [] } } }),
    song_url_v1: async () => ({ body: { data: [] } }),
    song_url: async () => ({ body: { data: [] } }),
    login_qr_key: async () => ({ body: { data: { unikey: "test-key" } } }),
    login_qr_create: async () => ({ body: { data: { qrimg: "data:image/png;base64,AA==" } } }),
    login_qr_check: async () => ({ body: { code: 801, message: "waiting" } }),
    login_status: async () => ({ body: { data: {} } }),
    user_account: async () => ({ body: {} }),
    logout: async () => ({ body: { code: 200 } }),
    recommend_songs: async () => ({ body: { data: { dailySongs: [] } } }),
    recommend_resource: async () => ({ body: { recommend: [] } }),
    ...overrides,
  };
}

function kugouProviderStub(overrides = {}) {
  return {
    loginStatus: async () => ({ provider: "kugou", loggedIn: false }),
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
    resolveStream: async () => ({ provider: "kugou", url: "", playable: false, reason: "login_required" }),
    ...overrides,
  };
}

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mineradio-music-api-"));
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
  });
  t.after(async () => {
    await api.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { api, dataDir, base: `http://127.0.0.1:${api.port}` };
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
