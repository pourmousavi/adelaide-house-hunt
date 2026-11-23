// Pure parsing helpers for the house-alerts Email Worker. No I/O, no dependencies.
// Everything here works on strings so it can be unit-tested in Node (worker/test.mjs).

// ---------- sender ----------

export const SENDER_RE = /realestate\.com\.au|domain\.com\.au|reamail/i;

// `parts` = envelope sender plus whichever sender-ish header values the caller has. Never stored.
export const senderMatches = (...parts) => parts.some((p) => p && SENDER_RE.test(String(p)));

// ---------- MIME ----------

function parseHeaders(block) {
  const h = {};
  for (const line of block.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) h[line.slice(0, i).trim().toLowerCase()] ??= line.slice(i + 1).trim();
  }
  return h;
}

function splitPart(s) {
  const m = s.match(/\r?\n\r?\n/);
  return m ? [s.slice(0, m.index), s.slice(m.index + m[0].length)] : [s, ""];
}

export function decodeQuotedPrintable(s) {
  const t = s.replace(/=\r?\n/g, "");
  const bytes = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) { bytes.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; }
    else {
      const code = t.charCodeAt(i);
      if (code < 128) bytes.push(code);
      else bytes.push(...new TextEncoder().encode(t[i])); // already-decoded 8bit text slipped in
    }
  }
  return Uint8Array.from(bytes);
}

export function decodeBase64(s) {
  const bin = atob(s.replace(/[^A-Za-z0-9+/=]/g, ""));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function bytesToText(bytes, charset) {
  try { return new TextDecoder(charset || "utf-8").decode(bytes); }
  catch { return new TextDecoder("utf-8").decode(bytes); }
}

// Walks a raw MIME message -> [{ type: "text/html", text: "decoded body" }, ...] (leaf parts only).
export function mimeParts(raw, depth = 0) {
  const [head, body] = splitPart(raw);
  const h = parseHeaders(head);
  const ctype = h["content-type"] ?? "text/plain";
  const type = ctype.split(";")[0].trim().toLowerCase();
  if (type.startsWith("multipart/") && depth < 8) {
    const b = ctype.match(/boundary="?([^";\s]+)"?/i)?.[1];
    if (!b) return [];
    return body.split(`--${b}`).slice(1)
      .filter((p) => !p.startsWith("--"))
      .flatMap((p) => mimeParts(p.replace(/^\r?\n/, ""), depth + 1));
  }
  const enc = (h["content-transfer-encoding"] ?? "7bit").toLowerCase();
  const charset = ctype.match(/charset="?([^";\s]+)"?/i)?.[1];
  let text;
  if (enc === "quoted-printable") text = bytesToText(decodeQuotedPrintable(body), charset);
  else if (enc === "base64") text = bytesToText(decodeBase64(body), charset);
  else text = body;
  return [{ type, text }];
}

export const htmlPart = (raw) => mimeParts(raw).find((p) => p.type === "text/html")?.text ?? null;

// Top-level header values by name (for the sender check only).
export const headerValues = (raw, names) => {
  const h = parseHeaders(splitPart(raw)[0]);
  return names.map((n) => h[n.toLowerCase()]).filter(Boolean);
};

// ---------- html helpers ----------

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", rsquo: "'", lsquo: "'" };
export const decodeEntities = (s) =>
  String(s ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);

const titleCase = (s) => String(s).toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_, a, c) => a + c.toUpperCase());

// ---------- listing URLs ----------

