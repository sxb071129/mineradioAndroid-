import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const root = new URL("../", import.meta.url);

test("PWA entry activates a waiting shell and reloads exactly once per version transition", async () => {
  const source = await readFile(new URL("public/pwa-register.js", root), "utf8");
  const serviceWorkerListeners = {};
  const registrationListeners = {};
  const messages = [];
  const storage = new Map();
  let reloads = 0;

  const registration = {
    waiting: {
      postMessage(message) {
        messages.push(message);
      },
    },
    installing: null,
    addEventListener(type, listener) {
      registrationListeners[type] = listener;
    },
    update: async () => undefined,
  };
  const navigator = {
    serviceWorker: {
      controller: {},
      addEventListener(type, listener) {
        serviceWorkerListeners[type] = listener;
      },
      register: async () => registration,
    },
  };
  const window = {
    isSecureContext: true,
    audio: { paused: true, ended: false },
    location: { reload() { reloads += 1; } },
    dispatchEvent() {},
  };
  vm.runInNewContext(source, {
    Boolean,
    CustomEvent: class CustomEvent {},
    Date,
    Number,
    String,
    clearTimeout,
    navigator,
    sessionStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, value); },
    },
    setTimeout,
    window,
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "MRROOM_ACTIVATE_UPDATE");
  assert.equal(typeof registrationListeners.updatefound, "function");
  assert.equal(typeof serviceWorkerListeners.controllerchange, "function");

  serviceWorkerListeners.controllerchange();
  serviceWorkerListeners.controllerchange();
  assert.equal(reloads, 1);
  assert.ok(Number(storage.get("mrroom-pwa-version-reload-v1")) > 0);
});

test("PWA cache migration is shell-only and preserves account and DIY storage", async () => {
  const [worker, registrar] = await Promise.all([
    readFile(new URL("public/sw.js", root), "utf8"),
    readFile(new URL("public/pwa-register.js", root), "utf8"),
  ]);

  assert.match(worker, /MRROOM_ACTIVATE_UPDATE/);
  assert.match(worker, /explicitUpdateActivation\s*=\s*true/);
  assert.match(worker, /self\.skipWaiting\(\)/);
  assert.match(worker, /explicitUpdateActivation \? self\.clients\.claim\(\)/);
  assert.match(registrar, /registration\.waiting/);
  assert.match(registrar, /controllerchange/);
  assert.match(registrar, /sessionStorage\.setItem\(RELOAD_GUARD_KEY/);
  assert.doesNotMatch(worker, /localStorage|indexedDB|cookie/i);
  assert.doesNotMatch(registrar, /localStorage\.clear|sessionStorage\.clear|caches\.delete/);
});
