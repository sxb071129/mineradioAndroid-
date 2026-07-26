import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readdir,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const STORE_VERSION = 1;
const DEFAULT_FILE_NAME = "kugou-descriptors.json";
const DEFAULT_MAX_RECORDS = 2_048;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const HARD_MAX_RECORDS = 8_192;
const HARD_MAX_FILE_BYTES = 16 * 1024 * 1024;
const HARD_MAX_TTL_MS = 365 * 24 * 60 * 60 * 1_000;
const TEMP_FILE_MAX_AGE_MS = 10 * 60 * 1_000;
const QUALITY_LEVELS = ["jymaster", "hires", "lossless", "exhigh", "standard"];
const QUALITY_SET = new Set(QUALITY_LEVELS);
const KEY_RE = /^[a-f0-9]{24}$/;
const HASH_RE = /^[A-Fa-f0-9]{32}$/;
const NUMERIC_ID_RE = /^\d{1,24}$/;
const ACCOUNT_ID_RE = /^\d{1,24}$/;
const EMPTY_SNAPSHOT_BYTES = Buffer.byteLength('{"version":1,"records":[]}\n');
const execFileAsync = promisify(execFile);
const coordinators = new Map();

function storeError(code, ErrorType = Error) {
  const error = new ErrorType(code);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, required, optional = []) {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.has(key));
}

function normalizeHash(value) {
  if (typeof value !== "string" || !HASH_RE.test(value)) {
    throw storeError("invalid_descriptor", TypeError);
  }
  return value.toUpperCase();
}

function normalizeNumericId(value) {
  if (value == null || value === "") return undefined;
  const normalized = typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    ? String(value)
    : value;
  if (typeof normalized !== "string" || !NUMERIC_ID_RE.test(normalized)) {
    throw storeError("invalid_descriptor", TypeError);
  }
  return normalized;
}

function normalizeDescriptor(value) {
  if (!isPlainObject(value)
    || !hasExactKeys(value, ["hash"], ["qualityHashes", "albumAudioId", "albumId"])) {
    throw storeError("invalid_descriptor", TypeError);
  }
  if (value.qualityHashes !== undefined && !isPlainObject(value.qualityHashes)) {
    throw storeError("invalid_descriptor", TypeError);
  }
  const rawQualityHashes = value.qualityHashes ?? {};
  if (Object.keys(rawQualityHashes).some((quality) => !QUALITY_SET.has(quality))) {
    throw storeError("invalid_descriptor", TypeError);
  }

  const qualityHashes = {};
  for (const quality of QUALITY_LEVELS) {
    if (!Object.hasOwn(rawQualityHashes, quality)) continue;
    qualityHashes[quality] = normalizeHash(rawQualityHashes[quality]);
  }
  const descriptor = {
    hash: normalizeHash(value.hash),
    qualityHashes,
  };
  const albumAudioId = normalizeNumericId(value.albumAudioId);
  const albumId = normalizeNumericId(value.albumId);
  if (albumAudioId !== undefined) descriptor.albumAudioId = albumAudioId;
  if (albumId !== undefined) descriptor.albumId = albumId;
  return descriptor;
}

function normalizeKey(value) {
  if (typeof value !== "string" || !KEY_RE.test(value)) {
    throw storeError("invalid_descriptor_key", TypeError);
  }
  return value;
}

function normalizeAccountId(value, { optional = true } = {}) {
  if (optional && (value == null || value === "")) return undefined;
  const normalized = typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    ? String(value)
    : value;
  if (typeof normalized !== "string" || !ACCOUNT_ID_RE.test(normalized)) {
    throw storeError("invalid_account_id", TypeError);
  }
  return BigInt(normalized).toString(10);
}

function normalizeTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw storeError("invalid_descriptor_store", TypeError);
  }
  return value;
}

function timestampFromClock(now) {
  const value = now();
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw storeError("invalid_descriptor_store_clock", TypeError);
  }
  return normalizeTimestamp(Math.trunc(value));
}

function addTimestamp(value, ttlMs) {
  const result = value + ttlMs;
  if (!Number.isSafeInteger(result)) {
    throw storeError("invalid_descriptor_store_ttl", RangeError);
  }
  return result;
}

function cloneDescriptor(descriptor) {
  return {
    hash: descriptor.hash,
    qualityHashes: { ...descriptor.qualityHashes },
    ...(descriptor.albumAudioId === undefined ? {} : { albumAudioId: descriptor.albumAudioId }),
    ...(descriptor.albumId === undefined ? {} : { albumId: descriptor.albumId }),
  };
}

function cloneRecords(records) {
  return new Map(Array.from(records, ([key, record]) => [key, {
    ...record,
    descriptor: cloneDescriptor(record.descriptor),
  }]));
}

