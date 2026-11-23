# Adelaide House Hunt

A free personal app for finding homes in the **Linden Park Primary School** and **Glenunga International High School** zones (official 2025 SA zone maps). You can add or remove other school zones and suburbs inside the app.

It works on phone, tablet and desktop. It runs entirely on GitHub's free tier:

| Part | Free service |
|---|---|
| Website | GitHub Pages |
| Fetching listings, rates and news (twice a day + the **Fetch new** button) | GitHub Actions |
| AI property and market analysis | GitHub Models (uses the Action's built-in token) |
| Listings, photos, agents, open homes, sales history, suburb trends | Domain Developer API (free tier) |
| Cash rate, inflation, mortgage rates | Reserve Bank of Australia (RBA) statistics |
| News | ABC, RBA, Google News RSS feeds |

The interest rate and inflation forecasts come from a simple model built into this app. They are not official forecasts. The method is explained on screen. Nothing here is financial advice.

## One-time setup

### 1. Domain API key (for real listings)
1. Sign up at <https://developer.domain.com.au> and create a **Project**.
2. Add these APIs on the free plan: **Agents & Listings**, **Properties & Locations**, and **Suburb Performance Statistics** if offered.
3. Under **Credentials**, create an **OAuth client** using the *Client credentials* type. Copy the Client ID and Client Secret.
4. In this GitHub repo, go to **Settings → Secrets and variables → Actions → New repository secret** and add:
   - `DOMAIN_CLIENT_ID`
   - `DOMAIN_CLIENT_SECRET`
5. Go to **Actions → Fetch data → Run workflow**. Until this is done, the app shows clearly labelled *sample* listings.

### 2. The "Fetch new" button and editing areas (once per device)
1. Create a fine-grained token at <https://github.com/settings/personal-access-tokens/new>.
   - Repository access: **Only select repositories →** this repo
   - Permissions: **Actions: Read and write** and **Contents: Read and write**
2. In the app, open **More → Settings** and paste the token. It is stored only in that browser.

Without a token the app still works. It shows data from the last scheduled run, every morning and evening.

### 3. Syncing preferences between devices
Preferences, your shortlist and notes are saved on each device. Use **More → Export / Import** to copy them to another device.

## Development
```bash
python3 -m http.server 8765        # then open http://localhost:8765/?data=dev/fixtures
node --test scripts/ assets/       # tests
DOMAIN_CLIENT_ID=… DOMAIN_CLIENT_SECRET=… GITHUB_TOKEN=$(gh auth token) node scripts/fetch.mjs
```
The data format is described in [docs/DATA.md](docs/DATA.md).
