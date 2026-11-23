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
  "source": "domain" | "sample",      // "sample" = Domain key not configured yet; UI must show a clear banner
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
    "priceLow": 1450000, "priceHigh": 1550000,        // parsed from priceText / Domain priceDetails; null if unknown
    "saleMethod": "auction" | "privateTreaty" | "eoi" | null,
    "auctionDate": "2026-12-06T11:00:00+10:30" | null,
    "photos": ["https://bucket-api.domain.com.au/..."],
    "description": "first ~600 chars",
    "features": ["Ducted air", "Pool"],
    "dateListed": "2026-10-30",
    "daysOnMarket": 24,
    "firstSeen": "2026-11-01",                        // first pipeline run that saw it
    "priceHistory": [{ "date": "2026-11-01", "priceText": "...", "priceLow": 1500000, "priceHigh": 1600000 }], // asking-price changes we observed
    "salesHistory": [{ "date": "2015-03-12", "price": 820000 }],   // past sales of this property (Domain properties API); [] if unknown
    "inspections": [{ "start": "2026-11-29T10:00:00+10:30", "end": "2026-11-29T10:30:00+10:30" }],
    "agents": [{ "name": "Jane Smith", "phone": "0400 000 000", "email": "jane@agency.com.au", "agency": "Agency Name", "photo": null }],
    "zones": ["Linden Park Primary School", "Glenunga International High School"],
    "status": "active" | "underOffer" | "removed",   // "removed" kept 30 days after it disappears
    "ai": {
      "summary": "2-3 sentences", "pros": ["..."], "cons": ["..."],
      "fairValueLow": 1400000, "fairValueHigh": 1520000,
      "verdict": "Worth inspecting" | "Fair" | "Overpriced" | "Strong value",
      "model": "openai/gpt-4.1-mini", "generatedAt": "..."
    } | null
  }]
}
```

## data/suburbs.json  (multi-year trend, Domain suburb performance statistics)
```json
{ "Linden Park|5065": { "house": [{ "year": 2016, "median": 820000, "sales": 64 }], "unit": [...] } }
```

Additive fields written by the pipeline (UI may ignore): listing `removedDate` (set when status is "removed"), `ai.priceText` (asking price the analysis was for), per-suburb `fetchedAt` in suburbs.json. Keys starting with `_` in suburbs.json (e.g. `_sample`) are metadata, not suburbs. `agents[].phone/email` come from Domain GET /v1/agents/{id} (cached 30 days in `data/agents.json`, keyed by contact id: `{name, phone, email, agency, photo, fetchedAt}`); null if that scope is unavailable.

## data/macro.json
```json
{
  "generatedAt": "...",
  "cashRate":     { "current": 3.60, "asOf": "2026-11-04", "history": [{ "date": "2016-01", "value": 2.0 }], "forecast": [{ "date": "2027-03", "value": 3.5, "lo": 3.1, "hi": 3.85 }] },
  "cpi":          { "current": 3.0,  "asOf": "2026-09", "history": [{ "date": "2016-03", "value": 1.3 }], "forecast": [{ "date": "2027-03", "value": 2.8, "lo": 2.2, "hi": 3.4 }] },
  "mortgageRate": { "current": 5.9,  "asOf": "2026-10", "history": [...], "label": "Owner-occupier variable, new loans, all institutions (RBA F6)" }  // no forecast for mortgageRate; its history starts 2019 (F6 start),
  "method": "Plain-English description of the forecast model",
  "sources": [{ "name": "RBA F1.1", "url": "https://www.rba.gov.au/statistics/tables/csv/f1.1-data.csv" }]
}
```
History monthly for cash/mortgage, quarterly for CPI (year-ended %). Forecast 8 quarters ahead with 80% band.
When a fresh (under 2 days) `data/forecast_timesfm.json` exists, `forecast` is the equal-weight blend of our rule model and Google TimesFM (average value; band = min of los to max of his; cash rate rounded to 0.05) and `cashRate`/`cpi` gain an optional `forecastComponents: { rule: [...], timesfm: [...] }` (same point shape). Otherwise `forecast` is the rule model alone and `forecastComponents` is absent. `method` names the models in use.

## data/news.json
```json
{ "generatedAt": "...", "items": [{ "title": "...", "link": "...", "source": "ABC News", "date": "...", "category": "adelaide" | "property" | "economy" | "rba" }] }
```
Max ~30 items, newest first, deduped by title.

## data/market.json  (AI market view)
```json
{ "generatedAt": "...", "model": "...", "headline": "one line", "outlook": "paragraph", "timing": "when-to-buy view with reasoning", "risks": ["..."], "watch": ["signals to watch"], "disclaimer": "Not financial advice." } 
```

## App-side (localStorage, per device; export/import as JSON)
- `hh.prefs`: { minBeds, minBaths, minCars, maxPrice, minLand, types[], mustHave[], notes }
- `hh.saved`: { [listingId]: { status: "shortlist" | "hidden", note } }
- `hh.gh`: { token, repo }  fine-grained PAT (this repo only; Actions: write, Contents: write) for "Fetch new" and editing areas.json
- `hh.finance`: { deposit, income, termYears, ... }
