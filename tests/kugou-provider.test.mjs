import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createKugouProvider } from "../scripts/kugou-provider.mjs";

const secret = "KUGOU_PROVIDER_TOP_SECRET";
const userId = "123456";
const hash = "A".repeat(32);

async function createFixture(t, fetchImpl, initialState) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mineradio-kugou-provider-"));
  const authFile = path.join(dataDir, "kugou.auth.json");
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  if (initialState) await writeFile(authFile, `${JSON.stringify(initialState)}\n`, { mode: 0o600 });
  const provider = await createKugouProvider({
    authFile,
    fetchImpl,
    qrCode: async () => "data:image/png;base64,AA==",
  });
  return { authFile, provider };
}

function authenticatedState(overrides = {}) {
  return {
    version: 1,
    device: {
      guid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      mid: "123456789",
      mac: "AAAAAAAAAAAA",
      dev: "BBBBBBBBBBBBBBBB",
      dfid: "REGISTERED_DFID",
    },
    session: {
      userId,
      token: secret,
      nickname: "本机酷狗用户",
      avatar: "",
      vipType: 1,
    },
    validation: {
      validationState: "valid",
      validatedAt: "2026-07-13T00:00:00.000Z",
      lastAttemptAt: "2026-07-13T00:00:00.000Z",
      code: "ok",
    },
    deviceRegistration: {
      registrationState: "registered",
      attemptedAt: "2026-07-13T00:00:00.000Z",
      registeredAt: "2026-07-13T00:00:00.000Z",
      code: "ok",
    },
    ...overrides,
  };
}

async function login(provider) {
  const qr = await provider.loginQrKey();
  return provider.loginQrCheck(qr.key);
}