function normalizePersistedRecord(value) {
  if (!isPlainObject(value)
    || !hasExactKeys(
      value,
      ["key", "createdAt", "lastUsedAt", "expiresAt", "descriptor"],
      ["accountId"],
    )) {
    throw storeError("invalid_descriptor_store", TypeError);
  }
  const record = {
    key: normalizeKey(value.key),
    createdAt: normalizeTimestamp(value.createdAt),
    lastUsedAt: normalizeTimestamp(value.lastUsedAt),
    expiresAt: normalizeTimestamp(value.expiresAt),
    descriptor: normalizeDescriptor(value.descriptor),
  };
  if (record.lastUsedAt < record.createdAt || record.expiresAt <= record.lastUsedAt) {
    throw storeError("invalid_descriptor_store", TypeError);
  }
  const accountId = normalizeAccountId(value.accountId);
  if (accountId !== undefined) record.accountId = accountId;
  return record;
}

function parseSnapshot(source) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw storeError("invalid_descriptor_store", TypeError);
  }
  if (!isPlainObject(parsed)
    || !hasExactKeys(parsed, ["version", "records"])
    || parsed.version !== STORE_VERSION
    || !Array.isArray(parsed.records)
    || parsed.records.length > HARD_MAX_RECORDS) {
    throw storeError("invalid_descriptor_store", TypeError);
  }

  const records = new Map();
  for (const value of parsed.records) {
    const record = normalizePersistedRecord(value);
    if (records.has(record.key)) throw storeError("invalid_descriptor_store", TypeError);
    records.set(record.key, record);
  }
  return records;
}

function orderedRecords(records) {
  return Array.from(records.values()).sort((left, right) => (
    left.lastUsedAt - right.lastUsedAt
    || left.createdAt - right.createdAt
    || left.key.localeCompare(right.key)
  ));
}

function serializeSnapshot(records) {
  const source = JSON.stringify({ version: STORE_VERSION, records: orderedRecords(records) });
  return `${source}\n`;
}

function pruneExpired(records, now) {
  let changed = false;
  for (const [key, record] of records) {
    if (record.expiresAt <= now) {
      records.delete(key);
      changed = true;
    }
  }
  return changed;
}

function normalizeLoadedTimes(records, now, ttlMs) {
  for (const record of records.values()) {
    record.createdAt = Math.min(record.createdAt, now);
    record.lastUsedAt = Math.max(record.createdAt, Math.min(record.lastUsedAt, now));
    record.expiresAt = Math.min(record.expiresAt, addTimestamp(record.lastUsedAt, ttlMs));
  }
  pruneExpired(records, now);
}

function enforceBounds(records, { maxRecords, maxFileBytes, protectedKey }) {
  const evictionCandidates = orderedRecords(records)
    .filter((record) => record.key !== protectedKey);
  let candidateIndex = 0;
  while (records.size > maxRecords && candidateIndex < evictionCandidates.length) {
    records.delete(evictionCandidates[candidateIndex].key);
    candidateIndex += 1;
  }
  if (records.size > maxRecords) {
    throw storeError("descriptor_store_record_limit", RangeError);
  }

  let snapshot = serializeSnapshot(records);
  let snapshotBytes = Buffer.byteLength(snapshot);
  while (snapshotBytes > maxFileBytes && candidateIndex < evictionCandidates.length) {
    const candidate = evictionCandidates[candidateIndex];
    candidateIndex += 1;
    if (!records.delete(candidate.key)) continue;
    const recordBytes = Buffer.byteLength(JSON.stringify(candidate));
    snapshotBytes -= recordBytes + (records.size > 0 ? 1 : 0);
  }
  if (snapshotBytes > maxFileBytes) {
    throw storeError("descriptor_store_file_limit", RangeError);
  }
  snapshot = serializeSnapshot(records);
  if (Buffer.byteLength(snapshot) > maxFileBytes) {
    throw storeError("descriptor_store_file_limit", RangeError);
  }
  return snapshot;
}

function isUnsupportedPermissionError(error) {
  return ["ENOSYS", "ENOTSUP", "EINVAL", "EPERM"].includes(error?.code);
}

async function setPosixModeWhereSupported(target, mode) {
  if (process.platform === "win32") return;
  try {
    await chmod(target, mode);
  } catch (error) {
    if (!isUnsupportedPermissionError(error)) throw error;
  }
}

function windowsPrincipal() {
  const username = String(process.env.USERNAME || "").trim();
  const domain = String(process.env.USERDOMAIN || "").trim();
  if (!username || /[ -]/.test(username + domain)) return "";
  return domain ? `${domain}\\${username}` : username;
}

