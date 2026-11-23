import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import * as L from "./lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const geojson = JSON.parse(readFileSync(join(root, "data/zones.geojson"), "utf8"));
const zones = L.selectZones(L.DEFAULT_AREAS, geojson);

test("parseCsv handles quotes, embedded commas and newlines", () => {
  const rows = L.parseCsv('a,b\r\n"x, y","line1\nline2"\n"q""uote",3');
  assert.deepEqual(rows, [["a", "b"], ["x, y", "line1\nline2"], ['q"uote', "3"]]);
});

test("parseRbaDate accepts dd/mm/yyyy, dd-Mon-yyyy and Mon-yyyy", () => {
  assert.equal(L.parseRbaDate("30/09/2026"), "2026-09-30");
  assert.equal(L.parseRbaDate("19-Nov-2026"), "2026-11-19");
  assert.equal(L.parseRbaDate("Feb-2024"), "2024-02-29");
  assert.equal(L.parseRbaDate("Title"), null);
});

test("parseRbaCsv extracts series by Series ID", () => {
  const csv = "﻿F1 TEST\nTitle,Cash,Other\nDescription,x,y\nSeries ID,AAA,BBB\n01/01/2020,1.5,\n31/01/2020,1.25,7\n,,\n";
  const { series } = L.parseRbaCsv(csv, ["AAA", "BBB"]);
  assert.deepEqual(series.AAA, [{ date: "2020-01-01", value: 1.5 }, { date: "2020-01-31", value: 1.25 }]);
  assert.deepEqual(series.BBB, [{ date: "2020-01-31", value: 7 }]);
  assert.deepEqual(L.toMonthly(series.AAA), [{ date: "2020-01", value: 1.25 }]);
});

test("parsePriceText", () => {
  const p = L.parsePriceText;
  assert.deepEqual(p("$1.2m"), { priceLow: 1200000, priceHigh: 1200000 });
  assert.deepEqual(p("$1,250,000"), { priceLow: 1250000, priceHigh: 1250000 });
  assert.deepEqual(p("Offers over $950,000"), { priceLow: 950000, priceHigh: 950000 });
  assert.deepEqual(p("$1.1m - $1.2m"), { priceLow: 1100000, priceHigh: 1200000 });
  assert.deepEqual(p("$1.45m – $1.55m"), { priceLow: 1450000, priceHigh: 1550000 });
  assert.deepEqual(p("$1.1 - $1.2m"), { priceLow: 1100000, priceHigh: 1200000 });
  assert.deepEqual(p("$900k+"), { priceLow: 900000, priceHigh: 900000 });
  for (const t of ["Contact agent", "Auction", "Expressions of interest", "", null]) assert.deepEqual(p(t), { priceLow: null, priceHigh: null });
});

test("point in polygon: school and CBD against real zones", () => {
  assert.equal(zones.length, 2);
  const school = [-34.9497, 138.6501], cbd = [-34.9285, 138.6007];
  for (const z of zones) {
    assert.ok(L.pointInGeometry(...school, z.geometry), `school inside ${z.name}`);
    assert.ok(!L.pointInGeometry(...cbd, z.geometry), `CBD outside ${z.name}`);
  }
  assert.deepEqual(L.zonesContaining(...school, zones).length, 2);
  assert.ok(L.zoneMatches(L.zonesContaining(...school, zones), zones, "all"));
  assert.ok(!L.zoneMatches([], zones, "any"));
});

test("point in polygon: holes and MultiPolygon", () => {
  const square = (a, b) => [[a, a], [b, a], [b, b], [a, b], [a, a]];
  const donut = { type: "Polygon", coordinates: [square(0, 10), square(4, 6)] };
  assert.ok(L.pointInGeometry(1, 1, donut));
  assert.ok(!L.pointInGeometry(5, 5, donut));
  const multi = { type: "MultiPolygon", coordinates: [[square(0, 1)], [square(10, 11)]] };
  assert.ok(L.pointInGeometry(10.5, 10.5, multi));
  assert.ok(!L.pointInGeometry(5, 5, multi));
});

