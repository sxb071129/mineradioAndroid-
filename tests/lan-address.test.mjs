import assert from "node:assert/strict";
import test from "node:test";
import { preferredLanHost } from "../app/lib/lan-address.mjs";

test("preferredLanHost keeps an already reachable page host", () => {
  assert.equal(preferredLanHost(["192.168.1.20"], "192.168.1.10"), "192.168.1.10");
});

test("preferredLanHost ranks home LAN addresses ahead of VPN and link-local adapters", () => {
  assert.equal(
    preferredLanHost(["169.254.2.3", "100.64.1.2", "10.8.0.2", "192.168.50.12"]),
    "192.168.50.12",
  );
  assert.equal(preferredLanHost(["100.64.1.2", "10.8.0.2"]), "10.8.0.2");
});

test("preferredLanHost safely falls back when no usable address is advertised", () => {
  assert.equal(preferredLanHost(["127.0.0.1", "169.254.1.1"], "localhost"), "localhost");
});
