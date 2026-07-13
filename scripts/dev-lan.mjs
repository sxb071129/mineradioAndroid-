import { spawn } from "node:child_process";
import path from "node:path";

const cli = path.resolve("node_modules", "vinext", "dist", "cli.js");
const action = process.argv[2] === "start" ? "start" : "dev";
const children = [
  spawn(process.execPath, [cli, action, "--host", "0.0.0.0"], {
    stdio: "inherit",
    env: {
      ...process.env,
      WRANGLER_LOG_PATH:
        process.env.WRANGLER_LOG_PATH || ".wrangler/wrangler.log",
    },
  }),
  spawn(process.execPath, ["scripts/lan-relay.mjs"], {
    stdio: "inherit",
    env: process.env,
  }),
];

let closing = false;
function close(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 250).unref();
}

for (const child of children) {
  child.on("exit", (code) => {
    if (!closing && code) close(code);
  });
}

process.on("SIGINT", () => close(0));
process.on("SIGTERM", () => close(0));
