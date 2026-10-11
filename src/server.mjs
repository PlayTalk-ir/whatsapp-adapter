#!/usr/bin/env node
/**
 * WhatsApp adapter HTTP API — same contract as the Bale adapter's inbox feed:
 *   GET  /healthz                      (no auth)
 *   GET  /readyz
 *   GET  /v1/session                   connection state + QR for linking
 *   POST /v1/session/logout            unlink and show a new QR
 *   GET  /v1/inbox/events?after=&limit=
 *   GET  /v1/inbox/chats/:chatId/history?limit=
 *   POST /v1/messages                  reply only (customer must have written first)
 *   GET  /v1/messages/:id
 */
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";

import { jidFromPhone } from "./normalize.mjs";
import { pacingFromEnv, replyWindowOpen } from "./pacing.mjs";
import { WaSession } from "./session.mjs";
import { WaStore } from "./store.mjs";

const IDEM_RE = /^[A-Za-z0-9:_.-]{1,128}$/;

export function createApp({ store, session, tokens, pacing, sendingPaused, queueMax = 200 }) {
  const tokenBufs = tokens.map((t) => Buffer.from(t));

  function authed(req) {
    const header = String(req.headers.authorization ?? "");
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return false;
    const given = Buffer.from(match[1].trim());
    return tokenBufs.some((t) => t.length === given.length && timingSafeEqual(t, given));
  }

  function send(res, status, body) {
    const json = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(json);
  }

  const fail = (res, status, code, message, details = {}) =>
    send(res, status, { error: { code, message, details } });

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 64 * 1024) throw new Error("body too large");
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    return raw ? JSON.parse(raw) : {};
  }

  function eventsPayload(rows) {
    const chats = store.chatsById([...new Set(rows.map((r) => r.chat_id))]);
    return rows.map((r) => {
      const chat = chats.get(r.chat_id);
      return {
        seq: r.seq,
        chat_id: r.chat_id,
        message_id: r.message_id,
        direction: r.direction,
        kind: r.kind,
        text: r.text,
        date_ms: r.date_ms,
        sender_id: r.sender_id,
        chat: { name: chat?.name ?? "", username: "", phone: chat?.phone ?? null },
      };
    });
  }

  function outboxStatus(row) {
    return {
      message_id: row.message_id,
      idempotency_key: row.idempotency_key,
      status: row.status,
      attempts: row.attempts,
      chat_id: row.chat_id,
      wa_message_id: row.wa_message_id,
      error: row.error_code ? { code: row.error_code, message: row.error_message ?? "" } : null,
      created_at: new Date(row.created_at).toISOString(),
      sent_at: row.sent_at ? new Date(row.sent_at).toISOString() : null,
      updated_at: new Date(row.updated_at).toISOString(),
    };
  }

  async function postMessage(req, res) {
    if (sendingPaused()) return fail(res, 503, "sending_paused", "sending is paused");
    if (store.queueDepth() >= queueMax) return fail(res, 429, "rate_limited", "queue full");
    let body;
    try {
      body = await readBody(req);
    } catch {
      return fail(res, 422, "invalid_body", "invalid JSON body");
    }
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim()) return fail(res, 422, "text_required", "text is required");
    if (text.length > 4000) return fail(res, 413, "text_too_long", "text exceeds 4000 characters");
    const key = String(body.idempotency_key ?? "");
    if (!IDEM_RE.test(key)) return fail(res, 422, "invalid_idempotency_key", "invalid idempotency_key");
    if ((body.mode ?? "reply") !== "reply") {
      return fail(res, 422, "mode_invalid", "only reply mode is supported on WhatsApp");
    }
    const rec = body.recipient ?? {};
    const chatId = rec.chat_id ? String(rec.chat_id) : jidFromPhone(rec.phone);
    if (!chatId) return fail(res, 422, "recipient_invalid", "recipient.chat_id or recipient.phone required");

    const existing = store.getOutboxByKey(key);
    if (existing) {
      if (existing.chat_id !== chatId || existing.text !== text) {
        return fail(res, 409, "idempotency_conflict", "idempotency key reused with different payload");
      }
      return send(res, 200, { message_id: existing.message_id, status: existing.status, idempotency_key: key });
    }
    const chat = store.getChat(chatId);
    if (!replyWindowOpen(pacing, chat?.last_in_ms, Date.now())) {
      return fail(res, 422, "reply_window_closed", "customer has not messaged us recently", {
        window_hours: pacing.replyWindowH,
      });
    }
    const row = store.enqueue({ idempotencyKey: key, chatId, text });
    return send(res, 202, { message_id: row.message_id, status: row.status, idempotency_key: key });
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      if (req.method === "GET" && path === "/healthz") return send(res, 200, { ok: true });
      if (!authed(req)) return fail(res, 401, "unauthorized", "missing or invalid token");

      if (req.method === "GET" && path === "/readyz") {
        return send(res, 200, {
          session_connected: session.connected,
          session_state: session.state,
          queue_depth: store.queueDepth(),
          paused: sendingPaused(),
        });
      }
      if (req.method === "GET" && path === "/v1/session") return send(res, 200, session.publicState());
      if (req.method === "POST" && path === "/v1/session/logout") {
        await session.logout();
        return send(res, 200, { ok: true });
      }
      if (req.method === "GET" && path === "/v1/inbox/events") {
        const after = Number(url.searchParams.get("after") ?? 0) || 0;
        const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") ?? 200) || 200, 1000));
        const rows = store.eventsAfter(after, limit);
        return send(res, 200, {
          events: eventsPayload(rows),
          next_after: rows.length ? rows[rows.length - 1].seq : after,
          has_more: rows.length === limit,
        });
      }
      const historyMatch = path.match(/^\/v1\/inbox\/chats\/([^/]+)\/history$/);
      if (req.method === "GET" && historyMatch) {
        const limit = Number(url.searchParams.get("limit") ?? 100) || 100;
        return send(res, 200, { events: eventsPayload(store.history(decodeURIComponent(historyMatch[1]), limit)) });
      }
      if (req.method === "POST" && path === "/v1/messages") return await postMessage(req, res);
      const msgMatch = path.match(/^\/v1\/messages\/([^/]+)$/);
      if (req.method === "GET" && msgMatch) {
        const row = store.getOutbox(decodeURIComponent(msgMatch[1]));
        return row ? send(res, 200, outboxStatus(row)) : fail(res, 404, "not_found", "message not found");
      }
      return fail(res, 404, "not_found", "not found");
    } catch (err) {
      console.error(err);
      if (!res.headersSent) fail(res, 500, "internal", "internal error");
      else res.end();
    }
  });
}