test("search box: intersection for all, union for any", () => {
  const all = L.searchBox(zones, "all"), any = L.searchBox(zones, "any");
  assert.ok(all.minLat < all.maxLat && all.minLng < all.maxLng);
  assert.ok(any.minLng <= all.minLng && any.maxLng >= all.maxLng);
});

// 40 quarters of year-ended CPI decaying from 6 toward 2.5, plus noise-free shape check
const cpiSeries = Array.from({ length: 120 }, (_, i) => ({ date: L.addMonths("1996-03", 3 * i), value: 2.5 + 3.5 * 0.9 ** (i % 40) }));

test("forecastCpi output shape and sanity", () => {
  const { forecast, phi } = L.forecastCpi(cpiSeries);
  assert.equal(forecast.length, 8);
  assert.ok(phi > 0 && phi < 1);
  const last = cpiSeries.at(-1);
  assert.equal(forecast[0].date, L.addMonths(last.date, 3));
  for (const f of forecast) {
    assert.ok(f.lo <= f.value && f.value <= f.hi);
    assert.ok(f.value > -2 && f.value < 10);
  }
  assert.ok(forecast[7].hi - forecast[7].lo > forecast[0].hi - forecast[0].lo, "band widens");
});

test("forecastCashRate output shape and sanity", () => {
  const quarterlyRates = cpiSeries.map((p, i) => ({ date: p.date, value: 2 + 0.5 * Math.sin(i / 5) + (i % 3) * 0.25 }));
  const cpiForecast = L.forecastCpi(cpiSeries).forecast;
  const { forecast, rho } = L.forecastCashRate({ quarterlyRates, cpi: cpiSeries, cpiForecast, current: 3.6 });
  assert.ok(rho > 0 && rho < 1);
  assert.equal(forecast.length, 8);
  for (const f of forecast) {
    assert.equal(f.value % 0.25, 0, "central path in 0.25 steps");
    assert.ok(f.lo >= 0 && f.lo <= f.value && f.value <= f.hi && f.hi < 15);
  }
});

const rss = `<?xml version="1.0"?><rss><channel>
<item><title><![CDATA[RBA holds rates &amp; signals patience - ABC News]]></title><link>https://example.com/1</link><pubDate>Mon, 23 Nov 2026 01:00:00 GMT</pubDate><source url="https://abc.net.au">ABC News</source></item>
<item><title>Adelaide house prices climb again</title><link>https://example.com/2</link><pubDate>Sun, 22 Nov 2026 01:00:00 GMT</pubDate></item>
<item><title>Adelaide house prices climb again</title><link>https://example.com/3</link><pubDate>Sun, 22 Nov 2026 02:00:00 GMT</pubDate></item>
<item><title>Global markets wobble</title><link>https://example.com/4</link><pubDate>Sat, 21 Nov 2026 01:00:00 GMT</pubDate></item>
</channel></rss>`;

test("parseRss, categorise, buildNews", () => {
  const items = L.parseRss(rss);
  assert.equal(items.length, 4);
  assert.equal(L.parseRss('<rdf:RDF><item rdf:about="x"><title>T</title><link>http://l</link><dc:date>2026-11-20T00:00:00Z</dc:date></item></rdf:RDF>')[0].date, "2026-11-20T00:00:00.000Z");
  assert.equal(items[0].title, "RBA holds rates & signals patience");
  assert.equal(items[0].source, "ABC News");
  assert.equal(items[0].date, "2026-11-23T01:00:00.000Z");
  const news = L.buildNews([{ items, category: "economy", source: "Feed" }], new Date("2026-11-23T05:00:00Z"));
  assert.equal(news.length, 3, "deduped by title");
  assert.deepEqual(news.map((n) => n.category), ["rba", "adelaide", "economy"]);
  assert.ok(news[0].date > news[1].date, "newest first");
  assert.equal(news[2].source, "Feed");
  assert.deepEqual(news[0].topics, ["rates"]);
  assert.ok(news.every((n) => n.importance >= 0 && n.importance <= 3));
});

