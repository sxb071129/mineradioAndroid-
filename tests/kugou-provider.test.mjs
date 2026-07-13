import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createKugouProvider } from "../scripts/kugou-provider.mjs";

test("Kugou provider persists QR credentials locally without returning them", async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mineradio-kugou-provider-"));
  const authFile = path.join(dataDir, "kugou.auth.json");
  const secret = "KUGOU_PROVIDER_TOP_SECRET";
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const requests = [];
  const fetchImpl = async (url) => {
    const target = new URL(url);
    requests.push(target);
    if (target.pathname === "/v2/qrcode") {
      return Response.json({ data: { qrcode: "KUGOU_QR_PROVIDER_KEY" } });
    }
    if (target.pathname === "/v2/get_userinfo_qrcode") {
      return Response.json({
        data: {
          status: 4,
          token: secret,
          userid: "123456",
          nickname: "本机酷狗用户",
          vip_type: 1,
        },
      });
    }
    if (target.pathname === "/risk/v2/r_register_dev") {
      return Response.json({ error: "registration skipped in test" }, { status: 503 });
    }
    if (target.hostname === "trackercdn.kugou.com" && target.pathname === "/i/v2/") {
      return Response.json({ status: 1, data: {} });
    }
    throw new Error(`Unexpected Kugou URL: ${target}`);
  };

  const provider = await createKugouProvider({
    authFile,
    fetchImpl,
    qrCode: async () => "data:image/png;base64,AA==",
  });
  const qr = await provider.loginQrKey();
  assert.equal(qr.key, "KUGOU_QR_PROVIDER_KEY");
  assert.match(qr.url, /^https:\/\/h5\.kugou\.com\//);
  const checked = await provider.loginQrCheck(qr.key);
  assert.equal(checked.code, 803);
  assert.equal(checked.loggedIn, true);
  assert.doesNotMatch(JSON.stringify(checked), new RegExp(secret));

  const persisted = await readFile(authFile, "utf8");
  assert.match(persisted, new RegExp(secret));
  assert.equal((await provider.loginStatus()).nickname, "本机酷狗用户");
  assert.equal(requests.some((request) => request.hostname === "userservice.kugou.com"), true);

  await provider.logout();
  assert.doesNotMatch(await readFile(authFile, "utf8"), new RegExp(secret));

  const unavailable = await provider.resolveStream({
    hash: "A".repeat(32),
    qualityHashes: { standard: "A".repeat(32) },
  }, "standard");
  assert.equal(unavailable.playable, false);
  assert.equal(unavailable.url, "");
  assert.equal(unavailable.reason, "login_required");
});
