import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("web manifest is installable and exposes original-material icons", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("public/manifest.webmanifest", root), "utf8"),
  );

  assert.equal(manifest.id, "/");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.theme_color, "#0b0f0e");
  assert.ok(
    manifest.icons.some((icon) => icon.sizes === "192x192" && icon.purpose === "any"),
  );
  assert.ok(
    manifest.icons.some(
      (icon) => icon.sizes === "512x512" && icon.purpose.includes("maskable"),
    ),
  );

  for (const [file, expectedSize] of [
    ["public/pwa-icon-192.png", 192],
    ["public/pwa-icon-512.png", 512],
    ["public/apple-touch-icon.png", 180],
  ]) {
    const png = await readFile(new URL(file, root));
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(png.readUInt32BE(16), expectedSize);
    assert.equal(png.readUInt32BE(20), expectedSize);
  }
});

test("root layout registers the PWA without changing the Classic default route", async () => {
  const [layout, page, registrar] = await Promise.all([
    readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/components/PwaRegistrar.tsx", root), "utf8"),
  ]);

  assert.match(layout, /manifest:\s*"\/manifest\.webmanifest"/);
  assert.match(layout, /<PwaRegistrar\s*\/>/);
  assert.match(layout, /appleWebApp:\s*\{/);
  assert.match(page, /<ClassicPlayerFrame room=\{query\.room\}\s*\/>/);
  assert.match(registrar, /window\.isSecureContext/);
  assert.match(registrar, /navigator\.serviceWorker\.register\("\/sw\.js"/);
  assert.match(registrar, /updateViaCache:\s*"none"/);
  assert.doesNotMatch(registrar, /addEventListener\("load"/);
});

test("Classic direct entry exposes install metadata and secure-context registration", async () => {
  const [classic, script] = await Promise.all([
    readFile(new URL("public/classic/index.html", root), "utf8"),
    readFile(new URL("public/pwa-register.js", root), "utf8"),
  ]);

  assert.match(classic, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(classic, /rel="apple-touch-icon" href="\/apple-touch-icon\.png"/);
  assert.match(classic, /src="\/pwa-register\.js\?v=20260801-v1"/);
  assert.match(script, /window\.isSecureContext/);
  assert.match(script, /serviceWorker[\s\S]*register\("\/sw\.js"/);
});

test("service worker isolates immutable core assets and bypasses private or streaming data", async () => {
  const worker = await readFile(new URL("public/sw.js", root), "utf8");

  assert.match(worker, /CACHE_VERSION = "20260801-pwa-v7"/);
  assert.match(worker, /CORE_ASSETS[\s\S]*?"\/classic\/index\.html"/);
  assert.match(worker, /"\/classic\/room-sync-core\.js\?v=20260801-adaptive-v2"/);
  assert.match(worker, /"\/classic\/classic-web-bridge\.js\?v=20260801-sync-v6"/);
  assert.match(worker, /"\/classic\/cover-pipeline\.js\?v=20260801-v1"/);
  assert.match(worker, /"\/classic\/sonic-terrain\.js\?v=20260801-voxel-v5"/);
  assert.match(worker, /CORE_CACHE_NAME/);
  assert.match(worker, /RUNTIME_CACHE_NAME/);
  assert.match(worker, /request\.headers\.has\("range"\)/);
  assert.match(worker, /request\.destination === "audio"/);
  assert.match(worker, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(worker, /url\.pathname\.startsWith\("\/\.well-known\/mr-room\/"\)/);
  assert.match(worker, /url\.pathname\.startsWith\("\/__mineradio\/"\)/);
  assert.match(worker, /url\.origin !== self\.location\.origin/);
  assert.match(worker, /request\.mode === "navigate"/);
  assert.match(worker, /Promise\.all\(/);
  assert.doesNotMatch(worker, /Promise\.allSettled/);
  assert.match(worker, /core_asset_unavailable/);
  assert.doesNotMatch(worker, /trimCache\(coreCache\)/);
  assert.match(worker, /MRROOM_ACTIVATE_UPDATE/);
  assert.match(worker, /self\.skipWaiting\(\)/);
  assert.match(worker, /self\.clients\.claim\(\)/);
  assert.doesNotMatch(worker, /caches\.match\([^)]*\/api\//);
});