// realestate.com.au/property-house-sa-linden+park-143456789   (id = trailing digits)
const REA_RE = /(?:https?:\/\/)?(?:www\.)?realestate\.com\.au\/property-([a-z0-9+%.-]+?)-sa-([a-z0-9+%.-]+?)-(\d{5,})(?=[/?#&"'\s]|$)/i;
// domain.com.au/12-example-st-linden-park-sa-5065-2019876543
const DOM_RE = /(?:https?:\/\/)?(?:www\.)?domain\.com\.au\/([a-z0-9-]+?)-(\d{7,})(?=[/?#&"'\s]|$)/i;

const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

const PROPERTY_TYPES = {
  house: "House", townhouse: "Townhouse", unit: "Unit", apartment: "ApartmentUnitFlat", flat: "ApartmentUnitFlat",
  villa: "Villa", duplex: "Duplex", "semi-detached": "SemiDetached", terrace: "Terrace", land: "Land", acreage: "Acreage",
  "retirement-living": "Retirement",
};
const typeFromSlug = (s) => PROPERTY_TYPES[safeDecode(s).toLowerCase().replace(/[+\s]+/g, "-")] ?? null;

// href -> { source, id, url, propertyType, suburb? } for a direct or redirect-wrapped listing link, else null.
// Redirects are decoded when the target sits in a query parameter or an encoded path segment.
export function resolveListingUrl(href) {
  const h = decodeEntities(String(href ?? "")).trim();
  if (!/^https?:\/\//i.test(h)) return null;
  const variants = [h, safeDecode(h), safeDecode(safeDecode(h))];
  for (const v of variants) {
    let m = v.match(REA_RE);
    if (m) {
      const url = `https://www.realestate.com.au/property-${m[1]}-sa-${m[2]}-${m[3]}`;
      return { source: "rea", id: m[3], url, propertyType: typeFromSlug(m[1]), suburb: titleCase(m[2].replace(/\+/g, " ").replace(/-/g, " ")) };
    }
    m = v.match(DOM_RE);
    if (m) {
      return { source: "domain", id: m[2], url: `https://www.domain.com.au/${m[1]}-${m[2]}`, propertyType: null, suburb: null, slug: m[1] };
    }
  }
  return null;
}

// Tracking / redirect hosts used by the alert senders (best guess; real samples may add more).
const TRACKING_HOST_RE = /^https?:\/\/[^/]*(reamail|click\.|links?\.|email\.|e\.|mail\.realestate|track|sendgrid|sparkpost|mandrillapp|mcsv|exacttarget|cmail|klclick|clicks?\.)/i;
const NOISE_LINK_RE = /unsubscribe|opt-?out|preferences|manage|privacy|terms|help|support|facebook|instagram|twitter|youtube|linkedin|app-?store|play\.google|mailto:|view[-_ ]?(in|online|browser)/i;

// ---------- text nodes ----------

// html fragment -> ordered text nodes. <img alt> contributes its alt text.
export function textNodes(html) {
  const clean = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, " ");
  const out = [];
  for (const m of clean.matchAll(/<img\b[^>]*>|<[^>]*>|[^<]+/g)) {
    const t = m[0];
    if (t.startsWith("<")) {
      if (/^<img/i.test(t)) {
        const alt = t.match(/\balt\s*=\s*"([^"]*)"|\balt\s*=\s*'([^']*)'/i);
        const a = decodeEntities(alt?.[1] ?? alt?.[2] ?? "").replace(/\s+/g, " ").trim();
        if (a) out.push(a);
      }
    } else {
      const s = decodeEntities(t).replace(/\s+/g, " ").trim();
      if (s) out.push(s);
    }
  }
  return out;
}

const ADDRESS_RE = /^(?:[A-Za-z]{2,10}\s+)?(\d+[A-Za-z]?(?:\s*[/-]\s*\d+[A-Za-z]?)?)\s+([A-Za-z][^,$]{2,50}),\s*([A-Za-z][A-Za-z' .-]{1,40}?)(?:,?\s+(?:SA|South Australia))?(?:\s+(\d{4}))?$/;

export function parseAddress(node) {
  const m = String(node).match(ADDRESS_RE);
  if (!m || /\b(bed|bath|car|garage|parking)/i.test(m[2])) return null;
  const suburb = titleCase(m[3].trim());
  const full = String(node).match(/^((?:[A-Za-z]{2,10}\s+)?\d+[A-Za-z]?(?:\s*[/-]\s*\d+[A-Za-z]?)?\s+[^,$]+),/)[1].trim();
  return { street: full, suburb, postcode: m[4] ?? null };
}

const PRICE_WORDS = /^(auction|contact agent|price (on application|guide)|poa|expressions? of interest|eoi|offers?\b|by negotiation|best offer|under offer|sold|for sale by)/i;

export function findPrice(nodes) {
  const dollar = nodes.find((n) => /\$\s?\d/.test(n) && n.length <= 80 && !parseAddress(n));
  if (dollar) return dollar.replace(/\s+/g, " ").trim();
  return nodes.find((n) => PRICE_WORDS.test(n) && n.length <= 60) ?? null;
}

const FEATURE_WORDS = { beds: "bed(?:room)?s?", baths: "bath(?:room)?s?", cars: "cars?(?:\\s*(?:spaces?|parks?|ports?))?|parking|garages?" };

// beds/baths/cars from "4 Beds 2 Baths 2 Cars", "Bedrooms 4 Bathrooms 2" and icon alt + number layouts.
export function findCounts(nodes) {
  const text = nodes.join(" ");
  const all = new RegExp(`\\b(?:${Object.values(FEATURE_WORDS).join("|")})\\b`, "i");
  const first = text.match(all);
  const out = { beds: null, baths: null, cars: null };
  if (!first) return out;
  const numBefore = /(?<![\d,.$/])\d{1,2}\s*$/.test(text.slice(0, first.index));
  for (const [k, w] of Object.entries(FEATURE_WORDS)) {
    const re = numBefore ? new RegExp(`(?<![\\d,.$/])(\\d{1,2})\\s*(?:${w})\\b`, "i") : new RegExp(`\\b(?:${w})\\b\\s*[:x-]?\\s*(\\d{1,2})(?![\\d,])`, "i");
    const m = text.match(re);
    if (m) out[k] = +m[1];
  }
  return out;
}

const IMG_OK = /(reastatic\.net|domainstatic\.com\.au|rea-?static|bucket-api\.domain)/i;
const IMG_BAD = /icon|logo|spacer|pixel|beacon|open\.|track|badge|avatar|agent|\.gif(\?|$)/i;

export function findImage(html) {
  for (const m of html.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)) {
    const src = decodeEntities(m[1] ?? m[2]);
    if (/^https?:\/\//i.test(src) && IMG_OK.test(src) && !IMG_BAD.test(src)) return src;
  }
  return null;
}

const KIND_RULES = [
  ["sold", /\bsold\b(?! by)/i],
  ["priceChange", /price (change|drop|reduc|update|guide (change|update))|reduced|new price|price (has )?(changed|dropped)/i],
  ["openHome", /open (home|for inspection)|inspection|open\s+(mon|tue|wed|thu|fri|sat|sun)/i],
  ["new", /new (listing|property|to market)|just listed|new\b/i],
];
export function kindOf(text) {
  for (const [kind, re] of KIND_RULES) if (re.test(text)) return kind;
  return null;
}
export const kindFromSubject = (subject) => (subject ? kindOf(String(subject)) : null);

const hash = (s) => { let h = 5381; for (const c of s) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0; return h.toString(36); };

// ---------- extraction ----------

// End of the last card: the footer (unsubscribe, recipient address, legal) starts at the first marker after `from`.
const footerStart = (html, from) => {
  const i = html.slice(from).search(/unsubscribe|<footer|manage (your )?(alert|preferences)|this email was sent/i);
  return i < 0 ? html.length : from + i;
};

function buildListing(block, info, subjectKind) {
  const nodes = textNodes(block);
  let addr = null;
  for (const n of nodes) { addr = parseAddress(n); if (addr) break; }
  const suburb = addr?.suburb ?? info.suburb ?? null;
  const counts = findCounts(nodes);
  const blockKind = kindOf(nodes.filter((n) => n.length < 60).join(" | "));
  return {
    source: info.source,
    id: info.id,
    url: info.url,
    ...(info.redirect && { urlIsRedirect: true }),
    address: addr ? `${addr.street}, ${suburb} SA${addr.postcode ? ` ${addr.postcode}` : ""}` : null,
    street: addr?.street ?? null,
    suburb,
    postcode: addr?.postcode ?? null,
    priceText: findPrice(nodes),
    beds: counts.beds, baths: counts.baths, cars: counts.cars,
    image: findImage(block),
    propertyType: info.propertyType ?? nodes.map((n) => PROPERTY_TYPES[n.toLowerCase()]).find(Boolean) ?? null,
    kind: blockKind ?? subjectKind ?? null,
  };
}

// html -> [listing]. Personal data (recipient, unsubscribe and tracking links) is never read into the result.
export function extractListings(html, { subject } = {}) {
  if (!html) return [];
  const subjectKind = kindFromSubject(subject);
  const body = html;
  const anchors = [...body.matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi)]
    .map((m) => ({ pos: m.index, end: m.index + m[0].length, href: m[1] ?? m[2] }));

  // Pass 1: anchors that resolve to a listing URL. Consecutive anchors with the same id share one card.
  const runs = [];
  for (const a of anchors) {
    const info = resolveListingUrl(a.href);
    if (!info) continue;
    const key = `${info.source}:${info.id}`;
    const last = runs.at(-1);
    if (last && last.key === key) last.end = a.end;
    else runs.push({ key, info, start: a.pos, end: a.end });
  }
  const cards = new Map();
  runs.forEach((r, i) => {
    const stop = runs[i + 1]?.start ?? footerStart(body, r.end);
    const prev = cards.get(r.key);
    const chunk = body.slice(r.start, stop);
    cards.set(r.key, { info: prev?.info ?? r.info, block: (prev?.block ?? "") + chunk });
  });
  const found = [...cards.values()].map((c) => buildListing(c.block, c.info, subjectKind));

  // Pass 2 (only if nothing resolved): opaque tracking links. Split into cards at each address text node.
  if (!found.length) {
    const marks = [];
    for (const m of body.matchAll(/>([^<>]{6,120})</g)) {
      const t = decodeEntities(m[1]).replace(/\s+/g, " ").trim();
      if (parseAddress(t)) marks.push({ pos: m.index, addr: t });
    }
    marks.forEach((mk, i) => {
      const from = i === 0 ? Math.max(0, mk.pos - 1500) : marks[i - 1].pos + 1, to = marks[i + 1]?.pos ?? footerStart(body, mk.pos + mk.addr.length);
      const block = body.slice(from, to);
      const link = anchors.find((a) => a.pos >= from && a.pos < to && /^https?:/i.test(a.href) && TRACKING_HOST_RE.test(a.href) && !NOISE_LINK_RE.test(a.href));
      const address = parseAddress(mk.addr);
      const id = `r${hash(`${address.street}|${address.suburb}`.toLowerCase())}`;
      const listing = buildListing(block, { source: /domain/i.test(link?.href ?? "") ? "domain" : "rea", id, url: link ? decodeEntities(link.href) : null, redirect: !!link }, subjectKind);
      if (listing.priceText || listing.beds != null) found.push(listing);
    });
  }
  return found;
}

// ---------- KV merge ----------

const isoDate = (ts) => ts.slice(0, 10);

// prev = stored record (or null), next = fresh extraction, ts = ISO timestamp. Never overwrites a value with null.
export function mergeListing(prev, next, ts) {
  const out = { ...(prev ?? {}) };
  for (const [k, v] of Object.entries(next)) if (v !== null && v !== undefined && k !== "kind") out[k] = v;
  out.firstSeen = prev?.firstSeen ?? ts;
  out.lastSeen = ts;
  const history = [...(prev?.priceHistory ?? [])];
  if (next.priceText && history.at(-1)?.priceText !== next.priceText) history.push({ date: isoDate(ts), priceText: next.priceText });
  out.priceHistory = history;
  if (next.kind) { out.alertKind = next.kind; out.alertKindAt = ts; }
  if (next.kind === "sold" || prev?.sold) { out.sold = true; out.soldAt = prev?.soldAt ?? ts; }
  return out;
}

// Fields served publicly. Anything else in a stored record is dropped.
export const PUBLIC_FIELDS = ["source", "id", "url", "urlIsRedirect", "address", "street", "suburb", "postcode", "priceText", "beds", "baths", "cars", "image", "propertyType", "alertKind", "alertKindAt", "sold", "soldAt", "firstSeen", "lastSeen", "priceHistory"];
export const publicView = (rec) => Object.fromEntries(PUBLIC_FIELDS.filter((k) => rec[k] !== undefined).map((k) => [k, rec[k]]));
