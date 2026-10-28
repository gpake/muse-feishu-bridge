// Feishu (Lark) long-connection transport for the Muse queue bridge.
// Official route: @larksuiteoapi/node-sdk WSClient - no public server needed,
// no callback URL; subscribe im.message.receive_v1 over WebSocket.
// - Inbound:  event -> shared queue core (queue.mjs: allowlist + inbox/outbox)
// - Reply:    client.im.v1.message.create in the same chat (SDK manages tenant_access_token)
// - Proactive: CLI mode below, target must be in config.json allowedSenders.
// Secrets ONLY from env: FEISHU_APP_ID / FEISHU_APP_SECRET. Never written to disk or logs.
//
// Console setup (user side): create an enterprise self-built app, enable the robot,
// add permissions (im:message, im:message.p2p_msg:readonly, im:message:send_as_bot),
// Events & Callbacks -> choose long connection -> subscribe im.message.receive_v1,
// then publish the version. After the first run, copy your sender open_id from the
// log into config.json allowedSenders (for Feishu the allowlist holds open_ids,
// e.g. "ou_xxxxxxxxxxxxxxxx", not phone numbers).
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { isAllowed, handleInbound, INBOX, DONE, SESSION, SYNC } from "./queue.mjs";

// Backfill state: survives host restart because it lives under queue/.
// Only chatId + the last fully-completed user message are stored here:
// no credentials, no sender identifiers beyond what queue files already hold
// (the allowlist in config.json is the source of truth for who may use it).
const STATE_FILE = path.join(path.dirname(SESSION), "bridge-state.json");

export function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const s = JSON.parse(raw);
    if (s && typeof s.chatId === "string" && s.chatId && Number.isFinite(Number(s.lastCompletedAtMs))) {
      return { chatId: s.chatId, lastCompletedAtMs: Number(s.lastCompletedAtMs), lastCompletedMessageId: s.lastCompletedMessageId || "" };
    }
  } catch {}
  return null;
}

export function saveState(state) {
  try {
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.log("backfill state save failed (non-fatal):", e?.message || e);
  }
}

// Message ids already completed (done/) or still queued (inbox/): backfill
// must never re-feed one of these, even across a host restart.
export function getSeenMessageIds() {
  const seen = new Set(seenMessageIds);
  for (const dir of [DONE, INBOX]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        const m = f.match(/^feishu-(.+?)(?:\.reply)?\.json$/);
        if (m) seen.add(m[1]);
      }
    } catch {}
  }
  return seen;
}

// Feishu timestamps arrive as ms strings in events and in history items;
// tolerate seconds as well so a wrong unit cannot silently drop messages.
export function normalizeTimeMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e11 ? n * 1000 : n;
}

// Pure, offline-testable: pick the user text messages in a history page
// that were never processed. `allowed` is a predicate on sender open_id.
export function filterMissedMessages(items, { seenIds, isAllowedSender, lastCompletedAtMs }) {
  const out = [];
  for (const it of items || []) {
    if (!it || it.msg_type !== "text") continue;
    const sender = it.sender || {};
    if (sender.sender_type === "app") continue; // our own replies
    if (sender.id_type && sender.id_type !== "open_id") continue;
    if (!isAllowedSender(sender.id)) continue;
    const createMs = normalizeTimeMs(it.create_time);
    if (!createMs || createMs <= lastCompletedAtMs - 60000) continue; // 60s overlap, dedup handles the rest
    const messageId = it.message_id || "";
    if (!messageId || seenIds.has(messageId)) continue;
    let text = "";
    try { text = JSON.parse(it.body?.content || "{}").text || ""; } catch { text = ""; }
    if (!text) continue;
    out.push({ messageId, senderOpenId: sender.id, chatId: it.chat_id || "", text, createMs });
  }
  out.sort((a, b) => a.createMs - b.createMs || (a.messageId < b.messageId ? -1 : 1));
  return out;
}

// Redelivery / self-echo guard: Feishu may resend an event; never process one twice.
const seenMessageIds = new Set();
export function remember(id) {
  if (!id) return;
  seenMessageIds.add(id);
  if (seenMessageIds.size > 5000) {
    const it = seenMessageIds.values();
    for (let i = 0; i < 1000; i++) seenMessageIds.delete(it.next().value);
  }
}

