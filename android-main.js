"use strict";

const fs = require("fs");
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

require("./server.js");
