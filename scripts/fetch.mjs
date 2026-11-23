#!/usr/bin/env node
// Data pipeline: RBA macro + forecast, news, email-alert listings (+ optional Domain API), AI analysis (Gemini free tier) -> data/*.json
// Node 20+, no dependencies. Each step is independent; a failing step keeps its previous JSON.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as L from "./lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// ---- config ----
const RBA = "https://www.rba.gov.au/statistics/tables/csv";
const FEEDS = [
  { url: "https://www.abc.net.au/news/feed/51892/rss.xml", category: "economy", source: "ABC News" },
  { url: "https://www.rba.gov.au/rss/rss-cb-media-releases.xml", category: "rba", source: "RBA" },
  ...["Adelaide property market", "Adelaide house prices", "RBA interest rates", "Australia inflation"].map((q) => ({
    url: `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-AU&gl=AU&ceid=AU:en`,
    category: q.startsWith("Adelaide") ? "property" : "economy", source: "Google News",
  })),
];
// Domain: one token per scope so a plan lacking one scope does not break the others (confirmed from the docs:
// search + GET listing = api_listings_read, properties = api_properties_read, suburb stats = api_suburbperformance_read).
const SCOPES = { listings: "api_listings_read", properties: "api_properties_read", agents: "api_agencies_read", suburbs: "api_suburbperformance_read" };
const DOMAIN_TOKEN_URL = "https://auth.domain.com.au/v1/connect/token";
const DOMAIN_API = "https://api.domain.com.au";
const DOMAIN_CALL_BUDGET = 150; // free tier is 500/day and we run ~2x/day plus manual runs
const SUBURB_CACHE_DAYS = 7, AGENT_CACHE_DAYS = 30;
const PROPERTY_LOOKUPS_PER_RUN = 15;
// Any OpenAI-compatible chat endpoint. Default: Google Gemini free tier (GitHub Models was retired 30 Jul 2026).
const AI_URL = process.env.AI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const MODEL = process.env.AI_MODEL || "gemini-flash-latest";
const AI_BATCH = 5, AI_MAX_REQUESTS = 8;
// Listings come from saved-search email alerts parsed by the house-alerts Cloudflare Email Worker (public data, not a secret).
const ALERTS_URL = (process.env.ALERTS_URL || "https://house-alerts.alipourmousavi.workers.dev").replace(/\/+$/, "");
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const GEOCODE_UA = "adelaide-house-hunt/1.0 (github.com/pourmousavi/adelaide-house-hunt)";
const GEOCODE_PER_RUN = 60, GEOCODE_GAP_MS = 1100; // Nominatim policy: at most 1 request per second

// ---- io helpers ----
const nowIso = new Date().toISOString();
const today = new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Adelaide" });
const file = (n) => join(DATA, n);
const readJson = (n, fallback = null) => { try { return JSON.parse(readFileSync(file(n), "utf8")); } catch { return fallback; } };
const strip = (o) => JSON.stringify(o, (k, v) => (k === "generatedAt" ? undefined : v));
function writeJson(name, obj) {
  const prev = readJson(name);
  if (prev && strip(prev) === strip(obj)) return console.log(`  ${name}: unchanged`);
  writeFileSync(file(name), JSON.stringify(obj, null, 2) + "\n");
  console.log(`  ${name}: written`);
}

