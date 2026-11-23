# Data contract

Static site (GitHub Pages) reads JSON from `data/`. A GitHub Action (`.github/workflows/fetch.yml`, Node script `scripts/fetch.mjs`) writes it. No server. Costs nothing.

All money is AUD numbers. Dates are ISO strings. Missing values are `null`, never invented.

## data/areas.json  (edited by the app via GitHub API, read by the pipeline)
```json
{
  "zones": ["Linden Park Primary School", "Glenunga International High School"],
  "zoneMatch": "all",            // "all" = inside every zone (intersection), "any" = inside at least one
  "extraSuburbs": [],            // [{ "suburb": "Burnside", "postcode": "5066" }] included regardless of zones
  "propertyTypes": ["House", "Townhouse", "Villa", "Unit", "ApartmentUnitFlat", "Duplex", "SemiDetached", "Terrace"]
}
```
`zones` names match `properties.school` in `data/zones.geojson` (all 130 SA metro primary + high school zones, official 2025 data from data.sa.gov.au).

## data/zones.geojson
FeatureCollection, `properties: { school, type: "PRIM" | "SEC" }`.

## data/listings.json
```json
{
  "generatedAt": "2026-11-23T05:00:00Z",
  "source": "alerts" | "none", // "alerts" = listings parsed from saved-search emails; "none" = no real listings yet, `listings` is `[]` and the UI shows an empty state
  "listings": [{
    "id": "2019876543",
    "url": "https://www.domain.com.au/...",
    "headline": "Character home on a quiet street",
    "address": "12 Example St, Linden Park SA 5065",
    "suburb": "Linden Park", "postcode": "5065",
    "lat": -34.95, "lng": 138.65,
    "propertyType": "House",
    "bedrooms": 4, "bathrooms": 2, "carspaces": 2,
    "landArea": 720, "buildingArea": null,           // m²
    "priceText": "$1.45m - $1.55m",
    "priceLow": 1450000, "priceHigh": 1550000,        // parsed from priceText; null if unknown
    "saleMethod": "auction" | "privateTreaty" | "eoi" | null,
    "auctionDate": "2026-12-06T11:00:00+10:30" | null,
    "photos": ["https://bucket-api.domain.com.au/..."],
    "description": "first ~600 chars",
    "features": ["Ducted air", "Pool"],
    "dateListed": "2026-10-30",
    "daysOnMarket": 24,
    "firstSeen": "2026-11-01",                        // first pipeline run that saw it
    "priceHistory": [{ "date": "2026-11-01", "priceText": "...", "priceLow": 1500000, "priceHigh": 1600000 }], // asking-price changes we observed
    "salesHistory": [{ "date": "2015-03-12", "price": 820000 }],   // past sales of this property; always [] (emails do not carry it)
    "inspections": [{ "start": "2026-11-29T10:00:00+10:30", "end": "2026-11-29T10:30:00+10:30" }],
    "agents": [{ "name": "Jane Smith", "phone": "0400 000 000", "email": "jane@agency.com.au", "agency": "Agency Name", "photo": null }],
    "zones": ["Linden Park Primary School", "Glenunga International High School"],
    "status": "active" | "underOffer" | "removed",   // see "Email-alert listings" below
    "origin": "rea" | "domain",                       // which portal the listing is from (additive; absent on sample/legacy rows)
    "via": "alerts",                                 // how the pipeline got it (additive)
    "ai": {
      "summary": "2-3 sentences", "pros": ["..."], "cons": ["..."],
      "fairValueLow": 1400000, "fairValueHigh": 1520000,
      "verdict": "Worth inspecting" | "Fair" | "Overpriced" | "Strong value",
      "model": "openai/gpt-4.1-mini", "generatedAt": "..."
    } | null
  }]
}
```

### Email-alert listings (`via: "alerts"`)
Listings come from saved-search alert emails (realestate.com.au, domain.com.au). A Cloudflare Email Worker (`worker/`, name `house-alerts`) forwards each alert and stores the listings it can parse in KV; `GET <worker>/listings.json` serves them (public fields only: source, id, url, address, suburb, postcode, priceText, beds/baths/cars, image, propertyType, alertKind, sold, firstSeen, lastSeen, priceHistory). Never stored or served: recipient, unsubscribe or tracking links, the raw email.

