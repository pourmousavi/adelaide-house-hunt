// NOTE: fixtures/rea-alert.* are SYNTHETIC, written by hand to resemble a realestate.com.au saved-search alert.
// Real alert markup will differ. Once a real alert is captured (raw:<ts> in KV), add it here and adjust the parser.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import * as P from "./src/parse.js";
import worker from "./src/index.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const html = readFileSync(join(dir, "rea-alert.html"), "utf8");
const eml = readFileSync(join(dir, "rea-alert.eml"), "utf8");

test("senderMatches", () => {
  assert.ok(P.senderMatches("bounce@mail.realestate.com.au"));
  assert.ok(P.senderMatches(null, '"Domain" <alerts@domain.com.au>'));
  assert.ok(P.senderMatches("x@e.reamail.example"));
  assert.ok(!P.senderMatches("friend@gmail.com", "Mum <mum@example.com>"));
});

test("quoted-printable and base64 decoding (utf-8)", () => {
  assert.equal(new TextDecoder().decode(P.decodeQuotedPrintable("caf=C3=A9 =\r\nok =3D")), "café ok =");
  assert.equal(new TextDecoder().decode(P.decodeBase64("Y2Fm\r\nw6k=")), "café");
});

test("mimeParts: multipart/alternative with base64 text and QP html", () => {
  const parts = P.mimeParts(eml);
  assert.deepEqual(parts.map((p) => p.type), ["text/plain", "text/html"]);
  assert.match(parts[0].text, /Plain text alternative/);
  assert.equal(P.htmlPart(eml).replace(/\r\n/g, "\n").trim(), html.replace(/\r\n/g, "\n").trim());
  assert.equal(P.htmlPart("Content-Type: text/plain\r\n\r\nhi"), null);
  assert.ok(P.headerValues(eml, ["from"])[0].includes("realestate.com.au"));
});

test("resolveListingUrl: direct, redirect-wrapped and non-listing links", () => {
  const rea = P.resolveListingUrl("https://www.realestate.com.au/property-house-sa-linden+park-143456789?cid=x&amp;utm=y");
  assert.deepEqual([rea.source, rea.id, rea.propertyType, rea.suburb], ["rea", "143456789", "House", "Linden Park"]);
  assert.equal(rea.url, "https://www.realestate.com.au/property-house-sa-linden+park-143456789"); // tracking params dropped
  const wrapped = P.resolveListingUrl("https://click.mail.realestate.com.au/r?u=https%3A%2F%2Fwww.realestate.com.au%2Fproperty-townhouse-sa-glenunga-138888001&t=TOKEN");
  assert.deepEqual([wrapped.id, wrapped.propertyType, wrapped.url.includes("TOKEN")], ["138888001", "Townhouse", false]);
  const dbl = P.resolveListingUrl("https://x.example/go?l=" + encodeURIComponent(encodeURIComponent("https://www.realestate.com.au/property-unit-sa-glen+osmond-120000999")));
  assert.equal(dbl.id, "120000999");
  const dom = P.resolveListingUrl("https://www.domain.com.au/7-sample-avenue-glenunga-sa-5064-2019876543?x=1");
  assert.deepEqual([dom.source, dom.id], ["domain", "2019876543"]);
  assert.equal(P.resolveListingUrl("https://www.domain.com.au/suburb-profile/glenunga-sa-5064"), null);
  assert.equal(P.resolveListingUrl("https://click.mail.realestate.com.au/unsubscribe?token=abc"), null);
  assert.equal(P.resolveListingUrl("mailto:a@b.c"), null);
});

