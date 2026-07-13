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
