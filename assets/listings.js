// Listing filtering/sorting, the card (carousel + facts + chart + expandable details),
// the filters panel, and .ics export.
import { h, icon, fmtMoney, fmtMoneyFull, fmtNum, fmtPct, fmtDate, fmtDateTime, fmtInspection, parseDate, downloadText, debounce, moneyHint } from './util.js';
import { renderChart } from './charts.js';
import { computeFinance } from './finance.js';
import { realGrowth, deflate } from './inflation.js';
import * as store from './store.js';

export const TYPE_LABELS = {
  House: 'House', Townhouse: 'Townhouse', Villa: 'Villa', Unit: 'Unit', ApartmentUnitFlat: 'Apartment',
  Duplex: 'Duplex', SemiDetached: 'Semi-detached', Terrace: 'Terrace',
};
const UNIT_TYPES = ['Unit', 'ApartmentUnitFlat'];
export const seriesKind = (t) => (UNIT_TYPES.includes(t) ? 'unit' : 'house');
export const shortZone = (z) => String(z)
  .replace(' International High School', ' IHS').replace(' Primary School', ' PS').replace(' High School', ' HS').replace(/ School$/, '');
const STATUS_LABELS = { active: null, underOffer: 'Under offer', removed: 'Removed' };
const YEAR = 365.25 * 86400000;

// ---------- derived facts ----------

export function askingMid(l) {
  if (l.priceLow != null && l.priceHigh != null) return (l.priceLow + l.priceHigh) / 2;
  return l.priceLow ?? l.priceHigh ?? null;
}
const entryMid = (p) => (p.priceLow != null && p.priceHigh != null ? (p.priceLow + p.priceHigh) / 2 : (p.priceLow ?? p.priceHigh ?? null));

/** -0.05 means asking is 5% under the AI fair-value midpoint (good). null when unknown. */
export function valueScore(l) {
  const mid = askingMid(l);
  const ai = l.ai;
  if (mid == null || !ai || ai.fairValueLow == null || ai.fairValueHigh == null) return null;
  const fair = (ai.fairValueLow + ai.fairValueHigh) / 2;
  return fair > 0 ? (mid - fair) / fair : null;
}

export function priceChange(l) {
  const ph = (l.priceHistory || []).filter(Boolean);
  if (ph.length < 2) return null;
  const a = ph[ph.length - 2];
  const b = ph[ph.length - 1];
  const am = entryMid(a);
  const bm = entryMid(b);
  if (am != null && bm != null && am !== bm) return { delta: bm - am, date: b.date, dir: bm < am ? 'down' : 'up' };
  if ((a.priceText || '') !== (b.priceText || '')) return { delta: null, date: b.date, dir: 'changed' };
  return null;
}

export function matchesAreas(l, areas) {
  if (!areas) return true;
  const extras = areas.extraSuburbs || [];
  if (extras.some((s) => s?.suburb && s.suburb.toLowerCase() === String(l.suburb || '').toLowerCase() && (!s.postcode || String(s.postcode) === String(l.postcode || '')))) return true;
  const zones = areas.zones || [];
  if (!zones.length) return true;
  const lz = l.zones || [];
  return areas.zoneMatch === 'any' ? zones.some((z) => lz.includes(z)) : zones.every((z) => lz.includes(z));
}

export function filterListings(all, { prefs, saved, areas, view }) {
  const kw = (prefs.mustHave || []).map((k) => String(k).trim().toLowerCase()).filter(Boolean);
  return all.filter((l) => {
    const st = saved[l.id]?.status;
    if (view === 'shortlist') return st === 'shortlist';
    if (view === 'hidden') return st === 'hidden';
    if (st === 'hidden') return false;
    if (!prefs.includeRemoved && l.status === 'removed') return false;
    if (!l.manual && !matchesAreas(l, areas)) return false; // added by hand: shown even outside the areas
    if ((l.bedrooms ?? 0) < (prefs.minBeds || 0)) return false;
    if ((l.bathrooms ?? 0) < (prefs.minBaths || 0)) return false;
    if ((l.carspaces ?? 0) < (prefs.minCars || 0)) return false;
    const low = l.priceLow ?? l.priceHigh;
    if (prefs.maxPrice && low != null && low > prefs.maxPrice) return false;
    if (prefs.minLand && l.landArea != null && l.landArea < prefs.minLand) return false;
    if (prefs.types?.length && !prefs.types.includes(l.propertyType)) return false;
    if (kw.length) {
      const hay = `${l.headline || ''} ${l.description || ''} ${(l.features || []).join(' ')}`.toLowerCase();
      if (!kw.every((k) => hay.includes(k))) return false;
    }
    return true;
  });
}

