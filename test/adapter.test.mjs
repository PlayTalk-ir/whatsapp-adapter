import assert from "node:assert/strict";
import { test } from "node:test";

import { describeContent, displayText, jidFromPhone, phoneFromJid } from "../src/normalize.mjs";
import { deferSeconds, replyWindowOpen } from "../src/pacing.mjs";
import { createApp } from "../src/server.mjs";
import { WaStore } from "../src/store.mjs";

const PACING = {
  chatMinIntervalS: 3,
  globalMinIntervalS: 2,
  jitterS: 0,
  maxPerMinute: 2,
  maxPerDay: 500,
  replyWindowH: 24,
};

test("describeContent maps text, captions, voice and skips protocol noise", () => {
  assert.deepEqual(describeContent({ conversation: " salam " }, "conversation"), { kind: "text", text: "salam" });
  assert.deepEqual(describeContent({ imageMessage: { caption: "pic" } }, "imageMessage"), { kind: "photo", text: "pic" });
  assert.deepEqual(describeContent({ audioMessage: { ptt: true } }, "audioMessage"), { kind: "voice", text: "" });
  assert.equal(describeContent({ protocolMessage: {} }, "protocolMessage"), null);
  assert.equal(describeContent({ reactionMessage: {} }, "reactionMessage"), null);
  assert.equal(displayText("voice", ""), "[پیام صوتی]");
  assert.equal(displayText("photo", "pic"), "[عکس] pic");
});

test("phone ⇄ jid normalization", () => {
  assert.equal(phoneFromJid("989121234567@s.whatsapp.net"), "09121234567");
  assert.equal(phoneFromJid("4915112345678@s.whatsapp.net"), "+4915112345678");
  assert.equal(phoneFromJid("12345@lid"), null);
  assert.equal(jidFromPhone("۰۹۱۲۱۲۳۴۵۶۷"), "989121234567@s.whatsapp.net");
  assert.equal(jidFromPhone("+98 912 123 4567"), "989121234567@s.whatsapp.net");
  assert.equal(jidFromPhone("abc"), null);
});

test("pacing enforces global gap, per-minute cap and per-chat gap", () => {
  const now = 1_000_000_000;
  assert.equal(deferSeconds(PACING, [], "a", now, 0), 0);
  assert.ok(deferSeconds(PACING, [{ ts: now - 1000, chatId: "b" }], "a", now, 0) > 0);
  assert.equal(deferSeconds(PACING, [{ ts: now - 2500, chatId: "b" }], "a", now, 0), 0);
  assert.ok(deferSeconds(PACING, [{ ts: now - 2500, chatId: "a" }], "a", now, 0) > 0);
  const burst = [{ ts: now - 10_000, chatId: "x" }, { ts: now - 5_000, chatId: "y" }];
  assert.ok(deferSeconds(PACING, burst, "a", now, 0) > 1);
  assert.equal(replyWindowOpen(PACING, now - 3_600_000, now), true);
  assert.equal(replyWindowOpen(PACING, now - 25 * 3_600_000, now), false);
  assert.equal(replyWindowOpen(PACING, null, now), false);
});

test("store keeps seq on re-upsert", () => {
  const store = new WaStore(":memory:");
  const base = { chatId: "c@s.whatsapp.net", direction: "in", kind: "text", dateMs: 1 };
  assert.equal(store.upsertMessage({ ...base, messageId: "m1", text: "a" }), true);
  assert.equal(store.upsertMessage({ ...base, messageId: "m2", text: "b" }), true);
  assert.equal(store.upsertMessage({ ...base, messageId: "m1", text: "a2" }), false);
  const events = store.eventsAfter(0);
  assert.deepEqual(events.map((e) => [e.seq, e.text]), [[1, "a2"], [2, "b"]]);
  store.close();
});

async function withApp(fn) {
  const store = new WaStore(":memory:");
  const session = { connected: true, state: "open", publicState: () => ({ state: "open" }), logout: async () => {} };
  const server = createApp({ store, session, tokens: ["t0k"], pacing: PACING, sendingPaused: () => false });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, opts = {}) =>
    fetch(base + path, {
      ...opts,
      headers: { Authorization: "Bearer t0k", "Content-Type": "application/json", ...(opts.headers ?? {}) },
    });
  try {
    await fn({ store, call, base });
  } finally {
    server.close();
    store.close();
  }
}

test("API: auth, feed and reply window", async () => {
  await withApp(async ({ store, call, base }) => {
    assert.equal((await fetch(`${base}/v1/inbox/events`)).status, 401);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);

    const chatId = "989121234567@s.whatsapp.net";
    const reply = { recipient: { chat_id: chatId }, text: "salam!", idempotency_key: "inbox:1", mode: "reply" };
    let r = await call("/v1/messages", { method: "POST", body: JSON.stringify(reply) });
    assert.equal(r.status, 422);
    assert.equal((await r.json()).error.code, "reply_window_closed");

    store.upsertMessage({ chatId, messageId: "m1", direction: "in", kind: "text", text: "hi", dateMs: Date.now() });
    store.upsertChat({ chatId, name: "Sara", phone: "09121234567", lastInMs: Date.now() });

    r = await call("/v1/inbox/events?after=0");
    const feed = await r.json();
    assert.equal(feed.events.length, 1);
    assert.equal(feed.events[0].chat.name, "Sara");
    assert.equal(feed.events[0].chat.phone, "09121234567");
    assert.equal(feed.next_after, 1);

    r = await call("/v1/messages", { method: "POST", body: JSON.stringify(reply) });
    assert.equal(r.status, 202);
    const { message_id } = await r.json();
    r = await call("/v1/messages", { method: "POST", body: JSON.stringify(reply) });
    assert.equal(r.status, 200);
    r = await call("/v1/messages", { method: "POST", body: JSON.stringify({ ...reply, text: "other" }) });
    assert.equal(r.status, 409);
    r = await call(`/v1/messages/${message_id}`);
    assert.equal((await r.json()).status, "queued");
  });
});