async function waitForProviderStatus(provider, predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await provider.loginStatus();
    if (predicate(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("provider_status_timeout");
}

function loginFetch({ registrationResponse, validationResponse } = {}) {
  return async (url) => {
    const target = new URL(url);
    if (target.pathname === "/v2/qrcode") {
      return Response.json({ data: { qrcode: "KUGOU_QR_PROVIDER_KEY" } });
    }
    if (target.pathname === "/v2/get_userinfo_qrcode") {
      return Response.json({
        data: { status: 4, token: secret, userid: userId, nickname: "本机酷狗用户", vip_type: 1 },
      });
    }
    if (target.pathname === "/risk/v2/r_register_dev") {
      return registrationResponse ?? Response.json({ data: { dfid: "NEW_REGISTERED_DFID" }, status: 1 });
    }
    if (target.pathname === "/v7/get_all_list") {
      return validationResponse ?? Response.json({ error_code: 0, status: 1, data: { lists: [] } });
    }
    if (target.pathname === "/v1/get_union_vip") {
      return Response.json({
        error_code: 0,
        status: 1,
        data: { is_vip: 1, vip_type: 6, svip_level: 5 },
      });
    }
    throw new Error(`Unexpected Kugou URL: ${target}`);
  };
}

test("registration failure persists as diagnostics without blocking validated playback", async (t) => {
  const { authFile, provider } = await createFixture(t, loginFetch({
    registrationResponse: Response.json({ error: `failed token=${secret}` }, { status: 503 }),
  }));

  const loginResult = await login(provider);
  assert.equal(loginResult.code, 803);
  const checked = await waitForProviderStatus(
    provider,
    (status) => status.deviceRegistrationState === "failed" && status.validationState === "valid",
  );
  assert.equal(checked.loggedIn, true);
  assert.equal(checked.hasLocalSession, true);
  assert.equal(checked.accountValidated, true);
  assert.equal(checked.deviceRegistrationState, "failed");
  assert.equal(checked.playbackReady, true);
  assert.equal(checked.restrictionCode, "");
  assert.doesNotMatch(JSON.stringify(checked), new RegExp(secret));

  const validated = await provider.validateSession();
  assert.equal(validated.ok, true);
  assert.equal(validated.accountValidated, true);
  assert.equal(validated.deviceRegistrationState, "failed");
  assert.equal(validated.playbackReady, true);
  assert.equal(validated.restrictionCode, "");

  const persistedText = await readFile(authFile, "utf8");
  const persisted = JSON.parse(persistedText);
  assert.match(persistedText, new RegExp(secret));
  assert.equal(persisted.deviceRegistration.registrationState, "failed");
  assert.equal(persisted.deviceRegistration.code, "provider_request_failed");
  assert.equal("message" in persisted.deviceRegistration, false);

  const restarted = await createKugouProvider({
    authFile,
    fetchImpl: async () => { throw new Error("network must not be used"); },
    qrCode: async () => "data:image/png;base64,AA==",
  });
  const status = await restarted.loginStatus();
  assert.equal(status.hasLocalSession, true);
  assert.equal(status.deviceRegistrationState, "failed");
  assert.equal(status.playbackReady, true);
  assert.equal(status.restrictionCode, "");
});

test("successful registration and explicit validation establish playback readiness", async (t) => {
  const { authFile, provider } = await createFixture(t, loginFetch());
  const loginResult = await login(provider);
  assert.equal(loginResult.code, 803);
  const checked = await waitForProviderStatus(
    provider,
    (status) => status.deviceRegistrationState === "registered" && status.validationState === "valid",
  );
  assert.equal(checked.deviceRegistered, true);
  assert.equal(checked.validationState, "valid");
  assert.equal(checked.playbackReady, true);

  const validated = await provider.validateSession();
  assert.equal(validated.ok, true);
  assert.equal(validated.accountValidated, true);
  assert.equal(validated.validationState, "valid");
  assert.equal(validated.playbackReady, true);
  assert.equal(provider.refreshAccount, provider.validateSession);

  const persisted = JSON.parse(await readFile(authFile, "utf8"));
  assert.equal(persisted.deviceRegistration.registrationState, "registered");
  assert.equal(persisted.validation.validationState, "valid");
});

test("cookie login imports only allowlisted fields, validates the session, and redacts credentials", async (t) => {
  const importedSecret = "COOKIE_IMPORT_TOP_SECRET";
  const importedUserId = "654321";
  const importedGuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const requests = [];
  const { authFile, provider } = await createFixture(t, async (url) => {
    const target = new URL(url);
    requests.push(target.pathname);
    if (target.pathname === "/v7/get_all_list") {
      assert.equal(target.searchParams.get("userid"), importedUserId);
      assert.equal(target.searchParams.get("token"), importedSecret);
      return Response.json({ error_code: 0, status: 1, data: { lists: [] } });
    }
    if (target.pathname === "/v1/get_union_vip") {
      return Response.json({
        error_code: 0,
        status: 1,
        data: { is_vip: 1, vip_type: 8, svip_level: 7 },
      });
    }
    throw new Error(`Unexpected Kugou URL: ${target}`);
  });
  const rawCookie = [
    `Cookie: userid=${importedUserId}; token=${encodeURIComponent(importedSecret)}; nickname=Cookie%20User`,
    "avatar=https%3A%2F%2Fimg.kugou.com%2Favatar.png; vip_type=8; svip_level=7",
    `KUGOU_API_GUID=${importedGuid}; KUGOU_API_MID=987654321; KUGOU_API_MAC=CCCCCCCCCCCC`,
    "KUGOU_API_DEV=DDDDDDDDDDDDDDDD; dfid=IMPORTED_DFID; ignored_field=must-not-persist",
  ].join("\r\n");

  const result = await provider.loginCookie(rawCookie);

  assert.equal(result.loggedIn, true);
  assert.equal(result.saved, true);
  assert.equal(result.accountValidated, true);
  assert.equal(result.userId, importedUserId);
  assert.equal(result.nickname, "Cookie User");
  assert.equal(result.vipType, 8);
  assert.equal(result.svipLevel, 7);
  assert.equal("token" in result, false);
  assert.equal("cookie" in result, false);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(importedSecret));
  assert.deepEqual(requests, ["/v7/get_all_list", "/v1/get_union_vip"]);

  const persistedText = await readFile(authFile, "utf8");
  const persisted = JSON.parse(persistedText);
  assert.equal(persisted.session.userId, importedUserId);
  assert.equal(persisted.session.token, importedSecret);
  assert.equal(persisted.session.nickname, "Cookie User");
  assert.equal(persisted.session.avatar, "https://img.kugou.com/avatar.png");
  assert.equal(persisted.device.guid, importedGuid);
  assert.equal(persisted.device.mid, "987654321");
  assert.equal(persisted.device.mac, "CCCCCCCCCCCC");
  assert.equal(persisted.device.dev, "DDDDDDDDDDDDDDDD");
  assert.equal(persisted.device.dfid, "IMPORTED_DFID");
  assert.equal(persisted.deviceRegistration.registrationState, "registered");
  assert.doesNotMatch(persistedText, /ignored_field|must-not-persist|Cookie:/i);
});

test("cookie login rejects malformed and oversized input before using the network", async (t) => {
  let calls = 0;
  const { authFile, provider } = await createFixture(t, async () => {
    calls += 1;
    throw new Error("network must not be used");
  });
  const before = await readFile(authFile, "utf8");

  await assert.rejects(
    provider.loginCookie("Cookie: nickname=Missing%20Credentials"),
    (error) => error?.code === "invalid_kugou_cookie" && error?.statusCode === 400,
  );
  await assert.rejects(
    provider.loginCookie(`userid=${userId}; token=${"X".repeat(33 * 1024)}`),
    (error) => error?.code === "invalid_kugou_cookie" && error?.statusCode === 400,
  );

  assert.equal(calls, 0);
  assert.equal(await readFile(authFile, "utf8"), before);
});

test("cookie login rolls back the previous session when validation rejects new credentials", async (t) => {
  const rejectedSecret = "REJECTED_COOKIE_SECRET";
  const initial = authenticatedState();
  const { authFile, provider } = await createFixture(
    t,
    async () => Response.json({ error: "token expired" }, { status: 401 }),
    initial,
  );

  await assert.rejects(
    provider.loginCookie(`Cookie: userid=999999; token=${rejectedSecret}; nickname=Rejected`),
    (error) => error?.code === "invalid_provider_credentials" && error?.statusCode === 401,
  );

  const status = await provider.loginStatus();
  assert.equal(status.userId, userId);
  assert.equal(status.validationState, "valid");
  assert.doesNotMatch(JSON.stringify(status), new RegExp(`${secret}|${rejectedSecret}`));
  const persistedText = await readFile(authFile, "utf8");
  assert.match(persistedText, new RegExp(secret));
  assert.doesNotMatch(persistedText, new RegExp(rejectedSecret));
});

test("account refresh restores Kugou SVIP metadata and sends its vipType to the tracker", async (t) => {
  const trackerVipTypes = [];
  const initial = authenticatedState({
    session: {
      ...authenticatedState().session,
      vipType: 0,
      svipLevel: 0,
    },
  });
  const { authFile, provider } = await createFixture(t, async (url) => {
    const target = new URL(url);
    if (target.pathname === "/v7/get_all_list") {
      return Response.json({ error_code: 0, status: 1, data: { lists: [] } });
    }
    if (target.pathname === "/v1/get_union_vip") {
      assert.equal(target.origin, "https://kugouvip.kugou.com");
      assert.equal(target.searchParams.get("busi_type"), "concept");
      return Response.json({
        error_code: 0,
        status: 1,
        data: { is_vip: 1, vip_type: 6, svip_level: 5 },
      });
    }
    if (target.pathname === "/i/v2/") {
      trackerVipTypes.push(target.searchParams.get("vipType"));
      return Response.json({
        error_code: 0,
        status: 1,
        data: { play_url: "https://trackercdn.kugou.com/audio/svip-example.flac" },
      });
    }
    throw new Error(`Unexpected Kugou URL: ${target}`);
  }, initial);

  const refreshed = await provider.refreshAccount();
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.vipType, 6);
  assert.equal(refreshed.svipLevel, 5);
  assert.equal(refreshed.vipLevel, "svip");
  assert.equal(refreshed.isVip, true);
  assert.equal(refreshed.isSvip, true);
  assert.equal(refreshed.vipLabel, "Kugou SVIP");

  const stream = await provider.resolveStream({ hash, qualityHashes: { standard: hash } }, "standard");
  assert.equal(stream.playable, true);
  assert.deepEqual(trackerVipTypes, ["6"]);

  const persisted = JSON.parse(await readFile(authFile, "utf8"));
  assert.equal(persisted.session.vipType, 6);
  assert.equal(persisted.session.svipLevel, 5);
  assert.doesNotMatch(JSON.stringify(refreshed), new RegExp(secret));
});