export function sortListings(list, sort) {
  const arr = [...list];
  const num = (v) => (v == null ? null : Number(v));
  const byNum = (get, dir = 1) => (a, b) => {
    const x = num(get(a)); const y = num(get(b));
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (x - y) * dir;
  };
  const time = (s) => (parseDate(s)?.getTime() ?? 0);
  switch (sort) {
    case 'priceAsc': return arr.sort(byNum((l) => l.priceLow ?? l.priceHigh));
    case 'priceDesc': return arr.sort(byNum((l) => l.priceHigh ?? l.priceLow, -1));
    case 'dom': return arr.sort(byNum((l) => l.daysOnMarket));
    case 'value': return arr.sort(byNum(valueScore));
    case 'newest':
    default: return arr.sort((a, b) => (time(b.firstSeen) - time(a.firstSeen)) || (time(b.dateListed) - time(a.dateListed)));
  }
}

export const SORT_OPTIONS = [
  ['newest', 'Newest first'], ['priceAsc', 'Price: low to high'], ['priceDesc', 'Price: high to low'],
  ['dom', 'Days on market'], ['value', 'AI value (best first)'],
];

// ---------- card ----------

export function renderCard(l, ctx) {
  const st = ctx.saved[l.id]?.status;
  const card = h('article', {
    class: `card status-${l.status || 'active'}${st ? ` is-${st}` : ''}`,
    id: `listing-${l.id}`, tabindex: '-1', 'aria-labelledby': `t-${l.id}`, dataset: { id: l.id },
  });

  card.append(renderCarousel(l));

  const body = h('div', { class: 'card-body' });
  const pc = priceChange(l);
  body.append(h('div', { class: 'card-head' },
    h('div', { class: 'card-price-row' },
      h('span', { class: `card-price${l.priceLow == null && l.priceHigh == null ? ' is-unknown' : ''}`, text: l.priceText || 'Price on request' }),
      pc && h('span', { class: `badge badge-price dir-${pc.dir}`, title: `Guide changed ${fmtDate(pc.date)}` },
        pc.dir === 'down' ? icon('arrow-down') : pc.dir === 'up' ? icon('arrow-up') : null,
        pc.delta != null ? `${pc.dir === 'down' ? 'Cut' : 'Up'} ${fmtMoney(Math.abs(pc.delta))}` : 'Guide changed', ` · ${fmtDate(pc.date, { year: undefined })}`),
    ),
    h('h3', { class: 'card-address', id: `t-${l.id}`, text: l.address || 'Address not provided' }),
    l.headline && h('p', { class: 'card-headline', text: l.headline }),
  ));

  body.append(h('ul', { class: 'facts', 'aria-label': 'Key facts' },
    fact('bed', l.bedrooms, 'bed'), fact('bath', l.bathrooms, 'bath'), fact('car', l.carspaces, 'car'),
    l.landArea != null && h('li', { class: 'fact' }, icon('land'), h('span', { text: `${fmtNum(l.landArea)} m²` }), h('span', { class: 'sr-only', text: ' land' })),
    h('li', { class: 'fact fact-type', text: TYPE_LABELS[l.propertyType] || l.propertyType || 'Property' }),
  ));

  const badges = [];
  const statusLabel = STATUS_LABELS[l.status];
  if (statusLabel) badges.push(h('span', { class: `badge badge-status s-${l.status}`, text: statusLabel }));
  if (l.saleMethod === 'auction') badges.push(h('span', { class: 'badge badge-auction' }, l.auctionDate ? `Auction ${fmtDateTime(l.auctionDate)}` : 'Auction'));
  else if (l.saleMethod === 'eoi') badges.push(h('span', { class: 'badge', text: 'Expressions of interest' }));
  for (const z of l.zones || []) badges.push(h('span', { class: `badge badge-zone${ctx.areas?.zones?.includes(z) ? ' is-target' : ''}`, title: z, text: shortZone(z) }));
  if (l.manual) badges.push(h('span', { class: 'badge', text: 'Added by you' }));
  if (l.ai?.verdict) badges.push(h('span', { class: `badge badge-verdict v-${slug(l.ai.verdict)}`, text: l.ai.verdict }));
  body.append(h('div', { class: 'badges' }, badges));

  const dom = l.daysOnMarket != null ? `${l.daysOnMarket} day${l.daysOnMarket === 1 ? '' : 's'} on market` : 'Days on market unknown';
  body.append(h('p', { class: 'card-meta' }, dom, l.firstSeen && ` · first seen ${fmtDate(l.firstSeen)}`, l.dateListed && ` · listed ${fmtDate(l.dateListed)}`));

  const details = h('div', { class: 'card-details', id: `d-${l.id}`, hidden: true });
  const detailsBtn = h('button', { type: 'button', class: 'btn btn-secondary', 'aria-expanded': 'false', 'aria-controls': `d-${l.id}` }, 'Details', icon('chevron-down', 'chev'));
  detailsBtn.addEventListener('click', () => {
    const open = details.hidden;
    if (open && !details.dataset.built) { details.dataset.built = '1'; details.append(...buildDetails(l, ctx)); }
    details.hidden = !open;
    detailsBtn.setAttribute('aria-expanded', String(open));
    detailsBtn.classList.toggle('is-open', open);
  });

  const saveBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-save', 'aria-pressed': String(st === 'shortlist'), 'aria-label': `${st === 'shortlist' ? 'Remove from shortlist' : 'Shortlist'}: ${l.address || l.id}` },
    icon('bookmark'), h('span', { text: st === 'shortlist' ? 'Shortlisted' : 'Shortlist' }));
  saveBtn.addEventListener('click', () => ctx.onSave(l.id, st === 'shortlist' ? null : 'shortlist'));
  const hideBtn = h('button', { type: 'button', class: 'btn btn-ghost', 'aria-label': `${st === 'hidden' ? 'Unhide' : 'Hide'}: ${l.address || l.id}` },
    icon('eye-off'), h('span', { text: st === 'hidden' ? 'Unhide' : 'Hide' }));
  hideBtn.addEventListener('click', () => ctx.onSave(l.id, st === 'hidden' ? null : 'hidden'));
  const mapBtn = h('button', { type: 'button', class: 'btn btn-ghost', 'aria-label': `Show ${l.address || l.id} on the map`, disabled: l.lat == null || l.lng == null },
    icon('pin'), h('span', { text: 'Map' }));
  mapBtn.addEventListener('click', () => ctx.onShowOnMap(l.id));

  body.append(h('div', { class: 'card-actions' }, saveBtn, hideBtn, mapBtn, detailsBtn));
  card.append(body);

  const kind = seriesKind(l.propertyType);
  const chartWrap = h('div', { class: 'card-chart' },
    h('div', { class: 'chart-head' },
      h('span', { class: 'chart-title', text: `Price in context` }),
      h('span', { class: 'chart-sub', text: `${l.suburb || 'Suburb'} ${kind} median, this home's sales, and the asking range` }),
    ),
    h('div', { class: 'chart chart-lazy', style: { minHeight: '220px' }, dataset: { id: l.id } }),
  );
  card.append(chartWrap);
  card.append(details);
  card._listing = l;
  card._ctx = ctx;
  return card;
}

