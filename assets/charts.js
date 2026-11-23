// Hand-drawn SVG time charts: lines, forecast bands, horizontal (price) bands, sale dots,
// crosshair tooltip, legend and a collapsed data table. Colours come from CSS tokens.
import { h, fmtMonthYear } from './util.js';

const NS = 'http://www.w3.org/2000/svg';
const YEAR = 365.25 * 86400000;

function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, String(v));
  for (const k of kids.flat()) if (k != null) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}

export function niceTicks(lo, hi, n = 4) {
  if (!(hi > lo)) return [lo];
  const span = hi - lo;
  const rough = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((st) => span / st <= n) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(+v.toFixed(10));
  return out;
}

function xTicks(x0, x1, plotWidth) {
  const years = (x1 - x0) / YEAR;
  const maxLabels = Math.max(2, Math.floor(plotWidth / 56));
  const step = Math.max(1, Math.ceil(years / maxLabels));
  const first = new Date(x0).getUTCFullYear() + 1;
  const out = [];
  for (let y = first; ; y++) {
    const t = Date.UTC(y, 0, 1);
    if (t > x1) break;
    if ((y - first) % step === 0) out.push({ x: t, label: String(y) });
  }
  return out;
}

/**
 * Render (and keep re-rendering on resize) a chart into `container`.
 * opts: { height, series:[{label, points:[{x,y}], color, dashed, width, endDot}],
 *         bands:[{label, points:[{x,lo,hi}], color}],
 *         hBands:[{label, lo, hi, from, to, color, outline}],
 *         dots:[{x, y, label, color}], dotsLabel, vMarkers:[{x, label}],
 *         xDomain:[x0,x1], yMin, yFormat, xFormat, ariaLabel, legend, table, emptyText }
 */
export function renderChart(container, opts) {
  container.classList.add('chart');
  container._chartOpts = opts;
  const draw = () => {
    const w = container.clientWidth;
    if (w < 40) return;
    container.replaceChildren(buildChart({ ...container._chartOpts, width: w }));
  };
  draw();
  if (window.ResizeObserver && !container._chartRO) {
    let last = container.clientWidth;
    const ro = new ResizeObserver(() => {
      const w = container.clientWidth;
      if (Math.abs(w - last) > 16) { last = w; draw(); }
    });
    ro.observe(container);
    container._chartRO = ro;
  }
}

