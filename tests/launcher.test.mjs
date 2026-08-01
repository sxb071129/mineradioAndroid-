import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Windows LAN launcher uses the asset-safe live server", async () => {
  const [launcher, runner, firewall, httpsSetup, gateway, packageJson] = await Promise.all([
    readFile(new URL("../scripts/start-mr-room-lan.ps1", import.meta.url), "utf8"),
    readFile(new URL("../scripts/dev-lan.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/configure-lan-firewall.ps1", import.meta.url), "utf8"),
    readFile(new URL("../scripts/setup-lan-https.ps1", import.meta.url), "utf8"),
    readFile(new URL("../scripts/lan-gateway.mjs", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(launcher, /DistEntry|run build/);
  assert.match(runner, /process\.platform === "win32" \? "dev"/);
  assert.match(runner, /"--hostname", "0\.0\.0\.0"/);
  assert.match(runner, /scripts\/music-api\.mjs/);
  assert.match(launcher, /Music API\s*:\s*\$MusicPort/);
  assert.match(launcher, /8790/);
  assert.match(launcher, /Recommended for phones and tablets/);
  assert.match(launcher, /Get-AddressKind/);
  assert.match(launcher, /VPN/);
  assert.match(launcher, /Test-LanFirewallRule/);
  assert.match(launcher, /MR\/\/ROOM ports are already listening/);
  assert.match(launcher, /start:lan:https/);
  assert.match(runner, /secureGatewayEnabled/);
  assert.match(runner, /scripts\/lan-gateway\.mjs/);
  assert.match(firewall, /-Profile Private/);
  assert.match(firewall, /-RemoteAddress LocalSubnet/);
  for (const port of ["3000", "3080", "3443", "8787", "8790"]) {
    assert.match(firewall, new RegExp(port));
  }
  assert.match(httpsSetup, /LOCALAPPDATA/);
  assert.match(httpsSetup, /MR ROOM Local Root CA/);
  assert.match(httpsSetup, /Protect-TlsDirectory/);
  assert.doesNotMatch(httpsSetup, /\.mineradio-lan/);
  assert.match(gateway, /127\.0\.0\.1/);
  assert.match(gateway, /host_not_allowed/);
  assert.match(gateway, /origin_not_allowed/);
  assert.doesNotMatch(runner, /"--host"/);
  const scripts = JSON.parse(packageJson).scripts;
  assert.equal(scripts["start:lan"], "node scripts/dev-lan.mjs dev");
  assert.equal(scripts["start:lan:https"], "node scripts/dev-lan.mjs dev --https");
  assert.match(scripts["setup:https"], /-TrustOnThisPC/);
});