function fact(name, value, word) {
  if (value == null) return null;
  return h('li', { class: 'fact' }, icon(name), h('span', { text: String(value) }), h('span', { class: 'sr-only', text: ` ${word}${value === 1 ? '' : 's'}` }));
}
const slug = (s) => String(s).toLowerCase().replace(/[^a-z]+/g, '-');

// ---------- carousel ----------

function renderCarousel(l) {
  const photos = (l.photos || []).filter(Boolean).slice(0, 12);
  const wrap = h('div', { class: 'carousel' });
  if (!photos.length) {
    wrap.append(h('div', { class: 'carousel-empty' }, icon('home'), h('span', { text: 'No photos yet' })));
    return wrap;
  }
  const track = h('div', { class: 'carousel-track', tabindex: '0', role: 'group', 'aria-roledescription': 'carousel', 'aria-label': `${photos.length} photo${photos.length === 1 ? '' : 's'} of ${l.address || 'this listing'}` });
  photos.forEach((src, i) => {
    const img = h('img', { src, alt: i === 0 ? (l.headline || l.address || 'Listing photo') : `Photo ${i + 1} of ${l.address || 'listing'}`, loading: 'lazy', decoding: 'async', width: '960', height: '640' });
    img.addEventListener('error', () => img.closest('.carousel-slide')?.classList.add('is-broken'));
    track.append(h('div', { class: 'carousel-slide' }, img));
  });
  wrap.append(track);
  if (photos.length > 1) {
    const counter = h('span', { class: 'carousel-counter', 'aria-live': 'polite', text: `1 / ${photos.length}` });
    const smooth = () => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
    const go = (dir) => track.scrollBy({ left: dir * track.clientWidth, behavior: smooth() });
    const prev = h('button', { type: 'button', class: 'carousel-btn prev', 'aria-label': 'Previous photo', onclick: () => go(-1) }, icon('chevron-left'));
    const next = h('button', { type: 'button', class: 'carousel-btn next', 'aria-label': 'Next photo', onclick: () => go(1) }, icon('chevron-right'));
    let raf = 0;
    let lastIdx = 1;
    track.addEventListener('scroll', () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth)) + 1;
        const idx = Math.min(photos.length, Math.max(1, i));
        if (idx === lastIdx) return;
        lastIdx = idx;
        counter.textContent = `${idx} / ${photos.length}`;
      });
    }, { passive: true });
    track.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    });
    wrap.append(prev, next, counter);
  }
  return wrap;
}

