/** Baileys socket lifecycle: QR linking, reconnects, inbound capture, paced sends. */
import { rm } from "node:fs/promises";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  getContentType,
  isLidUser,
  jidNormalizedUser,
  normalizeMessageContent,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";

import { describeContent, displayText, isPrivateJid, phoneFromJid, timestampMs } from "./normalize.mjs";
import { deferSeconds, typingMs } from "./pacing.mjs";

const MAX_ATTEMPTS = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class WaSession {
  /**
   * @param {{ store: import("./store.mjs").WaStore, authDir: string, pacing: ReturnType<typeof import("./pacing.mjs").pacingFromEnv>, sendingPaused: () => boolean, log?: (msg: string) => void }} opts
   */
  constructor({ store, authDir, pacing, sendingPaused, log = console.log }) {
    this.store = store;
    this.authDir = authDir;
    this.pacing = pacing;
    this.sendingPaused = sendingPaused;
    this.log = log;
    this.sock = null;
    this.state = "starting";
    this.qr = null;
    this.qrDataUrl = null;
    this.me = null;
    this.lastError = null;
    this.updatedAt = Date.now();
    this.backoffMs = 2000;
    this.stopped = false;
    this.workerTimer = null;
    this.logger = pino({ level: process.env.WA_LOG_LEVEL ?? "warn" });
  }

  get connected() {
    return this.state === "open";
  }

  publicState() {
    return {
      state: this.state,
      connected: this.connected,
      qr: this.qr,
      qr_data_url: this.qrDataUrl,
      me: this.me,
      last_error: this.lastError,
      updated_at: new Date(this.updatedAt).toISOString(),
    };
  }

  setState(state, extra = {}) {
    this.state = state;
    this.updatedAt = Date.now();
    Object.assign(this, extra);
  }

  async start() {
    this.stopped = false;
    const n = this.store.recoverStuck();
    if (n) this.log(`marked ${n} stuck sends as delivery_unknown`);
    await this.connect();
    this.scheduleWorker(1000);
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.workerTimer);
    try {
      this.sock?.end(undefined);
    } catch {
      /* already closed */
    }
  }

  /** Unlink this device and start a fresh QR pairing. */
  async logout() {
    try {
      await this.sock?.logout();
    } catch {
      /* socket may already be gone */
    }
    await rm(this.authDir, { recursive: true, force: true });
    this.setState("logged_out", { qr: null, qrDataUrl: null, me: null });
    setTimeout(() => this.connect().catch((err) => this.log(`reconnect failed: ${err.message}`)), 1000);
  }

  async connect() {
    if (this.stopped) return;
    this.setState("connecting");
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {
      version = undefined;
    }
    const sock = makeWASocket({
      auth: state,
      version,
      logger: this.logger,
      browser: Browsers.ubuntu("Chrome"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });
    this.sock = sock;

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", (update) => this.onConnectionUpdate(sock, update));
    sock.ev.on("messages.upsert", ({ messages }) => {
      for (const msg of messages ?? []) {
        this.onMessage(sock, msg).catch((err) => this.log(`message handling failed: ${err.message}`));
      }
    });
  }

  async onConnectionUpdate(sock, { connection, lastDisconnect, qr }) {
    if (sock !== this.sock) return;
    if (qr) {
      let dataUrl = null;
      try {
        dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
      } catch {
        /* the raw string is still returned */
      }
      this.setState("qr", { qr, qrDataUrl: dataUrl });
    }
    if (connection === "open") {
      this.backoffMs = 2000;
      const id = sock.user?.id ?? "";
      this.setState("open", {
        qr: null,
        qrDataUrl: null,
        lastError: null,
        me: { id: jidNormalizedUser(id), name: sock.user?.name ?? "", phone: phoneFromJid(jidNormalizedUser(id)) },
      });
      this.log(`WhatsApp connected as ${this.me.phone ?? this.me.id}`);
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      this.lastError = lastDisconnect?.error?.message ?? null;
      if (code === DisconnectReason.loggedOut) {
        this.log("WhatsApp session logged out — waiting for a new QR link");
        await rm(this.authDir, { recursive: true, force: true });
        this.setState("logged_out", { qr: null, qrDataUrl: null, me: null });
        setTimeout(() => this.connect().catch((err) => this.log(err.message)), 2000);
        return;
      }
      this.setState("closed");
      const delay = code === DisconnectReason.restartRequired ? 500 : this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
      setTimeout(() => this.connect().catch((err) => this.log(err.message)), delay);
    }
  }

  /** Prefer the phone-number JID so a person keeps one chat id across LID/PN addressing. */
  async chatJid(sock, key) {
    const remote = key?.remoteJid ?? "";
    if (!isLidUser(remote)) return jidNormalizedUser(remote);
    const alt = key.remoteJidAlt;
    if (alt && !isLidUser(alt)) return jidNormalizedUser(alt);
    try {
      const pn = await sock.signalRepository?.lidMapping?.getPNForLID(remote);
      if (pn) return jidNormalizedUser(pn);
    } catch {
      /* fall back to the LID */
    }
    return jidNormalizedUser(remote);
  }

  async onMessage(sock, msg) {
    const key = msg?.key;
    if (!key?.id || !isPrivateJid(key.remoteJid)) return;
    const content = normalizeMessageContent(msg.message);
    const described = describeContent(content, getContentType(content));
    if (!described) return;
    const text = displayText(described.kind, described.text);
    if (!text) return;
    const chatId = await this.chatJid(sock, key);
    const direction = key.fromMe ? "out" : "in";
    const dateMs = timestampMs(msg.messageTimestamp);
    this.store.upsertMessage({
      chatId,
      messageId: key.id,
      direction,
      kind: described.kind,
      text,
      dateMs,
      senderId: direction === "in" ? chatId : (this.me?.id ?? ""),
    });
    this.store.upsertChat({
      chatId,
      name: direction === "in" ? (msg.pushName ?? "") : "",
      phone: phoneFromJid(chatId),
      lastInMs: direction === "in" ? dateMs : null,
      lastInKey: direction === "in" ? JSON.stringify({ remoteJid: key.remoteJid, id: key.id, fromMe: false }) : null,
    });
  }

  // --- send worker --------------------------------------------------------

  scheduleWorker(ms) {
    clearTimeout(this.workerTimer);
    if (this.stopped) return;
    this.workerTimer = setTimeout(() => {
      this.workerTick()
        .catch((err) => this.log(`send worker error: ${err.message}`))
        .finally(() => this.scheduleWorker(500));
    }, ms);
  }

  async workerTick() {
    if (!this.connected || this.sendingPaused()) return;
    const now = Date.now();
    const row = this.store.nextQueued(now);
    if (!row) return;
    const defer = deferSeconds(this.pacing, this.store.recentSends(now), row.chat_id, now);
    if (defer > 0) {
      this.store.updateOutbox(row.message_id, { next_attempt_at: now + Math.ceil(defer * 1000) });
      return;
    }
    await this.send(row);
  }

  async send(row) {
    const sock = this.sock;
    this.store.updateOutbox(row.message_id, { status: "sending" });
    try {
      const chat = this.store.getChat(row.chat_id);
      if (chat?.last_in_key) {
        await sock.readMessages([JSON.parse(chat.last_in_key)]).catch(() => {});
      }
      await sock.presenceSubscribe(row.chat_id).catch(() => {});
      await sock.sendPresenceUpdate("composing", row.chat_id).catch(() => {});
      await sleep(typingMs(row.text));
      await sock.sendPresenceUpdate("paused", row.chat_id).catch(() => {});
      const sent = await sock.sendMessage(row.chat_id, { text: row.text });
      const now = Date.now();
      const waId = sent?.key?.id ?? `local-${row.message_id}`;
      this.store.recordSend(row.chat_id, now);
      this.store.updateOutbox(row.message_id, {
        status: "sent",
        wa_message_id: waId,
        sent_at: now,
        error_code: null,
        error_message: null,
      });
      this.store.upsertMessage({
        chatId: row.chat_id,
        messageId: waId,
        direction: "out",
        kind: "text",
        text: row.text,
        dateMs: now,
        senderId: this.me?.id ?? "",
      });
    } catch (err) {
      const attempts = row.attempts + 1;
      const message = String(err?.message ?? err).slice(0, 500);
      if (attempts < MAX_ATTEMPTS) {
        this.store.updateOutbox(row.message_id, {
          status: "queued",
          attempts,
          next_attempt_at: Date.now() + 2 ** attempts * 5000,
          error_code: "send_error",
          error_message: message,
        });
      } else {
        this.store.updateOutbox(row.message_id, {
          status: "failed",
          attempts,
          error_code: "send_error",
          error_message: message,
        });
      }
    }
  }
}
