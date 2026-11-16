import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const standaloneServer = resolve(APP_ROOT, "dist/standalone/server.js");
const vinextCli = resolve(APP_ROOT, "node_modules/vinext/dist/cli.js");
const spawnOptions = {
  stdio: "inherit",
  detached: process.platform !== "win32",
  cwd: APP_ROOT,
  env: {
    ...process.env,
    HOST: "0.0.0.0",
    PORT: process.env.PORT || "3000",
    WRANGLER_LOG_PATH: resolve(APP_ROOT, ".wrangler/wrangler.log"),
  },
};
const dashboardCommand = existsSync(standaloneServer)
  ? [standaloneServer]
  : [vinextCli, "start"];
const children = [
  spawn(process.execPath, [resolve(APP_ROOT, "monitor/atem-monitor.mjs")], spawnOptions),
  spawn(process.execPath, [resolve(APP_ROOT, "monitor/shading-monitor.mjs")], spawnOptions),
  spawn(process.execPath, [resolve(APP_ROOT, "monitor/lan-gateway.mjs")], spawnOptions),
  spawn(process.execPath, dashboardCommand, spawnOptions),
];

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    if (process.platform === "win32") child.kill("SIGTERM");
    else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
  }
};

for (const child of children) {
  child.on("exit", (code) => {
    if (code && code !== 0) {
      stop();
      process.exitCode = code;
    }
  });
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
