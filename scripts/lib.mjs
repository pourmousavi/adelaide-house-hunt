// Pure functions for the data pipeline. No I/O here so everything is unit-testable.
import { resolveListingUrl, parseAddress } from "../worker/src/parse.js";

export const TARGET = 2.5; // RBA inflation target midpoint, %
const Z80 = 1.2816; // z-score for a two-sided 80% band
const r2 = (x) => Math.round(x * 100) / 100;

// ---------- CSV / RBA ----------

// RFC4180-ish parser: RBA titles contain quoted commas and newlines.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = ""; rows.push(row); row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n) => String(n).padStart(2, "0");

// Accepts dd/mm/yyyy, dd-Mon-yyyy and Mon-yyyy (-> last day of that month). Returns YYYY-MM-DD or null.
export function parseRbaDate(s) {
  s = String(s ?? "").trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  m = s.match(/^(\d{1,2})-([A-Za-z]{3})[a-z]*-(\d{4})$/);
  if (m && MONTHS.includes(m[2].toLowerCase())) return `${m[3]}-${pad(MONTHS.indexOf(m[2].toLowerCase()) + 1)}-${pad(m[1])}`;
  m = s.match(/^([A-Za-z]{3})[a-z]*-(\d{4})$/);
  if (m && MONTHS.includes(m[1].toLowerCase())) {
    const mo = MONTHS.indexOf(m[1].toLowerCase()) + 1;
    return `${m[2]}-${pad(mo)}-${pad(new Date(Date.UTC(+m[2], mo, 0)).getUTCDate())}`;
  }
  return null;
}

// -> { [seriesId]: [{ date: 'YYYY-MM-DD', value }] } for the requested ids (or all).
export function parseRbaCsv(text, ids) {
  const rows = parseCsv(text);
  const head = rows.findIndex((r) => r[0] === "Series ID");
  if (head < 0) throw new Error("RBA CSV: no 'Series ID' row");
  const titles = (rows.find((r) => r[0] === "Title") ?? []).map((t) => t.replace(/\s+/g, " ").trim());
  const cols = rows[head].map((id, i) => ({ id, i })).filter((c) => c.i > 0 && c.id && (!ids || ids.includes(c.id)));
  const series = Object.fromEntries(cols.map((c) => [c.id, []]));
  for (const row of rows.slice(head + 1)) {
    const date = parseRbaDate(row[0]);
    if (!date) continue;
    for (const c of cols) {
      const v = parseFloat(row[c.i]);
      if (Number.isFinite(v)) series[c.id].push({ date, value: v });
    }
  }
  return { series, titles: Object.fromEntries(cols.map((c) => [c.id, titles[c.i]])) };
}

// Last observation in each calendar month -> [{ date: 'YYYY-MM', value }]
export function toMonthly(points) {
  const byMonth = new Map();
  for (const p of points) byMonth.set(p.date.slice(0, 7), p.value);
  return [...byMonth].map(([date, value]) => ({ date, value }));
}

export const addMonths = (ym, n) => {
  const [y, m] = ym.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
};

// ---------- forecast ----------

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const std = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };

// AR(1) toward `centre` fitted by least squares (no intercept on the deviation).
export function fitAr1(values, centre = TARGET) {
  const d = values.map((v) => v - centre);
  let num = 0, den = 0;
  for (let i = 1; i < d.length; i++) { num += d[i] * d[i - 1]; den += d[i - 1] ** 2; }
  const phi = den ? Math.min(0.99, Math.max(0, num / den)) : 0.8;
  let ss = 0;
  for (let i = 1; i < d.length; i++) ss += (d[i] - phi * d[i - 1]) ** 2;
  return { phi, sigma: Math.sqrt(ss / Math.max(1, d.length - 2)) };
}