test("high-quality playback enriches playlist hashes once and selects the requested Kugou source", async (t) => {
  const qualityHashes = {
    standard: "1".repeat(32),
    exhigh: "2".repeat(32),
    lossless: "3".repeat(32),
    hires: "4".repeat(32),
    jymaster: "5".repeat(32),
  };
  let metadataRequests = 0;
  const trackerHashes = [];
  const { provider } = await createFixture(t, async (url, init) => {
    const target = new URL(url);
    if (target.pathname === "/v1/audio/audio") {
      metadataRequests += 1;
      assert.equal(target.origin, "https://gateway.kugou.com");
      assert.equal(init.headers["x-router"], "kmr.service.kugou.com");
      const body = JSON.parse(init.body);
      assert.equal(body.data.length, 1);
      assert.equal(body.data[0].hash, hash);
      assert.match(body.key, /^[a-f0-9]{32}$/);
      return Response.json({
        error_code: 0,
        status: 1,
        data: [{
          hash_128: qualityHashes.standard,
          hash_320: qualityHashes.exhigh,
          hash_flac: qualityHashes.lossless,
          hash_high: qualityHashes.hires,
          hash_super: "6".repeat(32),
          jymaster_hash: qualityHashes.jymaster,
        }],
      });
    }
    if (target.pathname === "/i/v2/") {
      trackerHashes.push(target.searchParams.get("hash"));
      return Response.json({
        error_code: 0,
        status: 1,
        data: { play_url: "https://trackercdn.kugou.com/audio/quality-example.flac" },
      });
    }
    throw new Error(`Unexpected Kugou URL: ${target}`);
  }, authenticatedState());

  const descriptor = { hash, qualityHashes: { standard: hash } };
  const master = await provider.resolveStream(descriptor, "jymaster");
  const hires = await provider.resolveStream(descriptor, "hires");

  assert.equal(metadataRequests, 1);
  assert.equal(master.level, "jymaster");
  assert.equal(master.downgraded, false);
  assert.equal(hires.level, "hires");
  assert.equal(hires.downgraded, false);
  assert.deepEqual(trackerHashes, [qualityHashes.jymaster, qualityHashes.hires]);
});

