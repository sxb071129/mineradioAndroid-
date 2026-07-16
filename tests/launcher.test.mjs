import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Windows LAN launcher uses the asset-safe live server", async () => {
  const [launcher, runner, packageJson] = await Promise.all([
    readFile(new URL("../scripts/start-mr-room-lan.ps1", import.meta.url), "utf8"),
    readFile(new URL("../scripts/dev-lan.mjs", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(launcher, /DistEntry|run build/);
  assert.match(runner, /process\.platform === "win32" \? "dev"/);
  assert.match(runner, /"--hostname", "0\.0\.0\.0"/);
  assert.match(runner, /scripts\/music-api\.mjs/);
  assert.match(launcher, /Music API\s*:\s*\$MusicPort/);
  assert.match(launcher, /8790/);
  assert.doesNotMatch(runner, /"--host"/);
  assert.equal(JSON.parse(packageJson).scripts["start:lan"], "node scripts/dev-lan.mjs dev");
});