async function setWindowsAcl(target, { directory = false } = {}) {
  if (process.platform !== "win32") return;
  const principal = windowsPrincipal();
  if (!principal) throw storeError("descriptor_store_acl_unavailable");
  const inherit = directory ? "(OI)(CI)F" : "F";
  try {
    await execFileAsync("icacls.exe", [
      target,
      "/inheritance:r",
      "/grant:r",
      `${principal}:${inherit}`,
      `*S-1-5-18:${inherit}`,
      `*S-1-5-32-544:${inherit}`,
    ], { windowsHide: true, timeout: 10_000 });
  } catch (error) {
    throw Object.assign(storeError("descriptor_store_acl_failed"), { cause: error });
  }
}

async function securePath(target, { directory = false } = {}) {
  await setPosixModeWhereSupported(target, directory ? 0o700 : 0o600);
  await setWindowsAcl(target, { directory });
}

async function syncDirectoryWhereSupported(directory) {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch {
    // The snapshot has already been atomically committed. Directory fsync is an
    // extra durability guarantee and is unavailable on some filesystems.
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function ensureDataDirectory(dataDir) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await securePath(dataDir, { directory: true });
}

async function cleanupTemporaryFiles(dataDir, fileName) {
  const prefix = `${fileName}.`;
  const cutoff = Date.now() - TEMP_FILE_MAX_AGE_MS;
  let entries;
  try {
    entries = await readdir(dataDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith(".tmp")) return;
    const temporaryFile = path.join(dataDir, entry.name);
    try {
      const metadata = await stat(temporaryFile);
      if (metadata.mtimeMs <= cutoff) await unlink(temporaryFile);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }));
}

async function atomicWrite(filePath, snapshot) {
  const temporaryFile = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporaryFile, "wx", 0o600);
    await securePath(temporaryFile);
    await handle.writeFile(snapshot, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryFile, filePath);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporaryFile).catch(() => {});
    throw error;
  }
  await syncDirectoryWhereSupported(path.dirname(filePath));
}

async function readBoundedFile(filePath, maxFileBytes) {
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }

  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maxFileBytes) return { invalid: true };
    const buffer = await handle.readFile();
    if (buffer.byteLength > maxFileBytes) return { invalid: true };
    return { source: buffer.toString("utf8") };
  } finally {
    await handle.close();
  }
}

async function loadRecords(filePath, maxFileBytes) {
  const loaded = await readBoundedFile(filePath, maxFileBytes);
  if (loaded === null) return new Map();
  if (!loaded.invalid) {
    try {
      return parseSnapshot(loaded.source);
    } catch {
      // Reset below without including untrusted file contents in an error or backup name.
    }
  }
  try {
    await unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return new Map();
}

function validateOptions({ dataDir, fileName, maxRecords, maxFileBytes, ttlMs, now }) {
  if (typeof dataDir !== "string" || !dataDir.trim() || dataDir.includes("\0")) {
    throw storeError("descriptor_store_data_dir_required", TypeError);
  }
  if (typeof fileName !== "string"
    || !fileName
    || fileName.includes("\0")
    || path.basename(fileName) !== fileName
    || fileName === "."
    || fileName === "..") {
    throw storeError("invalid_descriptor_store_file_name", TypeError);
  }
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > HARD_MAX_RECORDS) {
    throw storeError("invalid_descriptor_store_max_records", RangeError);
  }
  if (!Number.isSafeInteger(maxFileBytes)
    || maxFileBytes < EMPTY_SNAPSHOT_BYTES
    || maxFileBytes > HARD_MAX_FILE_BYTES) {
    throw storeError("invalid_descriptor_store_max_file_bytes", RangeError);
  }
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > HARD_MAX_TTL_MS) {
    throw storeError("invalid_descriptor_store_ttl", RangeError);
  }
  if (typeof now !== "function") throw storeError("invalid_descriptor_store_clock", TypeError);
}

function coordinatorFor(filePath) {
  let coordinator = coordinators.get(filePath);
  if (!coordinator) {
    coordinator = {
      records: new Map(),
      tail: Promise.resolve(),
      lastError: null,
    };
    coordinators.set(filePath, coordinator);
  }
  return coordinator;
}

function enqueue(coordinator, operation) {
  const pending = coordinator.tail.then(operation, operation);
  coordinator.tail = pending.then(
    () => {
      coordinator.lastError = null;
    },
    (error) => {
      coordinator.lastError = error;
    },
  );
  return pending;
}

/**
 * Creates a durable store that maps opaque 24-character keys to private Kugou
 * playback descriptors. Instances in this process share a per-file coordinator,
 * so one instance cannot rewrite a stale snapshot after another clears it.
 */