test("browser-incompatible Kugou lossless formats fall back to a web-playable source", async (t) => {
  const losslessHash = "3".repeat(32);
  const trackerHashes = [];
  const { provider } = await createFixture(t, async (url) => {
    const target = new URL(url);
    if (target.pathname === "/i/v2/") {
      const requestedHash = target.searchParams.get("hash");
      trackerHashes.push(requestedHash);
      return Response.json({
        error_code: 0,
        status: 1,
        data: requestedHash === losslessHash
          ? { play_url: "https://trackercdn.kugou.com/audio/example.ape", extName: "ape" }
          : { play_url: "https://trackercdn.kugou.com/audio/example.mp3", extName: "mp3" },
      });
    }
    throw new Error(`Unexpected Kugou URL: ${target}`);
  }, authenticatedState());

  const result = await provider.resolveStream({
    hash,
    qualityHashes: { lossless: losslessHash, standard: hash },
  }, "lossless");

  assert.equal(result.playable, true);
  assert.equal(result.level, "standard");
  assert.equal(result.downgraded, true);
  assert.deepEqual(trackerHashes, [losslessHash, hash]);
});

test("successful QR login returns before best-effort device registration finishes", async (t) => {
  let finishRegistration;
  const { provider } = await createFixture(t, async (url) => {
    const target = new URL(url);
    if (target.pathname === "/v2/qrcode") {
      return Response.json({ data: { qrcode: "KUGOU_QR_PROVIDER_KEY" } });
    }
    if (target.pathname === "/v2/get_userinfo_qrcode") {
      return Response.json({
        data: { status: 4, token: secret, userid: userId, nickname: "Kugou user", vip_type: 1 },
      });
    }
    if (target.pathname === "/risk/v2/r_register_dev") {
      return new Promise((resolve) => {
        finishRegistration = () => resolve(Response.json({
          data: { dfid: "NEW_REGISTERED_DFID" },
          status: 1,
        }));
      });
    }
    throw new Error(`Unexpected Kugou URL: ${target}`);
  });

  const qr = await provider.loginQrKey();
  const result = await Promise.race([
    provider.loginQrCheck(qr.key),
    new Promise((_, reject) => setTimeout(() => reject(new Error("login_waited_for_registration")), 100)),
  ]);
  assert.equal(result.code, 803);
  assert.equal(result.loggedIn, true);
  assert.equal(result.hasLocalSession, true);
  assert.equal(result.deviceRegistrationState, "unregistered");

  finishRegistration();
  const registered = await waitForProviderStatus(
    provider,
    (status) => status.deviceRegistrationState === "registered",
  );
  assert.equal(registered.deviceRegistered, true);
});

