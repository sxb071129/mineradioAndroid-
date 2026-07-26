import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDescriptorStore } from "../scripts/descriptor-store.mjs";

const KEY_A = "0123456789abcdef01234567";
const KEY_B = "89abcdef0123456789abcdef";
const KEY_C = "fedcba9876543210fedcba98";
const HASH_A = "A".repeat(32);
const HASH_B = "B".repeat(32);
const HASH_C = "C".repeat(32);

function descriptor(hash = HASH_A, extra = {}) {
  return {
    hash,
    qualityHashes: {
      standard: hash,
      lossless: HASH_B,
    },
    albumAudioId: "123456",
    albumId: "654321",
    ...extra,
  };
}

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "mineradio-descriptor-store-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = await createDescriptorStore({ dataDir, ...options });
  return { dataDir, store };
}

test("persists opaque compatible keys and private descriptors across instances", async (t) => {
  const { dataDir, store } = await fixture(t);
  await store.set(KEY_A, descriptor(), { accountId: "42" });
  const generatedKey = await store.put(descriptor(HASH_C));

  assert.match(generatedKey, /^[a-f0-9]{24}$/);
  assert.notEqual(generatedKey, KEY_A);
  assert.deepEqual(await store.get(KEY_A), descriptor());

  const reopened = await createDescriptorStore({ dataDir });
  assert.deepEqual(await reopened.get(KEY_A), descriptor());
  assert.deepEqual(await reopened.get(generatedKey), descriptor(HASH_C));
  assert.equal(await reopened.size(), 2);

  const persisted = JSON.parse(await readFile(store.filePath, "utf8"));
  assert.equal(persisted.version, 1);
  assert.deepEqual(
    new Set(persisted.records.map((record) => record.key)),
    new Set([KEY_A, generatedKey]),
  );
});

test("expires records and refreshes their sliding expiry on use", async (t) => {
  let clock = 1_000;
  const { dataDir, store } = await fixture(t, { ttlMs: 100, now: () => clock });
  await store.set(KEY_A, descriptor());

  clock = 1_090;
  assert.deepEqual(await store.get(KEY_A), descriptor());
  const refreshed = JSON.parse(await readFile(store.filePath, "utf8"));
  assert.equal(refreshed.records[0].lastUsedAt, 1_090);
  assert.equal(refreshed.records[0].expiresAt, 1_190);

  clock = 1_150;
  const reopened = await createDescriptorStore({ dataDir, ttlMs: 100, now: () => clock });
  assert.deepEqual(await reopened.get(KEY_A), descriptor());

  clock = 1_251;
  const expired = await createDescriptorStore({ dataDir, ttlMs: 100, now: () => clock });
  assert.equal(await expired.get(KEY_A), null);
  assert.equal(await expired.size(), 0);
});

test("enforces record and serialized file bounds", async (t) => {
  let clock = 100;
  const { dataDir, store } = await fixture(t, {
    maxRecords: 2,
    maxFileBytes: 900,
    now: () => clock,
  });
  await store.set(KEY_A, descriptor(HASH_A));
  clock += 1;
  await store.set(KEY_B, descriptor(HASH_B));
  clock += 1;
  await store.set(KEY_C, descriptor(HASH_C));

  assert.equal(await store.size(), 2);
  assert.equal(await store.get(KEY_A), null);
  assert.deepEqual(await store.get(KEY_C), descriptor(HASH_C));
  assert.ok((await stat(store.filePath)).size <= 900);

  const reopened = await createDescriptorStore({
    dataDir,
    maxRecords: 2,
    maxFileBytes: 900,
    now: () => clock,
  });
  assert.equal(await reopened.size(), 2);

  const tinyDir = await mkdtemp(path.join(os.tmpdir(), "mineradio-descriptor-store-tiny-"));
  t.after(() => rm(tinyDir, { recursive: true, force: true }));
  const tinyStore = await createDescriptorStore({ dataDir: tinyDir, maxFileBytes: 100 });
  await assert.rejects(
    tinyStore.set(KEY_A, descriptor()),
    (error) => error instanceof RangeError && error.code === "descriptor_store_file_limit",
  );
  assert.equal(await tinyStore.size(), 0);
  assert.ok((await stat(tinyStore.filePath)).size <= 100);
});