test("parseAddress, findPrice, findCounts", () => {
  assert.deepEqual(P.parseAddress("12 Example Street, Linden Park SA 5065"), { street: "12 Example Street", suburb: "Linden Park", postcode: "5065" });
  assert.deepEqual(P.parseAddress("3/45 Smith Road, Glenunga"), { street: "3/45 Smith Road", suburb: "Glenunga", postcode: null });
  assert.equal(P.parseAddress("4 Bedrooms, 2 Bathrooms"), null);
  assert.equal(P.findPrice(["x", "$1.2m - $1.3m", "$9"]), "$1.2m - $1.3m");
  assert.equal(P.findPrice(["Auction Sat 5 Dec"]), "Auction Sat 5 Dec");
  assert.equal(P.findPrice(["nothing"]), null);
  assert.deepEqual(P.findCounts(["4 Beds", "2 Baths", "1 Car"]), { beds: 4, baths: 2, cars: 1 });
  assert.deepEqual(P.findCounts(["Bedrooms", "4", "Bathrooms 2", "Parking 3"]), { beds: 4, baths: 2, cars: 3 });
  assert.deepEqual(P.findCounts(["$1,200,000", "Bedrooms 5 Bathrooms 3"]), { beds: 5, baths: 3, cars: null });
  assert.deepEqual(P.findCounts(["nothing here"]), { beds: null, baths: null, cars: null });
});

test("extractListings on the synthetic REA fixture", () => {
  const ls = P.extractListings(html, { subject: "3 new properties for sale" });
  assert.equal(ls.length, 3);
  const [a, b, c] = ls;
  assert.deepEqual(
    { s: a.source, id: a.id, addr: a.address, sub: a.suburb, pc: a.postcode, price: a.priceText, b: [a.beds, a.baths, a.cars], t: a.propertyType, k: a.kind },
    { s: "rea", id: "143456789", addr: "12 Example Street, Linden Park SA 5065", sub: "Linden Park", pc: "5065", price: "$1,450,000 - $1,550,000", b: [4, 2, 2], t: "House", k: "new" });
  assert.equal(a.image, "https://i2.au.reastatic.net/800x600/abc123/main.jpg");
  assert.equal(b.id, "138888001");
  assert.equal(b.address, "3/45 Smith Road, Glenunga SA 5064");
  assert.equal(b.priceText, "Auction Sat 5 Dec");
  assert.deepEqual([b.beds, b.baths, b.cars, b.kind, b.propertyType], [3, 1, 1, "priceChange", "Townhouse"]);
  assert.equal(c.source, "domain");
  assert.deepEqual([c.id, c.priceText, c.beds, c.baths, c.cars, c.kind, c.propertyType], ["2019876543", "Offers over $1.2m", 5, 3, 2, "sold", "House"]);
  assert.equal(c.image, "https://rimh2.domainstatic.com.au/abc/photo.jpg");
});

test("no personal data or tracking tokens in extracted output", () => {
  const out = JSON.stringify(P.extractListings(html));
  for (const bad of ["jane", "gmail", "SECRET", "unsubscribe", "TOKEN", "utm_", "cid="]) assert.ok(!out.toLowerCase().includes(bad.toLowerCase()), bad);
  assert.ok(!out.includes("9 Bathrooms")); // footer text is not read
});

test("opaque tracking links: kept as redirect URL, fields still derived", () => {
  const h = `<a href="https://click.reamail.example/x/AAA"><img src="https://i2.au.reastatic.net/a.jpg"></a>
    <p>9 Opaque Road, Beaumont SA 5066</p><p>$2.1m</p><p>4 Bed 3 Bath 2 Car</p>
    <a href="https://click.reamail.example/x/BBB">View</a>
    <p>Unsubscribe</p>`;
  const [l] = P.extractListings(h);
  assert.equal(l.urlIsRedirect, true);
  assert.equal(l.url, "https://click.reamail.example/x/AAA");
  assert.ok(/^r[a-z0-9]+$/.test(l.id));
  assert.deepEqual([l.address, l.priceText, l.beds, l.baths, l.cars], ["9 Opaque Road, Beaumont SA 5066", "$2.1m", 4, 3, 2]);
});