// Pure: normalize an im.message.receive_v1 event into
// { senderOpenId, chatId, messageId, text }, or null when it is not a user text
// message. Exported so the mock test can exercise it without the SDK.
export function extractInbound(event) {
  const msg = event?.message;
  if (!msg) return null;
  const messageId = msg.message_id || "";
  if (messageId && seenMessageIds.has(messageId)) return null;
  const senderOpenId = event?.sender?.sender_id?.open_id || "";
  if (!senderOpenId) return null; // system / non-user event
  if (msg.message_type !== "text") {
    console.log(`ignored non-text message type: ${msg.message_type} from ${senderOpenId}`);
    return null;
  }
  let text = "";
  try {
    text = JSON.parse(msg.content || "{}").text || "";
  } catch {
    text = "";
  }
  if (!text) return null;
  return { senderOpenId, chatId: msg.chat_id || "", messageId, text, createMs: normalizeTimeMs(msg.create_time) || Date.now() };
}

export async function sendText(client, { receiveId, receiveIdType, text }) {
  const resp = await client.im.v1.message.create({
    params: { receive_id_type: receiveIdType }, // "chat_id" for replies, "open_id" for p2p push
    data: {
      receive_id: receiveId,
      msg_type: "text",
      content: JSON.stringify({ text }),
    },
  });
  remember(resp?.data?.message_id); // do not treat our own echo as inbound
  return resp;
}

// Interactive card: same permissions as text (im:message + send_as_bot).
// If the card is invalid, the caller falls back to plain text.
export async function sendCard(client, { receiveId, receiveIdType, card }) {
  const resp = await client.im.v1.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      msg_type: "interactive",
      content: JSON.stringify(card),
    },
  });
  remember(resp?.data?.message_id);
  return resp;
}

// Patch an already-sent card (streaming / edit). SDK signature:
// im.v1.message.patch({ path: { message_id }, data: { content: cardJson } }).
// content is the card JSON itself, not wrapped in msg_type.
export async function patchCard(client, messageId, card) {
  const resp = await client.im.v1.message.patch({
    path: { message_id: messageId },
    data: { content: JSON.stringify(card) },
  });
  if (resp && resp.code !== undefined && resp.code !== 0) {
    throw new Error(`patch rejected code=${resp.code} msg=${resp.msg || ""}`);
  }
  return resp;
}

export function cardFromAnswer(answer) {
  if (answer && typeof answer === "object" && answer.card) return answer.card;
  const text = typeof answer === "string" ? answer : answer?.text || "";
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: "Muse" } },
    elements: [{ tag: "div", text: { tag: "lark_md", content: text } }],
  };
}

export function placeholderCard() {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: "Muse" } },
    elements: [{ tag: "div", text: { tag: "lark_md", content: "正在思考…" } }],
  };
}

// Streaming step 1: try to patch the placeholder card with the final
// answer; if patch fails (e.g. update permission not yet effective) or
// the card would exceed 30KB, fall back to sending a new message, so
// the user still gets the reply and the log tells us patch did not work.
// Streaming progress: patch the placeholder card with the sections
// drafted so far, throttled to ~1.5s by the queue layer. Failures are
// non-fatal: the final answer patch (or new-message fallback) still
// delivers the complete reply.
export async function patchProgress(client, placeholderMessageId, streamText) {
  if (!placeholderMessageId || !streamText) return;
  try {
    const card = cardFromAnswer(streamText + "\n\n_正在生成…_");
    if (JSON.stringify(card).length > 30000) return;
    await patchCard(client, placeholderMessageId, card);
    console.log(`stream patch: ${streamText.length} chars so far`);
  } catch (e) {
    console.log("stream patch failed (non-fatal):", e?.message || e);
  }
}

export async function sendReplyWithPatch(client, { chatId, placeholderMessageId, answer }) {
  if (placeholderMessageId) {
    try {
      const card = cardFromAnswer(answer);
      if (JSON.stringify(card).length > 30000) {
        console.log("patch skipped: card over 30KB, falling back to new message");
      } else {
        await patchCard(client, placeholderMessageId, card);
        console.log(`patch succeeded for ${placeholderMessageId}`);
        return;
      }
    } catch (e) {
      console.log("patch failed, falling back to new message (non-fatal):", e?.message || e);
    }
  }
  return sendReply(client, { receiveId: chatId, receiveIdType: "chat_id", answer });
}

export async function sendReply(client, { receiveId, receiveIdType, answer }) {
  if (answer && typeof answer === "object" && answer.card) {
    try {
      return await sendCard(client, { receiveId, receiveIdType, card: answer.card });
    } catch (e) {
      console.log("card send failed, falling back to text:", e?.message || e);
    }
  }
  const text = typeof answer === "string" ? answer : answer?.text || "";
  return sendText(client, { receiveId, receiveIdType, text });
}