The pipeline `alerts` step (`scripts/fetch.mjs`, helpers in `scripts/lib.mjs`):
- maps each item to the listing contract. `id` is `rea-<digits>` for realestate.com.au and the plain Domain id for domain.com.au. Fields an email cannot give are `null`, `[]` or `""` (land and building area, description, agents, inspections, auction date, sales history).
- geocodes the address with OpenStreetMap Nominatim (max 1 request/second, User-Agent `adelaide-house-hunt/1.0 (...)`). Results are cached in `data/geocode.json` keyed by the normalised address (`{ "lat", "lng" }`); a cached address is never looked up again. A failed lookup is cached as `{ "miss": "<iso>" }` and retried after 7 days; HTTP errors are not cached. Only street or building level hits count (suburb centroids are rejected), and only inside South Australia.
- keeps the listing if its point is inside the selected zones (`zoneMatch`) or its suburb is in `extraSuburbs`; others are dropped. A listing with no map point is kept only if its suburb is in `extraSuburbs` (`lat`/`lng` null).
- an alert listing is never marked `removed` because it is absent from a run. It stays `active` until 60 days after `lastSeen`, then is dropped. If an alert says it is sold, `status` becomes `"removed"` with `sold: true` and `removedDate` = the alert date; it is dropped on the same 60-day rule.
- additive fields: `lastSeen` (date of the latest alert that mentioned it), `alertKind` (`"new" | "priceChange" | "openHome" | "sold" | null`), `urlIsRedirect` (true only when the email link could not be decoded, so `url` is a tracking redirect), `sold`.
- `priceHistory` comes from the worker (asking-price text changes seen in alerts). `firstSeen` is the date of the first alert; `dateListed` is `null`, so `daysOnMarket` counts from `firstSeen`.

`source` is `"alerts"` when any alert listing exists, else `"none"` (`{ "source": "none", "listings": [] }`). The pipeline never writes sample listings or sample suburbs to `data/`; sample data lives only in `dev/fixtures/` (open the app with `?data=dev/fixtures`).

## data/manual.json  (listings added by hand)
`[{ "url": "https://www.realestate.com.au/property-house-sa-linden+park-145678901", "address": "12 Example St, Linden Park SA 5065", "priceText": "$1.5m" | null, "beds": "4" | null, "baths": null, "cars": null, "addedAt": "2026-11-23" }]`. Written by the app's **Add a listing** form through the GitHub API. The `alerts` step maps each entry like a worker item (`lastSeen` = today, so it never expires) and marks the listing `manual: true`; manual listings are kept even outside the zones or without a map point. A worker (email) copy of the same listing wins.

## data/geocode.json
`{ "<normalised address>": { "lat": -34.94, "lng": 138.63 } | { "miss": "2026-11-23T05:00:00Z" } }`. Written by the `alerts` step.

## data/suburbs.json  (multi-year trend)
```json
{
  "_source": "SA Valuer-General via data.sa.gov.au",
  "_fetchedAt": "2026-11-23T05:00:00Z",
  "_method": "...",
  "Linden Park|5065": { "house": [{ "year": 2016, "median": 820000, "sales": 64, "quarters": 4 }], "unit": [] }
}
```
Primary source is `scripts/sa_medians.py` (weekly; it skips itself while `_fetchedAt` is under 7 days old, `--force` overrides). It reads the SA Government dataset "Metro median house sales" on data.sa.gov.au (Valuer-General sales by suburb; one quarterly XLSX per quarter from Q1 2015, discovered through the CKAN API; downloads cached in `.cache/sa_medians/`, which is gitignored and cached by the workflow). It covers all ~425 metro suburbs it can map to a postcode (postcodes come from the open australian_postcodes.csv, with a built-in list as fallback).
- The files carry no annual figure: each gives quarterly sales and median price for a quarter and the same quarter a year earlier. `house[].median` is the **median of that year's quarterly medians** (not a median of all sales), `sales` is the sum of the quarterly sales counts, `quarters` is how many quarters contributed (4 = full year; the current year is partial). Years start at 2015. `unit` is `[]` (the dataset is houses only).

