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

const { extractInbound, remember, sendReply, sendPlaceholder } = await import("./feishu.mjs");
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

// 8) quote replies: first send quotes the parent; a reply-API failure
// still delivers the reply via plain create (never dropped).
function fakeClient({ failReply = false } = {}) {
  const calls = [];
  return {
    calls,
    im: {
      v1: {
        message: {
          reply: async (req) => {
            calls.push(["reply", req?.path?.message_id, req?.data?.msg_type]);
            if (failReply) throw new Error("reply boom");
            return { code: 0, data: { message_id: "om_reply_new" } };
          },
          create: async (req) => {
            calls.push(["create", req?.data?.msg_type]);
            return { code: 0, data: { message_id: "om_create_new" } };
          },
        },
      },
    },
  };
}
{
  const fc = fakeClient();
  const phId = await sendPlaceholder(fc, { chatId: "oc_test_chat", parentMessageId: "om_test_001" });
  if (phId !== "om_reply_new" || fc.calls.length !== 1 || fc.calls[0][0] !== "reply" || fc.calls[0][1] !== "om_test_001" || fc.calls[0][2] !== "interactive") {
    throw new Error("quote placeholder must reply to the parent as a card: " + JSON.stringify(fc.calls));
  }
  const fc2 = fakeClient();
  const r = await sendReply(fc2, { receiveId: "oc_test_chat", receiveIdType: "chat_id", answer: "纯文本回复", parentMessageId: "om_test_001" });
  if (r?.data?.message_id !== "om_reply_new" || fc2.calls[0][0] !== "reply" || fc2.calls[0][2] !== "text") {
    throw new Error("quote text reply must use message.reply: " + JSON.stringify(fc2.calls));
  }
  const fc3 = fakeClient({ failReply: true });
  const phId3 = await sendPlaceholder(fc3, { chatId: "oc_test_chat", parentMessageId: "om_test_001" });
  if (phId3 !== "om_create_new" || !fc3.calls.some((c) => c[0] === "create")) {
    throw new Error("quote placeholder failure must fall back to plain create: " + JSON.stringify(fc3.calls));
  }
  const fc4 = fakeClient({ failReply: true });
  const r4 = await sendReply(fc4, { receiveId: "oc_test_chat", receiveIdType: "chat_id", answer: "回落也要送达", parentMessageId: "om_test_001" });
  if (r4?.data?.message_id !== "om_create_new") {
    throw new Error("quote text failure must fall back to plain create, reply not dropped: " + JSON.stringify(fc4.calls));
  }
  console.log("quote reply (placeholder + text + fallback delivery): OK");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("feishu mock test passed (no SDK, no network, no message sent)");