test("strictly validates descriptors and never persists unrelated secrets", async (t) => {
  const { store } = await fixture(t);
  const invalidDescriptors = [
    { ...descriptor(), token: "TOP_SECRET_TOKEN" },
    { ...descriptor(), cookie: "MUSIC_U=TOP_SECRET_COOKIE" },
    { ...descriptor(), url: "https://secret.example/stream.mp3" },
    descriptor(HASH_A, { qualityHashes: { standard: HASH_A, ultra: HASH_B } }),
    descriptor("not-a-kugou-hash"),
    descriptor(HASH_A, { albumId: "not-numeric" }),
    descriptor(HASH_A, { qualityHashes: { standard: "" } }),
  ];
  for (const invalid of invalidDescriptors) {
    await assert.rejects(
      store.set(KEY_A, invalid),
      (error) => error instanceof TypeError && error.code === "invalid_descriptor",
    );
  }
  await assert.rejects(store.set("A".repeat(24), descriptor()), /invalid_descriptor_key/);
  await assert.rejects(store.set(KEY_A, descriptor(), { accountId: "account-name" }), /invalid_account_id/);

  await store.set(KEY_A, {
    hash: HASH_A,
    albumAudioId: 123,
    albumId: 0,
  }, { accountId: 7 });
  assert.deepEqual(await store.get(KEY_A), {
    hash: HASH_A,
    qualityHashes: {},
    albumAudioId: "123",
    albumId: "0",
  });
  const source = await readFile(store.filePath, "utf8");
  assert.doesNotMatch(source, /token|cookie|https?:|resolved.?url|TOP_SECRET/i);
});

test("clears all descriptors and invalidates only the requested account", async (t) => {
  const { store } = await fixture(t);
  await store.set(KEY_A, descriptor(HASH_A), { accountId: "1" });
  await store.set(KEY_B, descriptor(HASH_B), { accountId: "2" });
  await store.set(KEY_C, descriptor(HASH_C));

  assert.equal(await store.invalidateAccount("1"), 1);
  assert.equal(await store.get(KEY_A), null);
  assert.deepEqual(await store.get(KEY_B), descriptor(HASH_B));
  assert.deepEqual(await store.get(KEY_C), descriptor(HASH_C));
  assert.equal(await store.clearAccount(2), 1);
  assert.equal(await store.get(KEY_B), null);
  assert.equal(await store.clear(), 1);
  assert.equal(await store.clear(), 0);
  assert.equal(await store.size(), 0);
});

test("recovers safely from corrupt and oversized store input", async (t) => {
  const secret = "DO_NOT_EXPOSE_THIS_SECRET";
  const { dataDir, store } = await fixture(t, { maxFileBytes: 512 });
  await writeFile(store.filePath, `{broken:${secret}`, "utf8");

  const recovered = await createDescriptorStore({ dataDir, maxFileBytes: 512 });
  assert.equal(await recovered.size(), 0);
  assert.deepEqual(JSON.parse(await readFile(recovered.filePath, "utf8")), {
    version: 1,
    records: [],
  });
  assert.deepEqual(await rm(`${recovered.filePath}.corrupt`, { force: true }), undefined);

  await writeFile(recovered.filePath, secret.repeat(100), "utf8");
  const recoveredOversize = await createDescriptorStore({ dataDir, maxFileBytes: 512 });
  assert.equal(await recoveredOversize.size(), 0);
  const names = await import("node:fs/promises").then(({ readdir }) => readdir(dataDir));
  assert.deepEqual(names, [path.basename(store.filePath)]);
  assert.doesNotMatch(await readFile(store.filePath, "utf8"), new RegExp(secret));
});