test("transient validation failure retains credentials and records provider unavailable", async (t) => {
  const { authFile, provider } = await createFixture(
    t,
    async () => { throw new Error(`offline ${secret}`); },
    authenticatedState(),
  );

  const refreshed = await provider.refreshAccount();
  assert.equal(refreshed.ok, false);
  assert.equal(refreshed.hasLocalSession, true);
  assert.equal(refreshed.validationState, "unavailable");
  assert.equal(refreshed.accountValidated, false);
  assert.equal(refreshed.validationCode, "provider_unavailable");
  assert.equal(refreshed.playbackReady, true);
  assert.doesNotMatch(JSON.stringify(refreshed), new RegExp(secret));
  assert.match(await readFile(authFile, "utf8"), new RegExp(secret));
});

test("definitive validation rejection marks the session stale without deleting it", async (t) => {
  const { authFile, provider } = await createFixture(
    t,
    async () => Response.json({ error: `token=${secret} expired` }, { status: 401 }),
    authenticatedState(),
  );

  const refreshed = await provider.validateSession();
  assert.equal(refreshed.ok, false);
  assert.equal(refreshed.hasLocalSession, true);
  assert.equal(refreshed.validationState, "stale");
  assert.equal(refreshed.restrictionCode, "stale_session");
  assert.equal(refreshed.playbackReady, false);
  assert.doesNotMatch(JSON.stringify(refreshed), new RegExp(secret));
  assert.match(await readFile(authFile, "utf8"), new RegExp(secret));

  const resolved = await provider.resolveStream({ hash, qualityHashes: { standard: hash } }, "standard");
  assert.equal(resolved.reason, "stale_session");
  assert.equal(resolved.url, "");
  assert.equal(resolved.resolvedHash, "");
});