function buildChart(o) {
  const W = o.width;
  const H = o.height || 200;
  const xs = [];
  const ys = [];
  const addX = (x) => { if (Number.isFinite(x)) xs.push(x); };
  const addY = (y) => { if (Number.isFinite(y)) ys.push(y); };
  for (const sr of o.series || []) for (const p of sr.points || []) { addX(p.x); addY(p.y); }
  for (const b of o.bands || []) for (const p of b.points || []) { addX(p.x); addY(p.lo); addY(p.hi); }
  for (const d of o.dots || []) { addX(d.x); addY(d.y); }
  for (const hb of o.hBands || []) { addX(hb.from); addX(hb.to); addY(hb.lo); addY(hb.hi); }
  for (const m of o.vMarkers || []) addX(m.x);
  if (o.xDomain) o.xDomain.forEach(addX);
  if (!xs.length || !ys.length) return h('p', { class: 'chart-empty', text: o.emptyText || 'No data yet.' });

  let x0 = Math.min(...xs);
  let x1 = Math.max(...xs);
  if (x1 === x0) { x0 -= YEAR / 2; x1 += YEAR / 2; }
  let y0 = Math.min(...ys);
  let y1 = Math.max(...ys);
  if (y1 === y0) { y0 -= Math.abs(y0) * 0.1 || 1; y1 += Math.abs(y1) * 0.1 || 1; }
  const padY = (y1 - y0) * 0.1;
  y0 -= padY; y1 += padY;
  if (o.yMin != null && y0 < o.yMin) y0 = o.yMin;

  const ticks = niceTicks(y0, y1, o.yTicks || 4);
  const yFmt = o.yFormat || ((v) => String(v));
  const labelW = Math.max(0, ...ticks.map((t) => String(yFmt(t)).length)) * 6.4 + 10;
  const pad = { t: 14, r: o.padRight ?? 10, b: 22, l: Math.max(26, Math.ceil(labelW)) };
  const pw = Math.max(10, W - pad.l - pad.r);
  const ph = Math.max(10, H - pad.t - pad.b);
  const X = (x) => pad.l + ((x - x0) / (x1 - x0)) * pw;
  const Y = (y) => pad.t + (1 - (y - y0) / (y1 - y0)) * ph;

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': o.ariaLabel || 'Chart', class: 'chart-svg' });

  // grid + axes
  const grid = s('g', { class: 'chart-grid' });
  for (const t of ticks) {
    const y = Y(t);
    if (y < pad.t - 1 || y > pad.t + ph + 1) continue;
    grid.append(s('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y }));
    grid.append(s('text', { x: pad.l - 6, y: y + 3.5, 'text-anchor': 'end', class: 'chart-tick' }, yFmt(t)));
  }
  for (const t of xTicks(x0, x1, pw)) grid.append(s('text', { x: X(t.x), y: H - 6, 'text-anchor': 'middle', class: 'chart-tick' }, t.label));
  svg.append(grid);

  // forecast / uncertainty bands
  for (const b of o.bands || []) {
    const pts = (b.points || []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.lo) && Number.isFinite(p.hi));
    if (pts.length < 2) continue;
    const top = pts.map((p) => `${X(p.x).toFixed(1)},${Y(p.hi).toFixed(1)}`).join('L');
    const bottom = [...pts].reverse().map((p) => `${X(p.x).toFixed(1)},${Y(p.lo).toFixed(1)}`).join('L');
    svg.append(s('path', { d: `M${top}L${bottom}Z`, fill: b.color, 'fill-opacity': b.opacity ?? 0.16, class: 'chart-band' }));
  }

  // horizontal price bands (asking range, fair value)
  for (const hb of o.hBands || []) {
    if (!Number.isFinite(hb.lo) || !Number.isFinite(hb.hi)) continue;
    const xa = hb.from != null ? X(hb.from) : pad.l;
    const xb = hb.to != null ? X(hb.to) : W - pad.r;
    const yHi = Y(Math.max(hb.lo, hb.hi));
    const yLo = Y(Math.min(hb.lo, hb.hi));
    const height = Math.max(2, yLo - yHi);
    svg.append(s('rect', {
      x: xa.toFixed(1), y: yHi.toFixed(1), width: Math.max(0, xb - xa).toFixed(1), height: height.toFixed(1),
      fill: hb.outline ? 'none' : hb.color, 'fill-opacity': hb.outline ? null : 0.24,
      stroke: hb.color, 'stroke-width': hb.outline ? 1.5 : 0, 'stroke-dasharray': hb.outline ? '3 3' : null,
      class: 'chart-hband',
    }));
    // Direct label only for filled bands; outlined bands rely on the legend + tooltip so labels never collide.
    if (hb.label && !hb.outline) {
      const inside = height >= 16;
      svg.append(s('text', { x: (xb - 4).toFixed(1), y: (inside ? yHi + height / 2 + 4 : yLo + 12).toFixed(1), 'text-anchor': 'end', class: 'chart-note' }, hb.label));
    }
  }

  // vertical markers (e.g. "now")
  for (const m of o.vMarkers || []) {
    if (!Number.isFinite(m.x)) continue;
    const x = X(m.x);
    svg.append(s('line', { x1: x, x2: x, y1: pad.t, y2: pad.t + ph, class: 'chart-marker' }));
    if (m.label) svg.append(s('text', { x: x + 4, y: pad.t + 9, class: 'chart-note' }, m.label));
  }

  // series lines
  for (const sr of o.series || []) {
    const pts = (sr.points || []).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (!pts.length) continue;
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join('');
    svg.append(s('path', { d, fill: 'none', stroke: sr.color, 'stroke-width': sr.width || 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'stroke-dasharray': sr.dashed ? '5 4' : null }));
    if (sr.endDot) {
      const p = pts[pts.length - 1];
      svg.append(s('circle', { cx: X(p.x).toFixed(1), cy: Y(p.y).toFixed(1), r: 3.5, fill: sr.color, class: 'chart-dot' }));
    }
  }

  // point marks (past sales)
  for (const d of o.dots || []) {
    if (!Number.isFinite(d.x) || !Number.isFinite(d.y)) continue;
    svg.append(s('circle', { cx: X(d.x).toFixed(1), cy: Y(d.y).toFixed(1), r: 4.5, fill: d.color || 'var(--ink)', class: 'chart-dot' }));
    if (d.short) svg.append(s('text', { x: X(d.x).toFixed(1), y: (Y(d.y) - 8).toFixed(1), 'text-anchor': 'middle', class: 'chart-note' }, d.short));
  }

  // hover layer
  const cross = s('line', { y1: pad.t, y2: pad.t + ph, class: 'chart-cross', visibility: 'hidden' });
  svg.append(cross);

  const fig = h('figure', { class: 'chart-fig' });
  fig.append(svg);
  const tip = h('div', { class: 'chart-tip', hidden: true, 'aria-hidden': 'true' });
  fig.append(tip);

  const all = [];
  for (const sr of o.series || []) for (const p of sr.points || []) if (Number.isFinite(p.x) && Number.isFinite(p.y)) all.push({ x: p.x, y: p.y, label: sr.label, color: sr.color, kind: 'series' });
  for (const b of o.bands || []) for (const p of b.points || []) if (Number.isFinite(p.x) && Number.isFinite(p.lo)) all.push({ x: p.x, lo: p.lo, hi: p.hi, label: b.label, color: b.color, kind: 'band' });
  for (const d of o.dots || []) if (Number.isFinite(d.x) && Number.isFinite(d.y)) all.push({ x: d.x, y: d.y, label: d.label || o.dotsLabel || 'Sale', color: d.color || 'var(--ink)', kind: 'dot' });

  if (all.length) {
    const xFmt = o.xFormat || fmtMonthYear;
    const tol = (x1 - x0) * 0.004;
    const onMove = (ev) => {
      const rect = svg.getBoundingClientRect();
      const t = x0 + ((ev.clientX - rect.left - pad.l) / pw) * (x1 - x0);
      let best = null;
      for (const p of all) { const d = Math.abs(p.x - t); if (!best || d < best.d) best = { d, x: p.x }; }
      if (!best) return;
      const near = all.filter((p) => Math.abs(p.x - best.x) <= tol);
      const cx = X(best.x);
      cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
      tip.replaceChildren(
        h('div', { class: 'chart-tip-date', text: xFmt(best.x) }),
        ...near.map((p) => h('div', { class: 'chart-tip-row' },
          h('span', { class: 'swatch', style: { background: p.color } }),
          h('span', { class: 'chart-tip-label', text: p.label }),
          h('b', { text: p.kind === 'band' ? `${yFmt(p.lo)} – ${yFmt(p.hi)}` : yFmt(p.y) }))),
      );
      tip.hidden = false;
      const tw = tip.offsetWidth || 120;
      tip.style.left = `${Math.round(Math.min(Math.max(0, cx + 10), W - tw))}px`;
      tip.style.top = '4px';
    };
    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerleave', () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); });
  }

  // legend (only when two or more things are plotted)
  if (o.legend !== false) {
    const items = [];
    for (const sr of o.series || []) if ((sr.points || []).length) items.push(legendItem(sr.label, sr.color, sr.dashed ? 'dash' : 'line'));
    for (const b of o.bands || []) if ((b.points || []).length) items.push(legendItem(b.label, b.color, 'band'));
    for (const hb of o.hBands || []) if (Number.isFinite(hb.lo)) items.push(legendItem(hb.label, hb.color, hb.outline ? 'outline' : 'band'));
    if ((o.dots || []).length) items.push(legendItem(o.dotsLabel || 'Past sales', o.dots[0].color || 'var(--ink)', 'dot'));
    if (items.length > 1) fig.append(h('div', { class: 'chart-legend' }, items));
  }

  if (o.table !== false && all.length) fig.append(dataTable(all, yFmt, o.xFormat || fmtMonthYear));
  return fig;
}

function legendItem(label, color, kind) {
  return h('span', { class: 'legend-item' }, h('span', { class: `legend-key legend-${kind}`, style: { '--c': color } }), label);
}

function dataTable(rows, yFmt, xFmt) {
  const det = h('details', { class: 'chart-table' });
  det.append(h('summary', { text: 'Data table' }));
  det.addEventListener('toggle', () => {
    if (!det.open || det.dataset.built) return;
    det.dataset.built = '1';
    const sorted = [...rows].sort((a, b) => a.x - b.x);
    det.append(h('div', { class: 'table-scroll' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Date' }), h('th', { scope: 'col', text: 'Series' }), h('th', { scope: 'col', text: 'Value' }))),
      h('tbody', {}, sorted.map((r) => h('tr', {}, h('td', { text: xFmt(r.x) }), h('td', { text: r.label }), h('td', { text: r.kind === 'band' ? `${yFmt(r.lo)} – ${yFmt(r.hi)}` : yFmt(r.y) })))),
    )));
  });
  return det;
}