// ---------- chart (lazy) ----------

let chartObserver = null;
export function observeCharts(root) {
  if (!chartObserver) {
    chartObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        chartObserver.unobserve(e.target);
        const card = e.target.closest('.card');
        if (card?._listing) buildPriceChart(e.target, card._listing, card._ctx);
      }
    }, { rootMargin: '240px 0px' });
  }
  root.querySelectorAll('.chart-lazy').forEach((el) => chartObserver.observe(el));
}

export function buildPriceChart(container, l, ctx, { real = false } = {}) {
  container.classList.remove('chart-lazy');
  const key = `${l.suburb}|${l.postcode}`;
  const kind = seriesKind(l.propertyType);
  const stats = (ctx.suburbs?.[key]?.[kind] || []).filter((r) => r && r.median != null && r.year);
  const now = Date.now();
  const cpiHist = ctx.macro?.cpi?.history || [];
  const growth = realGrowth(stats.map((r) => ({ year: r.year, median: r.median })), cpiHist);
  const idx = growth?.index;
  const toReal = real && idx;
  const adj = (v, year) => (toReal ? deflate(v, year, idx, growth.lastYear) : v);
  const pts = stats.map((r) => ({ x: Date.UTC(r.year, 6, 1), y: adj(r.median, r.year) }));
  const inflPts = growth ? stats.filter((r) => idx[r.year] != null).map((r) => ({ x: Date.UTC(r.year, 6, 1), y: adj(stats[0].median * idx[r.year], r.year) })) : [];
  const dots = (l.salesHistory || []).filter((r) => r?.price != null && r.date).map((r) => {
    const x = parseDate(r.date)?.getTime();
    return { x, y: adj(r.price, new Date(x).getUTCFullYear()), label: `Sold ${fmtDate(r.date)}${toReal ? " (today's dollars)" : ''}`, color: 'var(--ink)' };
  }).filter((d) => Number.isFinite(d.x));
  const asking = l.priceLow != null || l.priceHigh != null ? { lo: l.priceLow ?? l.priceHigh, hi: l.priceHigh ?? l.priceLow } : null;
  const fair = l.ai && l.ai.fairValueLow != null && l.ai.fairValueHigh != null ? { lo: l.ai.fairValueLow, hi: l.ai.fairValueHigh } : null;
  if (!pts.length && !dots.length && !asking) {
    container.replaceChildren(h('p', { class: 'chart-empty', text: ctx.suburbs ? `No price history for ${l.suburb || 'this suburb'} yet.` : 'Suburb trends are not available (suburbs.json missing).' }));
    return;
  }

  // Inflation tools (toggle + one-line verdict) sit around the chart; only when there is a CPI comparison to make.
  const wrap = container.closest('.card-chart');
  if (wrap) {
    wrap.querySelectorAll('.chart-tools, .chart-infl').forEach((n) => n.remove());
    if (growth) {
      const toggle = h('button', { type: 'button', class: `btn btn-ghost btn-sm chart-toggle${real ? ' is-on' : ''}`, 'aria-pressed': String(real) }, "Today's dollars");
      toggle.addEventListener('click', () => buildPriceChart(container, l, ctx, { real: !real }));
      container.before(h('div', { class: 'chart-tools' }, toggle));
      const g = growth;
      container.after(h('p', { class: 'chart-infl small', text: `Since ${g.firstYear}, median up ${fmtPct(g.nominalPct, 0)} vs inflation ${fmtPct(g.inflationPct, 0)} (real growth ${signedPct(g.realPctPa)} p.a.)${g.lastYear < stats[stats.length - 1].year ? ` to ${g.lastYear}` : ''}` }));
    }
  }

  const xsAll = [...pts.map((p) => p.x), ...dots.map((d) => d.x)];
  const xMin = Math.min(now - 10 * YEAR, ...(xsAll.length ? xsAll : [now - 10 * YEAR]));
  renderChart(container, {
    height: 220,
    xDomain: [xMin, now + 0.9 * YEAR],
    yMin: 0,
    series: [
      pts.length && { label: `${l.suburb} ${kind} median${toReal ? " (today's dollars)" : ''}`, points: pts, color: 'var(--chart-1)', endDot: true },
      inflPts.length > 1 && { label: 'Inflation only', points: inflPts, color: 'var(--ink-3)', dashed: true, width: 1.75 },
    ].filter(Boolean),
    dots, dotsLabel: 'This home sold',
    hBands: [
      asking && { label: 'Asking', lo: asking.lo, hi: asking.hi, from: now, color: 'var(--chart-2)' },
      fair && { label: 'AI fair value', lo: fair.lo, hi: fair.hi, from: now, color: 'var(--chart-3)', outline: true },
    ].filter(Boolean),
    vMarkers: [{ x: now, label: 'now' }],
    yFormat: (v) => fmtMoney(v),
    ariaLabel: `Price trend for ${l.address}: ${l.suburb} ${kind} median over ten years${toReal ? " in today's dollars" : ''}${inflPts.length > 1 ? ', with an inflation-only line' : ''}${dots.length ? `, ${dots.length} past sale${dots.length === 1 ? '' : 's'}` : ''}${asking ? `, asking ${l.priceText}` : ''}`,
  });
}