test("resolveStream returns structured restrictions and redacts provider data", async (t) => {
  const scenarios = [
    [{ status: 9, message: `copyright unavailable token=${secret} ${hash}` }, "copyright_unavailable"],
    [{ status: 9, message: "region restricted" }, "region_restricted"],
    [{ status: 404, message: "quality unavailable" }, "quality_unavailable"],
    [{ status: 6, message: "VIP required" }, "paid_required"],
    [{ error_code: 0, status: 0, data: {} }, "provider_contract_changed"],
  ];

  for (const [response, expected] of scenarios) {
    const { provider } = await createFixture(
      t,
      async (url) => {
        const target = new URL(url);
        assert.equal(target.protocol, "https:");
        assert.equal(target.hostname, "trackercdn.kugou.com");
        return Response.json(response);
      },
      authenticatedState(),
    );
    const result = await provider.resolveStream({ hash, qualityHashes: { standard: hash } }, "standard");
    assert.equal(result.reason, expected);
    assert.equal(result.restriction.category, expected);
    assert.equal(result.url, "");
    assert.equal(result.resolvedHash, "");
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
    assert.doesNotMatch(JSON.stringify(result), new RegExp(hash));
    assert.doesNotMatch(JSON.stringify(result), /https?:\/\//);
  }
});

test("resolveStream upgrades allowlisted Kugou HTTP stream URLs to HTTPS", async (t) => {
  const { provider } = await createFixture(
    t,
    async () => Response.json({
      error_code: 0,
      status: 1,
      data: { play_url: "http://trackercdn.kugou.com/audio/example.mp3" },
    }),
    authenticatedState(),
  );

  const result = await provider.resolveStream({ hash, qualityHashes: { standard: hash } }, "standard");
  assert.equal(result.playable, true);
  assert.equal(result.reason, "");
  assert.equal(result.url, "https://trackercdn.kugou.com/audio/example.mp3");
});

test("resolveStream rejects non-provider stream URLs without leaking them", async (t) => {
  for (const unsafeUrl of [
    `https://evil.example/${secret}/${hash}`,
    `http://evil.example/${secret}/${hash}`,
    `http://trackercdn.kugou.com.evil.example/${secret}/${hash}`,
    `http://user:pass@trackercdn.kugou.com/${secret}/${hash}`,
    `http://trackercdn.kugou.com:8080/${secret}/${hash}`,
    `http://notkugou.com/${secret}/${hash}`,
  ]) {
    const { provider } = await createFixture(
      t,
      async () => Response.json({ status: 1, data: { play_url: unsafeUrl } }),
      authenticatedState(),
    );
    const result = await provider.resolveStream({ hash, qualityHashes: { standard: hash } }, "standard");
    assert.equal(result.reason, "stream_host_rejected");
    assert.equal(result.url, "");
    assert.equal(result.resolvedHash, "");
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
    assert.doesNotMatch(JSON.stringify(result), /evil\.example|http:\/\//);
  }
});

test("lyric resolves an opaque track descriptor through fixed HTTPS Kugou endpoints", async (t) => {
  const lrc = "[00:01.00]first line\n[00:02.50]第二行";
  const accessKey = "SAFE_ACCESS_KEY";
  const requests = [];
  const { provider } = await createFixture(t, async (url) => {
    const target = new URL(url);
    requests.push(target);
    assert.equal(target.protocol, "https:");
    assert.equal(target.hostname, "lyrics.kugou.com");
    if (target.pathname === "/search") {
      assert.equal(target.searchParams.get("hash"), hash);
      return Response.json({ candidates: [{ id: "12345", accesskey: accessKey }] });
    }
    if (target.pathname === "/download") {
      assert.equal(target.searchParams.get("id"), "12345");
      assert.equal(target.searchParams.get("accesskey"), accessKey);
      return Response.json({ content: Buffer.from(lrc).toString("base64") });
    }
    throw new Error(`Unexpected Kugou lyric URL: ${target}`);
  });

  const result = await provider.lyric({ hash, duration: 180_000 });
  assert.deepEqual(result, {
    provider: "kugou",
    lyric: lrc,
    tlyric: "",
    yrc: "",
    source: "kugou-lyrics",
  });
  assert.equal(requests[0].searchParams.get("duration"), "180000");
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${hash}|${accessKey}`));
});

test("lyric rejects invalid descriptors and cross-origin redirects", async (t) => {
  let calls = 0;
  const invalidFixture = await createFixture(t, async () => {
    calls += 1;
    throw new Error("network must not be used");
  });
  await assert.rejects(invalidFixture.provider.lyric({ hash: "not-a-hash" }), /invalid_hash/);
  assert.equal(calls, 0);

  const redirectedFixture = await createFixture(
    t,
    async () => new Response(null, {
      status: 302,
      headers: { location: "https://evil.example/steal" },
    }),
  );
  await assert.rejects(
    redirectedFixture.provider.lyric({ hash }),
    /provider_cross_origin_redirect_rejected/,
  );
});

test("backward-compatible auth schema loads as an unvalidated but playable local session", async (t) => {
  const legacy = authenticatedState();
  delete legacy.validation;
  delete legacy.deviceRegistration;
  legacy.device.dfid = "-";
  const { provider } = await createFixture(
    t,
    async () => { throw new Error("network must not be used"); },
    legacy,
  );
  const status = await provider.loginStatus();
  assert.equal(status.loggedIn, true);
  assert.equal(status.hasCookie, true);
  assert.equal(status.hasLocalSession, true);
  assert.equal(status.validationState, "unvalidated");
  assert.equal(status.deviceRegistrationState, "unregistered");
  assert.equal(status.playbackReady, true);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(secret));
});

test("logout removes credentials and unauthenticated resolve reports login_required", async (t) => {
  const { authFile, provider } = await createFixture(
    t,
    async () => { throw new Error("network must not be used"); },
    authenticatedState(),
  );
  await provider.logout();
  assert.doesNotMatch(await readFile(authFile, "utf8"), new RegExp(secret));

  const unavailable = await provider.resolveStream({
    hash,
    qualityHashes: { standard: hash },
  }, "standard");
  assert.equal(unavailable.playable, false);
  assert.equal(unavailable.url, "");
  assert.equal(unavailable.reason, "login_required");
  assert.equal(unavailable.resolvedHash, "");
});