// Ack reaction on receipt: the user sees at once that the message reached
// the bridge, even when the Muse reply itself still takes seconds.
// Non-fatal by design: a missing reactions permission, an invalid emoji
// type, or a withdrawn message must never block the reply.
// Emoji order, corrected 2026-10-27 from the cross-implementation survey:
// EYES is a Slack-channel convention, not a verified Feishu emoji_type,
// so it was removed instead of wasting a failed call on every message.
// THUMBSUP is Nanobot's verified Feishu ack default; THINKING is
// Clawdbot's verified typing-indicator type. The first type Feishu
// accepts wins, so an uncertain name degrades instead of failing outright.
export async function addReactionAck(client, messageId) {
  if (!messageId) return false;
  for (const emojiType of ["THUMBSUP", "THINKING"]) {
    try {
      const resp = await client.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      if (resp && (resp.code === 0 || resp.code === undefined)) {
        console.log(`reaction ack: ${emojiType} on ${messageId}`);
        return true;
      }
      console.log(`reaction ack: ${emojiType} rejected code=${resp?.code} msg=${resp?.msg || ""}`);
    } catch (e) {
      console.log(`reaction ack: ${emojiType} failed (non-fatal):`, e?.message || e);
    }
  }
  console.log("reaction ack failed for all emoji types (non-fatal, reply continues)");
  return false;
}

// One-time seeding for bridges that started before state existed: the
// latest completed message in done/ still carries its message_id, and a
// single read-only message.get for it returns its chat_id + create_time.
// Read-only, graceful fallback: if it fails, the first live message
// after this deploy creates the state instead.
export async function seedStateFromLastDone(client) {
  let latest = null;
  try {
    for (const f of fs.readdirSync(DONE)) {
      if (!f.startsWith("feishu-") || f.endsWith(".reply.json") || !f.endsWith(".json")) continue;
      const rec = JSON.parse(fs.readFileSync(path.join(DONE, f), "utf8"));
      if (!rec || !isAllowed(rec.sender) || !rec.receivedAt) continue;
      if (!latest || rec.receivedAt > latest.receivedAt) latest = rec;
    }
  } catch (e) {
    console.log("backfill seed scan failed (non-fatal):", e?.message || e);
    return null;
  }
  if (!latest) return null;
  const messageId = String(latest.id || "").replace(/^feishu-/, "");
  if (!messageId) return null;
  try {
    const resp = await client.im.v1.message.get({ path: { message_id: messageId } });
    const item = resp?.data?.items?.[0];
    const chatId = item?.chat_id || "";
    const createMs = normalizeTimeMs(item?.create_time) || normalizeTimeMs(Date.parse(latest.receivedAt));
    if (resp && resp.code !== undefined && resp.code !== 0) {
      console.log(`backfill seed message.get rejected code=${resp.code} (non-fatal)`);
      return null;
    }
    if (!chatId || !createMs) return null;
    const state = { chatId, lastCompletedAtMs: createMs, lastCompletedMessageId: messageId };
    saveState(state);
    console.log(`backfill seeded from last completed message: chat ${chatId.slice(0, 6)}… at ${new Date(createMs).toISOString()}`);
    return state;
  } catch (e) {
    console.log("backfill seed message.get failed (non-fatal):", e?.message || e);
    return null;
  }
}

