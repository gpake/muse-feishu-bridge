// Watchdog for the Feishu bridge: keeps src/feishu.mjs running and
// restarts it when it exits (crash, WS terminal error, etc.).
// Credentials: first from this process's environment; if missing, from
// an owner-only credentials file at <root>/.credentials.env (0600),
// created only if you explicitly choose disk storage. The file is read
// here and passed to the child via its environment; values are never
// logged. Prefer environment variables when you can.
// Logs: logs/watchdog.log (timestamps, exit codes, restart counts only).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const LOG_FILE = path.join(ROOT, "logs", "watchdog.log");
fs.mkdirSync(path.join(ROOT, "logs"), { recursive: true });

function log(msg) {
  const line = `${new Date().toISOString()} watchdog: ${msg}\n`;
  fs.appendFileSync(LOG_FILE, line);
  process.stdout.write(line);
}

if (!process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET) {
  const credFile = path.join(ROOT, ".credentials.env");
  try {
    if (fs.existsSync(credFile)) {
      for (const line of fs.readFileSync(credFile, "utf8").split("\n")) {
        const m = line.match(/^\s*(FEISHU_APP_ID|FEISHU_APP_SECRET)\s*=\s*(.+?)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
      }
      log("loaded credentials from owner-only file");
    }
  } catch {
    log("failed to read credentials file");
  }
}
if (!process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET) {
  log("missing FEISHU_APP_ID / FEISHU_APP_SECRET, cannot start bridge");
  process.exit(2);
}

let restarts = 0;
let shuttingDown = false;
let child = null;

function startChild() {
  log(`starting bridge (restart #${restarts})`);
  child = spawn(process.execPath, [path.join(ROOT, "src", "feishu.mjs")], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logStream = fs.createWriteStream(path.join(ROOT, "logs", "feishu-watchdog.log"), { flags: "a" });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  child.on("exit", (code, signal) => {
    log(`bridge exited code=${code} signal=${signal}`);
    if (shuttingDown) return;
    restarts += 1;
    const delayMs = Math.min(60000, 5000 * restarts);
    log(`restarting bridge in ${delayMs}ms`);
    setTimeout(startChild, delayMs);
  });
  child.on("error", (err) => {
    log(`bridge spawn error: ${err.message}`);
  });
}

process.on("SIGTERM", () => {
  shuttingDown = true;
  log("watchdog shutting down");
  if (child) child.kill("SIGTERM");
  process.exit(0);
});
process.on("SIGINT", () => {
  shuttingDown = true;
  if (child) child.kill("SIGTERM");
  process.exit(0);
});

startChild();
console.log("watchdog running, monitoring feishu bridge");