// cpi: quarterly year-ended % [{ date: 'YYYY-MM', value }]
export function forecastCpi(cpi, horizon = 8) {
  const hist = cpi.filter((p) => p.date >= "1993-01");
  if (hist.length < 20) throw new Error("not enough CPI history");
  const { phi, sigma } = fitAr1(hist.map((p) => p.value));
  const last = hist.at(-1);
  const forecast = [];
  for (let h = 1; h <= horizon; h++) {
    const value = TARGET + phi ** h * (last.value - TARGET);
    let v = 0;
    for (let k = 0; k < h; k++) v += phi ** (2 * k);
    const sd = sigma * Math.sqrt(v);
    forecast.push({ date: addMonths(last.date, 3 * h), value: r2(value), lo: r2(value - Z80 * sd), hi: r2(value + Z80 * sd) });
  }
  return { forecast, phi, sigma };
}

export const NEUTRAL = 3.5;
export const TAYLOR_PHI = 1.5;
export const roundQuarter = (x) => Math.round(x * 4) / 4;

// Partial-adjustment Taylor rule. quarterlyRates / cpi: [{ date: 'YYYY-MM', value }].
export function forecastCashRate({ quarterlyRates, cpi, cpiForecast, current }) {
  const target = (pi) => NEUTRAL + TAYLOR_PHI * (pi - TARGET);
  const cpiBy = new Map(cpi.map((p) => [p.date, p.value]));
  const rateBy = new Map(quarterlyRates.map((p) => [p.date, p.value]));
  // Fit rho: r_t - T_t = rho * (r_{t-1} - T_t), over quarters since 2000.
  let num = 0, den = 0;
  for (const p of quarterlyRates) {
    const prev = rateBy.get(addMonths(p.date, -3)), pi = cpiBy.get(p.date);
    if (p.date < "2000-01" || prev === undefined || pi === undefined) continue;
    const t = target(pi);
    num += (p.value - t) * (prev - t); den += (prev - t) ** 2;
  }
  const fitted = den ? num / den : NaN;
  const rhoFitted = fitted > 0.5 && fitted < 0.95; // outside this the fit is unstable; use the default
  const rho = rhoFitted ? fitted : 0.8;

  const changes = quarterlyRates.slice(1).filter((p) => p.date >= "2010-01").map((p) => p.value - rateBy.get(addMonths(p.date, -3))).filter(Number.isFinite);
  const sigmaChange = std(changes);

  let r = current;
  const forecast = cpiForecast.map((f, i) => {
    r = rho * r + (1 - rho) * target(f.value);
    const value = Math.max(0, roundQuarter(r));
    const band = Z80 * sigmaChange * Math.sqrt(i + 1);
    return { date: f.date, value, lo: r2(Math.max(0, value - band)), hi: r2(value + band) };
  });
  return { forecast, rho, rhoFitted, sigmaChange };
}

export const FORECAST_METHOD =
  "Our own simple model, not an official forecast. Inflation: year-ended CPI is assumed to drift back toward the RBA's 2.5% target " +
  "(AR(1) mean reversion; persistence fitted by least squares on RBA quarterly data since 1993). The 80% band widens with the horizon " +
  "using the size of past forecast errors. Cash rate: each quarter the rate moves part of the way (fitted adjustment speed, default 0.8) " +
  "toward a Taylor-type target of 3.5% neutral + 1.5 x (forecast inflation - 2.5%). The central path is rounded to 0.25-point steps; " +
  "the 80% band uses the historical spread of quarterly cash rate changes since 2010 growing with the square root of the horizon. " +
  "Use as a rough guide only.";

export const BLENDED_METHOD =
  "Two models, averaged with equal weight. Model 1 is our own simple model: inflation drifts back toward the RBA's 2.5% target (AR(1) mean reversion), " +
  "and the cash rate moves part of the way each quarter toward a Taylor-type target of 3.5% neutral + 1.5 x (forecast inflation - 2.5%). " +
  "Model 2 is TimesFM, Google's open-source pretrained forecasting model, run on the RBA history with no tuning. " +
  "The central path is the average of the two (cash rate rounded to 0.05-point steps). The 80% band is deliberately wide: " +
  "it runs from the lower of the two models' bands to the higher of their upper bands. Not an official forecast; use as a rough guide only.";