// Backfill after a (re)connect: fetch the 1:1 chat history since the last
// completed message and feed missed user messages through the normal
// inbox -> hook -> reply path, oldest first. Never throws: a history
// permission error, a missing chatId, or an empty page just logs and
// returns, and the live long connection keeps working.
export async function backfillMissed(client) {
  let state = loadState();
  if (!state || !state.chatId || !state.lastCompletedAtMs) {
    state = await seedStateFromLastDone(client);
  }
  if (!state || !state.chatId || !state.lastCompletedAtMs) {
    console.log("backfill skipped: no persisted chatId / watermark yet (first live message will create it)");
    return { skipped: true, count: 0 };
  }
  let resp;
  try {
    resp = await client.im.v1.message.list({
      params: {
        // Note: this API's container_id_type is "chat" (not "chat_id",
        // which is the receive_id_type spelling used by message.create).
        // A wrong value returns 400 "invalid container_id_type" (seen live
        // on 2026-10-27) and must stay non-fatal.
        container_id_type: "chat",
        container_id: state.chatId,
        start_time: String(Math.floor((state.lastCompletedAtMs - 60000) / 1000)),
        end_time: String(Math.floor(Date.now() / 1000)),
        sort_type: "ByCreateTimeAsc",
        page_size: 50,
      },
    });
  } catch (e) {
    console.log("backfill history list failed (non-fatal):", e?.message || e);
    return { skipped: true, count: 0, error: e?.message || String(e) };
  }
  if (resp && resp.code !== undefined && resp.code !== 0) {
    console.log(`backfill history list rejected code=${resp.code} msg=${resp.msg || ""} (non-fatal; check history permission in console)`);
    return { skipped: true, count: 0, error: resp.msg || `code ${resp.code}` };
  }
  const missed = filterMissedMessages(resp?.data?.items || [], {
    seenIds: getSeenMessageIds(),
    isAllowedSender: (id) => isAllowed(id),
    lastCompletedAtMs: state.lastCompletedAtMs,
  });
  console.log(`backfill: ${missed.length} missed message(s) since ${new Date(state.lastCompletedAtMs).toISOString()}`);
  let count = 0;
  for (const m of missed) {
    if (getSeenMessageIds().has(m.messageId)) continue;
    remember(m.messageId);
    await addReactionAck(client, m.messageId);
    let placeholderMessageId = null;
    try {
      const ph = await sendCard(client, { receiveId: state.chatId, receiveIdType: "chat_id", card: placeholderCard() });
      placeholderMessageId = ph?.data?.message_id || null;
    } catch (e) {
      console.log("backfill placeholder card failed (non-fatal):", e?.message || e);
    }
    await handleInbound({
      id: `feishu-${m.messageId}`,
      sender: m.senderOpenId,
      text: m.text,
      reply: (answer) => sendReplyWithPatch(client, { chatId: state.chatId, placeholderMessageId, answer }),
      onProgress: (streamText) => patchProgress(client, placeholderMessageId, streamText),
    });
    saveState({ chatId: state.chatId, lastCompletedAtMs: m.createMs, lastCompletedMessageId: m.messageId });
    count += 1;
  }
  return { skipped: false, count };
}

function requireCreds() {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    console.error("FEISHU_APP_ID / FEISHU_APP_SECRET env not set.");
    process.exit(2);
  }
  return { appId, appSecret };
}

// Lazy import so syntax checks and the mock test run without the SDK installed.
async function newClient({ appId, appSecret }) {
  const Lark = await import("@larksuiteoapi/node-sdk");
  return new Lark.Client({ appId, appSecret });
}

// Main-chat -> Feishu sync (added 2026-10-28, user-approved "full sync"):
// The sync cron only writes queue/sync/<seq>.json {text}; it never touches
// credentials. This bridge process already holds the credentials in env,
// so it is the only sender. Files are sent oldest-first, then archived
// under queue/done/sync/. A failed send leaves the file in place for the
// next scan / bridge restart, so sync is eventual, never silently dropped.
// Sync text is plain text (not a reply card): it is a mirror of a message
// the user already saw in the main chat, marked as such on the first chunk.
function chunkText(text, max = 3500) {
  const out = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < 1000) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) out.push(rest);
  return out;
}

let syncRunning = false;
let syncPending = false;
async function scanSync(client) {
  if (syncRunning) { syncPending = true; return; }
  syncRunning = true;
  try {
    const state = loadState();
    if (!state || !state.chatId) { console.log("sync skipped: no persisted chatId yet"); return; }
    let files = [];
    try { files = fs.readdirSync(SYNC).filter((f) => f.endsWith(".json")).sort(); } catch {}
    for (const f of files) {
      let rec;
      try { rec = JSON.parse(fs.readFileSync(path.join(SYNC, f), "utf8")); } catch { continue; }
      const text = String(rec?.text || "").trim();
      if (!text) {
        try { fs.renameSync(path.join(SYNC, f), path.join(DONE, "sync", f)); } catch {}
        continue;
      }
      try {
        const chunks = chunkText(text);
        for (let i = 0; i < chunks.length; i++) {
          await sendText(client, { receiveId: state.chatId, receiveIdType: "chat_id", text: i === 0 ? `【主聊天同步】\n${chunks[i]}` : chunks[i] });
        }
        fs.mkdirSync(path.join(DONE, "sync"), { recursive: true });
        fs.renameSync(path.join(SYNC, f), path.join(DONE, "sync", f));
        console.log(`sync sent: ${f} (${text.length} chars)`);
      } catch (e) {
        console.log(`sync send failed, kept for retry: ${f}:`, e?.message || e);
        break;
      }
    }
  } finally {
    syncRunning = false;
    if (syncPending) { syncPending = false; scanSync(client); }
  }
}

function startSyncWatcher(client) {
  scanSync(client);
  try {
    fs.watch(SYNC, () => scanSync(client));
  } catch (e) { console.log("sync watch failed (periodic scan still runs):", e?.message || e); }
  setInterval(() => scanSync(client), 30000);
}

