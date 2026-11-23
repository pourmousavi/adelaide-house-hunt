// house-alerts: Cloudflare Email Worker.
// 1. Read the raw email, then always forward it to FORWARD_TO (read/parse failures can never block forwarding).
// 2. If it came from realestate.com.au / domain.com.au, pull the listings out and keep them in KV.
// 3. GET /listings.json serves the stored listings (public data only: no recipient, no tracking links, no raw email).
import { senderMatches, headerValues, htmlPart, extractListings, mergeListing, publicView } from "./parse.js";

const RAW_KEEP = 10;
const RAW_TTL = 14 * 24 * 3600;
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*" };
const MAX_RAW_BYTES = 5 * 1024 * 1024;

export default {
  async email(message, env, ctx) {
    // read before forwarding: the raw stream may not be readable afterwards
    let raw = null;
    try { raw = message.rawSize > MAX_RAW_BYTES ? null : await new Response(message.raw).text(); } catch (e) { console.log("read failed:", String(e?.message ?? e)); }
    try {
      await message.forward(env.FORWARD_TO || "ali.pourmousavi@gmail.com");
    } catch (e) {
      console.log("forward failed:", String(e?.message ?? e)); // keep going: still try to store listings
    }
    const diag = { at: new Date().toISOString(), matched: false };
    try {
      await handleAlert(message, raw, env, diag);
    } catch (e) {
      diag.error = String(e?.message ?? e).slice(0, 300);
      console.log("alert parse failed:", diag.error);
    }
    try { await env.ALERTS.put("diag:last", JSON.stringify(diag), { expirationTtl: RAW_TTL }); } catch {}
    // last alert per source, served by /status.json (no TTL: "never" vs "3 weeks ago" both matter)
    if (diag.source) try { await env.ALERTS.put(`last:${diag.source}`, JSON.stringify({ at: diag.at, listings: diag.listings ?? 0 })); } catch {}
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method === "GET" && url.pathname === "/listings.json") {
      const listings = await allListings(env);
      return new Response(JSON.stringify(listings), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60", ...CORS },
      });
    }
    if (request.method === "GET" && url.pathname === "/status.json") {
      const [rea, domain] = await Promise.all(["rea", "domain"].map((s) => env.ALERTS.get(`last:${s}`, "json")));
      return new Response(JSON.stringify({ rea, domain }), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60", ...CORS },
      });
    }
    return new Response("Not found", { status: 404, headers: CORS });
  },
};

async function allListings(env) {
  const keys = [];
  let cursor;
  do {
    const page = await env.ALERTS.list({ prefix: "l:", cursor });
    keys.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const values = await Promise.all(keys.map((k) => env.ALERTS.get(k, "json")));
  return values.filter(Boolean).map(publicView);
}

async function handleAlert(message, raw, env, diag) {
  diag.rawBytes = raw?.length ?? 0;
  if (!raw) return;
  const senders = [message.from, ...headerValues(raw, ["from", "sender", "return-path", "reply-to"])];
  diag.matched = senderMatches(...senders);
  if (!diag.matched) return;
  diag.senderDomains = [...new Set(senders.map((s) => String(s).match(/@([a-z0-9.-]+)/i)?.[1]?.toLowerCase()).filter(Boolean))]; // domains only, no addresses
  diag.source = diag.senderDomains.some((d) => /domain\.com\.au$/.test(d)) ? "domain" : "rea";

  const html = htmlPart(raw);
  diag.htmlFound = !!html;
  if (!html) return;
  const ts = new Date().toISOString();
  const subject = message.headers?.get?.("subject") ?? headerValues(raw, ["subject"])[0];
  const listings = extractListings(html, { subject });
  diag.listings = listings.length;

  for (const l of listings) {
    const key = `l:${l.source}:${l.id}`;
    const prev = await env.ALERTS.get(key, "json");
    await env.ALERTS.put(key, JSON.stringify(mergeListing(prev, l, ts)));
  }

  // Private debugging copy of the HTML body (never served). Keep the newest RAW_KEEP.
  await env.ALERTS.put(`raw:${ts}`, html, { expirationTtl: RAW_TTL });
  const old = (await env.ALERTS.list({ prefix: "raw:" })).keys.map((k) => k.name).sort().slice(0, -RAW_KEEP);
  await Promise.all(old.map((k) => env.ALERTS.delete(k)));
}
