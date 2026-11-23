// localStorage-backed state (per device). Keys follow docs/DATA.md.

export const KEYS = {
  prefs: 'hh.prefs',
  saved: 'hh.saved',
  gh: 'hh.gh',
  finance: 'hh.finance',
  areasLocal: 'hh.areasLocal',
  theme: 'hh.theme',
};

export const DEFAULT_PREFS = {
  minBeds: 0, minBaths: 0, minCars: 0, maxPrice: null, minLand: null,
  types: [], mustHave: [], notes: '', sort: 'newest', view: 'all',
};
export const DEFAULT_FINANCE = {
  price: 1500000, depositMode: 'amount', deposit: 300000, depositPct: 20,
  incomes: [150000, 90000], termYears: 30, ratePct: '', bufferPct: 3,
};
export const DEFAULT_GH = { repo: 'pourmousavi/adelaide-house-hunt', token: '' };

export function get(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return structuredClone(fallback);
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && fallback && typeof fallback === 'object' && !Array.isArray(fallback)
      ? { ...structuredClone(fallback), ...v }
      : v;
  } catch {
    return structuredClone(fallback);
  }
}

export function set(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function remove(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

export const getPrefs = () => get(KEYS.prefs, DEFAULT_PREFS);
export const setPrefs = (p) => set(KEYS.prefs, p);
export const getSaved = () => get(KEYS.saved, {});
export const setSaved = (s) => set(KEYS.saved, s);
export const getGh = () => get(KEYS.gh, DEFAULT_GH);
export const setGh = (g) => set(KEYS.gh, g);
export const getFinance = () => get(KEYS.finance, DEFAULT_FINANCE);
export const setFinance = (f) => set(KEYS.finance, f);
export const getAreasLocal = () => get(KEYS.areasLocal, null);
export const setAreasLocal = (a) => (a ? set(KEYS.areasLocal, a) : remove(KEYS.areasLocal));

/** Everything local as one JSON document (token optional). */
export function exportAll({ includeToken = false } = {}) {
  const gh = getGh();
  return JSON.stringify({
    app: 'house-hunt',
    version: 1,
    exportedAt: new Date().toISOString(),
    prefs: getPrefs(),
    saved: getSaved(),
    finance: getFinance(),
    areasLocal: getAreasLocal(),
    gh: includeToken ? gh : { repo: gh.repo },
  }, null, 2);
}

/** Merge an exported document back in. Returns a summary string or throws. */
export function importAll(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error('That file is not valid JSON.'); }
  if (!doc || doc.app !== 'house-hunt') throw new Error('That file was not exported from this app.');
  const parts = [];
  if (doc.prefs && typeof doc.prefs === 'object') { setPrefs({ ...DEFAULT_PREFS, ...doc.prefs }); parts.push('preferences'); }
  if (doc.saved && typeof doc.saved === 'object') {
    const merged = { ...getSaved(), ...doc.saved };
    setSaved(merged);
    parts.push(`${Object.keys(doc.saved).length} shortlist/hidden entries`);
  }
  if (doc.finance && typeof doc.finance === 'object') { setFinance({ ...DEFAULT_FINANCE, ...doc.finance }); parts.push('finance inputs'); }
  if (doc.areasLocal && typeof doc.areasLocal === 'object') { setAreasLocal(doc.areasLocal); parts.push('local area changes'); }
  if (doc.gh && typeof doc.gh === 'object') {
    const cur = getGh();
    setGh({ repo: doc.gh.repo || cur.repo, token: doc.gh.token || cur.token });
    parts.push(doc.gh.token ? 'GitHub repo and token' : 'GitHub repo');
  }
  if (!parts.length) throw new Error('Nothing recognisable in that file.');
  return `Imported ${parts.join(', ')}.`;
}
