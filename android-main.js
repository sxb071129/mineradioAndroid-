"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

process.chdir(__dirname);

try {
  const envPath = path.join(__dirname, "android-env.json");
  const envRaw = fs.readFileSync(envPath, "utf8").replace(/^\uFEFF/, "");
  const env = JSON.parse(envRaw);
  Object.keys(env || {}).forEach((key) => {
    if (env[key] !== undefined && env[key] !== null) {
      process.env[key] = String(env[key]);
    }
  });
} catch (error) {
  console.warn("[Android] environment load skipped:", error.message);
}

const androidTempDir = process.env.TMPDIR || path.join(__dirname, ".tmp");
fs.mkdirSync(androidTempDir, { recursive: true });
process.env.TMPDIR = androidTempDir;
os.tmpdir = () => androidTempDir;

require("./server.js");