test("mergeListing: first/last seen, price history, sticky sold, no null overwrite", () => {
  const t1 = "2026-11-23T05:00:00.000Z", t2 = "2026-11-25T05:00:00.000Z", t3 = "2026-11-26T05:00:00.000Z";
  const base = { source: "rea", id: "1", address: "1 A St, X SA 5000", priceText: "$1m", beds: 3, kind: "new" };
  const a = P.mergeListing(null, base, t1);
  assert.deepEqual([a.firstSeen, a.lastSeen, a.priceHistory, a.alertKind], [t1, t1, [{ date: "2026-11-23", priceText: "$1m" }], "new"]);
  const b = P.mergeListing(a, { ...base, priceText: "$950k", beds: null, kind: "priceChange" }, t2);
  assert.deepEqual([b.firstSeen, b.lastSeen, b.beds, b.priceHistory.length, b.alertKind], [t1, t2, 3, 2, "priceChange"]);
  assert.equal(P.mergeListing(b, { ...base, priceText: "$950k", kind: null }, t3).priceHistory.length, 2);
  const s = P.mergeListing(b, { ...base, kind: "sold" }, t3);
  assert.deepEqual([s.sold, s.soldAt], [true, t3]);
  assert.equal(P.mergeListing(s, { ...base, kind: "new" }, t3).sold, true);
});

test("publicView whitelists fields", () => {
  const v = P.publicView({ source: "rea", id: "1", secret: "x", recipient: "a@b.c", priceHistory: [] });
  assert.deepEqual(Object.keys(v).sort(), ["id", "priceHistory", "source"]);
});

// ---- worker handler with an in-memory KV ----
function fakeKV() {
  const m = new Map();
  return {
    m,
    async get(k, t) { const v = m.get(k); return v === undefined ? null : t === "json" ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list({ prefix }) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true }; },
  };
}
const msg = (raw, { from = "bounce@mail.realestate.com.au", forwardFails = false } = {}) => {
  const forwarded = [];
  return { forwarded, from, rawSize: raw.length, headers: new Headers({ subject: "3 new properties" }), raw: new Response(raw).body,
    async forward(to) { if (forwardFails) throw new Error("nope"); forwarded.push(to); } };
};

test("email(): forwards first, stores listings, keeps only 10 raw bodies, serves /listings.json", async () => {
  const env = { ALERTS: fakeKV(), FORWARD_TO: "me@example.com" };
  for (let i = 0; i < 12; i++) {
    const m = msg(eml);
    await worker.email(m, env, {});
    assert.deepEqual(m.forwarded, ["me@example.com"]);
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.equal([...env.ALERTS.m.keys()].filter((k) => k.startsWith("raw:")).length, 10);
  assert.equal([...env.ALERTS.m.keys()].filter((k) => k.startsWith("l:")).length, 3);
  const r = await worker.fetch(new Request("https://x.example/listings.json"), env);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  const list = await r.json();
  assert.equal(list.length, 3);
  assert.equal(list.find((l) => l.id === "143456789").priceHistory.length, 1);
  assert.ok(!JSON.stringify(list).includes("jane"));
  const st = await (await worker.fetch(new Request("https://x.example/status.json"), env)).json();
  assert.equal(st.rea.listings, 3);
  assert.ok(st.rea.at);
  assert.equal(st.domain, null);
  assert.equal((await worker.fetch(new Request("https://x.example/raw"), env)).status, 404);
  assert.equal((await worker.fetch(new Request("https://x.example/listings.json", { method: "POST" }), env)).status, 404);
});

test("email(): non-matching sender is forwarded but not parsed; parse failure and forward failure are contained", async () => {
  const env = { ALERTS: fakeKV(), FORWARD_TO: "me@example.com" };
  const other = eml.replace(/realestate\.com\.au/g, "example.org");
  const m = msg(other, { from: "friend@example.org" });
  await worker.email(m, env, {});
  assert.equal(m.forwarded.length, 1);
  assert.equal([...env.ALERTS.m.keys()].filter((k) => k.startsWith("l:")).length, 0);

  const broken = msg(eml);
  broken.raw = { broken: true }; // Response() will not read this as a stream
  broken.rawSize = 1;
  await worker.email(broken, env, {});
  assert.equal(broken.forwarded.length, 1); // forwarded before the parse blew up

  const ff = msg(eml, { forwardFails: true });
  await assert.doesNotReject(worker.email(ff, env, {}));
});
