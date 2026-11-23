// Loads the JSON data files described in docs/DATA.md. Every file may be missing:
// each loader resolves to { ok, data, error } and never throws.

const params = new URLSearchParams(location.search);
export const DATA_BASE = (params.get('data') || 'data').replace(/\/+$/, '');
export const IS_FIXTURES = DATA_BASE !== 'data';

export const FILES = {
  areas: 'areas.json',
  listings: 'listings.json',
  suburbs: 'suburbs.json',
  macro: 'macro.json',
  news: 'news.json',
  market: 'market.json',
};

export async function loadJSON(file, { bust = false } = {}) {
  const url = `${DATA_BASE}/${file}${bust ? `?v=${Date.now()}` : ''}`;
  try {
    const res = await fetch(url, bust ? { cache: 'no-store' } : {});
    if (!res.ok) return { ok: false, data: null, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, data, error: null };
  } catch (e) {
    return { ok: false, data: null, error: e?.message || 'network error' };
  }
}

/** Load all small data files in parallel. zones.geojson is loaded separately (it is ~1 MB). */
export async function loadAll({ bust = false } = {}) {
  const names = Object.keys(FILES);
  const results = await Promise.all(names.map((n) => loadJSON(FILES[n], { bust })));
  const out = { errors: {} };
  names.forEach((n, i) => {
    const r = results[i];
    out[n] = r.ok ? validate(n, r.data) : null;
    if (!r.ok) out.errors[n] = r.error;
    else if (out[n] == null) out.errors[n] = 'unexpected shape';
  });
  return out;
}

let zonesPromise = null;
/** zones.geojson is real data that lives in data/; when previewing fixtures fall back to it. */
export function loadZones({ bust = false } = {}) {
  if (!zonesPromise || bust) {
    const parse = (r) => (r.ok && Array.isArray(r.data?.features) ? { ok: true, features: r.data.features, error: null } : null);
    const q = bust ? `?v=${Date.now()}` : '';
    const primary = IS_FIXTURES ? fetchJSON(`data/zones.geojson${q}`) : loadJSON('zones.geojson', { bust });
    zonesPromise = primary.then(async (r) => {
      const first = parse(r);
      if (first) return first;
      if (IS_FIXTURES) {
        const second = parse(await loadJSON('zones.geojson', { bust }));
        if (second) return second;
      }
      return { ok: false, features: [], error: r.error || 'unexpected shape' };
    });
  }
  return zonesPromise;
}

async function fetchJSON(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return { ok: false, data: null, error: `HTTP ${res.status}` };
    return { ok: true, data: await res.json(), error: null };
  } catch (e) {
    return { ok: false, data: null, error: e?.message || 'network error' };
  }
}

/** Light validation so a half-written file degrades to "missing" instead of crashing. */
function validate(name, d) {
  if (!d || typeof d !== 'object') return null;
  switch (name) {
    case 'areas':
      return { zones: arr(d.zones), zoneMatch: d.zoneMatch === 'any' ? 'any' : 'all', extraSuburbs: arr(d.extraSuburbs), propertyTypes: arr(d.propertyTypes) };
    case 'listings':
      return { generatedAt: d.generatedAt || null, source: d.source || 'unknown', listings: arr(d.listings).filter((l) => l && l.id != null) };
    case 'suburbs':
      return d;
    case 'macro':
      return d;
    case 'news':
      return { generatedAt: d.generatedAt || null, items: arr(d.items).filter((i) => i && i.title) };
    case 'market':
      return d.headline || d.outlook ? d : null;
    default:
      return d;
  }
}
const arr = (x) => (Array.isArray(x) ? x : []);

/** The most recent generatedAt across files, for "Data updated X ago". */
export function latestGeneratedAt(data) {
  const stamps = ['listings', 'macro', 'news', 'market']
    .map((k) => data?.[k]?.generatedAt)
    .filter(Boolean)
    .map((s) => new Date(s).getTime())
    .filter((t) => !Number.isNaN(t));
  return stamps.length ? new Date(Math.max(...stamps)).toISOString() : null;
}

// ---------- geometry (point in school zone) ----------

function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi) inside = !inside;
  }
  return inside;
}

export function pointInFeature(lng, lat, feature) {
  const g = feature?.geometry;
  if (!g) return false;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  return polys.some((poly) => pointInRing(lng, lat, poly[0]) && !poly.slice(1).some((hole) => pointInRing(lng, lat, hole)));
}

/** Add any of the given zone names the listing falls inside (by lat/lng) to listing.zones. */
export function applyZonesLocally(listings, zoneFeatures, zoneNames) {
  const feats = zoneFeatures.filter((f) => zoneNames.includes(f.properties?.school));
  for (const l of listings) {
    if (l.lat == null || l.lng == null) continue;
    const zs = new Set(l.zones || []);
    for (const f of feats) if (pointInFeature(l.lng, l.lat, f)) zs.add(f.properties.school);
    l.zones = [...zs];
  }
}