// Equal-weight blend of two forecast arrays [{date,value,lo,hi}], matched by date. step = rounding grid (e.g. 0.05), 0 = 2dp.
export function blendForecasts(rule, other, step = 0) {
  const byDate = new Map(other.map((f) => [f.date, f]));
  const rnd = (x) => (step ? Math.round(x / step) * step : x);
  return rule.filter((f) => byDate.has(f.date)).map((f) => {
    const t = byDate.get(f.date);
    const value = r2(rnd((f.value + t.value) / 2));
    return { date: f.date, value, lo: r2(Math.min(f.lo, t.lo, value)), hi: r2(Math.max(f.hi, t.hi, value)) };
  });
}

// Returns a copy of macro with forecasts blended with TimesFM output (if fresh), or reverted to rule-only otherwise.
export function applyBlend(macro, tfm, now = Date.now(), maxAgeDays = 2) {
  const out = { ...macro, cashRate: { ...macro.cashRate }, cpi: { ...macro.cpi } };
  const ruleOf = (k) => macro[k].forecastComponents?.rule ?? macro[k].forecast;
  const fresh = tfm && isFresh(tfm.generatedAt, maxAgeDays, now);
  for (const [k, step] of [["cashRate", 0.05], ["cpi", 0]]) {
    const rule = ruleOf(k);
    const blended = fresh && Array.isArray(tfm[k]) ? blendForecasts(rule, tfm[k], step) : [];
    delete out[k].forecastComponents;
    if (blended.length) { out[k].forecast = blended; out[k].forecastComponents = { rule, timesfm: tfm[k] }; }
    else out[k].forecast = rule;
  }
  out.method = out.cashRate.forecastComponents && out.cpi.forecastComponents ? BLENDED_METHOD : FORECAST_METHOD;
  return out;
}

// ---------- news ----------

