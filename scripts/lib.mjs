// Pure functions for the data pipeline. No I/O here so everything is unit-testable.

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

// feeds: [{ items, category (fallback), source (fallback) }]
// perFeed: Google News is ordered by relevance, so cap each feed's newest items or one feed floods the list.
export function buildNews(feeds, now = new Date(), max = 30, maxAgeDays = 60, perFeed = 7) {
  const seen = new Set(), out = [];
  for (const f of feeds) {
    const items = [...f.items].filter((i) => i.date).sort((a, b) => b.date.localeCompare(a.date)).slice(0, perFeed);
    for (const i of items) {
      const key = i.title.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!i.date || seen.has(key) || now - new Date(i.date) > maxAgeDays * 864e5) continue;
      seen.add(key);
      out.push({ title: i.title, link: i.link, source: i.source ?? f.source, date: i.date, category: categorise(i.title, f.category) });
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

const titleCase = (s) => String(s ?? "").toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
const stripHtml = (s) => decodeEntities(String(s ?? "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const isoDate = (s) => (s ? String(s).slice(0, 10) : null);
export const daysBetween = (a, b) => Math.round((Date.parse(isoDate(b)) - Date.parse(isoDate(a))) / 864e5);
const adl = (t) => (t && !/(Z|[+-]\d\d:?\d\d)$/.test(t) ? `${t}+10:30` : t ?? null); // Domain omits the offset on some times

// Domain search result item -> contract listing (details fetched later fill the rest). null if unusable.
export function normalizeSearchItem(item) {
  const l = item?.listing;
  if (item?.type !== "PropertyListing" || !l?.id) return null;
  const p = l.propertyDetails ?? {}, pd = l.priceDetails ?? {};
  const priceText = pd.displayPrice?.trim() || null;
  const parsed = pd.priceFrom || pd.priceTo || pd.price
    ? { priceLow: pd.priceFrom ?? pd.price ?? pd.priceTo, priceHigh: pd.priceTo ?? pd.price ?? pd.priceFrom }
    : parsePriceText(priceText);
  const hasLatLng = Number.isFinite(p.latitude) && Number.isFinite(p.longitude);
  const labels = (l.labels ?? []).join(" ");
  return {
    id: String(l.id),
    url: l.listingSlug ? `https://www.domain.com.au/${l.listingSlug}` : null,
    headline: l.headline ?? null,
    address: `${p.displayableAddress ?? ""} ${p.state ?? ""} ${p.postcode ?? ""}`.replace(/\s+/g, " ").trim(),
    suburb: titleCase(p.suburb), postcode: p.postcode ?? null,
    lat: hasLatLng ? p.latitude : null, lng: hasLatLng ? p.longitude : null,
    propertyType: p.propertyType ?? null,
    bedrooms: p.bedrooms ?? null, bathrooms: p.bathrooms ?? null, carspaces: p.carspaces ?? null,
    landArea: p.landArea ?? null, buildingArea: p.buildingArea ?? null,
    priceText, priceLow: parsed.priceLow ?? null, priceHigh: parsed.priceHigh ?? null,
    saleMethod: l.auctionSchedule?.time ? "auction" : /expression|eoi/i.test(priceText ?? "") ? "eoi" : priceText && parsed.priceLow ? "privateTreaty" : null,
    auctionDate: adl(l.auctionSchedule?.time),
    photos: (l.media ?? []).filter((m) => /image/i.test(m.category ?? "image")).map((m) => m.url).slice(0, 12),
    description: stripHtml(l.summaryDescription).slice(0, 600),
    features: p.features ?? [],
    ...(l.dateListed && { dateListed: isoDate(l.dateListed) }),
    inspections: (l.inspectionSchedule?.times ?? []).map((t) => ({ start: adl(t.openingTime), end: adl(t.closingTime) })),
    agents: (l.advertiser?.contacts ?? []).map((c) => ({ name: c.name ?? null, phone: null, email: null, agency: l.advertiser?.name ?? null, photo: c.photoUrl ?? null })),
    status: /under\s*offer/i.test(labels) ? "underOffer" : "active",
  };
}

// Overlay GET /v1/listings/{id} onto a normalized listing. Only fields the detail endpoint documents are used.
export function applyDetail(listing, d) {
  const out = { ...listing };
  if (d.description) out.description = stripHtml(d.description).slice(0, 600);
  if (d.dateListed) out.dateListed = isoDate(d.dateListed);
  if (d.seoUrl) out.url = d.seoUrl;
  if (d.features?.length) out.features = d.features;
  const insp = d.inspectionDetails?.inspections;
  if (insp?.length) out.inspections = insp.map((t) => ({ start: adl(t.openingTime), end: adl(t.closingTime) }));
  const media = (d.media ?? []).filter((m) => /image|photo/i.test(`${m.category} ${m.type}`)).map((m) => m.url);
  if (media.length) out.photos = media.slice(0, 12);
  // Contact phone/email are not part of the documented listing payload; take them only if present.
  const contacts = d.contacts ?? d.advertiserContacts ?? [];
  if (contacts.length) {
    out.agents = contacts.map((c, i) => ({
      ...(out.agents[i] ?? { agency: null, photo: null }),
      name: c.name ?? out.agents[i]?.name ?? null,
      phone: c.phone ?? c.mobile ?? null, email: c.email ?? null,
    }));
  }
  return out;
}

// GET /v1/agents/{id} -> cache entry (fetchedAt added by caller)
export function parseAgent(a) {
  const name = a.name ?? [a.firstName, a.lastName].filter(Boolean).join(" ");
  return {
    name: name || null, phone: a.mobile ?? a.phone ?? null, email: a.email ?? null,
    agency: a.agencyName ?? a.agency?.name ?? null, photo: a.photo ?? a.photoUrl ?? null,
  };
}

// Listing agents from the cache; contact ids not in the cache keep the search-result agent at the same index.
export function agentsFromCache(contactIds, cache, fallback = []) {
  return contactIds.map((id, i) => {
    const { fetchedAt, ...a } = cache[id] ?? {};
    return fetchedAt ? a : fallback[i];
  }).filter(Boolean);
}

export const isFresh = (fetchedAt, days, now = Date.now()) => !!fetchedAt && (now - Date.parse(fetchedAt)) / 864e5 < days;

// prev: previous listings.json listings; fresh: this run's normalized listings; today: 'YYYY-MM-DD'.
export function mergeListings(prev, fresh, today, keepRemovedDays = 30) {
  const old = new Map(prev.map((l) => [l.id, l]));
  const seen = new Set();
  const out = [];
  for (const f of fresh) {
    seen.add(f.id);
    const p = old.get(f.id);
    const l = { ...p, ...f };
    delete l.removedDate;
    l.firstSeen = p?.firstSeen ?? today;
    l.priceHistory = [...(p?.priceHistory ?? [])];
    if (l.priceHistory.at(-1)?.priceText !== f.priceText) {
      l.priceHistory.push({ date: today, priceText: f.priceText, priceLow: f.priceLow, priceHigh: f.priceHigh });
    }
    l.salesHistory = f.salesHistory ?? p?.salesHistory ?? [];
    l.ai = p?.ai ?? null;
    l.dateListed ??= null;
    l.daysOnMarket = Math.max(0, daysBetween(l.dateListed ?? l.firstSeen, today));
    out.push(l);
  }
  for (const p of prev) {
    if (seen.has(p.id)) continue;
    if (p.status !== "removed") out.push({ ...p, status: "removed", removedDate: today });
    else if (daysBetween(p.removedDate ?? today, today) <= keepRemovedDays) out.push(p);
  }
  return out;
}

// ---------- suburb stats ----------

// Domain suburbPerformanceStatistics v2 response -> [{ year, median, sales }]
export function parseSuburbStats(json) {
  return (json?.series?.seriesInfo ?? [])
    .map((s) => ({ year: s.year, median: s.values?.medianSoldPrice ?? null, sales: s.values?.numberSold ?? null }))
    .filter((s) => Number.isFinite(s.year));
}

// ---------- AI ----------

export const VERDICTS = ["Worth inspecting", "Fair", "Overpriced", "Strong value"];

// Listings that need (re)analysis: new, or asking price text changed since the last analysis.
export const needsAi = (l) => l.status !== "removed" && (!l.ai || l.ai.priceText !== l.priceText);

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
  };
}

// ---------- sample data ----------

export const SEED_SUBURBS = [
  { suburb: "Linden Park", postcode: "5065" }, { suburb: "Glenunga", postcode: "5064" },
  { suburb: "Tusmore", postcode: "5065" }, { suburb: "Toorak Gardens", postcode: "5065" },
  { suburb: "St Georges", postcode: "5065" }, { suburb: "Beaumont", postcode: "5066" },
];

// Deterministic grid scan: up to n points spread across the zone intersection.
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

export function sampleListings(zones, today, nowIso) {
  const pts = samplePoints(zones, 8);
  const addDays = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
  const specs = [
    ["$1.45m - $1.55m", "privateTreaty", "House", 4, 2, 2, 720, "Fair"],
    ["Contact agent", null, "House", 3, 1, 1, 610, "Worth inspecting"],
    ["Auction", "auction", "House", 5, 3, 2, 850, "Overpriced"],
    ["Offers over $1.2m", "privateTreaty", "Townhouse", 3, 2, 2, 320, "Strong value"],
    ["$1.8m", "privateTreaty", "House", 4, 2, 3, 790, "Fair"],
    ["$950,000 - $1,050,000", "privateTreaty", "Villa", 3, 1, 1, 540, "Worth inspecting"],
    ["Expressions of interest", "eoi", "House", 4, 3, 2, 690, "Overpriced"],
    ["$780k", "privateTreaty", "Unit", 2, 1, 1, null, "Strong value"],
  ];
  return pts.map(([lat, lng], i) => {
    const [priceText, saleMethod, propertyType, bedrooms, bathrooms, carspaces, landArea, verdict] = specs[i];
    const { suburb, postcode } = SEED_SUBURBS[i % SEED_SUBURBS.length];
    const { priceLow, priceHigh } = parsePriceText(priceText);
    const listed = addDays(today, -(3 + i * 4));
    const agent = { name: "Sample Agent", phone: "0400 000 000", email: "sample.agent@example.com", agency: "Sample Realty", photo: null };
    return {
      id: `SAMPLE-${i + 1}`, url: null,
      headline: `SAMPLE – ${bedrooms} bedroom ${propertyType.toLowerCase()} near the schools`,
      address: `${i + 1} Sample Street, ${suburb} SA ${postcode}`, suburb, postcode, lat, lng,
      propertyType, bedrooms, bathrooms, carspaces, landArea, buildingArea: null,
      priceText, priceLow, priceHigh, saleMethod,
      auctionDate: saleMethod === "auction" ? `${addDays(today, 14)}T11:00:00+10:30` : null,
      photos: [`https://picsum.photos/seed/sample${i + 1}/800/600`, `https://picsum.photos/seed/sample${i + 1}b/800/600`],
      description: "SAMPLE listing for UI development. This is not a real property.",
      features: ["Sample feature", i % 2 ? "Ducted air" : "Pool"],
      dateListed: listed, daysOnMarket: 3 + i * 4, firstSeen: listed,
      priceHistory: [{ date: listed, priceText, priceLow, priceHigh }],
      salesHistory: [{ date: "2015-03-12", price: 820000 }],
      inspections: [{ start: `${addDays(today, 5)}T10:00:00+10:30`, end: `${addDays(today, 5)}T10:30:00+10:30` }],
      agents: [agent],
      zones: zones.map((z) => z.name),
      status: i === 3 ? "underOffer" : "active",
      ai: {
        summary: "SAMPLE analysis. Real summaries appear once the Domain and AI keys are configured.",
        pros: ["Sample pro"], cons: ["Sample con"],
        fairValueLow: priceLow ? Math.round(priceLow * 0.95) : 1000000, fairValueHigh: priceHigh ? Math.round(priceHigh * 1.02) : 1150000,
        verdict, model: "sample", generatedAt: nowIso, priceText,
      },
    };
  });
}

// Plausible but invented 10-year trends so the UI can draw charts.
export function sampleSuburbs(today) {
  const lastYear = +today.slice(0, 4) - 1;
  const bases = { "Linden Park": 1.0e6, Glenunga: 1.15e6, Tusmore: 1.1e6, "Toorak Gardens": 1.3e6, "St Georges": 1.2e6, Beaumont: 1.25e6 };
  const out = { _sample: true };
  SEED_SUBURBS.forEach(({ suburb, postcode }, k) => {
    const series = (base, sales) => Array.from({ length: 10 }, (_, i) => ({
      year: lastYear - 9 + i,
      median: Math.round((base * 1.065 ** i * (1 + 0.03 * Math.sin(i + k))) / 5000) * 5000,
      sales: Math.round(sales * (1 + 0.2 * Math.cos(i * 1.3 + k))),
    }));
    out[`${suburb}|${postcode}`] = { house: series(bases[suburb], 60), unit: series(bases[suburb] * 0.55, 25) };
  });
  return out;
}

export const DEFAULT_AREAS = {
  zones: ["Linden Park Primary School", "Glenunga International High School"],
  zoneMatch: "all",
  extraSuburbs: [],
  propertyTypes: ["House", "Townhouse", "Villa", "Unit", "ApartmentUnitFlat", "Duplex", "SemiDetached", "Terrace"],
};