test("news relevance filter and importance score", () => {
  const keep = ["Chalmers primes Australians for more bad news", "Australian borrowers face threat of further rate hikes before relief in late 2027"];
  const drop = "No life jackets on airboat during 2023 crash";
  const now = new Date("2026-11-23T05:00:00Z");
  const d = (days) => new Date(now - days * 864e5).toISOString();
  for (const t of keep) {
    assert.ok(L.isRelevantNews(t), t);
    assert.ok(L.newsImportance(t, d(1), now) >= 2, t);
  }
  assert.ok(!L.isRelevantNews(drop));
  assert.ok(L.newsImportance("Adelaide house prices climb again", d(1), now) >= 1.5);
  assert.ok(L.newsImportance("Chalmers primes Australians for more bad news", d(1), now) > L.newsImportance("Chalmers primes Australians for more bad news", d(40), now));
  assert.deepEqual(L.newsTopics("Australian borrowers face threat of further rate hikes"), ["rates"]);
  const feed = { filter: true, source: "ABC", category: "economy", items: [...keep, drop].map((title, i) => ({ title, link: `http://x/${i}`, date: d(1 + i) })) };
  const out = L.buildNews([feed], now);
  assert.deepEqual(out.map((n) => n.title), keep);
  const many = { source: "G", category: "economy", items: Array.from({ length: 60 }, (_, i) => ({ title: `Inflation story ${i}`, link: `http://y/${i}`, date: d(i / 20) })) };
  assert.equal(L.buildNews([many, many, many, many, many], now, 40, 60, 60).length, 40);
});

