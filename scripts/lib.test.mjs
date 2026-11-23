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
});

const base = (o = {}) => ({
  id: "1", priceText: "$1.5m", priceLow: 1500000, priceHigh: 1500000, status: "active",
  dateListed: "2026-11-01", photos: [], suburb: "Linden Park", ...o,
});

test("mergeListings keeps firstSeen, appends priceHistory, marks removed, drops after 30 days", () => {
  const day1 = L.mergeListings([], [base({ id: "1" }), base({ id: "2", dateListed: null })], "2026-11-10");
  assert.equal(day1[0].firstSeen, "2026-11-10");
  assert.equal(day1[0].priceHistory.length, 1);
  assert.equal(day1[0].daysOnMarket, 9);
  assert.equal(day1[1].daysOnMarket, 0, "falls back to firstSeen");
  assert.equal(day1[0].ai, null);

  day1[0].ai = { summary: "kept", priceText: "$1.5m" };
  const day2 = L.mergeListings(day1, [base({ id: "1", priceText: "$1.4m", priceLow: 1400000, priceHigh: 1400000 })], "2026-11-12");
  const a = day2.find((l) => l.id === "1");
  assert.equal(a.firstSeen, "2026-11-10");
  assert.equal(a.priceHistory.length, 2);
  assert.equal(a.priceHistory[1].priceText, "$1.4m");
  assert.equal(a.ai.summary, "kept");
  assert.equal(L.needsAi(a), true, "price text changed since analysis");
  const b = day2.find((l) => l.id === "2");
  assert.equal(b.status, "removed");
  assert.equal(b.removedDate, "2026-11-12");

  const same = L.mergeListings(day2, [base({ id: "1", priceText: "$1.4m", priceLow: 1400000, priceHigh: 1400000 })], "2026-11-13");
  assert.equal(same.find((l) => l.id === "1").priceHistory.length, 2, "unchanged price adds nothing");
  assert.equal(same.find((l) => l.id === "2").status, "removed");
  const later = L.mergeListings(same, [base({ id: "1", priceText: "$1.4m", priceLow: 1400000, priceHigh: 1400000 })], "2026-12-20");
  assert.equal(later.find((l) => l.id === "2"), undefined, "dropped after 30 days");
});

test("normalizeSearchItem maps a Domain search result", () => {
  const l = L.normalizeSearchItem({ type: "PropertyListing", listing: {
    id: 2013958589, headline: "Nice", priceDetails: { displayPrice: "$1.1m - $1.2m" },
    propertyDetails: { state: "SA", suburb: "LINDEN PARK", postcode: "5065", displayableAddress: "1 Test St, Linden Park", latitude: -34.95, longitude: 138.65, bedrooms: 4, propertyType: "House", landArea: 700, features: ["Pool"] },
    summaryDescription: "<b>Hi</b><br />there &amp; you", media: [{ category: "Image", url: "https://x/1.jpg" }],
    advertiser: { name: "Agency", contacts: [{ name: "Jo", photoUrl: "p" }] }, listingSlug: "slug-1",
    auctionSchedule: { time: "2026-12-06T11:00:00" }, labels: ["Under Offer"],
  } });
  assert.equal(l.id, "2013958589");
  assert.equal(l.suburb, "Linden Park");
  assert.equal(l.address, "1 Test St, Linden Park SA 5065");
  assert.equal(l.priceLow, 1100000);
  assert.equal(l.saleMethod, "auction");
  assert.equal(l.auctionDate, "2026-12-06T11:00:00+10:30");
  assert.equal(l.description, "Hi there & you");
  assert.equal(l.status, "underOffer");
  assert.equal(l.url, "https://www.domain.com.au/slug-1");
  assert.equal(L.normalizeSearchItem({ type: "Project", listing: {} }), null);
});

test("cleanAi validates model output", () => {
  const ok = L.cleanAi({ summary: "s", pros: ["a"], cons: [], fairValueLow: "1000000", fairValueHigh: 1200000, verdict: "Fair" }, { model: "m", priceText: "p", now: "n" });
  assert.equal(ok.fairValueLow, 1000000);
  assert.equal(L.cleanAi({ summary: "s", verdict: "Great!" }, { model: "m", priceText: "p", now: "n" }), null);
  assert.deepEqual(L.parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
});

test("sample data lies inside both zones and is labelled", () => {
  const s = L.sampleListings(zones, "2026-11-23", "2026-11-23T00:00:00Z");
  assert.equal(s.length, 8);
  for (const l of s) {
    assert.ok(l.headline.startsWith("SAMPLE"));
    assert.equal(L.zonesContaining(l.lat, l.lng, zones).length, 2, l.address);
  }
  assert.equal(L.sampleSuburbs("2026-11-23")._sample, true);
});

test("agent mapping and cache", () => {
  const a = L.parseAgent({ firstName: "Jane", lastName: "Smith", mobile: "0400 000 000", phone: "08 1", email: "j@x.com", agencyName: "Ag", photo: "p" });
  assert.deepEqual(a, { name: "Jane Smith", phone: "0400 000 000", email: "j@x.com", agency: "Ag", photo: "p" });
  const cache = { 7: { ...a, fetchedAt: "2026-11-01T00:00:00Z" } };
  assert.deepEqual(L.agentsFromCache([7, 8], cache, [null, { name: "Fallback" }]), [a, { name: "Fallback" }]);
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
