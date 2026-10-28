// Channel-agnostic Muse queue bridge core.
// Flow: inbound message (allowlist only) -> queue/inbox/<id>.json
//       Muse (woken by a hook polling the inbox) writes queue/outbox/<id>.json
//       the transport process picks the reply up and sends it back in the same space.
// Config: JSON at $BRIDGE_CONFIG, else <root>/config.json:
//   { "allowedSenders": ["+8613..."] (open_id for Feishu),
//     "replyTimeoutMs": 600000, "pollMs": 1000 }
// Queue root override for tests: $BRIDGE_QUEUE_ROOT.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const QROOT = process.env.BRIDGE_QUEUE_ROOT || path.join(ROOT, "queue");
export const INBOX = path.join(QROOT, "inbox");
export const OUTBOX = path.join(QROOT, "outbox");
export const DONE = path.join(QROOT, "done");
export const STREAM = path.join(QROOT, "stream");
export const SYNC = path.join(QROOT, "sync");
export const SESSION = path.join(QROOT, "session.jsonl");
for (const d of [INBOX, OUTBOX, DONE, STREAM, SYNC]) fs.mkdirSync(d, { recursive: true });

// Persistent session transcript (single-user 1:1 bot): one JSON line per
// turn, {role: "user"|"assistant", text, at}. This is the bot's real
// conversation state, read by the Feishu reply worker on every turn.
// It survives worker restarts; only role/text/time are stored, no sender ids.
export function appendSession(role, text) {
  if (!text) return;
  try {
    fs.appendFileSync(SESSION, JSON.stringify({ role, text: String(text), at: new Date().toISOString() }) + "\n");
    // Keep the file bounded: retain the last 200 turns.
    const lines = fs.readFileSync(SESSION, "utf8").trim().split("\n").filter(Boolean);
    if (lines.length > 200) fs.writeFileSync(SESSION, lines.slice(-200).join("\n") + "\n");
  } catch {}
}

const cfgPath = process.env.BRIDGE_CONFIG || path.join(ROOT, "config.json");
if (!fs.existsSync(cfgPath)) {
  console.error(`Missing config file: ${cfgPath} - copy config.example.json and set allowedSenders (your number / open_id only).`);
  process.exit(2);
}
export const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const allow = new Set((cfg.allowedSenders || []).map((s) => String(s).replace(/[\s-]/g, "")));
if (allow.size === 0 || [...allow].some((s) => s.includes("X"))) {
  console.error("allowedSenders must contain at least one real value, no placeholders.");
  process.exit(2);
}
export const norm = (s) => String(s || "").replace(/[\s-]/g, "");
export const isAllowed = (sender) => allow.has(norm(sender));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Event-driven, not polling: wait for the worker to create outbox/<id>.json
// via fs.watch on the outbox directory. The old 1-second sleep loop is
// gone; this resolves the instant the file appears (plus a timeout).
// A missed watch event cannot hang forever: the timeout still bounds it.
// Streaming: the worker may append sections to stream/<id>.txt while
// drafting a long answer. waitForReply watches that file and calls
// onProgress(accumulatedText) at most once per 1500ms (first chunk
// immediately), so the transport can patch the same card during
// generation instead of only once at the end. Short answers skip the
// stream file entirely and go through the outbox path as before.
async function waitForReply(id, timeoutMs = cfg.replyTimeoutMs || 600000, onProgress) {
  const file = path.join(OUTBOX, `${id}.json`);
  const target = `${id}.json`;
  const streamFile = path.join(STREAM, `${id}.txt`);
  const streamTarget = `${id}.txt`;
  let lastProgressAt = 0;
  let lastProgressText = "";
  const maybeProgress = () => {
    if (typeof onProgress !== "function") return;
    let text = "";
    try { text = fs.readFileSync(streamFile, "utf8"); } catch { return; }
    if (!text || text === lastProgressText) return;
    const now = Date.now();
    if (lastProgressAt !== 0 && now - lastProgressAt < 1500) return;
    lastProgressAt = now;
    lastProgressText = text;
    try { const r = onProgress(text); if (r && typeof r.catch === "function") r.catch(() => {}); } catch {}
  };
  const take = () => {
    if (!fs.existsSync(file)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!data || (typeof data.text !== "string" && !data.card)) return null;
      fs.renameSync(file, path.join(DONE, `${id}.reply.json`));
      return data;
    } catch {
      return null;
    }
  };
  const immediate = take();
  if (immediate !== null) return immediate;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { watcher.close(); } catch {}
      try { streamWatcher.close(); } catch {}
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    let watcher;
    let streamWatcher;
    try {
      watcher = fs.watch(OUTBOX, (event, filename) => {
        if (filename && filename !== target) return;
        const v = take();
        if (v !== null) finish(v);
      });
      watcher.on("error", () => finish(null));
      if (typeof onProgress === "function") {
        streamWatcher = fs.watch(STREAM, (event, filename) => {
          if (filename && filename !== streamTarget) return;
          maybeProgress();
        });
        streamWatcher.on("error", () => {});
        maybeProgress();
      }
    } catch {
      finish(null);
    }
  });
}

export async function handleInbound({ id, sender, text, reply, onProgress }) {
  if (!isAllowed(sender)) {
    console.log(`ignored non-allowlisted sender: ${norm(sender)}`);
    return;
  }
  const rec = { id, sender, text, receivedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(INBOX, `${id}.json.tmp`), JSON.stringify(rec, null, 2));
  fs.renameSync(path.join(INBOX, `${id}.json.tmp`), path.join(INBOX, `${id}.json`));
  appendSession("user", text);
  const answerObj = await waitForReply(id, cfg.replyTimeoutMs || 600000, onProgress);
  fs.renameSync(path.join(INBOX, `${id}.json`), path.join(DONE, `${id}.json`));
  try {
    const streamFile = path.join(STREAM, `${id}.txt`);
    if (fs.existsSync(streamFile)) fs.renameSync(streamFile, path.join(DONE, `${id}.stream.txt`));
  } catch {}
  if (!answerObj) {
    const fallback = "我暂时没能处理这条消息，请稍后再发一次。";
    appendSession("assistant", fallback);
    await reply(fallback);
    return;
  }
  appendSession("assistant", answerObj.text || "[卡片消息]");
  // Backward compatible: plain-text transports get a string; Feishu gets
  // the full object when a card is present, so it can send a card.
  await reply(answerObj.card ? answerObj : answerObj.text);
}
