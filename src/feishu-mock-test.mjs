// Local simulation for the Feishu transport: no SDK, no network.
// Verifies event parsing, allowlist gating, and the queue round-trip
// (inbox -> simulated Muse reply in outbox -> reply callback).
// Uses a temp config + temp queue root; the real project files are untouched.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const ROOT = path.dirname(new URL(import.meta.url).pathname) + "/..";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) syntax-check the real modules
for (const f of ["src/feishu.mjs", "src/queue.mjs"]) {
  execFileSync("node", ["--check", path.join(ROOT, f)]);
}
console.log("syntax: feishu.mjs + queue.mjs OK");

// 2) temp config + temp queue, set BEFORE the modules load (they validate at import)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-mock-"));
const TEST_USER = "ou_test_test_openid_123";
fs.writeFileSync(
  path.join(tmp, "config.json"),
  JSON.stringify({ allowedSenders: [TEST_USER], replyTimeoutMs: 10000, pollMs: 50 })
);
process.env.BRIDGE_CONFIG = path.join(tmp, "config.json");
process.env.BRIDGE_QUEUE_ROOT = path.join(tmp, "queue");

const { extractInbound, remember } = await import("./feishu.mjs");
const { handleInbound, INBOX, OUTBOX, DONE } = await import("./queue.mjs");
const inboxHas = (id) => fs.existsSync(path.join(INBOX, `${id}.json`));

// 3) event parsing: a normal user text message
const event = {
  sender: { sender_id: { open_id: TEST_USER } },
  message: {
    message_id: "om_test_001",
    chat_id: "oc_test_chat",
    message_type: "text",
    content: JSON.stringify({ text: "在吗" }),
  },
};
const parsed = extractInbound(event);
if (!parsed || parsed.senderOpenId !== TEST_USER || parsed.text !== "在吗" || parsed.chatId !== "oc_test_chat") {
  throw new Error("extractInbound failed on a normal text event: " + JSON.stringify(parsed));
}
console.log("event parsing (text): OK");

// 4) non-text and system events are ignored
const ignored1 = extractInbound({
  sender: { sender_id: { open_id: TEST_USER } },
  message: { message_id: "om_img_1", chat_id: "oc", message_type: "image", content: "{}" },
});
const ignored2 = extractInbound({ sender: {}, message: { message_id: "om_sys", message_type: "text", content: JSON.stringify({ text: "x" }) } });
if (ignored1 !== null || ignored2 !== null) throw new Error("non-text / non-user events must be ignored");
console.log("event parsing (ignore non-text / system): OK");

// 5) queue round-trip for an allowlisted sender
const id = "feishu-om_test_001";
let replied = null;
const inboundP = handleInbound({
  id,
  sender: TEST_USER,
  text: "在吗",
  reply: async (t) => { replied = t; },
});
await sleep(200); // let handleInbound write the inbox file
if (!inboxHas(id)) throw new Error("inbox file was not written");
console.log("inbox write (allowlisted): OK");
// simulate Muse replying via the outbox
fs.writeFileSync(path.join(OUTBOX, `${id}.json`), JSON.stringify({ id, text: "在的，我是 Muse（模拟回复）" }));
await inboundP;
if (replied !== "在的，我是 Muse（模拟回复）") throw new Error("reply callback got wrong text: " + replied);
if (inboxHas(id)) throw new Error("inbox file was not archived");
if (fs.existsSync(path.join(OUTBOX, `${id}.json`))) throw new Error("outbox file was not archived");
console.log("queue round-trip inbox->outbox->reply: OK");

// 6) non-allowlisted sender is ignored, nothing written
let strangerReplied = false;
await handleInbound({
  id: "feishu-stranger",
  sender: "ou_stranger_999",
  text: "hi",
  reply: async () => { strangerReplied = true; },
});
if (inboxHas("feishu-stranger") || strangerReplied) {
  throw new Error("non-allowlisted sender must be ignored silently");
}
console.log("allowlist (stranger ignored): OK");

// 7) redelivery of the same message_id is ignored
remember("om_test_001");
if (extractInbound(event) !== null) throw new Error("duplicate message_id must be ignored");
console.log("redelivery guard: OK");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("feishu mock test passed (no SDK, no network, no message sent)");