test("cleanAi validates model output", () => {
  const ok = L.cleanAi({ summary: "s", pros: ["a"], cons: [], fairValueLow: "1000000", fairValueHigh: 1200000, verdict: "Fair" }, { model: "m", priceText: "p", now: "n" });
  assert.equal(ok.fairValueLow, 1000000);
  assert.equal(L.cleanAi({ summary: "s", verdict: "Great!" }, { model: "m", priceText: "p", now: "n" }), null);
  assert.deepEqual(L.parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
});

test("isFresh", () => {
  assert.ok(L.isFresh("2026-11-01T00:00:00Z", 30, Date.parse("2026-11-20")));
  assert.ok(!L.isFresh("2026-09-01T00:00:00Z", 30, Date.parse("2026-11-20")));
});

test("blendForecasts averages values, widens band, rounds cash rate to 0.05", () => {
  const rule = [{ date: "2026-12", value: 5, lo: 4.6, hi: 5.4 }, { date: "2027-03", value: 4.75, lo: 4.3, hi: 5.2 }];
  const tfm = [{ date: "2026-12", value: 4.62, lo: 4.4, hi: 4.9 }, { date: "2027-03", value: 4.46, lo: 4.0, hi: 5.0 }, { date: "2027-06", value: 4, lo: 3, hi: 5 }];
  const b = L.blendForecasts(rule, tfm, 0.05);
  assert.equal(b.length, 2); // unmatched dates dropped
  assert.deepEqual(b[0], { date: "2026-12", value: 4.8, lo: 4.4, hi: 5.4 }); // 4.81 -> 4.80
  assert.deepEqual(b[1], { date: "2027-03", value: 4.6, lo: 4, hi: 5.2 });   // 4.605 -> 4.60
  assert.equal(L.blendForecasts(rule, tfm)[0].value, 4.81); // 2dp when no step
});

test("applyBlend: fresh file blends and keeps components; stale or absent reverts to rule-only", () => {
  const f = (v) => [{ date: "2026-12", value: v, lo: v - 1, hi: v + 1 }];
  const macro = { cashRate: { forecast: f(5) }, cpi: { forecast: f(3) }, method: L.FORECAST_METHOD };
  const now = Date.parse("2026-11-23T12:00:00Z");
  const tfm = { generatedAt: "2026-11-23T05:00:00Z", cashRate: f(4), cpi: f(4) };
  const b = L.applyBlend(macro, tfm, now);
  assert.equal(b.cashRate.forecast[0].value, 4.5);
  assert.equal(b.cpi.forecast[0].value, 3.5);
  assert.deepEqual(b.cpi.forecastComponents.rule, f(3));
  assert.equal(b.method, L.BLENDED_METHOD);
  assert.equal(L.applyBlend(b, tfm, now).cpi.forecast[0].value, 3.5); // idempotent
  for (const old of [null, { ...tfm, generatedAt: "2026-11-20T00:00:00Z" }]) {
    const r = L.applyBlend(b, old, now);
    assert.deepEqual(r.cpi.forecast, f(3));
    assert.equal(r.cpi.forecastComponents, undefined);
    assert.equal(r.method, L.FORECAST_METHOD);
  }
});

// ---------- email alerts ----------

test("geocodeQuery strips unit numbers; geoKey normalises", () => {
  assert.equal(L.geocodeQuery({ address: "3/45 Smith Road, Glenunga SA 5064" }), "45 Smith Road, Glenunga SA 5064");
  assert.equal(L.geocodeQuery({ address: "Unit 3/45 Smith Road, Glenunga SA 5064" }), "45 Smith Road, Glenunga SA 5064");
  assert.equal(L.geocodeQuery({ address: "12 Example St, Linden Park SA 5065" }), "12 Example St, Linden Park SA 5065");
  assert.equal(L.geoKey({ address: "12 Example St,  Linden Park SA 5065" }), "12 example st linden park sa 5065");
});

test("parseNominatim accepts precise results only", () => {
  const hit = { lat: "-34.95", lon: "138.65", addresstype: "house", class: "place" };
  assert.deepEqual(L.parseNominatim([hit]), { lat: -34.95, lng: 138.65 });
  assert.equal(L.parseNominatim([{ ...hit, addresstype: "suburb" }]), null);
  assert.equal(L.parseNominatim([{ ...hit, class: "boundary" }]), null);
  assert.equal(L.parseNominatim([{ ...hit, lat: "-33.9", lon: "151.2" }]), null); // not South Australia
  assert.deepEqual(L.parseNominatim([{ ...hit, addresstype: "city" }, hit]), { lat: -34.95, lng: 138.65 });
  assert.equal(L.parseNominatim([]), null);
  assert.equal(L.parseNominatim(null), null);
});

const alertItem = (o = {}) => ({
  source: "rea", id: "143456789", url: "https://www.realestate.com.au/property-house-sa-linden+park-143456789",
  address: "12 Example Street, Linden Park SA 5065", suburb: "Linden Park", postcode: "5065", priceText: "$1,450,000 - $1,550,000",
  beds: 4, baths: 2, cars: 2, image: "https://i2.au.reastatic.net/a.jpg", propertyType: "House",
  firstSeen: "2026-11-20T01:00:00.000Z", lastSeen: "2026-11-22T01:00:00.000Z",
  priceHistory: [{ date: "2026-11-20", priceText: "$1,500,000 - $1,600,000" }, { date: "2026-11-22", priceText: "$1,450,000 - $1,550,000" }], ...o,
});

test("mapAlertItem maps to the listing contract", () => {
  const l = L.mapAlertItem(alertItem(), "2026-11-23");
  assert.equal(l.id, "rea-143456789");
  assert.deepEqual([l.origin, l.via, l.status, l.bedrooms, l.bathrooms, l.carspaces, l.propertyType], ["rea", "alerts", "active", 4, 2, 2, "House"]);
  assert.deepEqual([l.priceLow, l.priceHigh, l.saleMethod], [1450000, 1550000, "privateTreaty"]);
  assert.deepEqual(l.photos, ["https://i2.au.reastatic.net/a.jpg"]);
  assert.equal(l.priceHistory.length, 2);
  assert.deepEqual([l.priceHistory[0].priceLow, l.firstSeen, l.lastSeen, l.daysOnMarket], [1500000, "2026-11-20", "2026-11-22", 3]);
  assert.equal(L.mapAlertItem(alertItem({ source: "domain", id: "2019876543" }), "2026-11-23").id, "2019876543");
  assert.equal(L.mapAlertItem(alertItem({ source: "domain" }), "2026-11-23").origin, "domain");
  assert.equal(L.mapAlertItem(alertItem({ priceText: "Auction Sat 5 Dec" }), "2026-11-23").saleMethod, "auction");
  const sold = L.mapAlertItem(alertItem({ sold: true, soldAt: "2026-11-22T05:00:00Z" }), "2026-11-23");
  assert.deepEqual([sold.status, sold.sold, sold.removedDate], ["removed", true, "2026-11-22"]);
  assert.equal(L.mapAlertItem({ id: "1" }, "2026-11-23"), null);
  // no history from the worker: one entry from the current price
  assert.equal(L.mapAlertItem(alertItem({ priceHistory: undefined }), "2026-11-23").priceHistory.length, 1);
});

test("inExtraSuburbs matches by suburb (and postcode when both known)", () => {
  const areas = { extraSuburbs: [{ suburb: "Burnside", postcode: "5066" }, { suburb: "Beaumont" }] };
  assert.ok(L.inExtraSuburbs({ suburb: "burnside", postcode: "5066" }, areas));
  assert.ok(!L.inExtraSuburbs({ suburb: "Burnside", postcode: "5000" }, areas));
  assert.ok(L.inExtraSuburbs({ suburb: "Beaumont", postcode: null }, areas));
  assert.ok(!L.inExtraSuburbs({ suburb: "Glenunga" }, areas));
  assert.ok(!L.inExtraSuburbs({ suburb: "Glenunga" }, {}));
});

test("mergeAlertListings: absent listings stay active for 60 days after lastSeen, then drop; AI is kept", () => {
  const mk = (id, lastSeen, extra = {}) => ({ ...L.mapAlertItem(alertItem({ id, lastSeen: `${lastSeen}T00:00:00Z` }), "2026-11-23"), ...extra });
  const prev = [mk("1", "2026-11-22", { ai: { summary: "x" } }), mk("2", "2026-09-30"), mk("3", "2026-09-20"), mk("4", "2026-11-22")];
  const fresh = [mk("1", "2026-11-23")];
  const out = L.mergeAlertListings(prev, fresh, "2026-11-23", new Set(["rea-4"]));
  const byId = Object.fromEntries(out.map((l) => [l.id, l]));
  assert.deepEqual(Object.keys(byId).sort(), ["rea-1", "rea-2"]);          // 3 is 64 days old, 4 is now outside the zones
  assert.equal(byId["rea-2"].status, "active");                              // absent, but never marked removed
  assert.deepEqual(byId["rea-1"].ai, { summary: "x" });
  assert.equal(byId["rea-1"].lastSeen, "2026-11-23");
});

test("mergeAlertListings: sold sticks, even when a later alert lacks the flag", () => {
  const sold = L.mapAlertItem(alertItem({ sold: true, soldAt: "2026-11-21T00:00:00Z" }), "2026-11-23");
  const later = L.mapAlertItem(alertItem(), "2026-11-24");
  const [m] = L.mergeAlertListings([sold], [later], "2026-11-24");
  assert.deepEqual([m.status, m.sold, m.removedDate], ["removed", true, "2026-11-21"]);
});

test("alert listing inside Linden Park x Glenunga zones passes the pipeline filter; far one does not", () => {
  const [lat, lng] = L.samplePoints(zones, 1)[0];
  const inside = L.zonesContaining(lat, lng, zones);
  assert.ok(L.zoneMatches(inside, zones, "all"));
  assert.ok(!L.zoneMatches(L.zonesContaining(-34.6, 138.5, zones), zones, "all"));
});

test("manualToAlertItem turns a link + address into a listing", () => {
  const m = L.manualToAlertItem({ url: "https://www.realestate.com.au/property-house-sa-linden+park-145678901?rsf=x", address: "12 Example St, Linden Park SA 5065", beds: "4", priceText: "" }, "2026-11-23");
  assert.deepEqual([m.source, m.id, m.suburb, m.postcode, m.propertyType, m.beds, m.priceText, m.lastSeen], ["rea", "145678901", "Linden Park", "5065", "House", 4, null, "2026-11-23"]);
  const l = L.mapAlertItem(m, "2026-11-23");
  assert.equal(l.id, "rea-145678901");
  assert.equal(L.manualToAlertItem({ url: "https://www.realestate.com.au/buy/in-linden+park/list-1", address: "1 A St" }, "2026-11-23"), null, "search page rejected");
  assert.equal(L.manualToAlertItem({ url: "https://www.domain.com.au/7-a-st-glenunga-sa-5064-2019876543", address: "" }, "2026-11-23"), null, "address required");
});

test("manualToAlertItem: bookmarklet imports expire 60 days after the last import", () => {
  const m = { url: "https://www.domain.com.au/7-a-st-glenunga-sa-5064-2019876543", address: "7 A St, Glenunga SA 5064", via: "bookmarklet", addedAt: "2026-09-01", seenAt: "2026-10-01", image: "https://x/1.jpg" };
  const i = L.manualToAlertItem(m, "2026-11-23");
  assert.deepEqual([i.lastSeen, i.firstSeen, i.image], ["2026-10-01", "2026-09-01", "https://x/1.jpg"]);
  assert.equal(L.manualToAlertItem({ ...m, seenAt: "2026-09-01" }, "2026-11-23"), null);
});

test("dedupeByAddress folds the Domain copy of a realestate.com.au listing into it", () => {
  const rea = { id: "rea-1", origin: "rea", url: "https://www.realestate.com.au/property-house-sa-st+georges-1", address: "528 Portrush Road, St Georges", propertyType: "House", priceText: "$1.9m", bedrooms: 5, photos: [], ai: null, firstSeen: "2026-11-23" };
  const dom = { id: "2021221626", origin: "domain", url: "https://www.domain.com.au/528-portrush-road-st-georges-sa-5064-2021221626", address: "528 Portrush Rd, St Georges SA 5064", propertyType: null, postcode: "5064", photos: ["https://x/house.jpg"], ai: { verdict: "Fair" }, firstSeen: "2026-11-20" };
  const other = { id: "rea-2", origin: "rea", address: "12 Portrush Road, St Georges", photos: [] };
  const { listings, dropped } = L.dedupeByAddress([dom, rea, other]);
  assert.deepEqual(listings.map((l) => l.id), ["rea-1", "rea-2"]);
  assert.deepEqual([...dropped], ["2021221626"]);
  const k = listings[0];
  assert.deepEqual([k.propertyType, k.postcode, k.photos[0], k.ai.verdict, k.firstSeen], ["House", "5064", "https://x/house.jpg", "Fair", "2026-11-20"]);
  assert.equal(k.alsoAt[0].url, dom.url);
  assert.equal(L.dedupeByAddress([{ id: "a", address: "Address on request, Beaumont" }, { id: "b", address: "Address on request, Beaumont" }]).listings.length, 2, "no street number: never merged");
});

test("isAgentPhoto spots headshots, not house photos", () => {
  assert.ok(L.isAgentPhoto("https://i2.au.reastatic.net/200x200-crop,gravity=north/x/main.jpg"));
  assert.ok(L.isAgentPhoto("https://rimh2.domainstatic.com.au/a=/90x90/filters:q/https://images.domain.com.au/img/1/contact_1.jpeg"));
  assert.ok(!L.isAgentPhoto("https://i2.au.reastatic.net/800x600-resize,extend/x/image.jpg"));
});

test("needsAi re-runs analyses made with older inputs", () => {
  const base = { status: "active", priceText: "$1m" };
  assert.equal(L.needsAi({ ...base, ai: { priceText: "$1m" } }), true); // pre-version analysis
  const ai = L.cleanAi({ summary: "s", verdict: "Fair" }, { model: "m", priceText: "$1m", now: "t" });
  assert.equal(L.needsAi({ ...base, ai }), false);
  assert.equal(L.needsAi({ ...base, priceText: "$1.1m", ai }), true);
});
