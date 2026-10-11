/** SQLite store: inbox messages (seq cursor), chats, outbox and send ledger. */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export class WaStore {
  /** @param {string} path */
  constructor(path) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        date_ms INTEGER NOT NULL,
        sender_id TEXT NOT NULL DEFAULT '',
        UNIQUE (chat_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_wa_messages_chat ON messages(chat_id, date_ms);
      CREATE TABLE IF NOT EXISTS chats (
        chat_id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        phone TEXT,
        last_in_ms INTEGER,
        last_in_key TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        message_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        chat_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        wa_message_id TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        sent_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_wa_outbox_status ON outbox(status, next_attempt_at);
      CREATE TABLE IF NOT EXISTS sends (
        ts INTEGER NOT NULL,
        chat_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_wa_sends_ts ON sends(ts);
    `);
  }

  close() {
    this.db.close();
  }

  /**
   * Insert a message, or update text/kind if it is already stored (keeps its seq).
   * @returns {boolean} true when the row is new
   */
  upsertMessage({ chatId, messageId, direction, kind, text, dateMs, senderId = "" }) {
    const existing = this.db
      .prepare("SELECT seq FROM messages WHERE chat_id=? AND message_id=?")
      .get(chatId, messageId);
    if (existing) {
      this.db
        .prepare("UPDATE messages SET kind=?, text=? WHERE seq=?")
        .run(kind, text, existing.seq);
      return false;
    }
    this.db
      .prepare(
        `INSERT INTO messages (chat_id, message_id, direction, kind, text, date_ms, sender_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(chatId, messageId, direction, kind, text, dateMs, senderId);
    return true;
  }

  upsertChat({ chatId, name, phone, lastInMs, lastInKey }) {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO chats (chat_id, name, phone, last_in_ms, last_in_key, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET
           name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE chats.name END,
           phone = COALESCE(excluded.phone, chats.phone),
           last_in_ms = MAX(COALESCE(chats.last_in_ms, 0), COALESCE(excluded.last_in_ms, 0)),
           last_in_key = COALESCE(excluded.last_in_key, chats.last_in_key),
           updated_at = excluded.updated_at`,
      )
      .run(chatId, name ?? "", phone ?? null, lastInMs ?? null, lastInKey ?? null, now);
  }

  getChat(chatId) {
    return this.db.prepare("SELECT * FROM chats WHERE chat_id=?").get(chatId) ?? null;
  }

  eventsAfter(seq, limit = 200) {
    return this.db
      .prepare("SELECT * FROM messages WHERE seq > ? ORDER BY seq LIMIT ?")
      .all(seq, Math.max(1, Math.min(limit, 1000)));
  }

  history(chatId, limit = 100) {
    return this.db
      .prepare("SELECT * FROM messages WHERE chat_id=? ORDER BY date_ms DESC, seq DESC LIMIT ?")
      .all(chatId, Math.max(1, Math.min(limit, 500)))
      .reverse();
  }

  chatsById(chatIds) {
    if (!chatIds.length) return new Map();
    const marks = chatIds.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT * FROM chats WHERE chat_id IN (${marks})`).all(...chatIds);
    return new Map(rows.map((r) => [r.chat_id, r]));
  }

  // --- outbox -------------------------------------------------------------

  getOutboxByKey(key) {
    return this.db.prepare("SELECT * FROM outbox WHERE idempotency_key=?").get(key) ?? null;
  }

  getOutbox(messageId) {
    return this.db.prepare("SELECT * FROM outbox WHERE message_id=?").get(messageId) ?? null;
  }

  enqueue({ idempotencyKey, chatId, text }) {
    const now = Date.now();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO outbox (message_id, idempotency_key, chat_id, text, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(id, idempotencyKey, chatId, text, now, now);
    return this.getOutbox(id);
  }

  queueDepth() {
    return this.db
      .prepare("SELECT COUNT(*) AS c FROM outbox WHERE status IN ('queued','sending')")
      .get().c;
  }

  nextQueued(nowMs) {
    return (
      this.db
        .prepare(
          `SELECT * FROM outbox WHERE status='queued' AND next_attempt_at <= ?
           ORDER BY created_at LIMIT 1`,
        )
        .get(nowMs) ?? null
    );
  }

  updateOutbox(messageId, fields) {
    const entries = Object.entries({ ...fields, updated_at: Date.now() });
    const cols = entries.map(([k]) => `${k}=?`).join(", ");
    this.db
      .prepare(`UPDATE outbox SET ${cols} WHERE message_id=?`)
      .run(...entries.map(([, v]) => v ?? null), messageId);
  }

  /** Rows left in "sending" by a crash may or may not have gone out. */
  recoverStuck() {
    return this.db
      .prepare(
        `UPDATE outbox SET status='delivery_unknown', error_code='delivery_unknown',
           error_message='interrupted while sending', updated_at=? WHERE status='sending'`,
      )
      .run(Date.now()).changes;
  }

  recordSend(chatId, ts = Date.now()) {
    this.db.prepare("INSERT INTO sends (ts, chat_id) VALUES (?, ?)").run(ts, chatId);
    this.db.prepare("DELETE FROM sends WHERE ts < ?").run(ts - 2 * 86_400_000);
  }

  recentSends(nowMs = Date.now()) {
    return this.db
      .prepare("SELECT ts, chat_id AS chatId FROM sends WHERE ts >= ?")
      .all(nowMs - 86_400_000);
  }
}