async function http(url, opts = {}, retries = 1) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { ...opts, headers: { "User-Agent": UA, ...opts.headers }, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} ${url.split("?")[0]}`), { status: r.status });
      return r;
    } catch (e) {
      if (i >= retries || (e.status && e.status < 500)) throw e;
    }
  }
}

// ---- a. + b. macro and forecast ----
async function macroStep() {
  const [f1, g1, f6] = await Promise.all(["f1-data", "g1-data", "f6-data"].map(async (t) => (await http(`${RBA}/${t}.csv`)).text()));
  const cash = L.parseRbaCsv(f1, ["FIRMMCRTD"]).series.FIRMMCRTD; // daily target; f1-data (not f1.1) carries this series
  const cpi = L.toMonthly(L.parseRbaCsv(g1, ["GCPIAGYP"]).series.GCPIAGYP);
  const mort = L.parseRbaCsv(f6, ["FLRHOFVA"]).series.FLRHOFVA; // owner-occupier, variable, new loans, all institutions
  if (!cash.length || !cpi.length || !mort.length) throw new Error("RBA series empty");

  const since = (a) => a.filter((p) => p.date >= "2015-01");
  const cashMonthly = L.toMonthly(cash);
  const prev = readJson("macro.json");
  let cashFc = prev?.cashRate?.forecastComponents?.rule ?? prev?.cashRate?.forecast ?? [], cpiFc = prev?.cpi?.forecastComponents?.rule ?? prev?.cpi?.forecast ?? [], method = prev?.method ?? L.FORECAST_METHOD;
  try {
    const c = L.forecastCpi(cpi);
    const quarterly = cashMonthly.filter((p) => ["03", "06", "09", "12"].includes(p.date.slice(5)));
    const r = L.forecastCashRate({ quarterlyRates: quarterly, cpi, cpiForecast: c.forecast, current: cash.at(-1).value });
    cpiFc = c.forecast; cashFc = r.forecast; method = L.FORECAST_METHOD;
    console.log(`  forecast: cpi phi=${c.phi.toFixed(2)}, cash rho=${r.rho.toFixed(2)}${r.rhoFitted ? "" : " (default)"}, sigma/qtr=${r.sigmaChange.toFixed(2)}`);
  } catch (e) { warn(`forecast failed, keeping previous: ${e.message}`); }

  const last = (a) => a.at(-1);
  const mm = L.toMonthly(mort);
  const data = {
    generatedAt: nowIso,
    cashRate: { current: last(cash).value, asOf: last(cash).date, history: since(cashMonthly), forecast: cashFc },
    cpi: { current: last(cpi).value, asOf: last(cpi).date, history: since(cpi), forecast: cpiFc },
    mortgageRate: { current: last(mm).value, asOf: last(mm).date, history: since(mm), label: "Owner-occupier variable, new loans, all institutions (RBA F6)" },
    method,
    sources: [
      { name: "RBA F1 (cash rate target, daily)", url: `${RBA}/f1-data.csv` },
      { name: "RBA G1 (CPI year-ended)", url: `${RBA}/g1-data.csv` },
      { name: "RBA F6 (housing lending rates)", url: `${RBA}/f6-data.csv` },
    ],
  };
  const blended = L.applyBlend(data, readJson("forecast_timesfm.json"));
  writeJson("macro.json", blended);
  return blended;
}

// Re-blend macro.json with data/forecast_timesfm.json without refetching (used by the workflow after the TimesFM step).
function blendOnly() {
  const macro = readJson("macro.json");
  if (!macro) throw new Error("no macro.json to blend");
  const out = L.applyBlend(macro, readJson("forecast_timesfm.json"));
  writeJson("macro.json", out);
  console.log(out.cashRate.forecastComponents ? "  blended rule model with TimesFM" : "  no fresh TimesFM file; rule-only forecast");
}

// ---- c. news ----
async function newsStep() {
  // staggered: Google News returns 429 when hit in parallel
  const results = await Promise.allSettled(FEEDS.map(async (f, i) => {
    await new Promise((r) => setTimeout(r, i * 1500));
    return { ...f, items: L.parseRss(await (await http(f.url)).text()) };
  }));
  const feeds = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  results.forEach((r, i) => r.status === "rejected" && warn(`feed ${FEEDS[i].url}: ${r.reason.message}`));
  const items = L.buildNews(feeds);
  if (!items.length) throw new Error("no news items");
  writeJson("news.json", { generatedAt: nowIso, items });
}

// ---- d0. email alerts ----
async function geocodeAll(items) {
  const cache = readJson("geocode.json", {});
  let budget = GEOCODE_PER_RUN, blocked = false, lastCall = 0, called = 0;
  for (const l of items) {
    const key = L.geoKey(l);
    if (!key) continue;
    const c = cache[key];
    if (c?.lat != null) { l.lat = c.lat; l.lng = c.lng; continue; } // cached addresses are never looked up again
    if (c?.miss && L.isFresh(c.miss, L.GEOCODE_RETRY_DAYS)) continue;
    if (blocked || budget <= 0) continue;
    budget--;
    const wait = lastCall + GEOCODE_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    try {
      const url = `${NOMINATIM}?format=json&countrycodes=au&limit=3&addressdetails=0&q=${encodeURIComponent(L.geocodeQuery(l))}`;
      const hit = L.parseNominatim(await (await http(url, { headers: { "User-Agent": GEOCODE_UA } }, 0)).json());
      called++;
      if (hit) { cache[key] = hit; l.lat = hit.lat; l.lng = hit.lng; } else cache[key] = { miss: nowIso };
    } catch (e) { warn(`geocode "${key}": ${e.message}`); if (e.status === 429 || e.status === 403) blocked = true; } // errors are not cached
  }
  const sorted = Object.fromEntries(Object.entries(cache).sort(([a], [b]) => a.localeCompare(b)));
  if (called) writeJson("geocode.json", sorted);
  return called;
}

// Returns the merged alert listings (inside the selected zones or extraSuburbs). Writes only geocode.json.
async function alertsStep(areas, geojson) {
  const prevFile = readJson("listings.json");
  const prev = (prevFile?.listings ?? []).filter((l) => l.via === "alerts");
  const zones = L.selectZones(areas, geojson);
  let raw;
  try { raw = await (await http(`${ALERTS_URL}/listings.json`)).json(); }
  catch (e) { warn(`alerts fetch failed, keeping ${prev.length} previous alert listings: ${e.message}`); return prev; }
  if (!Array.isArray(raw)) throw new Error("alerts /listings.json is not an array");

  const items = raw.map((r) => L.mapAlertItem(r, today)).filter(Boolean)
    .filter((l) => !l.propertyType || !areas.propertyTypes || areas.propertyTypes.includes(l.propertyType));
  const called = await geocodeAll(items.filter((l) => l.address));
  const fresh = [], outside = new Set();
  let unlocated = 0;
  for (const l of items) {
    if (l.lat === null) {
      if (L.inExtraSuburbs(l, areas)) { fresh.push(l); continue; } // in a chosen suburb but no map point: keep, shown without a pin
      unlocated++; continue;
    }
    l.zones = L.zonesContaining(l.lat, l.lng, zones);
    if (L.zoneMatches(l.zones, zones, areas.zoneMatch) || L.inExtraSuburbs(l, areas)) fresh.push(l); else outside.add(l.id);
  }
  const merged = L.mergeAlertListings(prev, fresh, today, outside);
  console.log(`  alerts: ${raw.length} in worker, ${fresh.length} inside zones, ${outside.size} outside, ${unlocated} not located, ${called} geocoded, ${merged.length} kept`);
  return merged;
}

// ---- d. listings ----
function makeDomain(id, secret) {
  const tokens = {};
  const budget = { left: DOMAIN_CALL_BUDGET };
  async function token(scope) {
    if (!tokens[scope]) {
      const r = await http(DOMAIN_TOKEN_URL, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: "client_credentials", scope }),
      }, 0);
      tokens[scope] = (await r.json()).access_token;
    }
    return tokens[scope];
  }
  return {
    budget,
    async call(scopeKey, path, body) {
      if (budget.left-- <= 0) throw new Error("Domain call budget exhausted");
      const r = await http(DOMAIN_API + path, {
        method: body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${await token(SCOPES[scopeKey])}`, ...(body && { "Content-Type": "application/json" }) },
        ...(body && { body: JSON.stringify(body) }),
      }, 0);
      return r.json();
    },
  };
}

