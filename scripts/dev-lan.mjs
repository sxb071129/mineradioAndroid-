import { spawn } from "node:child_process";
import path from "node:path";

const cli = path.resolve("node_modules", "vinext", "dist", "cli.js");
const requestedAction = process.argv[2] === "start" ? "start" : "dev";

// vinext 0.0.50's production static-file cache keeps Windows path
// separators, so /assets/*.css and /assets/*.js return 404 on Windows.
// Use the live server for the desktop LAN launcher until that upstream
// production-server bug is fixed. Other platforms can still opt into start.
const action = process.platform === "win32" ? "dev" : requestedAction;
const children = [
  spawn(
    process.execPath,
    [cli, action, "--hostname", "0.0.0.0", "--port", "3000"],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        WRANGLER_LOG_PATH:
          process.env.WRANGLER_LOG_PATH || ".wrangler/wrangler.log",
      },
    },
  ),
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