async function run() {
  const { appId, appSecret } = requireCreds();
  const Lark = await import("@larksuiteoapi/node-sdk");
  const client = new Lark.Client({ appId, appSecret });
  // This VM reaches the internet through an egress proxy: a direct WS
  // handshake to msg-frontier.feishu.cn fails with a TLS error, while the
  // same handshake through the proxy succeeds. Pass the proxy agent to
  // WSClient when a proxy is configured; otherwise connect directly.
  let agent;
  const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
  if (proxyUrl) {
    try {
      const pkg = await import("https-proxy-agent");
      const HttpsProxyAgent = pkg.HttpsProxyAgent || pkg.default?.HttpsProxyAgent || pkg.default;
      if (HttpsProxyAgent) agent = new HttpsProxyAgent(proxyUrl);
    } catch {
      console.log("proxy agent unavailable, continuing with direct connection");
    }
  }
  // Backfill on every (re)connect: a WS reconnect after a host restart
  // is exactly when missed messages need to be caught up. Guarded so
  // overlapping reconnects cannot feed the same message twice.
  let wsReadySeen = false;
  let backfillRunning = false;
  const runBackfillOnce = async () => {
    if (backfillRunning) return;
    backfillRunning = true;
    try { await backfillMissed(client); } catch (e) { console.log("backfill failed (non-fatal):", e?.message || e); }
    backfillRunning = false;
  };
  const wsClient = new Lark.WSClient({ appId, appSecret, agent, loggerLevel: Lark.LoggerLevel.info, onReady: () => { console.log("feishu ws ready"); wsReadySeen = true; runBackfillOnce(); }, onError: (e) => { console.log("feishu ws error:", e?.message || e); console.log("feishu ws terminal error, exiting so watchdog can restart"); setTimeout(() => process.exit(1), 1000); } });
  await wsClient.start({
    eventDispatcher: new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (event) => {
        const inbound = extractInbound(event);
        if (!inbound) return;
        const { senderOpenId, chatId, messageId, text, createMs } = inbound;
        if (!isAllowed(senderOpenId)) {
          console.log(`ignored non-allowlisted sender open_id: ${senderOpenId}`);
          console.log("hint: add this open_id to config.json allowedSenders to authorize you.");
          return;
        }
        remember(messageId);
        // Ack first, so the user sees receipt before the reply is ready.
        await addReactionAck(client, messageId);
        // Streaming step 1: send a placeholder card immediately, then
        // patch that same card with the final answer. If placeholder
        // creation fails, reply falls back to a new message as before.
        let placeholderMessageId = null;
        try {
          const ph = await sendCard(client, { receiveId: chatId, receiveIdType: "chat_id", card: placeholderCard() });
          placeholderMessageId = ph?.data?.message_id || null;
        } catch (e) {
          console.log("placeholder card failed (non-fatal, reply will be a new message):", e?.message || e);
        }
        await handleInbound({
          id: `feishu-${messageId || Date.now()}`,
          sender: senderOpenId,
          text,
          reply: (answer) => sendReplyWithPatch(client, { chatId, placeholderMessageId, answer }),
          onProgress: (streamText) => patchProgress(client, placeholderMessageId, streamText),
        });
        // Only now is this message "completed": backfill after a later
        // restart must resume after it, not before it.
        if (chatId && messageId) saveState({ chatId, lastCompletedAtMs: createMs || Date.now(), lastCompletedMessageId: messageId });
      },
    }),
  });
  console.log("feishu bridge connected (long connection), waiting for messages...");
  startSyncWatcher(client);
  if (!wsReadySeen) runBackfillOnce();
}

// Proactive push (Muse-initiated): node src/feishu.mjs proactive <open_id> <text...>
// The target must be allowlisted; this is what lets Muse reach out first.
async function proactive(targetOpenId, text) {
  if (!isAllowed(targetOpenId)) {
    console.error("refusing proactive send: target not in allowedSenders.");
    process.exit(2);
  }
  const { appId, appSecret } = requireCreds();
  const client = await newClient({ appId, appSecret });
  await sendText(client, { receiveId: targetOpenId, receiveIdType: "open_id", text });
  console.log("proactive message sent.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode === "proactive") {
    const [target, ...rest] = process.argv.slice(3);
    if (!target || rest.length === 0) {
      console.error("usage: node src/feishu.mjs proactive <open_id> <text...>");
      process.exit(2);
    }
    proactive(target, rest.join(" "));
  } else {
    run();
  }
}