async function searchAll(domain, criteria) {
  const out = [], pageSize = 100;
  for (let pageNumber = 1; pageNumber <= 10; pageNumber++) { // search is capped at 1000 results anyway
    const page = await domain.call("listings", "/v1/listings/residential/_search", { listingType: "Sale", ...criteria, pageNumber, pageSize });
    out.push(...page);
    if (page.length < pageSize) break;
  }
  return out;
}

async function fetchSuburbs(domain, wanted, prev) {
  const out = { ...prev };
  for (const { suburb, postcode } of wanted) {
    const key = `${suburb}|${postcode}`;
    const old = prev[key];
    if (L.isFresh(old?.fetchedAt, SUBURB_CACHE_DAYS)) continue;
    try {
      const get = async (cat) => L.parseSuburbStats(await domain.call("suburbs",
        `/v2/suburbPerformanceStatistics/SA/${encodeURIComponent(suburb)}/${postcode}?propertyCategory=${cat}&periodSize=years&startingPeriodRelativeToCurrent=1&totalPeriods=10`));
      out[key] = { house: await get("house"), unit: await get("unit"), fetchedAt: nowIso };
    } catch (e) { warn(`suburb ${key}: ${e.message}`); if (/budget|40[13]/.test(e.message)) break; }
  }
  return out;
}