async function main() {
  const tokens = String(process.env.WA_ADAPTER_API_TOKENS ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (!tokens.length) {
    // Stay up idle so `restart: unless-stopped` does not crash-loop before it is configured.
    console.warn("WA_ADAPTER_API_TOKENS is not set — WhatsApp adapter disabled.");
    setInterval(() => {}, 1 << 30);
    return;
  }
  const dataDir = process.env.WA_DATA_DIR ?? "data";
  const store = new WaStore(process.env.WA_DB_PATH ?? join(dataDir, "whatsapp.sqlite"));
  const pacing = pacingFromEnv();
  const sendingPaused = () => /^(1|true|yes|on)$/i.test(process.env.WA_SENDING_PAUSED ?? "");
  const session = new WaSession({
    store,
    authDir: process.env.WA_AUTH_DIR ?? join(dataDir, "auth"),
    pacing,
    sendingPaused,
  });
  const server = createApp({ store, session, tokens, pacing, sendingPaused });
  const host = process.env.WA_API_HOST ?? "0.0.0.0";
  const port = Number(process.env.WA_API_PORT) || 8788;
  server.listen(port, host, () => console.log(`WhatsApp adapter API on ${host}:${port}`));
  await session.start();

  const shutdown = async () => {
    await session.stop();
    server.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (process.argv[1]?.endsWith("server.mjs")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
