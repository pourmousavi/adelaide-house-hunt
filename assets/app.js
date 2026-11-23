// Entry point: boot, routing between views, data (re)loading, the fetch workflow, and listings orchestration.
import { loadAll, loadZones, latestGeneratedAt, applyZonesLocally, IS_FIXTURES } from './data.js';
import * as store from './store.js';
import { h, icon, relTime, daysSince, toast } from './util.js';
import { filterListings, sortListings, renderCard, renderFilters, observeCharts, activeFilterCount, SORT_OPTIONS } from './listings.js';
import { renderMacroStrip, renderNewsStrip, emptyState, renderOutlook, renderFinancePage, renderAreas, renderSettings, renderMore } from './views.js';
import { createMap } from './map.js';
import { getFile, putFile, dispatchFetch } from './github.js';

const $ = (sel, el = document) => el.querySelector(sel);
const ALERTS_URL = 'https://house-alerts.alipourmousavi.workers.dev';
const VIEWS = ['listings', 'map', 'outlook', 'finance', 'areas', 'settings', 'more'];
const TITLES = { listings: 'Listings', map: 'Map', outlook: 'Outlook', finance: 'Finance', areas: 'Areas', settings: 'Settings', more: 'More' };
const DEFAULT_AREAS = {
  zones: ['Linden Park Primary School', 'Glenunga International High School'], zoneMatch: 'all', extraSuburbs: [],
  propertyTypes: ['House', 'Townhouse', 'Villa', 'Unit', 'ApartmentUnitFlat', 'Duplex', 'SemiDetached', 'Terrace'],
};

const state = {
  data: null, prefs: store.getPrefs(), saved: store.getSaved(), areas: DEFAULT_AREAS,
  current: null, mapApi: null, mapInit: false, mapPending: null, financePrice: null, fetching: false, settingsRendered: false,
};

const effectiveAreas = () => store.getAreasLocal() || state.data?.areas || DEFAULT_AREAS;

// ---------------------------------------------------------------- boot

async function boot() {
  applyTheme(store.get(store.KEYS.theme, 'auto'));
  renderAlertStatus();
  $('#filters-toggle').addEventListener('click', (e) => {
    const open = $('#filters-panel').classList.toggle('is-open');
    e.currentTarget.setAttribute('aria-expanded', String(open));
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (state.mapApi) toast('Reload to switch the map tiles to the new theme.'); });
  await reloadData({ bust: false });
  route();
  window.addEventListener('hashchange', route);
  setInterval(updateUpdatedLabel, 60000);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}

function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

// ---------------------------------------------------------------- data

async function reloadData({ bust }) {
  const root = $('#listings-root');
  root.setAttribute('aria-busy', 'true');
  const data = await loadAll({ bust });
  state.data = data;
  state.areas = effectiveAreas();
  if (store.getAreasLocal() && data.listings) {
    loadZones().then((z) => {
      if (!z.ok || !state.data?.listings) return;
      applyZonesLocally(state.data.listings.listings, z.features, state.areas.zones);
      renderListings();
    });
  }
  renderBanner();
  renderMacroStrip($('#macro'), data.macro, data.errors.macro);
  renderNewsStrip($('#news-strip'), data.news);
  renderListings();
  renderOutlook($('#outlook-root'), data.market, data.news, data.errors);
  if (state.mapApi) state.mapApi.setListings(visibleListings());
  if (state.current === 'finance') renderFinance();
  if (state.current === 'areas') renderAreasView();
  updateUpdatedLabel();
  root.removeAttribute('aria-busy');
  return data;
}

function renderBanner() {
  const el = $('#banner');
  el.replaceChildren();
  const d = state.data;
  if (IS_FIXTURES) el.append(h('div', { class: 'banner banner-info' }, icon('info'), h('span', {}, 'Previewing sample fixtures from ', h('code', { text: 'dev/fixtures/' }), '. ', h('a', { href: location.pathname, text: 'Use live data' }))));
  const errs = Object.entries(d?.errors || {}).filter(([k]) => k === 'listings' || k === 'macro');
  if (errs.length) {
    const names = { areas: 'areas.json', listings: 'listings.json', suburbs: 'suburbs.json', macro: 'macro.json', news: 'news.json', market: 'market.json' };
    el.append(h('div', { class: 'banner banner-error', role: 'status' }, icon('alert'), h('div', {},
      h('b', { text: `${errs.length === 1 ? 'One data file' : `${errs.length} data files`} could not be loaded.` }),
      h('ul', { class: 'banner-list' }, errs.map(([k, v]) => h('li', { text: `${names[k] || k}: ${v}` }))),
      h('span', { class: 'small', text: 'The pipeline writes these on each fetch; the rest of the app keeps working.' }))));
  }
}