async function salesHistory(domain, address) {
  const hits = await domain.call("properties", `/v1/properties/_suggest?terms=${encodeURIComponent(address)}&pageSize=1`);
  if (!hits?.[0]?.id) return [];
  const p = await domain.call("properties", `/v1/properties/${hits[0].id}`);
  return (p.salesHistory ?? p.sales ?? [])
    .map((s) => ({ date: String(s.date ?? s.soldDate ?? s.contractDate ?? "").slice(0, 10), price: s.price ?? s.soldPrice ?? null }))
    .filter((s) => s.date && s.price);
}

async function listingsStep(areas, geojson, alertListings) {
  const prevFile = readJson("listings.json");
  const zones = L.selectZones(areas, geojson);
  if (!zones.length) throw new Error("areas.json zones match nothing in zones.geojson");
  const id = process.env.DOMAIN_CLIENT_ID, secret = process.env.DOMAIN_CLIENT_SECRET;
  // API listings = anything not from alerts (legacy files have no `via`); samples never count as real.
  const prevApi = (prevFile?.listings ?? []).filter((l) => l.via !== "alerts" && !String(l.id).startsWith("SAMPLE-"));
  const alerts = alertListings ?? (prevFile?.listings ?? []).filter((l) => l.via === "alerts"); // alerts step failed: keep previous

  let api = prevApi, suburbs = readJson("suburbs.json", {});
  if (id && secret) ({ listings: api, suburbs } = await domainListings(areas, zones, prevApi, id, secret));
  else if (prevApi.length) console.log("  no Domain credentials; keeping previous Domain listings");

  const apiIds = new Set(api.map((l) => l.id));
  const listings = [...api, ...alerts.filter((l) => !apiIds.has(l.id))]; // the richer API copy wins when both exist
  const source = api.length ? "domain" : alerts.length ? "alerts" : null;

  if (!source) {
    if (id && secret) { writeJson("listings.json", { generatedAt: nowIso, source: "domain", listings }); return { listings, suburbs }; }
    // never replace real data with samples
    console.log("  no real listings yet (no alerts, no Domain credentials); writing SAMPLE data");
    const sample = L.sampleListings(zones, today, nowIso);
    writeJson("listings.json", { generatedAt: nowIso, source: "sample", listings: sample });
    if (!Object.keys(suburbs).length || suburbs._sample) { suburbs = L.sampleSuburbs(today); writeJson("suburbs.json", suburbs); }
    return { listings: sample, suburbs, sample: true };
  }
  writeJson("listings.json", { generatedAt: nowIso, source, listings });
  return { listings, suburbs };
}

