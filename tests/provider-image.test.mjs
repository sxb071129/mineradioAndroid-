import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import {
  accountAvatarSrc,
  DEFAULT_ACCOUNT_AVATAR,
  normalizeProviderImageUrl,
} from "../app/lib/provider-image.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("provider account images upgrade known HTTP CDNs without allowing arbitrary mixed content", () => {
  assert.equal(
    normalizeProviderImageUrl("http://p1.music.126.net/avatar.jpg"),
    "https://p1.music.126.net/avatar.jpg",
  );
  assert.equal(
    normalizeProviderImageUrl("http://img.kugou.com/avatar.png"),
    "https://img.kugou.com/avatar.png",
  );
  assert.equal(normalizeProviderImageUrl("http://untrusted.example/avatar.png"), "");
  assert.equal(normalizeProviderImageUrl("http://img.kugou.com:8080/avatar.png"), "");
  assert.equal(normalizeProviderImageUrl("javascript:alert(1)"), "");
  assert.equal(normalizeProviderImageUrl("https://images.example.test/avatar.webp"), "https://images.example.test/avatar.webp");
});

test("account avatars use the original player artwork when metadata is absent or invalid", () => {
  assert.equal(accountAvatarSrc(""), DEFAULT_ACCOUNT_AVATAR);
  assert.equal(accountAvatarSrc("http://untrusted.example/avatar.png"), DEFAULT_ACCOUNT_AVATAR);
  assert.equal(
    accountAvatarSrc("https://p1.music.126.net/avatar.jpg"),
    "https://p1.music.126.net/avatar.jpg",
  );
});

test("Classic upgrades persisted provider HTTP covers before proxying them into the color pipeline", async () => {
  const html = await readFile(path.join(root, "public", "classic", "index.html"), "utf8");
  const helpers = sourceBetween(
    html,
    "var TRUSTED_HTTP_PROVIDER_IMAGE_SUFFIXES",
    "function songCustomCoverKey",
  );
  const context = {
    URL,
    encodeURIComponent,
    isInlineCoverSrc: () => false,
    window: {
      MineradioWebBridge: {
        coverUrl: (url) => `proxy:${url}`,
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(helpers, context);

  assert.equal(
    context.normalizeProviderImageUrl("http://p4.music.126.net/emily.jpg"),
    "https://p4.music.126.net/emily.jpg",
  );
  assert.equal(
    context.coverProxySrc("http://p4.music.126.net/emily.jpg"),
    "proxy:https://p4.music.126.net/emily.jpg",
  );
  assert.equal(context.coverProxySrc("http://untrusted.example/emily.jpg"), "");
  assert.match(html, /pipeline\.loadReadableImage\(\[proxiedUrl, directUrl\]/);
  assert.match(html, /function refreshCoverDependentColors\(\)/);
  assert.match(html, /function applyCoverCanvas[\s\S]*?refreshCoverDependentColors\(\)/);
});

test("Classic and Modern account avatars replace failed remote images with original fallbacks", async () => {
  const [classic, modern] = await Promise.all([
    readFile(path.join(root, "public", "classic", "index.html"), "utf8"),
    readFile(path.join(root, "app", "components", "MineradioPlayer.tsx"), "utf8"),
  ]);
  const avatarHelpers = sourceBetween(
    classic,
    "function providerAvatarFallbackSrc",
    "function renderTopAccountPill",
  );
  const context = {
    encodeURIComponent,
    platformMeta: () => ({ short: "KG" }),
    platformStatus: () => ({ avatar: "https://img.kugou.com/missing.png" }),
    avatarSrc: (url) => `proxy:${url}`,
  };
  vm.createContext(context);
  vm.runInContext(avatarHelpers, context);

  const image = {};
  context.setProviderAvatarElement(image, "kugou", {
    avatar: "https://img.kugou.com/missing.png",
  });
  assert.equal(image.src, "proxy:https://img.kugou.com/missing.png");
  image.onerror();
  assert.match(image.src, /^data:image\/svg\+xml/);
  assert.equal(image.onerror, null);

  assert.match(classic, /wireProviderAvatarFallbacks\(btn\)/);
  assert.match(modern, /src=\{accountAvatarSrc\(cloudUser\.avatar\)\}/);
  assert.match(modern, /dataset\.fallbackApplied === "1"/);
  assert.match(modern, /event\.currentTarget\.src = DEFAULT_ACCOUNT_AVATAR/);
});