const decodeEntities = (s) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export function parseRss(xml) {
  return [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)].map((m) => {
    const tag = (name) => {
      const r = m[1].match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`));
      return r ? decodeEntities(r[1]).replace(/<[^>]+>/g, "").trim() : null;
    };
    const d = new Date(tag("pubDate") ?? tag("dc:date") ?? ""); // RBA feed is RSS 1.0 (dc:date)
    let title = tag("title"), source = tag("source");
    if (title && source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3)); // Google News appends the outlet
    return { title, link: tag("link"), source, date: isNaN(d) ? null : d.toISOString() };
  }).filter((i) => i.title && i.link);
}

export function categorise(title, fallback = "economy") {
  if (/\bRBA\b|Reserve Bank|cash rate|rate (hike|cut|rise)/i.test(title)) return "rba";
  if (/Adelaide|South Australia|\bSA\b/i.test(title)) return "adelaide";
  if (/house price|property|housing|real estate|auction|rent|mortgage|home loan|dwelling/i.test(title)) return "property";
  return fallback;
}

// ---- relevance + importance ----
// General business feeds (ABC) carry plenty of unrelated stories; keep only titles that mention these.
const RELEVANT = /\binflation\b|\bCPI\b|interest rates?|rate hikes?|rate cuts?|\bRBA\b|Reserve Bank|mortgage|housing|property|house prices?|home loans?|\bbudget\b|Treasury|Chalmers|unemployment|recession|\beconomy\b|\beconomic\b|Adelaide|South Australia|\bSA\b|rate (rise|rises|hold)|cash rate|borrowers?/;
export const isRelevantNews = (title) => RELEVANT.test(String(title ?? ""));
const OFF_TOPIC = /South Africa/i; // "South African" house prices are not ours (Google News matches "SA property prices")

const TOPIC_RES = {
  rates: /interest rates?|rate (hikes?|cuts?|rises?|hold)|cash rate|\bRBA\b|Reserve Bank|mortgage|home loans?|borrowers?/i,
  inflation: /\binflation\b|\bCPI\b|cost of living/i,
  housing: /housing|property|house prices?|home prices?|real estate|dwelling|auction|rent/i,
  adelaide: /Adelaide|South Australia|\bSA\b/,
  budget: /\bbudget\b|Treasury|Chalmers|\bMYEFO\b/i,
};
export function newsTopics(title) {
  const t = String(title ?? "");
  return Object.entries(TOPIC_RES).filter(([, re]) => re.test(t)).map(([k]) => k);
}

/** 0-3: inflation/rates/RBA/Treasury terms and Adelaide housing score highest; recency adds up to 0.75. */
export function newsImportance(title, date, now = new Date()) {
  const t = String(title ?? "");
  const topics = newsTopics(t);
  let score = 0;
  if (/\binflation\b|\bCPI\b|\bRBA\b|Reserve Bank|cash rate|rate (hikes?|cuts?|rises?|hold)|interest rates?|Treasury|Chalmers|forecast/i.test(t)) score += 1.5;
  else if (topics.includes("rates") || topics.includes("budget")) score += 1;
  if (topics.includes("adelaide") && topics.includes("housing")) score += 1;
  else if (topics.includes("adelaide") || topics.includes("housing")) score += 0.5;
  const age = date ? (now - new Date(date)) / 864e5 : 60;
  score += age <= 2 ? 0.75 : age <= 7 ? 0.5 : age <= 21 ? 0.25 : 0;
  return Math.min(3, Math.round(score * 4) / 4);
}

// feeds: [{ items, category (fallback), source (fallback), filter (true = keep only relevant titles) }]
// perFeed: Google News is ordered by relevance, so cap each feed's newest items or one feed floods the list.
export function buildNews(feeds, now = new Date(), max = 40, maxAgeDays = 60, perFeed = 10) {
  const seen = new Set(), out = [];
  for (const f of feeds) {
    const items = [...f.items].filter((i) => i.date && !OFF_TOPIC.test(i.title) && (!f.filter || isRelevantNews(i.title))).sort((a, b) => b.date.localeCompare(a.date)).slice(0, perFeed);
    for (const i of items) {
      const key = i.title.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!i.date || seen.has(key) || now - new Date(i.date) > maxAgeDays * 864e5) continue;
      seen.add(key);
      out.push({
        title: i.title, link: i.link, source: i.source ?? f.source, date: i.date, category: categorise(i.title, f.category),
        topics: newsTopics(i.title), importance: newsImportance(i.title, i.date, now),
      });
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date)).slice(0, max);
}

// ---------- geometry ----------

// Ray casting. x = lng, y = lat.
export function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// poly = [outer, ...holes]
export const pointInPolygon = (x, y, poly) => pointInRing(x, y, poly[0]) && !poly.slice(1).some((h) => pointInRing(x, y, h));

export function pointInGeometry(lat, lng, geom) {
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : [];
  return polys.some((p) => pointInPolygon(lng, lat, p));
}

export function bboxOf(geom) {
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  const b = { minLat: 90, maxLat: -90, minLng: 180, maxLng: -180 };
  for (const p of polys) for (const [x, y] of p[0]) {
    b.minLat = Math.min(b.minLat, y); b.maxLat = Math.max(b.maxLat, y);
    b.minLng = Math.min(b.minLng, x); b.maxLng = Math.max(b.maxLng, x);
  }
  return b;
}

// areas.zones names -> [{ name, geometry }] (unknown names dropped)
export function selectZones(areas, geojson) {
  return areas.zones
    .map((name) => ({ name, f: geojson.features.find((f) => f.properties.school === name) }))
    .filter((z) => z.f)
    .map((z) => ({ name: z.name, geometry: z.f.geometry }));
}

// Search bounding box: intersection for "all", union for "any". null if the boxes do not overlap.
export function searchBox(zones, match) {
  const boxes = zones.map((z) => bboxOf(z.geometry));
  if (!boxes.length) return null;
  const all = match !== "any";
  const pick = (k, f) => f(...boxes.map((b) => b[k]));
  const b = {
    minLat: pick("minLat", all ? Math.max : Math.min), maxLat: pick("maxLat", all ? Math.min : Math.max),
    minLng: pick("minLng", all ? Math.max : Math.min), maxLng: pick("maxLng", all ? Math.min : Math.max),
  };
  return b.minLat < b.maxLat && b.minLng < b.maxLng ? b : null;
}

export const zonesContaining = (lat, lng, zones) =>
  zones.filter((z) => pointInGeometry(lat, lng, z.geometry)).map((z) => z.name);

export const zoneMatches = (names, zones, match) => (match === "any" ? names.length > 0 : zones.length > 0 && names.length === zones.length);

// ---------- prices ----------

// "$1.2m", "$1,250,000", "Offers over $X", "$1.1m - $1.2m", "$900k+" ... -> { priceLow, priceHigh }.
// A single figure sets both ends. No figure ("Contact agent", "Auction") -> nulls.
export function parsePriceText(text) {
  const none = { priceLow: null, priceHigh: null };
  if (!text) return none;
  const found = [...String(text).replace(/–|—/g, "-").matchAll(/\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(m(?:illion)?\b|k\b)?/gi)]
    .filter((m) => m[0].includes("$") || m[2])
    .map((m) => ({ n: parseFloat(m[1].replace(/,/g, "")), unit: (m[2] ?? "").toLowerCase()[0] }));
  // "$1.1 - $1.2m": first figure inherits the unit of the next one
  found.forEach((f, i) => { if (!f.unit && f.n < 1000 && found[i + 1]?.unit) f.unit = found[i + 1].unit; });
  const vals = found.map((f) => Math.round(f.n * (f.unit === "m" ? 1e6 : f.unit === "k" ? 1e3 : 1))).filter((v) => v >= 50000);
  if (!vals.length) return none;
  return { priceLow: Math.min(vals[0], vals.at(-1)), priceHigh: Math.max(vals[0], vals.at(-1)) };
}

// ---------- listings ----------

const isoDate = (s) => (s ? String(s).slice(0, 10) : null);
export const daysBetween = (a, b) => Math.round((Date.parse(isoDate(b)) - Date.parse(isoDate(a))) / 864e5);

export const isFresh = (fetchedAt, days, now = Date.now()) => !!fetchedAt && (now - Date.parse(fetchedAt)) / 864e5 < days;

// ---------- email-alert listings ----------

export const SOLD_KEEP_DAYS = 365; // sold homes stay (in the Sold tab, and as comparables for the AI) this long after the sale
export const ALERT_KEEP_DAYS = 60; // alert listings stay active this long after the last alert that mentioned them
export const GEOCODE_RETRY_DAYS = 7; // a failed geocode lookup is retried after this long

export const normAddress = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
export const geoKey = (l) => normAddress(l.address);

// Nominatim copes badly with "3/45 Smith Rd": query by the street number instead.
export const geocodeQuery = (l) => `${String(l.address ?? "").replace(/^((?:unit|apt|apartment|lot|u)\s*)?\d+[a-z]?\s*\/\s*/i, "")}`.trim();

const COARSE = new Set(["suburb", "city", "town", "village", "state", "county", "postcode", "region", "neighbourhood", "quarter", "city_district", "municipality", "country", "district", "hamlet", "locality"]);

// Nominatim json -> { lat, lng } for the first precise (street or building level) result in South Australia, else null.
export function parseNominatim(json) {
  for (const r of Array.isArray(json) ? json : []) {
    const lat = parseFloat(r.lat), lng = parseFloat(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || COARSE.has(r.addresstype) || r.class === "boundary") continue;
    if (lat < -38.2 || lat > -25.9 || lng < 129 || lng > 141.1) continue;
    return { lat, lng };
  }
  return null;
}

const SALE_WORDS = /auction/i;

// Worker /listings.json item -> contract listing (no coordinates yet). null if unusable.
export function mapAlertItem(it, today) {
  if (!it || !it.id || !it.source) return null;
  const origin = it.source === "rea" ? "rea" : "domain"; // which portal sent the alert
  const { priceLow, priceHigh } = parsePriceText(it.priceText);
  const firstSeen = isoDate(it.firstSeen) ?? today, lastSeen = isoDate(it.lastSeen) ?? today;
  const priceHistory = (it.priceHistory?.length ? it.priceHistory : [{ date: firstSeen, priceText: it.priceText ?? null }])
    .map((h) => ({ date: isoDate(h.date) ?? firstSeen, priceText: h.priceText ?? null, ...parsePriceText(h.priceText) }));
  const sold = !!it.sold;
  return {
    id: origin === "rea" ? `rea-${it.id}` : String(it.id),
    url: it.url ?? null,
    ...(it.urlIsRedirect && { urlIsRedirect: true }),
    headline: null,
    address: it.address ?? null,
    suburb: it.suburb ?? null, postcode: it.postcode ?? null,
    lat: null, lng: null,
    propertyType: it.propertyType ?? null,
    bedrooms: it.beds ?? null, bathrooms: it.baths ?? null, carspaces: it.cars ?? null,
    landArea: it.land > 0 ? it.land : null, buildingArea: null,
    priceText: it.priceText ?? null, priceLow, priceHigh,
    saleMethod: SALE_WORDS.test(it.priceText ?? "") ? "auction" : /expression|eoi/i.test(it.priceText ?? "") ? "eoi" : priceLow ? "privateTreaty" : null,
    auctionDate: null,
    photos: it.image ? [it.image] : [],
    description: "",
    features: [],
    dateListed: null,
    daysOnMarket: Math.max(0, daysBetween(firstSeen, today)),
    firstSeen,
    priceHistory,
    salesHistory: [], inspections: [], agents: [],
    zones: [],
    status: sold ? "removed" : "active",
    ...(sold && { removedDate: isoDate(it.soldAt) ?? lastSeen, sold: true, soldPriceText: it.soldPriceText ?? null, soldPrice: parsePriceText(it.soldPriceText).priceHigh }),
    alertKind: it.alertKind ?? null,
    lastSeen,
    origin, via: "alerts",
    ai: null,
  };
}

// data/manual.json entry (added from the app: listing link + address) -> worker-shaped item for mapAlertItem, or null.
// Hand-added: lastSeen is today, so it stays until removed from manual.json or an alert says it sold.
// Bookmarklet imports (via "bookmarklet"): lastSeen is the last import, so they expire like alert listings.
export function manualToAlertItem(m, today) {
  const u = resolveListingUrl(m?.url);
  const address = String(m?.address ?? "").trim();
  if (!u || !address) return null;
  if (m.sold) { if (m.soldDate && daysBetween(m.soldDate, today) > SOLD_KEEP_DAYS) return null; } // sold over a year ago
  else if (m.via === "bookmarklet" && daysBetween(m.seenAt ?? m.addedAt ?? today, today) > ALERT_KEEP_DAYS) return null; // not re-imported for 60 days
  const a = parseAddress(address.replace(/\s+SA\s+(\d{4})$/i, ", SA $1"));
  const n = (x) => (x === "" || x == null || !Number.isFinite(+x) ? null : +x);
  return {
    source: u.source, id: u.id, url: u.url, address,
    suburb: a?.suburb ?? u.suburb ?? null, postcode: a?.postcode ?? address.match(/\b(5\d{3})\b/)?.[1] ?? null,
    propertyType: u.propertyType, priceText: m.priceText?.trim() || null,
    beds: n(m.beds), baths: n(m.baths), cars: n(m.cars), land: n(m.land),
    image: m.image && !isAgentPhoto(m.image) ? m.image : null,
    firstSeen: m.addedAt ?? today, lastSeen: m.via === "bookmarklet" ? (m.seenAt ?? m.addedAt ?? today) : today, alertKind: null,
    ...(m.sold && { sold: true, soldAt: m.soldDate ?? m.seenAt ?? today, soldPriceText: m.soldPriceText ?? null }),
  };
}

// Agent headshots that the first bookmarklet version picked up instead of the house photo.
// Square thumbnails are headshots; house photos are 4:3 or 3:2.
export const isAgentPhoto = (u) => /contact_\d+|gravity=north|\/(\d{2,3})x\1[/-]/i.test(String(u ?? ""));

// "528 Portrush Road, St Georges SA 5064" and "528 Portrush Rd, St Georges" -> "528 portrush rd st georges"
const STREET_ABBR = { street: "st", road: "rd", avenue: "ave", av: "ave", terrace: "tce", drive: "dr", place: "pl", court: "ct", crescent: "cres", parade: "pde", lane: "ln", highway: "hwy", grove: "gr", close: "cl", boulevard: "bvd", circuit: "cct", square: "sq" };
const daysAgo = (d, n) => new Date(Date.parse(isoDate(d)) - n * 864e5).toISOString().slice(0, 10);
export const addressKey = (a) => String(a ?? "").toLowerCase()
  .replace(/,?\s*(sa|south australia)?\s*\d{4}\s*$/, "").replace(/[^a-z0-9/ ]+/g, " ")
  .split(/\s+/).filter(Boolean).map((w) => STREET_ABBR[w] ?? w).join(" ");

// The same home listed on both portals (different ids): keep one card. realestate.com.au's copy is kept
// (so its id, shortlist and AI stay stable) and gaps are filled from the other; the other's link goes in `alsoAt`.
// Returns { listings, dropped } where dropped are the ids folded into another listing.
export function dedupeByAddress(listings) {
  const byKey = new Map(), dropped = new Set(), out = [];
  const rank = (l) => (l.sold ? 2 : 0) + (l.origin === "rea" ? 0 : 1); // a current listing is kept over a sold copy, realestate.com.au over Domain
  for (const l of listings.map((x) => ({ ...x })).sort((a, b) => rank(a) - rank(b))) { // copies: inputs are not changed
    const k = addressKey(l.address);
    const keep = k && /^\S*\d/.test(k) ? byKey.get(k) : null; // only street-numbered addresses are matched
    if (!keep) { if (k) byKey.set(k, l); out.push(l); continue; }
    for (const f of ["priceText", "priceLow", "priceHigh", "saleMethod", "propertyType", "bedrooms", "bathrooms", "carspaces", "landArea", "lat", "lng", "postcode"]) keep[f] ??= l[f];
    if (!keep.photos?.length && l.photos?.length) keep.photos = l.photos;
    if (l.sold && !keep.sold && (!keep.firstSeen || (l.removedDate ?? "") >= daysAgo(keep.firstSeen, 30)))
      Object.assign(keep, { sold: true, status: "removed", removedDate: l.removedDate, soldPriceText: l.soldPriceText ?? null, soldPrice: l.soldPrice ?? null });
    else if (l.sold && keep.sold) { keep.soldPriceText ??= l.soldPriceText; keep.soldPrice ??= l.soldPrice; }
    if (l.firstSeen && (!keep.firstSeen || l.firstSeen < keep.firstSeen)) keep.firstSeen = l.firstSeen;
    keep.ai ??= l.ai;
    keep.alsoAt = [...(keep.alsoAt ?? []).filter((x) => x.url !== l.url), { origin: l.origin, url: l.url }];
    dropped.add(l.id);
  }
  return { listings: out, dropped };
}

export const inExtraSuburbs = (l, areas) =>
  (areas.extraSuburbs ?? []).some((s) => String(s.suburb).toLowerCase() === String(l.suburb ?? "").toLowerCase() && (!s.postcode || !l.postcode || s.postcode === l.postcode));

// prev: previous alert listings; fresh: this run's mapped, located and in-zone listings; outside: ids seen this run but outside the zones.
// An absent listing is not removed: it stays until ALERT_KEEP_DAYS after lastSeen, then is dropped.
export function mergeAlertListings(prev, fresh, today, outside = new Set(), keepDays = ALERT_KEEP_DAYS) {
  const old = new Map(prev.map((l) => [l.id, l]));
  const seen = new Set();
  const out = [];
  for (const f of fresh) {
    seen.add(f.id);
    const p = old.get(f.id);
    const l = { ...p, ...f, ai: p?.ai ?? null };
    if (!f.sold) { delete l.removedDate; delete l.sold; if (p?.sold) { l.status = "removed"; l.sold = true; l.removedDate = p.removedDate; l.soldPriceText = p.soldPriceText ?? null; l.soldPrice = p.soldPrice ?? null; } }
    out.push(l);
  }
  for (const p of prev) {
    if (seen.has(p.id) || outside.has(p.id)) continue;
    if (p.sold ? daysBetween(p.removedDate ?? p.lastSeen ?? today, today) > SOLD_KEEP_DAYS : daysBetween(p.lastSeen ?? p.firstSeen ?? today, today) > keepDays) continue;
    out.push({ ...p, daysOnMarket: Math.max(0, daysBetween(p.firstSeen ?? today, today)) });
  }
  return out;
}

// Sold homes in the same suburb in the last year, newest first: comparables for the AI.
export function recentSales(listing, all, today, max = 6) {
  return all.filter((s) => s.sold && s.id !== listing.id && s.suburb === listing.suburb && s.soldPrice && daysBetween(s.removedDate ?? today, today) <= SOLD_KEEP_DAYS)
    .sort((a, b) => String(b.removedDate).localeCompare(String(a.removedDate))).slice(0, max)
    .map((s) => ({ address: s.address, type: s.propertyType, beds: s.bedrooms, baths: s.bathrooms, soldPrice: s.soldPrice, soldDate: s.removedDate }));
}

// ---------- AI ----------

export const VERDICTS = ["Worth inspecting", "Fair", "Overpriced", "Strong value"];

// Bump to re-run every analysis on the next fetches (2: inputs now include the suburb trend for postcode-less listings).
export const AI_INPUT_VERSION = 2;
// Listings that need (re)analysis: new, asking price text changed, or analysed with older inputs.
export const needsAi = (l) => l.status !== "removed" && (!l.ai || l.ai.priceText !== l.priceText || (l.ai.inputVersion ?? 1) < AI_INPUT_VERSION);

export function parseJsonLoose(text) {
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(t);
}

const num = (x) => (Number.isFinite(+x) && x !== null && x !== "" ? Math.round(+x) : null);
const strs = (a) => (Array.isArray(a) ? a.map(String).slice(0, 5) : []);

// Validate one model result into the contract `ai` object, or null.
export function cleanAi(r, { model, priceText, now }) {
  if (!r || typeof r.summary !== "string" || !VERDICTS.includes(r.verdict)) return null;
  return {
    summary: r.summary, pros: strs(r.pros), cons: strs(r.cons),
    fairValueLow: num(r.fairValueLow), fairValueHigh: num(r.fairValueHigh),
    verdict: r.verdict, model, generatedAt: now,
    priceText, // which asking price this analysis was for (additive field, used to detect changes)
    inputVersion: AI_INPUT_VERSION,
  };
}

// Deterministic grid scan: up to n points spread across the zone intersection (used by tests).
export function samplePoints(zones, n) {
  const box = searchBox(zones, "all") ?? bboxOf(zones[0].geometry);
  const pts = [];
  const N = 60;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const lat = box.minLat + ((i + 0.5) / N) * (box.maxLat - box.minLat);
    const lng = box.minLng + ((j + 0.5) / N) * (box.maxLng - box.minLng);
    if (zones.every((z) => pointInGeometry(lat, lng, z.geometry))) pts.push([lat, lng]);
  }
  const step = Math.max(1, Math.floor(pts.length / n));
  return pts.filter((_, i) => i % step === Math.floor(step / 2)).slice(0, n);
}

export const DEFAULT_AREAS = {
  zones: ["Linden Park Primary School", "Glenunga International High School"],
  zoneMatch: "all",
  extraSuburbs: [],
  propertyTypes: ["House", "Townhouse", "Villa", "Unit", "ApartmentUnitFlat", "Duplex", "SemiDetached", "Terrace"],
};