function updateUpdatedLabel() {
  const el = $('#updated');
  const ts = latestGeneratedAt(state.data);
  if (!ts) { el.textContent = state.data ? 'No data published yet' : 'Loading…'; el.removeAttribute('title'); el.classList.remove('is-stale'); return; }
  el.textContent = `Processed ${relTime(ts)}`;
  el.title = new Date(ts).toLocaleString('en-AU', { timeZone: 'Australia/Adelaide' });
  el.classList.toggle('is-stale', (daysSince(ts) ?? 0) >= 3);
}

// ---------------------------------------------------------------- listings

const NO_LISTINGS_TEXT = "New ones appear when a realestate.com.au / Domain alert email arrives. Homes already on the market can be added above with \"Add a listing\" (alerts are set up for Linden Park, Glenunga, St Georges, Frewville, Glenside, Glen Osmond, Beaumont, Hazelwood Park, Mount Osmond).";

function listingsAll() { return state.data?.listings?.listings || []; }
function visibleListings(view = state.prefs.view || 'all') {
  return sortListings(filterListings(listingsAll(), { prefs: state.prefs, saved: state.saved, areas: state.areas, view }), state.prefs.sort);
}
function savedCounts() {
  const ids = new Set(listingsAll().map((l) => String(l.id)));
  let shortlist = 0; let hidden = 0;
  for (const [id, v] of Object.entries(state.saved)) { if (!ids.has(String(id))) continue; if (v?.status === 'shortlist') shortlist++; if (v?.status === 'hidden') hidden++; }
  return { shortlist, hidden };
}

const cardCtx = () => ({
  saved: state.saved, areas: state.areas, suburbs: state.data?.suburbs, macro: state.data?.macro,
  onSave(id, status) {
    if (status) state.saved[id] = { ...(state.saved[id] || {}), status };
    else delete state.saved[id];
    store.setSaved(state.saved);
    toast(status === 'shortlist' ? 'Added to shortlist' : status === 'hidden' ? 'Listing hidden' : 'Restored');
    renderListings();
    if (state.mapApi) state.mapApi.setListings(visibleListings());
  },
  onShowOnMap(id) { state.mapPending = id; location.hash = '#map'; },
  onFinance(price) { state.financePrice = price; location.hash = '#finance'; },
});

function renderListings() {
  renderAddListing();
  const root = $('#listings-root');
  const toolbar = $('#listings-toolbar');
  const d = state.data;
  renderFiltersPanel();
  if (!d?.listings) {
    toolbar.replaceChildren();
    root.replaceChildren(h('div', { class: 'empty' },
      h('p', { class: 'empty-title', text: 'Listings could not be loaded' }),
      h('p', { class: 'muted', text: `listings.json: ${d?.errors?.listings || 'unknown error'}. The data pipeline writes it on each fetch.` }),
      h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => reloadData({ bust: true }) }, icon('refresh'), 'Try again')));
    return;
  }
  const view = state.prefs.view || 'all';
  const counts = savedCounts();
  const all = listingsAll();
  const visible = visibleListings(view);
  const seg = (v, label, n) => h('button', { type: 'button', class: `seg-btn${view === v ? ' is-active' : ''}`, 'aria-pressed': String(view === v), onclick: () => setPrefs({ view: v }) }, label, n != null && h('span', { class: 'count', text: n }));
  const sortSel = h('select', { id: 'sort', 'aria-label': 'Sort listings', onchange: (e) => setPrefs({ sort: e.target.value }) },
    SORT_OPTIONS.map(([v, l]) => h('option', { value: v, selected: state.prefs.sort === v, text: l })));
  toolbar.replaceChildren(
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Which listings' }, seg('all', 'All', visible.length || (view === 'all' ? 0 : null)), seg('shortlist', 'Shortlist', counts.shortlist), seg('hidden', 'Hidden', counts.hidden)),
    h('div', { class: 'toolbar-right' }, h('label', { for: 'sort', class: 'muted small', text: 'Sort' }), sortSel),
  );
  const zoneNote = state.areas.zones?.length ? `${state.areas.zoneMatch === 'any' ? 'in any of' : 'inside all of'}: ${state.areas.zones.join(', ')}` : 'no zone filter';
  const summary = h('p', { class: 'result-summary muted small' }, view === 'all' ? `${visible.length} of ${all.length} listings · ${zoneNote}` : view === 'shortlist' ? `${visible.length} shortlisted` : `${visible.length} hidden`);
  if (!visible.length) {
    const msg = view === 'shortlist' ? ['Nothing shortlisted yet', 'Tap Shortlist on a listing to keep it here.']
      : view === 'hidden' ? ['No hidden listings', 'Hide a listing to move it out of the main list.']
        : all.length ? ['No listings match', 'Loosen the filters, or widen the areas.'] : null;
    if (!msg) { root.replaceChildren(emptyState('No listings yet', NO_LISTINGS_TEXT)); return; }
    root.replaceChildren(summary, h('div', { class: 'empty' }, h('p', { class: 'empty-title', text: msg[0] }), h('p', { class: 'muted', text: msg[1] }),
      view === 'all' && all.length && activeFilterCount(state.prefs) ? h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => setPrefs({ ...store.DEFAULT_PREFS, sort: state.prefs.sort, view, notes: state.prefs.notes }) }, 'Clear filters') : null));
    return;
  }
  const ctx = cardCtx();
  root.replaceChildren(summary, ...visible.map((l) => renderCard(l, ctx)));
  observeCharts(root);
}

