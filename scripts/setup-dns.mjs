#!/usr/bin/env node
/**
 * Create the DNS-only A record for whatsapp-adaptor.boostsho.ir.
 * Reads CLOUDFLARE_* from j:/dev/minecraft/.env.cloudflare or the environment.
 */
import { readFile } from "node:fs/promises";

const HOSTNAME = "whatsapp-adaptor.boostsho.ir";
const VPS_IP = process.env.VPS_IP || "5.42.223.209";

async function loadCloudflareEnv() {
  const path = process.env.CLOUDFLARE_ENV_FILE || "j:/dev/minecraft/.env.cloudflare";
  try {
    const raw = await readFile(path, "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 0) continue;
      const key = t.slice(0, eq).trim();
      const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[key] && val) process.env[key] = val;
    }
  } catch {
    // env already populated
  }
}

async function cf(path, options = {}) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN missing");
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const body = await res.json();
  if (!body.success) throw new Error(`Cloudflare API ${path}: ${JSON.stringify(body.errors ?? body)}`);
  return body.result;
}

await loadCloudflareEnv();
const zoneName = process.env.CLOUDFLARE_ZONE_NAME || "boostsho.ir";
const zones = await cf(`/zones?name=${encodeURIComponent(zoneName)}`);
const zone = zones[0];
if (!zone) throw new Error(`Zone not found: ${zoneName}`);

const existing = await cf(`/zones/${zone.id}/dns_records?name=${encodeURIComponent(HOSTNAME)}&type=A`);
if (existing.length) {
  const rec = existing[0];
  if (rec.content !== VPS_IP || rec.proxied) {
    await cf(`/zones/${zone.id}/dns_records/${rec.id}`, {
      method: "PATCH",
      body: JSON.stringify({ type: "A", name: HOSTNAME, content: VPS_IP, proxied: false, ttl: 1 }),
    });
    console.log(`Updated A ${HOSTNAME} → ${VPS_IP} (DNS only)`);
  } else {
    console.log(`DNS A record already points ${HOSTNAME} at ${VPS_IP} (DNS only)`);
  }
} else {
  await cf(`/zones/${zone.id}/dns_records`, {
    method: "POST",
    body: JSON.stringify({ type: "A", name: HOSTNAME, content: VPS_IP, proxied: false, ttl: 1 }),
  });
  console.log(`Created DNS A ${HOSTNAME} → ${VPS_IP} (DNS only)`);
}
