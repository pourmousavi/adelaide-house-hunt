# Adelaide House Hunt

A free personal app for finding homes in the **Linden Park Primary School** and **Glenunga International High School** zones (official 2025 SA zone maps). You can add or remove other school zones and suburbs inside the app.

It works on phone, tablet and desktop. It runs entirely on GitHub's free tier:

| Part | Free service |
|---|---|
| Website | GitHub Pages |
| Fetching listings, rates and news (twice a day + the **Fetch new** button) | GitHub Actions |
| AI property and market analysis | Google Gemini API free tier (any OpenAI-compatible provider works) |
| Listings (address, price, beds/baths/cars, photo) | Your realestate.com.au / domain.com.au saved-search **email alerts**, parsed by a Cloudflare Email Worker (free tier) |
| Suburb median price trends | SA Government open data (Valuer-General sales, data.sa.gov.au) |
| Map points for listings | OpenStreetMap Nominatim (cached) |
| Cash rate, inflation, mortgage rates | Reserve Bank of Australia (RBA) statistics |
| News | ABC, RBA, Google News RSS feeds |

The interest rate and inflation forecasts blend two models: a simple economic-rule model and Google's open-source **TimesFM** forecasting model. They are not official forecasts. The method is explained on screen. Nothing here is financial advice.

## One-time setup

### 1. Listings from your email alerts
Listings come only from your saved-search email alerts. (Domain's API was tried and dropped: its free plan returns nothing usable and there is no clear paid plan.) Alerts only report listings that are new or changed after the search is saved, so homes already on the market before that do not appear.

How the email flow works:
1. In realestate.com.au (and optionally domain.com.au), save your searches and turn on email alerts to your alert address (`ali@alipourmousavi.com`).
2. That address uses Cloudflare Email Routing. A routing rule sends each message to the **`house-alerts`** Email Worker (`worker/`). The worker first forwards every email to your normal inbox, then reads the realestate.com.au / domain.com.au ones, extracts the listings (address, price, beds/baths/cars, photo, new / price change / sold) and keeps them in Cloudflare KV. No personal data, unsubscribe links or tracking tokens are stored or published.
3. Twice a day the GitHub Action downloads `<worker URL>/listings.json`, finds each address on the map (OpenStreetMap, cached in `data/geocode.json`), keeps the ones inside your school zones (or extra suburbs), and writes `data/listings.json`. A listing stays for 60 days after the last alert that mentioned it, unless an alert says it sold.
4. Until the first alert arrives the listings page is empty.
5. **Homes already on the market**: on the Listings page open **Add a listing**, paste the property's own link (one listing, not a search page) and its street address, plus price and beds/baths/cars if you like. It is saved to `data/manual.json` (needs the GitHub token from step 3) and a fetch starts. Hand-added listings are shown even outside the zones and stay until you delete them from `data/manual.json` or an alert says they sold.
6. **Whole search pages at once (bookmarklet)**: in **Settings → Import from a search page**, drag the *House Hunt import* button to your bookmarks bar. On a realestate.com.au or domain.com.au search-results page, click it: the app opens with every listing it read from that page; click **Import**. One click per results page. Imported listings go through the zone filter and drop off 60 days after you last imported them (unless an alert mentions them). The bookmarklet finds cards from their listing links, not the sites' class names, but a big site redesign can still break it.
7. **Sold homes and sale prices**: run the same bookmarklet on a *Sold* search-results page (realestate.com.au or domain.com.au, "Sold" selected) now and then, say weekly. Homes in your list that appear there move to the **Sold** tab with their sale price and date ("price withheld" when the site hides it); other sold homes inside your zones are added too. Sold homes stay 12 months and are given to the AI as recent sales nearby when it judges asking prices. Sold alert emails also move a home to Sold, without a price.

Deploying the worker (already done once): `cd worker && wrangler deploy`. The Action reads the worker URL from the `ALERTS_URL` repository variable (optional; the deployed URL is the default).

### 2. Free AI key (for the AI analysis)
1. Go to <https://aistudio.google.com/apikey>, sign in with a Google account and click **Create API key**. No card is needed for the free tier.
2. Add it as a repository secret named `AI_API_KEY` (Settings → Secrets and variables → Actions → New repository secret).
3. Optional: to use another provider, e.g. Groq or OpenRouter, set the repository **variables** `AI_BASE_URL` (its OpenAI-compatible chat-completions URL) and `AI_MODEL`.

### 3. The "Fetch new" button and editing areas (once per device)
1. Create a fine-grained token at <https://github.com/settings/personal-access-tokens/new>.
   - Repository access: **Only select repositories →** this repo
   - Permissions: **Actions: Read and write** and **Contents: Read and write**
2. In the app, open **More → Settings** and paste the token. It is stored only in that browser.

Without a token the app still works. It shows data from the last scheduled run, every morning and evening.

### 4. Syncing preferences between devices
Preferences, your shortlist and notes are saved on each device. Use **More → Export / Import** to copy them to another device.

## Development
```bash
python3 -m http.server 8765        # then open http://localhost:8765/?data=dev/fixtures
node --test scripts/*.test.mjs assets/*.test.mjs worker/test.mjs   # tests
python3 scripts/sa_medians.py --force   # suburb median trends (weekly in the Action)
AI_API_KEY=… node scripts/fetch.mjs
```
The data format is described in [docs/DATA.md](docs/DATA.md).
