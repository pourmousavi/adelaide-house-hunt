import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeImport, bookmarkletHref } from "./bookmarklet.js";

test("mergeImport adds, refreshes imports, leaves hand-added entries and skips rows without an address", () => {
  const list = [
    { url: "https://www.realestate.com.au/property-house-sa-glenunga-111111", address: "1 A St, Glenunga", addedAt: "2026-11-01" },
    { url: "https://www.realestate.com.au/property-house-sa-glenunga-222222", address: "2 B St, Glenunga", via: "bookmarklet", addedAt: "2026-11-01", seenAt: "2026-11-01", priceText: "$1m" },
  ];
  const items = [
    { url: "https://www.realestate.com.au/property-house-sa-glenunga-111111", address: "1 A St, Glenunga", priceText: "$9m" },
    { url: "https://www.realestate.com.au/property-house-sa-glenunga-222222", address: "2 B St, Glenunga", priceText: "$1.1m", beds: 3 },
    { url: "https://www.realestate.com.au/property-house-sa-glenunga-333333", address: "3 C St, Glenunga" },
    { url: "https://www.realestate.com.au/property-house-sa-glenunga-444444", address: null },
  ];
  const r = mergeImport(list, items, "2026-11-23");
  assert.deepEqual([r.added, r.updated, r.skipped], [1, 1, 2]);
  assert.equal(r.list[0].priceText, undefined, "hand-added entry untouched");
  assert.deepEqual([r.list[1].priceText, r.list[1].beds, r.list[1].seenAt, r.list[1].addedAt], ["$1.1m", 3, "2026-11-23", "2026-11-01"]);
  assert.equal(r.list[2].via, "bookmarklet");
  assert.equal(list[1].priceText, "$1m", "input not mutated");
});

test("bookmarkletHref is a javascript: URL that parses", () => {
  const href = bookmarkletHref("https://example.com/app/");
  assert.ok(href.startsWith("javascript:"));
  new Function(decodeURIComponent(href.slice(11))); // throws on a syntax error
});

test("mergeImport: a sold item marks the existing entry sold without touching its asking price", () => {
  const list = [
    { url: "https://www.realestate.com.au/property-house-sa-glenunga-111111", address: "1 A St, Glenunga", priceText: "$1.7m", via: "bookmarklet", seenAt: "2026-11-01" },
    { url: "https://www.realestate.com.au/property-house-sa-glenunga-222222", address: "2 B St, Glenunga", priceText: "$2m" }, // hand-added
  ];
  const items = [
    { url: "https://www.realestate.com.au/sold/property-house-sa-glenunga-111111", address: "1 A St, Glenunga", sold: true, soldDate: "2026-11-15", soldPriceText: "$1,850,000" },
    { url: "https://www.realestate.com.au/sold/property-house-sa-glenunga-222222", address: "2 B St, Glenunga", sold: true, soldDate: "2026-11-16", soldPriceText: null },
    { url: "https://www.realestate.com.au/sold/property-house-sa-glenunga-333333", address: "3 C St, Glenunga", sold: true, soldDate: "2026-11-10", soldPriceText: "$1.2m" },
  ];
  const r = mergeImport(list, items, "2026-11-24");
  assert.deepEqual([r.added, r.updated, r.sold], [1, 2, 3]);
  assert.deepEqual([r.list[0].priceText, r.list[0].sold, r.list[0].soldPriceText], ["$1.7m", true, "$1,850,000"]);
  assert.deepEqual([r.list[1].priceText, r.list[1].sold, r.list[1].via], ["$2m", true, undefined]);
  assert.deepEqual([r.list[2].priceText, r.list[2].soldDate], [null, "2026-11-10"]);
});