test("serializes concurrent mutations without losing records", async (t) => {
  const { dataDir, store } = await fixture(t, { maxRecords: 16 });
  await Promise.all([
    store.set(KEY_A, descriptor(HASH_A), { accountId: "1" }),
    store.set(KEY_B, descriptor(HASH_B), { accountId: "2" }),
    store.set(KEY_C, descriptor(HASH_C), { accountId: "3" }),
  ]);
  await Promise.all([store.get(KEY_A), store.delete(KEY_B), store.get(KEY_C)]);
  await store.flush();

  assert.equal(await store.size(), 2);
  assert.deepEqual(await store.get(KEY_A), descriptor(HASH_A));
  assert.equal(await store.get(KEY_B), null);
  assert.deepEqual(await store.get(KEY_C), descriptor(HASH_C));

  const reopened = await createDescriptorStore({ dataDir, maxRecords: 16 });
  assert.equal(await reopened.size(), 2);
  assert.deepEqual(await reopened.get(KEY_A), descriptor(HASH_A));
  assert.deepEqual(await reopened.get(KEY_C), descriptor(HASH_C));
});

test("coordinates multiple instances sharing one snapshot", async (t) => {
  const { dataDir, store: first } = await fixture(t, { maxRecords: 16 });
  const second = await createDescriptorStore({ dataDir, maxRecords: 16 });

  await first.set(KEY_A, descriptor(HASH_A), { accountId: "00042" });
  await second.set(KEY_B, descriptor(HASH_B), { accountId: "7" });
  assert.equal(await first.invalidateAccount(42), 1);
  await second.size();

  const reopened = await createDescriptorStore({ dataDir, maxRecords: 16 });
  assert.equal(await reopened.get(KEY_A), null);
  assert.deepEqual(await reopened.get(KEY_B), descriptor(HASH_B));
});

test("overwriting a descriptor preserves its account binding by default", async (t) => {
  const { store } = await fixture(t);
  await store.set(KEY_A, descriptor(HASH_A), { accountId: "1" });
  await store.set(KEY_A, descriptor(HASH_B));
  assert.equal(await store.invalidateAccount("1"), 1);
  assert.equal(await store.get(KEY_A), null);
});

test("bounds persisted timestamps and rejects unbounded options", async (t) => {
  let clock = 1_000;
  const { dataDir, store } = await fixture(t, { ttlMs: 100, now: () => clock });
  await writeFile(store.filePath, JSON.stringify({
    version: 1,
    records: [{
      key: KEY_A,
      createdAt: 1,
      lastUsedAt: 1_000,
      expiresAt: Number.MAX_SAFE_INTEGER,
      descriptor: descriptor(),
    }],
  }), "utf8");

  const reopened = await createDescriptorStore({ dataDir, ttlMs: 100, now: () => clock });
  clock = 1_101;
  assert.equal(await reopened.get(KEY_A), null);
  await assert.rejects(
    createDescriptorStore({ dataDir, maxFileBytes: Number.MAX_SAFE_INTEGER }),
    /invalid_descriptor_store_max_file_bytes/,
  );
  await assert.rejects(
    createDescriptorStore({ dataDir, maxRecords: Number.MAX_SAFE_INTEGER }),
    /invalid_descriptor_store_max_records/,
  );
});

test("scavenges abandoned temporary snapshots", async (t) => {
  const { dataDir, store } = await fixture(t);
  const temporary = `${store.filePath}.123.abandoned.tmp`;
  await writeFile(temporary, "private descriptor", "utf8");
  const old = new Date(Date.now() - 60 * 60 * 1_000);
  await utimes(temporary, old, old);

  await createDescriptorStore({ dataDir });
  assert.deepEqual(await readdir(dataDir), [path.basename(store.filePath)]);
});

test("uses restrictive store and directory permissions where POSIX mode bits are meaningful", async (t) => {
  const { dataDir, store } = await fixture(t);
  await store.set(KEY_A, descriptor());
  if (process.platform !== "win32") {
    assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
    assert.equal((await stat(store.filePath)).mode & 0o777, 0o600);
  }
});