async function domainListings(areas, zones, prev, id, secret) {
  const domain = makeDomain(id, secret);
  const prevById = new Map(prev.map((l) => [l.id, l]));

  const commonCriteria = { propertyTypes: areas.propertyTypes };
  const raw = [];
  const box = L.searchBox(zones, areas.zoneMatch);
  if (box) {
    // Domain geoWindow box shape per the Domain swagger (topLeft / bottomRight, lat + lon)
    raw.push(...(await searchAll(domain, { ...commonCriteria, geoWindow: { box: { topLeft: { lat: box.maxLat, lon: box.minLng }, bottomRight: { lat: box.minLat, lon: box.maxLng } } } })));
  } else warn("selected zones do not overlap; skipping geo search");
  const extraIds = new Set();
  if (areas.extraSuburbs?.length) {
    const locations = areas.extraSuburbs.map((s) => ({ state: "SA", suburb: s.suburb, postCode: s.postcode ?? "", includeSurroundingSuburbs: false }));
    for (const it of await searchAll(domain, { ...commonCriteria, locations })) { raw.push(it); extraIds.add(String(it.listing?.id)); }
  }

  const fresh = new Map();
  for (const item of raw) {
    const l = L.normalizeSearchItem(item);
    if (!l || fresh.has(l.id) || l.lat === null) continue;
    l.zones = L.zonesContaining(l.lat, l.lng, zones);
    l.origin = "domain"; l.via = "api";
    if (L.zoneMatches(l.zones, zones, areas.zoneMatch) || extraIds.has(l.id)) fresh.set(l.id, l);
  }
  console.log(`  search: ${raw.length} results, ${fresh.size} inside zones`);

  // Details only for new listings or ones whose price text changed.
  const agentCache = readJson("agents.json", {});
  let agentsOk = true;
  let lookups = PROPERTY_LOOKUPS_PER_RUN, propertiesOk = true;
  for (const [lid, l] of fresh) {
    const p = prevById.get(lid);
    if (p && p.priceText === l.priceText) { delete l.description; continue; }
    try {
      const d = await domain.call("listings", `/v1/listings/${lid}`);
      const detailed = L.applyDetail(l, d);
      const ids = d.advertiserIdentifiers?.contactIds ?? [];
      for (const aid of ids) {
        if (!agentsOk || L.isFresh(agentCache[aid]?.fetchedAt, AGENT_CACHE_DAYS)) continue;
        try { agentCache[aid] = { ...L.parseAgent(await domain.call("agents", `/v1/agents/${aid}`)), fetchedAt: nowIso }; }
        catch (e) { if (/40[13]|budget/.test(e.message)) agentsOk = false; warn(`agent ${aid}: ${e.message}`); }
      }
      detailed.agents = L.agentsFromCache(ids, agentCache, detailed.agents);
      fresh.set(lid, detailed);
    } catch (e) { warn(`detail ${lid}: ${e.message}`); }
    if (!p && propertiesOk && lookups > 0 && domain.budget.left > 20) {
      lookups--;
      try { const h = await salesHistory(domain, l.address); if (h.length) fresh.get(lid).salesHistory = h; }
      catch (e) { if (/40[13]|budget/.test(e.message)) propertiesOk = false; warn(`sales history ${lid}: ${e.message}`); }
    }
  }

  writeJson("agents.json", agentCache);
  const listings = L.mergeListings(prev, [...fresh.values()], today);

  const wanted = [...L.SEED_SUBURBS, ...(areas.extraSuburbs ?? []).map((s) => ({ suburb: s.suburb, postcode: s.postcode })),
    ...listings.filter((l) => l.status !== "removed").map((l) => ({ suburb: l.suburb, postcode: l.postcode }))];
  const uniq = [...new Map(wanted.filter((w) => w.suburb && w.postcode).map((w) => [`${w.suburb}|${w.postcode}`, w])).values()];
  const prevSub = readJson("suburbs.json", {});
  // Domain stats override the SA Valuer-General series for the same suburb; other suburbs and _ metadata are kept.
  const suburbs = await fetchSuburbs(domain, uniq, prevSub._sample ? {} : prevSub);
  writeJson("suburbs.json", suburbs);
  console.log(`  domain calls used: ${DOMAIN_CALL_BUDGET - domain.budget.left}`);
  return { listings, suburbs };
}

