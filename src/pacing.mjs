/**
 * Send pacing for the WhatsApp Web session. Unofficial sessions get banned for
 * bot-like bursts, so every reply waits for per-chat and global gaps plus jitter.
 */

export function pacingFromEnv(env = process.env) {
  const num = (name, fallback) => {
    const n = Number(env[name]);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    chatMinIntervalS: num("WA_CHAT_MIN_INTERVAL_S", 3),
    globalMinIntervalS: num("WA_GLOBAL_MIN_INTERVAL_S", 2),
    jitterS: num("WA_JITTER_S", 2),
    maxPerMinute: num("WA_MAX_PER_MINUTE", 12),
    maxPerDay: num("WA_MAX_PER_DAY", 500),
    replyWindowH: num("WA_REPLY_WINDOW_H", 24),
  };
}

/**
 * Seconds to wait before sending to `chatId`; 0 when allowed now.
 * @param {{ ts: number, chatId: string }[]} recentSends sends of the last 24h (ms timestamps)
 */
export function deferSeconds(cfg, recentSends, chatId, nowMs, jitter = Math.random()) {
  const lastGlobal = recentSends.reduce((m, s) => Math.max(m, s.ts), 0);
  if (lastGlobal) {
    const wait = (cfg.globalMinIntervalS + jitter * cfg.jitterS) * 1000;
    if (nowMs - lastGlobal < wait) return (wait - (nowMs - lastGlobal)) / 1000;
  }
  const lastMinute = recentSends.filter((s) => nowMs - s.ts < 60_000);
  if (lastMinute.length >= cfg.maxPerMinute) {
    const oldest = Math.min(...lastMinute.map((s) => s.ts));
    return Math.max(1, (60_000 - (nowMs - oldest)) / 1000);
  }
  const lastDay = recentSends.filter((s) => nowMs - s.ts < 86_400_000);
  if (lastDay.length >= cfg.maxPerDay) return 300;
  const lastChat = recentSends
    .filter((s) => s.chatId === chatId)
    .reduce((m, s) => Math.max(m, s.ts), 0);
  if (lastChat && nowMs - lastChat < cfg.chatMinIntervalS * 1000) {
    return (cfg.chatMinIntervalS * 1000 - (nowMs - lastChat)) / 1000;
  }
  return 0;
}

/** How long to show "typing…" before a message of this length. */
export function typingMs(text, jitter = Math.random()) {
  const base = Math.min(4000, 800 + String(text ?? "").length * 35);
  return Math.round(base * (0.8 + jitter * 0.4));
}

export function replyWindowOpen(cfg, lastInboundMs, nowMs) {
  if (!lastInboundMs) return false;
  return nowMs - lastInboundMs <= cfg.replyWindowH * 3_600_000;
}