export async function createDescriptorStore({
  dataDir,
  fileName = DEFAULT_FILE_NAME,
  maxRecords = DEFAULT_MAX_RECORDS,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now,
} = {}) {
  validateOptions({ dataDir, fileName, maxRecords, maxFileBytes, ttlMs, now });
  const resolvedDataDir = path.resolve(dataDir);
  const filePath = path.join(resolvedDataDir, fileName);
  const coordinator = coordinatorFor(filePath);

  await enqueue(coordinator, async () => {
    await ensureDataDirectory(resolvedDataDir);
    await cleanupTemporaryFiles(resolvedDataDir, fileName);
    const records = await loadRecords(filePath, maxFileBytes);
    const timestamp = timestampFromClock(now);
    normalizeLoadedTimes(records, timestamp, ttlMs);
    const snapshot = enforceBounds(records, { maxRecords, maxFileBytes });
    await atomicWrite(filePath, snapshot);
    coordinator.records = records;
  });

  function currentTime() {
    return timestampFromClock(now);
  }

  function mutate(mutator, { protectedKey } = {}) {
    return enqueue(coordinator, async () => {
      const draft = cloneRecords(coordinator.records);
      const timestamp = currentTime();
      pruneExpired(draft, timestamp);
      const result = mutator(draft, timestamp);
      const keyToProtect = typeof protectedKey === "function" ? protectedKey(result) : protectedKey;
      const snapshot = enforceBounds(draft, {
        maxRecords,
        maxFileBytes,
        protectedKey: keyToProtect,
      });
      await atomicWrite(filePath, snapshot);
      coordinator.records = draft;
      return result;
    });
  }

  async function set(key, descriptor, options = {}) {
    const normalizedKey = normalizeKey(key);
    const normalizedDescriptor = normalizeDescriptor(descriptor);
    const accountIdProvided = Object.hasOwn(options, "accountId");
    const normalizedAccountId = normalizeAccountId(options.accountId);
    return mutate((draft, timestamp) => {
      const previous = draft.get(normalizedKey);
      const lastUsedAt = Math.max(previous?.lastUsedAt ?? timestamp, timestamp);
      const record = {
        key: normalizedKey,
        createdAt: previous?.createdAt ?? lastUsedAt,
        lastUsedAt,
        expiresAt: addTimestamp(lastUsedAt, ttlMs),
        descriptor: normalizedDescriptor,
      };
      const effectiveAccountId = accountIdProvided ? normalizedAccountId : previous?.accountId;
      if (effectiveAccountId !== undefined) record.accountId = effectiveAccountId;
      draft.set(normalizedKey, record);
      return normalizedKey;
    }, { protectedKey: normalizedKey });
  }

  async function put(descriptor, options = {}) {
    const normalizedDescriptor = normalizeDescriptor(descriptor);
    const accountIdProvided = Object.hasOwn(options, "accountId");
    const normalizedAccountId = normalizeAccountId(options.accountId);
    if (options.key !== undefined) {
      return set(
        options.key,
        normalizedDescriptor,
        accountIdProvided ? { accountId: normalizedAccountId } : {},
      );
    }

    return mutate((draft, timestamp) => {
      let generatedKey;
      do {
        generatedKey = randomBytes(12).toString("hex");
      } while (draft.has(generatedKey));
      const record = {
        key: generatedKey,
        createdAt: timestamp,
        lastUsedAt: timestamp,
        expiresAt: addTimestamp(timestamp, ttlMs),
        descriptor: normalizedDescriptor,
      };
      if (normalizedAccountId !== undefined) record.accountId = normalizedAccountId;
      draft.set(generatedKey, record);
      return generatedKey;
    }, { protectedKey: (generatedKey) => generatedKey });
  }

  async function get(key) {
    const normalizedKey = normalizeKey(key);
    return mutate((draft, timestamp) => {
      const record = draft.get(normalizedKey);
      if (!record) return null;
      record.lastUsedAt = Math.max(record.lastUsedAt, timestamp);
      record.expiresAt = addTimestamp(record.lastUsedAt, ttlMs);
      draft.set(normalizedKey, record);
      return cloneDescriptor(record.descriptor);
    }, { protectedKey: normalizedKey });
  }

  async function remove(key) {
    const normalizedKey = normalizeKey(key);
    return mutate((draft) => draft.delete(normalizedKey));
  }

  async function clear() {
    return mutate((draft) => {
      const removed = draft.size;
      draft.clear();
      return removed;
    });
  }

  async function invalidateAccount(accountId) {
    const normalizedAccountId = normalizeAccountId(accountId, { optional: false });
    return mutate((draft) => {
      let removed = 0;
      for (const [key, record] of draft) {
        if (record.accountId === normalizedAccountId) {
          draft.delete(key);
          removed += 1;
        }
      }
      return removed;
    });
  }

  async function size() {
    return mutate((draft) => draft.size);
  }

  async function flush() {
    await coordinator.tail;
    if (coordinator.lastError) throw coordinator.lastError;
  }

  return Object.freeze({
    filePath,
    set,
    put,
    get,
    delete: remove,
    clear,
    clearAccount: invalidateAccount,
    invalidateAccount,
    size,
    flush,
  });
}