// ---- e. AI ----
class AiUnavailable extends Error {}

async function chat(token, system, user) {
  const r = await fetch(AI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, temperature: 0.3, max_tokens: 3000, response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(user) }] }),
    signal: AbortSignal.timeout(90000),
  });
  if ([401, 403, 429].includes(r.status)) throw new AiUnavailable(`AI HTTP ${r.status}`);
  if (!r.ok) throw new Error(`AI HTTP ${r.status}`);
  return L.parseJsonLoose((await r.json()).choices[0].message.content);
}

const trend = (suburbs, l) => {
  const rows = suburbs?.[`${l.suburb}|${l.postcode}`]?.[/unit|apartment/i.test(l.propertyType ?? "") ? "unit" : "house"] ?? [];
  return rows.slice(-6).map((r) => ({ year: r.year, median: r.median, sales: r.sales }));
};
const macroBrief = (m) => m && {
  cashRate: m.cashRate.current, cashRateForecast4q: m.cashRate.forecast[3]?.value,
  cpiYearEnded: m.cpi.current, cpiForecast4q: m.cpi.forecast[3]?.value, mortgageRate: m.mortgageRate.current,
};

const LISTING_SYSTEM = `You are a cautious Adelaide residential property analyst helping a family buy a home near Linden Park Primary School and Glenunga International High School. For each listing in "listings", give a short, honest assessment using only the facts provided (listing facts, suburb median price trend, macro data). Do not invent facts; if the price is not disclosed, say so and base fair value on the suburb trend and features, keeping the range wide. Return JSON: {"results":[{"id":string,"summary":"2-3 sentences","pros":[string],"cons":[string],"fairValueLow":number AUD,"fairValueHigh":number AUD,"verdict":"Worth inspecting"|"Fair"|"Overpriced"|"Strong value"}]}. Max 4 pros and 4 cons, each under 12 words.`;

async function aiListingsStep(listingsRes, macro, token) {
  const file0 = readJson("listings.json");
  const todo = file0.listings.filter(L.needsAi);
  if (!todo.length) return console.log("  no listings need analysis");
  const byId = new Map(file0.listings.map((l) => [l.id, l]));
  let done = 0;
  try {
    for (let i = 0; i < todo.length && i / AI_BATCH < AI_MAX_REQUESTS; i += AI_BATCH) {
      const batch = todo.slice(i, i + AI_BATCH);
      const res = await chat(token, LISTING_SYSTEM, {
        macro: macroBrief(macro),
        listings: batch.map((l) => ({
          id: l.id, address: l.address, suburb: l.suburb, type: l.propertyType, beds: l.bedrooms, baths: l.bathrooms, cars: l.carspaces,
          landM2: l.landArea, askingPrice: l.priceText, priceLow: l.priceLow, priceHigh: l.priceHigh, saleMethod: l.saleMethod,
          daysOnMarket: l.daysOnMarket, priceChanges: l.priceHistory.length - 1, features: l.features, description: l.description?.slice(0, 400),
          pastSales: l.salesHistory, suburbMedianTrend: trend(listingsRes.suburbs, l),
        })),
      });
      for (const r of res.results ?? []) {
        const l = byId.get(String(r.id));
        const ai = l && L.cleanAi(r, { model: MODEL, priceText: l.priceText, now: nowIso });
        if (ai) { l.ai = ai; done++; }
      }
    }
  } catch (e) {
    if (!(e instanceof AiUnavailable)) warn(`AI listings: ${e.message}`);
    else warn(`${e.message}; keeping previous AI values`);
  }
  if (done) writeJson("listings.json", { ...file0, listings: file0.listings });
  console.log(`  AI analysed ${done}/${todo.length} listings`);
}

