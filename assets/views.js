// Secondary views: macro indicator strip, Outlook + News, Finance page, Areas manager, Settings, More.
import { h, icon, fmtMoney, fmtMoneyFull, fmtPct, fmtDate, fmtMonthYear, relTime, parseDate, signed, toast, downloadText, moneyHint } from './util.js';
import { renderChart } from './charts.js';
import { computeFinance } from './finance.js';
import * as store from './store.js';
import { DATA_BASE, IS_FIXTURES } from './data.js';

const YEAR = 365.25 * 86400000;
export const emptyState = (title, body, action) => h('div', { class: 'empty' }, h('p', { class: 'empty-title', text: title }), body && h('p', { class: 'muted', text: body }), action);

// =====================================================================
// Macro strip
// =====================================================================

export function renderMacroStrip(root, macro, error) {
  root.replaceChildren();
  if (!macro) {
    root.append(h('div', { class: 'macro-missing muted', text: `Key indicators are not available${error ? ` (macro.json: ${error})` : ''}.` }));
    return;
  }
  const cash = macro.cashRate;
  const tiles = [
    tile({ label: 'RBA cash rate', data: cash, deltaMode: 'lastMove', digits: 2, sub: 'target, % p.a.' }),
    tile({ label: 'CPI inflation', data: macro.cpi, deltaMode: 'prev', digits: 1, sub: 'year-ended, %' }),
    tile({ label: 'Mortgage rate', data: mortgageWithForecast(macro.mortgageRate, cash), deltaMode: 'prev', digits: 2, sub: macro.mortgageRate?.label || 'variable, % p.a.', derived: !macro.mortgageRate?.forecast }),
    tile({ label: 'Unemployment', data: macro.unemployment, deltaMode: 'prev', digits: 1, sub: macro.unemployment?.label || 'seasonally adjusted, %' }),
  ];
  const strip = h('div', { class: 'macro-tiles' }, tiles.map((t) => t.el));
  const panel = h('div', { class: 'macro-method', id: 'macro-method', hidden: true },
    h('h3', { text: 'How the forecasts are made' }),
    h('p', { text: macro.method || 'No method description was provided.' }),
    Array.isArray(macro.sources) && macro.sources.length && h('div', {},
      h('h4', { text: 'Sources' }),
      h('ul', { class: 'source-list' }, macro.sources.map((s) => h('li', {}, s.url ? h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', text: s.name || s.url }) : (s.name || ''))))),
    macro.generatedAt && h('p', { class: 'small muted', text: `Updated ${fmtDate(macro.generatedAt)}. Shaded bands are the model's 80% interval; dashed lines are model forecasts, not RBA guidance.` }),
  );
  const infoBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-expanded': 'false', 'aria-controls': 'macro-method' }, icon('info'), 'How these are forecast');
  infoBtn.addEventListener('click', () => {
    const open = panel.hidden;
    panel.hidden = !open;
    infoBtn.setAttribute('aria-expanded', String(open));
  });
  root.append(strip, h('div', { class: 'macro-foot' }, infoBtn), panel);
  tiles.forEach((t) => t.draw());
}

function mortgageWithForecast(mort, cash) {
  if (!mort || mort.current == null) return mort;
  if (Array.isArray(mort.forecast) && mort.forecast.length) return mort;
  if (!cash || cash.current == null || !Array.isArray(cash.forecast)) return mort;
  const shift = (v) => (v == null ? null : +(mort.current + (v - cash.current)).toFixed(2));
  return { ...mort, forecast: cash.forecast.filter((f) => f && f.value != null).map((f) => ({ date: f.date, value: shift(f.value), lo: shift(f.lo ?? f.value), hi: shift(f.hi ?? f.value) })) };
}

const fmtAsOf = (s) => (/^\d{4}-\d{2}$/.test(String(s)) ? fmtMonthYear(s) : fmtDate(s));

function computeDelta(hist, current, mode) {
  if (!hist.length) return null;
  if (mode === 'lastMove') {
    let i = hist.length - 1;
    while (i >= 0 && Math.abs(hist[i].value - current) < 1e-9) i--;
    if (i < 0) return { dir: 'flat', text: 'unchanged over the series' };
    const d = current - hist[i].value;
    const when = hist[i + 1]?.date || hist[i].date;
    return { dir: d > 0 ? 'up' : 'down', text: `${signed(d * 100, 0)} bp in ${fmtMonthYear(when)}` };
  }
  const prev = Math.abs(hist[hist.length - 1].value - current) < 1e-9 && hist.length > 1 ? hist[hist.length - 2] : hist[hist.length - 1];
  const d = current - prev.value;
  return { dir: d > 0.001 ? 'up' : d < -0.001 ? 'down' : 'flat', text: `${signed(d, 2)} pt vs ${fmtMonthYear(prev.date)}` };
}

function tile({ label, data, deltaMode, digits, sub, derived }) {
  const el = h('div', { class: 'tile' });
  if (!data || data.current == null) {
    el.append(h('div', { class: 'tile-top' }, h('span', { class: 'tile-label', text: label })), h('span', { class: 'tile-value is-missing', text: '—' }), h('span', { class: 'tile-sub', text: 'not available' }));
    return { el, draw() {} };
  }
  const hist = (data.history || []).filter((p) => p && p.value != null && p.date);
  const delta = computeDelta(hist, data.current, deltaMode);
  el.append(
    h('div', { class: 'tile-top' }, h('span', { class: 'tile-label', text: label }), data.asOf && h('span', { class: 'tile-asof', text: fmtAsOf(data.asOf) })),
    h('div', { class: 'tile-main' },
      h('span', { class: 'tile-value', text: `${Number(data.current).toFixed(digits)}%` }),
      delta && h('span', { class: `tile-delta dir-${delta.dir}` }, delta.dir === 'flat' ? null : icon(delta.dir === 'up' ? 'arrow-up' : 'arrow-down'), h('span', { text: delta.text }))),
    sub && h('span', { class: 'tile-sub', text: sub }),
  );
  const chart = h('div', { class: 'chart tile-chart' });
  el.append(chart);
  const histPts = hist.map((p) => ({ x: parseDate(p.date)?.getTime(), y: p.value })).filter((p) => Number.isFinite(p.x));
  const fc = (data.forecast || []).filter((f) => f && f.value != null && f.date)
    .map((f) => ({ x: parseDate(f.date)?.getTime(), y: f.value, lo: f.lo ?? f.value, hi: f.hi ?? f.value })).filter((p) => Number.isFinite(p.x));
  const last = histPts[histPts.length - 1];
  const fcLine = last ? [{ x: last.x, y: last.y }, ...fc] : fc;
  const band = last ? [{ x: last.x, lo: last.y, hi: last.y }, ...fc] : fc;
  const draw = () => renderChart(chart, {
    height: 110, yTicks: 3, table: false,
    series: [
      { label: 'History', points: histPts, color: 'var(--chart-1)' },
      fc.length && { label: derived ? 'Model forecast (shifted by the cash-rate path)' : 'Model forecast', points: fcLine, color: 'var(--chart-1)', dashed: true },
    ].filter(Boolean),
    bands: fc.length ? [{ label: '80% band', points: band, color: 'var(--chart-1)' }] : [],
    vMarkers: last && fc.length ? [{ x: last.x }] : [],
    yFormat: (v) => `${Number(v).toFixed(1)}%`,
    emptyText: 'No history available.',
    ariaLabel: `${label}: history${histPts.length ? ` from ${fmtMonthYear(histPts[0].x)}` : ''}${fc.length ? ` and model forecast to ${fmtMonthYear(fc[fc.length - 1].x)} with an 80% band` : ''}`,
  });
  return { el, draw };
}

// =====================================================================
// Outlook + News
// =====================================================================

const TOPIC_LABELS = { rates: 'Interest rates & the RBA', inflation: 'Inflation', housing: 'Housing & property', adelaide: 'Adelaide & South Australia', budget: 'Budget & Treasury' };
const TOPIC_ORDER = ['rates', 'inflation', 'housing', 'adelaide', 'budget'];
// Older news.json rows have no topics/importance: fall back to category so the UI still groups them.
const CAT_TOPIC = { rba: 'rates', adelaide: 'adelaide', property: 'housing', economy: 'inflation' };
const itemTopics = (it) => (it.topics?.length ? it.topics : [CAT_TOPIC[it.category]].filter(Boolean));
const byImportance = (a, b) => (b.importance ?? 0) - (a.importance ?? 0) || String(b.date).localeCompare(String(a.date));

function newsItem(it) {
  return h('li', { class: 'news-item' },
    it.link ? h('a', { href: it.link, target: '_blank', rel: 'noopener noreferrer', text: it.title }) : h('span', { text: it.title }),
    h('span', { class: 'news-meta', text: [it.source, it.date && relTime(it.date)].filter(Boolean).join(' · ') }));
}

/** Compact "What's moving rates & prices" strip for the top of the Listings view. */
export function renderNewsStrip(root, news, limit = 4) {
  root.replaceChildren();
  const items = [...(news?.items || [])].sort(byImportance).slice(0, limit);
  root.hidden = !items.length;
  if (!items.length) return;
  root.append(
    h('div', { class: 'news-strip-head' },
      h('h2', { id: 'news-strip-h', class: 'news-strip-title', text: "What's moving rates & prices" }),
      h('a', { class: 'news-strip-more', href: '#outlook', text: 'More in Outlook' })),
    h('ul', { class: 'news-list' }, items.map(newsItem)));
}

export function renderOutlook(root, market, news, errors = {}) {
  root.replaceChildren();
  const list = (title, items) => h('div', { class: 'outlook-list' }, h('h3', { text: title }),
    Array.isArray(items) && items.length ? h('ul', {}, items.map((i) => h('li', { text: i }))) : h('p', { class: 'muted', text: 'Nothing listed.' }));
  const sec = h('section', { class: 'outlook', 'aria-labelledby': 'outlook-h' }, h('h2', { id: 'outlook-h', class: 'section-title', text: 'Market outlook' }));
  if (!market) {
    sec.append(emptyState('No market view yet', 'AI market view appears after the AI key is added.'));
  } else {
    sec.append(
      h('p', { class: 'outlook-headline', text: market.headline || 'Market view' }),
      market.outlook && h('p', { class: 'outlook-body', text: market.outlook }),
      market.timing && h('div', { class: 'callout' }, h('h3', { text: 'When to buy' }), h('p', { text: market.timing })),
      h('div', { class: 'two-col' }, list('Risks', market.risks), list('Watch list', market.watch)),
      h('p', { class: 'small muted', text: [market.disclaimer || 'Not financial advice.', market.model, market.generatedAt && `updated ${fmtDate(market.generatedAt)}`].filter(Boolean).join(' · ') }),
    );
  }
  root.append(sec);

  const ns = h('section', { class: 'news', 'aria-labelledby': 'news-h' }, h('h2', { id: 'news-h', class: 'section-title', text: 'News' }));
  const items = news?.items || [];
  if (!items.length) {
    ns.append(emptyState('No headlines yet', 'Headlines appear after the first fetch.'));
  } else {
    // Each story sits under its most important topic (first in TOPIC_ORDER), so nothing repeats.
    const groups = new Map();
    for (const it of [...items].sort(byImportance)) {
      const t = TOPIC_ORDER.find((k) => itemTopics(it).includes(k)) || 'other';
      if (!groups.has(t)) groups.set(t, []);
      groups.get(t).push(it);
    }
    for (const t of [...TOPIC_ORDER, 'other'].filter((k) => groups.has(k))) {
      ns.append(h('h3', { class: 'news-cat', text: TOPIC_LABELS[t] || 'Other' }), h('ul', { class: 'news-list' }, groups.get(t).map(newsItem)));
    }
    if (news.generatedAt) ns.append(h('p', { class: 'small muted', text: `Collected ${relTime(news.generatedAt)}.` }));
  }
  root.append(ns);
}

// =====================================================================
// Finance page
// =====================================================================

export function renderFinancePage(root, macro, { price } = {}) {
  root.replaceChildren();
  const fin = store.getFinance();
  if (price != null) fin.price = Math.round(price);
  const field = (id, label, input, hint) => h('div', { class: 'field' }, h('label', { for: id, text: label }), input, hint && h('span', { class: 'hint', text: hint }));
  const num = (id, value, attrs = {}) => h('input', { id, name: id, type: 'number', inputmode: 'decimal', value: value ?? '', oninput: update, ...attrs });
  const money = (id, label, value, attrs = {}) => {
    const input = num(id, value, { inputmode: 'numeric', autocomplete: 'off', ...attrs });
    return h('div', { class: 'field' }, h('label', { for: id, text: label }), input, moneyHint(input));
  };
  const radio = (value, label, checked) => h('label', { class: 'seg-item' }, h('input', { type: 'radio', name: 'depositMode', value, checked, onchange: update }), h('span', { text: label }));
  const curRate = macro?.mortgageRate?.current;
  const form = h('form', { class: 'fin-form', onsubmit: (e) => e.preventDefault(), 'aria-label': 'Finance inputs' },
    money('fin-price', 'Purchase price ($)', fin.price, { min: '0', step: '10000' }),
    h('fieldset', { class: 'field' }, h('legend', { text: 'Deposit' }),
      h('div', { class: 'seg' }, radio('amount', 'Dollar amount', fin.depositMode !== 'pct'), radio('pct', 'Percent of price', fin.depositMode === 'pct')),
      h('div', { class: 'field-row' },
        money('fin-deposit', 'Deposit ($)', fin.deposit, { min: '0', step: '10000' }),
        field('fin-depositPct', 'Deposit (%)', num('fin-depositPct', fin.depositPct, { min: '0', max: '100', step: '1' })))),
    h('div', { class: 'field-row' },
      money('fin-income1', 'Income 1 ($ gross / yr)', fin.incomes?.[0], { min: '0', step: '1000' }),
      money('fin-income2', 'Income 2 ($ gross / yr)', fin.incomes?.[1], { min: '0', step: '1000' })),
    h('div', { class: 'field-row' },
      field('fin-term', 'Term (years)', num('fin-term', fin.termYears, { min: '1', max: '40', step: '1' })),
      field('fin-rate', 'Interest rate (% p.a.)', num('fin-rate', fin.ratePct, { min: '0', max: '20', step: '0.05', placeholder: curRate != null ? String(curRate) : '6.0' }),
        curRate != null ? `Blank uses the current ${curRate}% (${macro.mortgageRate.label || 'RBA series'}).` : 'Blank uses 6%.')),
    h('div', { class: 'field-row' },
      field('fin-buffer', 'Serviceability buffer (%)', num('fin-buffer', fin.bufferPct ?? 3, { min: '0', max: '10', step: '0.5' }), 'APRA guidance is +3% over the actual rate.'),
      h('div', { class: 'field' }, h('span', { class: 'label-like', text: 'Loan type' }), h('span', { class: 'static-value', text: 'Principal and interest' }))),
  );
  const out = h('div', { class: 'fin-out' });
  root.append(h('div', { class: 'fin-layout' }, form, out));

  function read() {
    const v = (id) => form.querySelector(`#${id}`).value;
    const n = (id) => { const x = Number(v(id)); return v(id) === '' || !Number.isFinite(x) ? null : x; };
    const inputs = {
      price: n('fin-price') ?? 0,
      depositMode: form.querySelector('input[name=depositMode]:checked')?.value || 'amount',
      deposit: n('fin-deposit') ?? 0, depositPct: n('fin-depositPct') ?? 0,
      incomes: [n('fin-income1') ?? 0, n('fin-income2') ?? 0],
      termYears: n('fin-term') ?? 30, ratePct: v('fin-rate') === '' ? '' : n('fin-rate'), bufferPct: n('fin-buffer') ?? 3,
    };
    store.setFinance(inputs);
    form.querySelector('#fin-deposit').closest('.field').classList.toggle('is-inactive', inputs.depositMode === 'pct');
    form.querySelector('#fin-depositPct').closest('.field').classList.toggle('is-inactive', inputs.depositMode !== 'pct');
    return inputs;
  }
  function update() { const inputs = read(); renderFinanceOutputs(out, computeFinance(inputs, macro), macro); }
  update();
}

function renderFinanceOutputs(out, r, macro) {
  out.replaceChildren();
  const stat = (label, value, sub, cls = '') => h('div', { class: `stat ${cls}` }, h('span', { class: 'stat-label', text: label }), h('span', { class: 'stat-value', text: value }), sub && h('span', { class: 'stat-sub', text: sub }));
  if (!r.price) { out.append(emptyState('Enter a purchase price', 'Everything else follows from the price.')); return; }
  const lmiWarn = r.lvrPct > 80;
  out.append(
    h('div', { class: 'hero-stat' }, h('span', { class: 'stat-label', text: 'Monthly repayment' }), h('span', { class: 'hero-value', text: fmtMoneyFull(r.monthly) }),
      h('span', { class: 'stat-sub', text: `${fmtMoney(r.loan)} loan · ${r.termYears} years · ${fmtPct(r.ratePct, 2)} P&I` })),
    h('div', { class: 'stat-grid' },
      stat('Loan', fmtMoneyFull(r.loan), `LVR ${fmtPct(r.lvrPct, 1)}`),
      stat('SA stamp duty', fmtMoneyFull(r.stampDuty), 'estimate, check RevenueSA'),
      stat('Transfer + mortgage registration', fmtMoneyFull(r.transferFee + r.mortgageRegistration), 'LSSA 2025-26, rough'),
      stat('Lenders mortgage insurance', fmtMoneyFull(lmiWarn ? r.lmi : 0), lmiWarn ? `LVR over 80% — very rough estimate` : 'not needed at 80% LVR or below', lmiWarn ? 'is-warn' : ''),
      stat('Cash needed at settlement', fmtMoneyFull(r.cashNeeded), 'deposit + duty + fees + LMI'),
      stat('Total interest over the term', fmtMoneyFull(r.interest)),
      r.repayToIncome != null ? stat('Repayments as share of income', fmtPct(r.repayToIncome, 1), `on ${fmtMoney(r.incomeAnnual)} gross a year`) : stat('Repayments as share of income', '—', 'add an income to see this'),
      stat(`Buffer test at ${fmtPct(r.ratePct + r.bufferPct, 2)}`, fmtMoneyFull(r.bufferedMonthly),
        r.bufferedToIncome != null ? `${fmtPct(r.bufferedToIncome, 1)} of income · ${r.bufferVerdict}` : 'per month with the buffer',
        r.bufferVerdict === 'unlikely' ? 'is-danger' : r.bufferVerdict === 'tight' ? 'is-warn' : ''),
    ),
    h('p', { class: 'small muted', text: 'Stamp duty uses RevenueSA general rates for an established home; there is no first-home-buyer concession on established homes. Lenders apply their own buffers and expense assumptions. Not financial advice.' }),
  );

  const sec = h('section', { class: 'fin-forecast' }, h('h3', { text: 'Repayments under our cash-rate forecast' }));
  if (!r.forecast.length) {
    sec.append(h('p', { class: 'muted', text: macro?.cashRate ? 'No cash-rate forecast in macro.json yet.' : 'Key indicators are not loaded, so there is no forecast path.' }));
  } else {
    const pts = r.forecast.map((f) => ({ x: parseDate(f.date)?.getTime(), ...f })).filter((f) => Number.isFinite(f.x));
    const now = Date.now();
    const chart = h('div', { class: 'chart fin-chart', style: { minHeight: '200px' } });
    sec.append(
      h('p', { class: 'muted small', text: `The variable rate is shifted by the forecast change in the cash rate (now ${macro.cashRate.current}%). The band follows the 80% interval of the cash-rate forecast.` }),
      chart,
      h('div', { class: 'table-scroll' }, h('table', { class: 'fin-table' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Quarter' }), h('th', { scope: 'col', text: 'Rate' }), h('th', { scope: 'col', text: 'Monthly' }), h('th', { scope: 'col', text: 'Range (80%)' }))),
        h('tbody', {}, pts.map((f) => h('tr', {}, h('td', { text: fmtMonthYear(f.date) }), h('td', { text: fmtPct(f.rate, 2) }), h('td', { text: fmtMoneyFull(f.repay) }), h('td', { text: `${fmtMoneyFull(f.repayLo)} – ${fmtMoneyFull(f.repayHi)}` })))),
      )),
    );
    out.append(sec);
    renderChart(chart, {
      height: 200, yTicks: 4,
      series: [{ label: 'Monthly repayment', points: [{ x: now, y: r.monthly }, ...pts.map((f) => ({ x: f.x, y: f.repay }))], color: 'var(--chart-1)', dashed: true }],
      bands: [{ label: '80% band', points: [{ x: now, lo: r.monthly, hi: r.monthly }, ...pts.map((f) => ({ x: f.x, lo: f.repayLo, hi: f.repayHi }))], color: 'var(--chart-1)' }],
      vMarkers: [{ x: now, label: 'now' }],
      yFormat: (v) => fmtMoney(v), table: false,
      ariaLabel: `Forecast monthly repayments from ${fmtMoneyFull(r.monthly)} now to ${fmtMoneyFull(pts[pts.length - 1].repay)} in ${fmtMonthYear(pts[pts.length - 1].date)}`,
    });
    return;
  }
  out.append(sec);
}

// =====================================================================
// Areas manager
// =====================================================================

const ZONE_TYPE = { PRIM: 'Primary', SEC: 'High', PRSEC: 'Primary + High' };

export function renderAreas(root, { areas, dataAreas, isLocal, loadZones, gh, onChange, onDiscard, onSave }) {
  root.replaceChildren();
  const a = { zones: [...(areas.zones || [])], zoneMatch: areas.zoneMatch || 'all', extraSuburbs: [...(areas.extraSuburbs || [])], propertyTypes: areas.propertyTypes || [] };
  const commit = () => onChange(a);

  if (isLocal) root.append(h('div', { class: 'notice' }, icon('info'), h('span', {}, 'These areas are applied on this device only. ', gh?.token ? 'Save to GitHub so the pipeline fetches listings for them.' : 'Add a GitHub token in Settings to save them for the pipeline.'),
    h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: onDiscard }, 'Discard local changes')));
  if (!dataAreas) root.append(h('p', { class: 'muted small', text: 'data/areas.json has not been loaded, so these are the defaults.' }));

  // current zones
  const zoneList = h('ul', { class: 'list-plain area-list', 'aria-label': 'Selected school zones' });
  const drawZones = () => {
    zoneList.replaceChildren(...(a.zones.length ? a.zones.map((z) => h('li', { class: 'row-between' }, h('span', { text: z }),
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-label': `Remove ${z}`, onclick: () => { a.zones = a.zones.filter((x) => x !== z); drawZones(); drawResults(); commit(); } }, icon('x'), 'Remove')))
      : [h('li', { class: 'muted', text: 'No school zones selected. Listings will not be filtered by zone.' })]));
  };
  drawZones();
  root.append(h('section', { class: 'area-sec' }, h('h3', { text: 'School zones' }), zoneList));

  // zone match
  const match = (value, label, desc) => h('label', { class: 'radio-row' }, h('input', { type: 'radio', name: 'zoneMatch', value, checked: a.zoneMatch === value, onchange: () => { a.zoneMatch = value; commit(); } }), h('span', {}, h('b', { text: label }), ' ', h('span', { class: 'muted', text: desc })));
  root.append(h('fieldset', { class: 'area-sec' }, h('legend', { text: 'A listing must be inside' }), match('all', 'every zone', '(the overlap)'), match('any', 'at least one zone', '')));

  // add zone (search)
  const search = h('input', { type: 'search', id: 'zone-search', placeholder: 'Search 130 school zones…', autocomplete: 'off' });
  const results = h('ul', { class: 'list-plain search-results', 'aria-label': 'Matching school zones' });
  let features = null;
  const drawResults = () => {
    const q = search.value.trim().toLowerCase();
    results.replaceChildren();
    if (!features) { results.append(h('li', { class: 'muted', text: 'Loading school zones…' })); return; }
    if (!features.length) { results.append(h('li', { class: 'muted', text: 'zones.geojson could not be loaded.' })); return; }
    const matches = features.filter((f) => (f.properties?.school || '').toLowerCase().includes(q)).slice(0, q ? 25 : 12);
    if (!matches.length) { results.append(h('li', { class: 'muted', text: `No school zone matches "${search.value}".` })); return; }
    for (const f of matches) {
      const name = f.properties.school;
      const added = a.zones.includes(name);
      results.append(h('li', { class: 'row-between' },
        h('span', {}, name, ' ', h('span', { class: 'pill', text: ZONE_TYPE[f.properties.type] || f.properties.type || '' })),
        h('button', { type: 'button', class: 'btn btn-secondary btn-sm', disabled: added, 'aria-label': `${added ? 'Already added' : 'Add'} ${name}`, onclick: () => { a.zones.push(name); drawZones(); drawResults(); commit(); } }, added ? 'Added' : 'Add')));
    }
  };
  search.addEventListener('input', drawResults);
  root.append(h('section', { class: 'area-sec' }, h('h3', { text: 'Add a school zone' }), h('label', { for: 'zone-search', class: 'sr-only', text: 'Search school zones' }), search, results));
  drawResults();
  loadZones().then((z) => { features = z.ok ? [...z.features].sort((x, y) => (x.properties?.school || '').localeCompare(y.properties?.school || '')) : []; drawResults(); });

  // extra suburbs
  const subList = h('ul', { class: 'list-plain area-list', 'aria-label': 'Extra suburbs' });
  const drawSubs = () => {
    subList.replaceChildren(...(a.extraSuburbs.length ? a.extraSuburbs.map((s, i) => h('li', { class: 'row-between' }, h('span', { text: `${s.suburb}${s.postcode ? ` ${s.postcode}` : ''}` }),
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-label': `Remove ${s.suburb}`, onclick: () => { a.extraSuburbs.splice(i, 1); drawSubs(); commit(); } }, icon('x'), 'Remove')))
      : [h('li', { class: 'muted', text: 'None. Suburbs added here are included whatever the zones say.' })]));
  };
  drawSubs();
  const subIn = h('input', { type: 'text', id: 'sub-name', placeholder: 'Suburb', autocomplete: 'off' });
  const pcIn = h('input', { type: 'text', id: 'sub-pc', placeholder: 'Postcode', inputmode: 'numeric', pattern: '[0-9]{4}', maxlength: '4', autocomplete: 'off' });
  const subForm = h('form', { class: 'add-row', onsubmit: (e) => {
    e.preventDefault();
    const suburb = subIn.value.trim();
    const postcode = pcIn.value.trim();
    if (!suburb) { subIn.focus(); return; }
    if (postcode && !/^\d{4}$/.test(postcode)) { toast('Postcode should be four digits.', { kind: 'error' }); pcIn.focus(); return; }
    a.extraSuburbs.push({ suburb, postcode });
    subIn.value = ''; pcIn.value = '';
    drawSubs(); commit();
  } }, h('div', { class: 'field' }, h('label', { for: 'sub-name', text: 'Suburb' }), subIn), h('div', { class: 'field field-pc' }, h('label', { for: 'sub-pc', text: 'Postcode' }), pcIn), h('button', { type: 'submit', class: 'btn btn-secondary' }, 'Add suburb'));
  root.append(h('section', { class: 'area-sec' }, h('h3', { text: 'Extra suburbs' }), subList, subForm));

  // save
  const status = h('p', { class: 'muted small', role: 'status' });
  const saveBtn = h('button', { type: 'button', class: 'btn btn-primary', disabled: !gh?.token }, icon('upload'), 'Save to GitHub and fetch');
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true; saveBtn.setAttribute('aria-busy', 'true'); status.textContent = 'Saving data/areas.json…';
    try { status.textContent = await onSave(a); toast('Areas saved to GitHub'); }
    catch (e) { status.textContent = `Could not save: ${e.message}`; toast('Save failed', { kind: 'error' }); }
    finally { saveBtn.disabled = false; saveBtn.removeAttribute('aria-busy'); }
  });
  root.append(h('section', { class: 'area-sec' }, h('div', { class: 'row-wrap' }, saveBtn,
    !gh?.token && h('span', { class: 'muted small', text: 'Needs a GitHub token (Settings) to write data/areas.json and start a fetch. Changes still apply here immediately.' })), status));
}

// =====================================================================
// Settings
// =====================================================================

export function renderSettings(root, { onTheme, onLocalDataChanged }) {
  root.replaceChildren();
  const gh = store.getGh();

  // appearance
  const themeSel = h('select', { id: 'theme', onchange: (e) => onTheme(e.target.value) },
    [['auto', 'Match the device'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => h('option', { value: v, selected: store.get(store.KEYS.theme, 'auto') === v, text: l })));
  root.append(h('section', { class: 'set-sec' }, h('h3', { text: 'Appearance' }), h('div', { class: 'field' }, h('label', { for: 'theme', text: 'Theme' }), themeSel)));

  // github
  const repoIn = h('input', { id: 'gh-repo', type: 'text', value: gh.repo || store.DEFAULT_GH.repo, autocomplete: 'off', spellcheck: 'false', placeholder: 'owner/repo' });
  const tokenIn = h('input', { id: 'gh-token', type: 'password', value: gh.token || '', autocomplete: 'off', spellcheck: 'false', placeholder: 'github_pat_…' });
  const showBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-pressed': 'false', onclick: () => { const show = tokenIn.type === 'password'; tokenIn.type = show ? 'text' : 'password'; showBtn.textContent = show ? 'Hide' : 'Show'; showBtn.setAttribute('aria-pressed', String(show)); } }, 'Show');
  const ghStatus = h('p', { class: 'small', role: 'status', text: gh.token ? 'A token is saved on this device.' : 'No token saved. Fetching will only reload published data.' });
  const ghForm = h('form', { class: 'set-form', onsubmit: (e) => {
    e.preventDefault();
    const repo = repoIn.value.trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { toast('Repo should look like owner/repo.', { kind: 'error' }); repoIn.focus(); return; }
    store.setGh({ repo, token: tokenIn.value.trim() });
    ghStatus.textContent = tokenIn.value.trim() ? 'Saved. The token stays in this browser only.' : 'Saved repo. No token set.';
    toast('GitHub settings saved');
  } },
    h('div', { class: 'field' }, h('label', { for: 'gh-repo', text: 'GitHub repository' }), repoIn, h('span', { class: 'hint', text: 'Where the data pipeline runs and data/*.json is published from.' })),
    h('div', { class: 'field' }, h('label', { for: 'gh-token', text: 'Fine-grained personal access token' }), h('div', { class: 'input-row' }, tokenIn, showBtn),
      h('span', { class: 'hint', text: 'Stored in this browser\'s localStorage only; never sent anywhere except api.github.com.' })),
    h('div', { class: 'row-wrap' },
      h('button', { type: 'submit', class: 'btn btn-primary', text: 'Save' }),
      h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => { store.setGh({ repo: repoIn.value.trim() || store.DEFAULT_GH.repo, token: '' }); tokenIn.value = ''; ghStatus.textContent = 'Token cleared.'; toast('Token cleared'); } }, 'Clear token')),
    ghStatus,
    h('details', { class: 'howto' }, h('summary', { text: 'How to create the token' }), h('ol', {},
      h('li', {}, 'Open ', h('a', { href: 'https://github.com/settings/personal-access-tokens', target: '_blank', rel: 'noopener noreferrer', text: 'github.com/settings/personal-access-tokens' }), ' and choose Generate new token.'),
      h('li', { text: 'Repository access: Only select repositories, then pick this repo.' }),
      h('li', { text: 'Permissions: Actions — Read and write; Contents — Read and write.' }),
      h('li', { text: 'Set an expiry you are comfortable with, generate, and paste it above.' }))),
  );
  root.append(h('section', { class: 'set-sec' }, h('h3', { text: 'GitHub (live fetching and area edits)' }), ghForm));

  // data source
  root.append(h('section', { class: 'set-sec' }, h('h3', { text: 'Data' }),
    h('p', {}, 'Loading from ', h('code', { text: `${DATA_BASE}/` }), IS_FIXTURES ? ' (sample fixtures for development). ' : '. ',
      IS_FIXTURES ? h('a', { href: location.pathname, text: 'Switch to live data' }) : h('a', { href: `${location.pathname}?data=dev/fixtures`, text: 'Preview with sample fixtures' }))));

  // export / import
  const includeToken = h('input', { type: 'checkbox', id: 'exp-token' });
  const fileIn = h('input', { type: 'file', id: 'imp-file', accept: 'application/json,.json', class: 'sr-only', onchange: async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try { const msg = store.importAll(await f.text()); toast(msg); onLocalDataChanged(); }
    catch (err) { toast(err.message, { kind: 'error' }); }
    e.target.value = '';
  } });
  root.append(h('section', { class: 'set-sec' }, h('h3', { text: 'Sync between devices' }),
    h('p', { class: 'muted', text: 'Preferences, shortlist, hidden listings, finance inputs and local area changes live in this browser. Export a file here and import it on the other device.' }),
    h('div', { class: 'row-wrap' },
      h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => downloadText(`house-hunt-${new Date().toISOString().slice(0, 10)}.json`, store.exportAll({ includeToken: includeToken.checked }), 'application/json') }, icon('download'), 'Export'),
      h('label', { class: 'btn btn-secondary', for: 'imp-file' }, icon('upload'), 'Import'), fileIn,
      h('label', { class: 'check' }, includeToken, 'Include the GitHub token')),
    h('div', { class: 'row-wrap' }, h('button', { type: 'button', class: 'btn btn-ghost btn-danger', onclick: () => {
      if (!window.confirm('Clear all local data on this device (preferences, shortlist, finance inputs, token)? This cannot be undone.')) return;
      Object.values(store.KEYS).forEach(store.remove);
      toast('Local data cleared'); onLocalDataChanged();
    } }, 'Clear all local data')),
  ));
}

// =====================================================================
// More (phone menu)
// =====================================================================

export function renderMore(root, { counts }) {
  root.replaceChildren(h('ul', { class: 'more-list' },
    item('#shortlist', 'bookmark', 'Shortlist', counts.shortlist ? `${counts.shortlist} saved` : 'Nothing saved yet'),
    item('#hidden', 'eye-off', 'Hidden listings', counts.hidden ? `${counts.hidden} hidden` : 'None hidden'),
    item('#areas', 'pin', 'Areas', 'School zones and suburbs'),
    item('#settings', 'settings', 'Settings', 'GitHub token, theme, export and import'),
  ));
  function item(href, ic, title, sub) {
    return h('li', {}, h('a', { class: 'more-item', href }, icon(ic), h('span', { class: 'more-text' }, h('b', { text: title }), h('span', { class: 'muted', text: sub })), icon('chevron-right', 'chev')));
  }
}