// ---------------------------------------------------------------- add a listing by hand

const LISTING_URL_RE = /^https?:\/\/(www\.)?(realestate\.com\.au\/property-[^?#]*-\d{5,}|domain\.com\.au\/[a-z0-9-]+-\d{7,})/i;
const listingKey = (url) => String(url).match(/-(\d{5,})(?:[/?#]|$)/)?.[1];

function renderAddListing() {
  const root = $('#add-listing-root');
  if (root.dataset.rendered) return;
  root.dataset.rendered = '1';
  const field = (id, label, attrs, hint) => h('div', { class: 'field' }, h('label', { for: id, text: label }), h('input', { id, name: id, autocomplete: 'off', ...attrs }), hint && h('span', { class: 'hint', text: hint }));
  const num = (id, label) => field(id, label, { type: 'number', min: '0', max: '20', step: '1', inputmode: 'numeric' });
  const status = h('p', { class: 'small', role: 'status' });
  const form = h('form', { class: 'set-form', onsubmit: async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const url = f['al-url'].trim(), address = f['al-address'].trim().replace(/\s+/g, ' ');
    if (!LISTING_URL_RE.test(url)) { status.textContent = 'That is not a single-listing link. Open the property on realestate.com.au or domain.com.au and copy the link from the address bar.'; form['al-url'].focus(); return; }
    if (!/^\S*\d.*\s\S+/.test(address)) { status.textContent = 'Enter the street address, e.g. 12 Example St, Linden Park SA 5065.'; form['al-address'].focus(); return; }
    const gh = store.getGh();
    if (!gh.token) { status.replaceChildren('Adding needs the GitHub token. Save it in ', h('a', { href: '#settings', text: 'Settings' }), ' first.'); return; }
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true; status.textContent = 'Saving…';
    try {
      let list = [], sha = null;
      try { const file = await getFile(gh.repo, gh.token, 'data/manual.json'); sha = file.sha; list = JSON.parse(file.content); } catch (err) { if (!/404/.test(err.message)) throw err; }
      const key = listingKey(url);
      if (list.some((m) => listingKey(m.url) === key)) { status.textContent = 'That listing is already added.'; return; }
      list.push({ url: url.split(/[?#]/)[0], address, priceText: f['al-price'].trim() || null,
        beds: f['al-beds'] || null, baths: f['al-baths'] || null, cars: f['al-cars'] || null, addedAt: new Date().toISOString().slice(0, 10) });
      await putFile(gh.repo, gh.token, 'data/manual.json', `${JSON.stringify(list, null, 2)}\n`, { sha, message: `Add listing by hand: ${address}` });
      let note = `Added ${address}.`;
      try { await dispatchFetch(gh.repo, gh.token); note += ' A fetch has started; it appears in the list in a few minutes.'; }
      catch (err) { note += ` It appears after the next scheduled fetch (could not start one now: ${err.message}).`; }
      status.textContent = note; toast('Listing added');
      form.reset();
    } catch (err) { status.textContent = `Could not add it: ${err.message}`; }
    finally { btn.disabled = false; }
  } },
    field('al-url', 'Listing link', { type: 'url', required: true, placeholder: 'https://www.realestate.com.au/property-house-sa-…', spellcheck: 'false' }, 'One property per entry, not a search page.'),
    field('al-address', 'Street address', { type: 'text', required: true, placeholder: '12 Example St, Linden Park SA 5065' }, 'Needed to place it on the map; the link does not contain it.'),
    field('al-price', 'Price (optional)', { type: 'text', placeholder: '$1.45m - $1.55m' }),
    h('div', { class: 'field-row' }, num('al-beds', 'Beds'), num('al-baths', 'Baths'), num('al-cars', 'Cars')),
    h('div', { class: 'row-wrap' }, h('button', { type: 'submit', class: 'btn btn-primary', text: 'Add listing' })),
    status);
  root.replaceChildren(h('details', { class: 'howto set-sec add-listing' }, h('summary', { text: 'Add a listing' }), form));
}

function renderFiltersPanel() {
  const root = $('#filters-root');
  const n = activeFilterCount(state.prefs);
  $('#filters-count').textContent = n ? String(n) : '';
  if (root.dataset.rendered === JSON.stringify([state.prefs.minBeds, state.prefs.minBaths, state.prefs.minCars, state.prefs.maxPrice, state.prefs.minLand, state.prefs.types, state.prefs.mustHave, state.prefs.includeRemoved, state.prefs.notes])) return;
  renderFilters(root, state.prefs, (p, o) => setPrefs(p, { rerenderFilters: !!o?.rerender }), { typeOptions: state.data?.areas?.propertyTypes?.length ? state.data.areas.propertyTypes : DEFAULT_AREAS.propertyTypes });
  root.dataset.rendered = JSON.stringify([state.prefs.minBeds, state.prefs.minBaths, state.prefs.minCars, state.prefs.maxPrice, state.prefs.minLand, state.prefs.types, state.prefs.mustHave, state.prefs.includeRemoved, state.prefs.notes]);
}

function setPrefs(patch, { rerenderFilters = true } = {}) {
  state.prefs = { ...state.prefs, ...patch };
  store.setPrefs(state.prefs);
  if (!rerenderFilters) {
    $('#filters-root').dataset.rendered = JSON.stringify([state.prefs.minBeds, state.prefs.minBaths, state.prefs.minCars, state.prefs.maxPrice, state.prefs.minLand, state.prefs.types, state.prefs.mustHave, state.prefs.includeRemoved, state.prefs.notes]);
  }
  renderListings();
  if (state.mapApi) state.mapApi.setListings(visibleListings());
}

function openCard(id) {
  const go = () => {
    const card = document.getElementById(`listing-${id}`);
    if (!card) { toast('That listing is not in the current list (filtered or hidden).'); return; }
    card.scrollIntoView({ block: 'start', behavior: 'auto' });
    card.focus({ preventScroll: true });
    card.classList.add('is-highlight');
    setTimeout(() => card.classList.remove('is-highlight'), 1600);
  };
  if (state.current !== 'listings') { location.hash = '#listings'; setTimeout(go, 50); } else go();
}

// ---------------------------------------------------------------- routing

function route() {
  let name = (location.hash || '#listings').slice(1).split('?')[0];
  if (name === 'shortlist' || name === 'hidden') { setPrefs({ view: name }); name = 'listings'; }
  if (!VIEWS.includes(name)) name = 'listings';
  showView(name);
}

function showView(name) {
  const prev = state.current;
  state.current = name;
  for (const v of VIEWS) $(`#view-${v}`).hidden = v !== name;
  $('#macro').hidden = !(name === 'listings' || name === 'outlook');
  document.querySelectorAll('.topnav a, .tabbar a').forEach((a) => {
    const target = a.getAttribute('href').slice(1);
    const active = target === name || (name === 'areas' || name === 'settings') && target === 'more' && a.closest('.tabbar');
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  document.title = `${TITLES[name]} · House Hunt`;
  if (prev && prev !== name) window.scrollTo(0, 0);
  if (name === 'map') showMap();
  if (name === 'finance') renderFinance();
  if (name === 'areas') renderAreasView();
  if (name === 'settings' && !state.settingsRendered) { state.settingsRendered = true; renderSettingsView(); }
  if (name === 'more') renderMore($('#more-root'), { counts: savedCounts() });
}

async function showMap() {
  const status = $('#map-status');
  if (!state.mapApi && !state.mapInit) {
    state.mapInit = true;
    status.textContent = 'Loading map…';
    try {
      const api = await createMap($('#map-canvas'), { onSelect: openCard });
      state.mapApi = api;
      api.setListings(visibleListings());
      const z = await loadZones();
      if (z.ok) api.setZones(z.features.filter((f) => state.areas.zones?.includes(f.properties?.school)));
      status.textContent = z.ok ? '' : `School zone boundaries unavailable (zones.geojson: ${z.error}).`;
    } catch (e) {
      status.textContent = `The map could not load: ${e.message}`;
      state.mapInit = false;
      return;
    }
  } else if (state.mapApi) {
    setTimeout(() => state.mapApi.invalidate(), 30);
  }
  if (state.mapPending && state.mapApi) {
    const id = state.mapPending;
    state.mapPending = null;
    setTimeout(() => { if (!state.mapApi.focus(id)) toast('No map position for that listing.'); }, 80);
  }
}

function renderFinance() {
  renderFinancePage($('#finance-root'), state.data?.macro, { price: state.financePrice });
  state.financePrice = null;
}

function renderAreasView() {
  renderAreas($('#areas-root'), {
    areas: state.areas, dataAreas: state.data?.areas, isLocal: !!store.getAreasLocal(), loadZones, gh: store.getGh(),
    onChange(a) {
      store.setAreasLocal(a);
      state.areas = effectiveAreas();
      renderListings();
      loadZones().then((z) => {
        if (!z.ok) return;
        if (state.data?.listings) applyZonesLocally(state.data.listings.listings, z.features, a.zones);
        renderListings();
        if (state.mapApi) { state.mapApi.setZones(z.features.filter((f) => a.zones.includes(f.properties?.school))); state.mapApi.setListings(visibleListings()); }
      });
      if (!$('#areas-root .notice')) renderAreasView();
    },
    onDiscard() { store.setAreasLocal(null); state.areas = effectiveAreas(); renderListings(); renderAreasView(); if (state.mapApi) loadZones().then((z) => z.ok && state.mapApi.setZones(z.features.filter((f) => state.areas.zones.includes(f.properties?.school)))); },
    async onSave(a) {
      const gh = store.getGh();
      if (!gh.token) throw new Error('no GitHub token');
      const doc = { zones: a.zones, zoneMatch: a.zoneMatch, extraSuburbs: a.extraSuburbs, propertyTypes: a.propertyTypes?.length ? a.propertyTypes : (state.data?.areas?.propertyTypes || DEFAULT_AREAS.propertyTypes) };
      const text = `${JSON.stringify(doc, null, 2)}\n`;
      let sha = null;
      try { sha = (await getFile(gh.repo, gh.token, 'data/areas.json')).sha; } catch (e) { if (!/404/.test(e.message)) throw e; }
      await putFile(gh.repo, gh.token, 'data/areas.json', text, { sha, message: 'Update search areas from the app' });
      store.setAreasLocal(null);
      if (state.data) state.data.areas = doc;
      state.areas = effectiveAreas();
      let note = 'Saved data/areas.json to GitHub.';
      try { await dispatchFetch(gh.repo, gh.token); note += ' A fetch has been started; new listings appear once it finishes and the site republishes.'; }
      catch (e) { note += ` Could not start a fetch (${e.message}).`; }
      renderListings();
      setTimeout(renderAreasView, 0);
      return note;
    },
  });
}

function renderSettingsView() {
  renderSettings($('#settings-root'), {
    onTheme(t) { store.set(store.KEYS.theme, t); applyTheme(t); },
    onLocalDataChanged() {
      state.prefs = store.getPrefs(); state.saved = store.getSaved(); state.areas = effectiveAreas();
      $('#filters-root').dataset.rendered = '';
      renderListings();
      state.settingsRendered = true;
      renderSettingsView();
    },
  });
}

// ---------------------------------------------------------------- alert status

// Last realestate.com.au / Domain alert email the worker received (live), next to when the pipeline last processed them.
async function renderAlertStatus() {
  const el = $('#alerts-status');
  let st = null;
  try { const r = await fetch(`${ALERTS_URL}/status.json`, { cache: 'no-store' }); if (r.ok) st = await r.json(); } catch {}
  const row = (name, s) => h('li', { title: s?.at ? new Date(s.at).toLocaleString('en-AU', { timeZone: 'Australia/Adelaide' }) : '' },
    h('b', { text: name }), ' ', !st ? 'unavailable' : s?.at ? `${relTime(s.at)} · ${s.listings} listing${s.listings === 1 ? '' : 's'}` : 'no alert yet');
  el.replaceChildren(h('span', { class: 'alerts-h', text: 'Last alert received' }), h('ul', { class: 'list-plain' }, row('realestate', st?.rea), row('Domain', st?.domain)));
}

boot().catch((e) => {
  console.error(e);
  const main = $('#main');
  main.prepend(h('div', { class: 'banner banner-error', role: 'alert' }, icon('alert'), h('span', { text: `The app failed to start: ${e.message}` })));
});