const MARKET_SYSTEM = `You are a cautious Australian housing market analyst writing for a family buying a home in Adelaide's eastern suburbs (Linden Park, Glenunga, Tusmore, Toorak Gardens, St Georges, Beaumont). Using only the data provided (RBA macro data, our simple forecasts, recent headlines, suburb median trends and current listing stats), write a balanced market view. Be explicit about uncertainty; never promise price movements. Return JSON: {"headline":"one line","outlook":"one paragraph","timing":"when-to-buy view with reasoning, one paragraph","risks":[string],"watch":[string]} with 3-5 items in risks and watch.`;

async function aiMarketStep(listingsRes, macro, news, token) {
  const active = (listingsRes?.listings ?? []).filter((l) => l.status !== "removed");
  const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
  const input = {
    today,
    macro: macro && { ...macroBrief(macro), cashRateForecast: macro.cashRate.forecast, cpiForecast: macro.cpi.forecast, recentCashRate: macro.cashRate.history.slice(-12) },
    headlines: (news?.items ?? []).slice(0, 15).map((n) => `${n.date.slice(0, 10)} [${n.category}] ${n.title}`),
    suburbTrends: Object.fromEntries(Object.entries(listingsRes?.suburbs ?? {}).filter(([k]) => !k.startsWith("_")).map(([k, v]) => [k, v.house?.slice(-6)])),
    listingStats: {
      active: active.length, medianAskingMid: med(active.filter((l) => l.priceLow).map((l) => (l.priceLow + l.priceHigh) / 2)),
      medianDaysOnMarket: med(active.map((l) => l.daysOnMarket)), withPriceCuts: active.filter((l) => l.priceHistory.length > 1).length,
      auctions: active.filter((l) => l.saleMethod === "auction").length,
    },
  };
  try {
    const r = await chat(token, MARKET_SYSTEM, input);
    if (typeof r.headline !== "string" || typeof r.outlook !== "string") throw new Error("unexpected market view shape");
    writeJson("market.json", {
      generatedAt: nowIso, model: MODEL, headline: r.headline, outlook: r.outlook, timing: String(r.timing ?? ""),
      risks: (r.risks ?? []).map(String), watch: (r.watch ?? []).map(String), disclaimer: "Not financial advice.",
    });
  } catch (e) { warn(`AI market view: ${e.message}; keeping previous`); }
}

// ---- main ----
function warn(msg) { console.warn(`  ! ${msg}`); if (process.env.GITHUB_ACTIONS) console.log(`::warning::${msg}`); }

async function step(name, fn) {
  console.log(`[${name}]`);
  try { return await fn(); } catch (e) { warn(`${name} failed, previous data kept: ${e.message}`); return null; }
}

if (process.argv.includes("--blend-only")) { blendOnly(); process.exit(0); }

mkdirSync(DATA, { recursive: true });
if (!existsSync(file("areas.json"))) writeJson("areas.json", L.DEFAULT_AREAS);
const areas = readJson("areas.json", L.DEFAULT_AREAS);
const geojson = readJson("zones.geojson");

const macro = await step("macro", macroStep) ?? readJson("macro.json");
await step("news", newsStep);
const alertListings = geojson ? await step("alerts", () => alertsStep(areas, geojson)) : null;
const listingsRes = geojson ? await step("listings", () => listingsStep(areas, geojson, alertListings)) : null;
const news = readJson("news.json");

const ghToken = process.env.AI_API_KEY;
if (!ghToken) console.log("[ai]\n  no AI_API_KEY secret; keeping previous AI values");
else {
  if (listingsRes && !listingsRes.sample) { await step("ai listings", () => aiListingsStep(listingsRes, macro, ghToken)); }
  const real = listingsRes && !listingsRes.sample ? listingsRes : { listings: [], suburbs: {} }; // never feed sample data to the model
  await step("ai market", () => aiMarketStep(real, macro, news, ghToken));
}
console.log("done");