const signedPct = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`;

// ---------- details ----------

function section(title, ...content) {
  return h('section', { class: 'dsec' }, h('h4', { class: 'dsec-title', text: title }), ...content);
}

function buildDetails(l, ctx) {
  const out = [];
  if (l.description) out.push(section('About', h('p', { class: 'desc', text: l.description })));
  if (l.features?.length) out.push(section('Features', h('ul', { class: 'chips' }, l.features.map((f) => h('li', { class: 'chip', text: f })))));

  const times = [];
  for (const ins of l.inspections || []) if (ins?.start) times.push(h('li', { class: 'row-between' },
    h('span', { text: fmtInspection(ins) }),
    h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => downloadIcs(l, ins.start, ins.end, `Inspection: ${l.address}`) }, icon('calendar'), 'Add to calendar')));
  if (l.auctionDate) times.push(h('li', { class: 'row-between' },
    h('span', {}, h('b', { text: 'Auction ' }), fmtDateTime(l.auctionDate)),
    h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => downloadIcs(l, l.auctionDate, null, `Auction: ${l.address}`) }, icon('calendar'), 'Add to calendar')));
  out.push(section('Inspections', times.length ? h('ul', { class: 'list-plain' }, times) : h('p', { class: 'muted', text: 'No inspection times listed yet.' })));

  const agents = (l.agents || []).filter((a) => a && (a.name || a.phone || a.email));
  out.push(section('Agents', agents.length ? h('ul', { class: 'list-plain agents' }, agents.map((a) => h('li', { class: 'agent' },
    h('div', { class: 'agent-name' }, h('b', { text: a.name || 'Agent' }), a.agency && h('span', { class: 'muted', text: ` · ${a.agency}` })),
    h('div', { class: 'agent-actions' },
      a.phone && h('a', { class: 'btn btn-secondary btn-sm', href: `tel:${String(a.phone).replace(/\s+/g, '')}` }, icon('phone'), a.phone),
      a.email && h('a', { class: 'btn btn-secondary btn-sm', href: `mailto:${a.email}` }, icon('mail'), 'Email'),
    ),
  ))) : h('p', { class: 'muted', text: 'No agent details.' })));

  if (l.url) out.push(h('p', { class: 'dsec' }, h('a', { class: 'btn btn-secondary', href: l.url, target: '_blank', rel: 'noopener noreferrer' }, 'View original listing', icon('external'))));

  out.push(section('AI analysis', l.ai ? aiBlock(l) : h('p', { class: 'muted', text: 'Not analysed yet. The analysis runs on the next data fetch.' })));
  out.push(section('Finance', financeMini(l, ctx)));
  return out;
}

function aiBlock(l) {
  const ai = l.ai;
  const asking = l.priceLow != null || l.priceHigh != null ? [l.priceLow ?? l.priceHigh, l.priceHigh ?? l.priceLow] : null;
  const fair = ai.fairValueLow != null && ai.fairValueHigh != null ? [ai.fairValueLow, ai.fairValueHigh] : null;
  const frag = [];
  if (ai.verdict) frag.push(h('p', { class: 'verdict-line' }, h('span', { class: `badge badge-verdict v-${slug(ai.verdict)}`, text: ai.verdict })));
  if (ai.summary) frag.push(h('p', { class: 'desc', text: ai.summary }));
  if (ai.pros?.length || ai.cons?.length) frag.push(h('div', { class: 'pros-cons' },
    h('div', {}, h('h5', { text: 'For' }), h('ul', {}, (ai.pros || []).map((p) => h('li', { text: p })))),
    h('div', {}, h('h5', { text: 'Against' }), h('ul', {}, (ai.cons || []).map((p) => h('li', { text: p })))),
  ));
  if (fair || asking) frag.push(rangeBar(asking, fair));
  const gen = ai.generatedAt ? ` · ${fmtDate(ai.generatedAt)}` : '';
  frag.push(h('p', { class: 'muted small', text: `${ai.model || 'AI model'}${gen}. AI opinion, not a valuation.` }));
  return frag;
}

function rangeBar(asking, fair) {
  const vals = [...(asking || []), ...(fair || [])];
  const lo = Math.min(...vals) * 0.97;
  const hi = Math.max(...vals) * 1.03;
  const pct = (v) => `${(((v - lo) / (hi - lo)) * 100).toFixed(1)}%`;
  const row = (label, range, cls) => range && h('div', { class: 'range-row' },
    h('span', { class: 'range-label', text: label }),
    h('div', { class: 'range-track' }, h('span', { class: `range-fill ${cls}`, style: { left: pct(range[0]), width: `calc(${pct(range[1])} - ${pct(range[0])})` } })),
    h('span', { class: 'range-val', text: range[0] === range[1] ? fmtMoney(range[0]) : `${fmtMoney(range[0])} – ${fmtMoney(range[1])}` }),
  );
  let note = null;
  if (asking && fair) {
    const am = (asking[0] + asking[1]) / 2;
    const fm = (fair[0] + fair[1]) / 2;
    const d = ((am - fm) / fm) * 100;
    note = h('p', { class: 'small muted', text: Math.abs(d) < 1.5 ? 'Asking guide sits on the AI fair-value midpoint.' : `Asking guide is ${Math.abs(d).toFixed(0)}% ${d > 0 ? 'above' : 'below'} the AI fair-value midpoint.` });
  }
  return h('div', { class: 'range-bars' }, row('Asking', asking, 'f-asking'), row('Fair value', fair, 'f-fair'), note);
}

function financeMini(l, ctx) {
  const price = askingMid(l);
  if (price == null) return h('p', { class: 'muted', text: 'No price guide, so nothing to calculate yet. Use the Finance tab with your own figure.' });
  const fin = store.getFinance();
  const r = computeFinance({ ...fin, price }, ctx.macro);
  const cell = (label, value, sub) => h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: label }), h('span', { class: 'stat-value', text: value }), sub && h('span', { class: 'stat-sub', text: sub }));
  const depositNote = fin.depositMode === 'pct' ? `${fin.depositPct}% deposit` : `${fmtMoney(r.deposit)} deposit`;
  return h('div', { class: 'finance-mini' },
    h('p', { class: 'small muted', text: `At ${fmtMoneyFull(price)} (asking midpoint), ${depositNote}, ${r.termYears} yrs at ${fmtPct(r.ratePct, 2)} P&I.` }),
    h('div', { class: 'stat-grid' },
      cell('Monthly repayment', fmtMoneyFull(r.monthly)),
      cell('Loan', fmtMoney(r.loan), `LVR ${fmtPct(r.lvrPct, 0)}${r.lvrPct > 80 ? ' · LMI likely' : ''}`),
      cell('Stamp duty', fmtMoneyFull(r.stampDuty), 'estimate'),
      cell('Cash needed', fmtMoney(r.cashNeeded), 'deposit + duty + fees'),
      r.repayToIncome != null && cell('Repayments / income', fmtPct(r.repayToIncome, 0), `${fmtPct(r.bufferedToIncome, 0)} with +${r.bufferPct}% buffer`),
    ),
    h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => ctx.onFinance(price) }, 'Open in Finance', icon('chevron-right')),
  );
}

// ---------- .ics ----------

const icsDate = (iso) => parseDate(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsEsc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => `\\${c}`);

export function downloadIcs(l, start, end, title) {
  const startD = parseDate(start);
  if (!startD) return;
  const endIso = end || new Date(startD.getTime() + 30 * 60000).toISOString();
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//House Hunt//EN', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    `UID:${l.id}-${icsDate(start)}@house-hunt`, `DTSTAMP:${icsDate(new Date().toISOString())}`,
    `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(endIso)}`, `SUMMARY:${icsEsc(title)}`,
    `LOCATION:${icsEsc(l.address)}`, l.url && `URL:${l.url}`, `DESCRIPTION:${icsEsc(l.headline || '')}`,
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean);
  downloadText(`${slug(title).slice(0, 40)}-${l.id}.ics`, `${lines.join('\r\n')}\r\n`, 'text/calendar');
}

// ---------- filters panel ----------

export function renderFilters(root, prefs, onChange, { typeOptions = Object.keys(TYPE_LABELS) } = {}) {
  root.replaceChildren();
  const emit = debounce(() => onChange(read()), 250);
  const numInput = (id, label, value, attrs = {}, hint = false) => {
    const input = h('input', { id, name: id, type: 'number', inputmode: 'numeric', min: '0', value: value ?? '', oninput: emit, ...attrs });
    return h('div', { class: 'field' }, h('label', { for: id, text: label }), input, hint && moneyHint(input));
  };
  const form = h('form', { class: 'filters', onsubmit: (e) => { e.preventDefault(); onChange(read()); } });
  form.append(
    h('div', { class: 'field-row' },
      numInput('f-beds', 'Min beds', prefs.minBeds || ''), numInput('f-baths', 'Min baths', prefs.minBaths || ''), numInput('f-cars', 'Min cars', prefs.minCars || '')),
    h('div', { class: 'field-row' },
      numInput('f-price', 'Max price ($)', prefs.maxPrice || '', { step: '10000', placeholder: 'any', autocomplete: 'off' }, true),
      numInput('f-land', 'Min land (m²)', prefs.minLand || '', { step: '10', placeholder: 'any' })),
    h('fieldset', { class: 'field' }, h('legend', { text: 'Property types' }),
      h('div', { class: 'checks' }, typeOptions.map((t) => h('label', { class: 'check' },
        h('input', { type: 'checkbox', name: 'types', value: t, checked: prefs.types?.includes(t), onchange: emit }), TYPE_LABELS[t] || t)))),
    h('div', { class: 'field' },
      h('label', { for: 'f-keywords', text: 'Must mention' }),
      h('input', { id: 'f-keywords', type: 'text', value: (prefs.mustHave || []).join(', '), placeholder: 'pool, north-facing', oninput: emit, autocomplete: 'off' }),
      h('span', { class: 'hint', text: 'Comma-separated; matched against the description and features.' })),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'f-removed', checked: !!prefs.includeRemoved, onchange: emit }), 'Include removed listings'),
    h('div', { class: 'field' },
      h('label', { for: 'f-notes', text: 'Our notes' }),
      h('textarea', { id: 'f-notes', rows: '3', placeholder: 'What matters to us…', oninput: emit }, prefs.notes || '')),
    h('div', { class: 'row-between' },
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => { onChange({ ...store.DEFAULT_PREFS, sort: prefs.sort, view: prefs.view, notes: form.querySelector('#f-notes').value }, { rerender: true }); } }, 'Clear filters')),
  );
  root.append(form);
  function read() {
    const v = (id) => form.querySelector(`#${id}`).value;
    const n = (id) => { const x = Number(v(id)); return Number.isFinite(x) && x > 0 ? x : null; };
    return {
      ...prefs,
      minBeds: n('f-beds') || 0, minBaths: n('f-baths') || 0, minCars: n('f-cars') || 0,
      maxPrice: n('f-price'), minLand: n('f-land'),
      types: [...form.querySelectorAll('input[name=types]:checked')].map((i) => i.value),
      mustHave: v('f-keywords').split(',').map((s) => s.trim()).filter(Boolean),
      includeRemoved: form.querySelector('#f-removed').checked,
      notes: v('f-notes'),
    };
  }
}

// Active filters as removable chips: { label, clear } where clear is the prefs patch that removes it.
export function activeFilters(prefs) {
  const out = [];
  const add = (on, label, clear) => on && out.push({ label, clear });
  add(prefs.minBeds, `${prefs.minBeds}+ beds`, { minBeds: 0 });
  add(prefs.minBaths, `${prefs.minBaths}+ baths`, { minBaths: 0 });
  add(prefs.minCars, `${prefs.minCars}+ cars`, { minCars: 0 });
  add(prefs.maxPrice, `Up to ${fmtMoney(prefs.maxPrice)}`, { maxPrice: null });
  add(prefs.minLand, `Land ${fmtNum(prefs.minLand)} m²+`, { minLand: null });
  add(prefs.types?.length, (prefs.types || []).map((t) => TYPE_LABELS[t] || t).join(', '), { types: [] });
  for (const k of prefs.mustHave || []) add(k, `Has "${k}"`, { mustHave: prefs.mustHave.filter((x) => x !== k) });
  return out;
}

export const activeFilterCount = (prefs) => activeFilters(prefs).length;
