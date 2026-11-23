// Price estimate for listings with no published price: a ridge regression on log(asking midpoint)
// fitted to the priced listings in the same dataset (same school zones, so they are the comparables).
// ponytail: asking prices, not sale prices, and ~70 comps; a guide, not a valuation. Feed sold prices
// in as training rows if the pipeline ever gets them.

const mid = (l) => (l.priceLow != null && l.priceHigh != null ? (l.priceLow + l.priceHigh) / 2 : (l.priceLow ?? l.priceHigh ?? null));
const text = (l) => `${l.headline || ''} ${l.description || ''} ${(l.features || []).join(' ')}`;

export function hasPool(l) { return /\b(swimming |in-?ground |solar[- ]heated )?pool\b(?!\s*table)/i.test(text(l)) ? 1 : 0; }

export function buildYear(l) {
  const t = text(l);
  if (/\b(brand[- ]new|newly built|new build)\b/i.test(t)) return new Date().getFullYear();
  const m = t.match(/\bbuilt\s+(?:in\s+|circa\s+|c\.?\s*|around\s+)?((?:18|19|20)\d{2})\b/i);
  return m ? +m[1] : null;
}

/** suburbs.json key for a listing; listings from alerts often have no postcode, so fall back to the name. */
export function suburbKey(l, suburbs) {
  if (!suburbs || !l.suburb) return null;
  const name = l.suburb.toLowerCase();
  const keys = Object.keys(suburbs);
  return keys.find((k) => k.toLowerCase() === `${name}|${l.postcode}`) ?? keys.find((k) => k.toLowerCase().startsWith(`${name}|`)) ?? null;
}

function suburbMedian(l, suburbs) {
  const key = suburbKey(l, suburbs);
  if (!key) return null;
  const kind = ['Unit', 'ApartmentUnitFlat'].includes(l.propertyType) ? 'unit' : 'house';
  const rows = (suburbs[key]?.[kind] || []).filter((r) => r?.median);
  return rows.length ? rows.at(-1).median : null;
}

// Raw feature row; null = unknown (imputed with the training mean, so it neither helps nor hurts).
const FEATURES = ['bedrooms', 'bathrooms', 'car spaces', 'land size', 'pool', 'build year', 'house vs unit', 'suburb median'];
function row(l, suburbs) {
  const sm = suburbMedian(l, suburbs);
  return [
    l.bedrooms ?? null, l.bathrooms ?? null, l.carspaces == null ? null : Math.min(l.carspaces, 4),
    l.landArea > 0 ? Math.log(l.landArea) : null, hasPool(l), buildYear(l),
    ['Unit', 'ApartmentUnitFlat'].includes(l.propertyType) ? 0 : 1, sm ? Math.log(sm) : null,
  ];
}

function solve(A, b) { // Gaussian elimination with partial pivoting; A is small and ridge-regularised
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    const p = M.reduce((best, r, i) => (i >= c && Math.abs(r[c]) > Math.abs(M[best][c]) ? i : best), c);
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) x[r] = (M[r][n] - M[r].slice(r + 1, n).reduce((s, v, k) => s + v * x[r + 1 + k], 0)) / M[r][r];
  return x;
}

function fit(train, suburbs, lambda) {
  const X = train.map((l) => row(l, suburbs));
  const y = train.map((l) => Math.log(mid(l)));
  // Standardise each column on the known values; drop columns with no spread (e.g. land when nobody publishes it).
  const cols = FEATURES.map((_, j) => {
    const v = X.map((r) => r[j]).filter((x) => x != null);
    const mean = v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
    const sd = v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1)) : 0;
    return { j, mean, sd };
  }).filter((c) => c.sd > 1e-9);
  const z = (r) => cols.map((c) => ((r[c.j] ?? c.mean) - c.mean) / c.sd);
  const Z = X.map(z);
  const ym = y.reduce((a, b) => a + b, 0) / y.length;
  const A = cols.map((_, i) => cols.map((_, j) => Z.reduce((s, r) => s + r[i] * r[j], 0) + (i === j ? lambda : 0)));
  const w = solve(A, cols.map((_, i) => Z.reduce((s, r, n) => s + r[i] * (y[n] - ym), 0)));
  const pred = (r) => ym + z(r).reduce((s, v, i) => s + v * w[i], 0);
  const resid = X.map((r, i) => y[i] - pred(r));
  const sigma = Math.sqrt(resid.reduce((s, e) => s + e * e, 0) / Math.max(1, train.length - cols.length - 1)); // ~68% band in log space
  return { pred, sigma, cols, resid };
}

/** Sets l.estimate = { low, mid, high, n, basis } on every listing without a price. Returns the count. */
export function estimatePrices(listings, suburbs, { lambda = 1, minComps = 8 } = {}) {
  for (const l of listings) delete l.estimate;
  let train = listings.filter((l) => mid(l) > 0);
  if (train.length < minComps) return 0;
  let m = fit(train, suburbs, lambda);
  // One robust pass: drop comps the features can't explain (an $11m estate with undisclosed land) and refit.
  const kept = train.filter((_, i) => Math.abs(m.resid[i]) <= 2.5 * m.sigma);
  if (kept.length >= minComps && kept.length < train.length) { train = kept; m = fit(train, suburbs, lambda); }
  const round = (v) => Math.round(v / 10000) * 10000;
  let count = 0;
  for (const l of listings) {
    if (mid(l) > 0) continue;
    const r = row(l, suburbs);
    const p = m.pred(r);
    const basis = m.cols.filter((c) => r[c.j] != null).map((c) => FEATURES[c.j]);
    l.estimate = { low: round(Math.exp(p - m.sigma)), mid: round(Math.exp(p)), high: round(Math.exp(p + m.sigma)), n: train.length, basis };
    count++;
  }
  return count;
}