Additive fields written by the pipeline (UI may ignore): `house[].quarters` in suburbs.json, listing `removedDate` (set when status is "removed"), `ai.priceText` (asking price the analysis was for). Keys starting with `_` in suburbs.json are metadata, not suburbs.

## data/macro.json
```json
{
  "generatedAt": "...",
  "cashRate":     { "current": 3.60, "asOf": "2026-11-04", "history": [{ "date": "2016-01", "value": 2.0 }], "forecast": [{ "date": "2027-03", "value": 3.5, "lo": 3.1, "hi": 3.85 }] },
  "cpi":          { "current": 3.0,  "asOf": "2026-09", "history": [{ "date": "2016-03", "value": 1.3 }], "forecast": [{ "date": "2027-03", "value": 2.8, "lo": 2.2, "hi": 3.4 }] },
  "mortgageRate": { "current": 5.9,  "asOf": "2026-10", "history": [...], "label": "Owner-occupier variable, new loans, all institutions (RBA F6)" }  // no forecast for mortgageRate; its history starts 2019 (F6 start),
  "unemployment": { "current": 4.9, "asOf": "2026-10", "history": [...], "label": "Seasonally adjusted, % of labour force (ABS via RBA H5)" }  // monthly, no forecast; kept from the previous file if H5 fails,
  "method": "Plain-English description of the forecast model",
  "sources": [{ "name": "RBA F1.1", "url": "https://www.rba.gov.au/statistics/tables/csv/f1.1-data.csv" }]
}
```
History monthly for cash/mortgage, quarterly for CPI (year-ended %). Forecast 8 quarters ahead with 80% band.
When a fresh (under 2 days) `data/forecast_timesfm.json` exists, `forecast` is the equal-weight blend of our rule model and Google TimesFM (average value; band = min of los to max of his; cash rate rounded to 0.05) and `cashRate`/`cpi` gain an optional `forecastComponents: { rule: [...], timesfm: [...] }` (same point shape). Otherwise `forecast` is the rule model alone and `forecastComponents` is absent. `method` names the models in use.

## data/news.json
```json
{ "generatedAt": "...", "items": [{ "title": "...", "link": "...", "source": "ABC News", "date": "...", "category": "adelaide" | "property" | "economy" | "rba",
  "topics": ["rates", "inflation", "housing", "adelaide", "budget"], "importance": 2.5 }] }
```
Max 40 items, newest first, deduped by title. Feeds: RBA media releases, the ABC business feed (kept only when the title matches relevance keywords such as inflation, CPI, interest rate, RBA, mortgage, housing, budget, Treasury, Chalmers, Adelaide, SA; the rest is dropped) and Google News queries (Adelaide property/house prices/housing market, SA property prices, RBA interest rates and cash rate decision, Australia/Chalmers/Treasury inflation and budget). `topics` is zero or more tags from the title; `importance` is 0-3 (inflation, rates, RBA, Treasury and forecast terms and Adelaide housing score higher, plus a recency bonus). Older files may lack `topics` and `importance`; the UI falls back to `category`.

## data/market.json  (AI market view)
```json
{ "generatedAt": "...", "model": "...", "headline": "one line", "outlook": "paragraph", "timing": "when-to-buy view with reasoning", "risks": ["..."], "watch": ["signals to watch"], "disclaimer": "Not financial advice." } 
```

## App-side (localStorage, per device; export/import as JSON)
- `hh.prefs`: { minBeds, minBaths, minCars, maxPrice, minLand, types[], mustHave[], notes }
- `hh.saved`: { [listingId]: { status: "shortlist" | "hidden", note } }
- `hh.gh`: { token, repo }  fine-grained PAT (this repo only; Actions: write, Contents: write) for "Fetch new" and editing areas.json
- `hh.finance`: { deposit, income, termYears, ... }
