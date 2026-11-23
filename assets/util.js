// Small DOM + formatting helpers shared by every module.

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Create an element. attrs: class, text, html, dataset, style (object), on<Event> handlers, any attribute. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Inline SVG icon referencing a <symbol id="i-name"> defined in index.html. */
export function icon(name, cls = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `icon ${cls}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function debounce(fn, ms = 200) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// ---------- numbers ----------

const AUD = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 });
export function fmtMoney(n, { compact = true } = {}) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  if (compact) {
    const abs = Math.abs(v);
    if (abs >= 1e6) return `${v < 0 ? '-' : ''}$${trimZeros((abs / 1e6).toFixed(abs >= 10e6 ? 1 : 2))}m`;
    if (abs >= 1e3) return `${v < 0 ? '-' : ''}$${trimZeros((abs / 1e3).toFixed(abs >= 1e5 ? 0 : 1))}k`;
  }
  return AUD.format(v);
}
const trimZeros = (s) => (s.includes('.') ? s.replace(/\.?0+$/, '') : s);

export function fmtMoneyFull(n) { return fmtMoney(n, { compact: false }); }

export function fmtNum(n, digits = 0) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return Number(n).toLocaleString('en-AU', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function fmtPct(n, digits = 1) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return `${Number(n).toFixed(digits)}%`;
}

export function signed(n, digits = 2, unit = '') {
  if (n == null || !Number.isFinite(n)) return '—';
  const s = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${s}${Math.abs(n).toFixed(digits)}${unit}`;
}

// ---------- dates ----------

const TZ = 'Australia/Adelaide';

/** Parse "2026-11", "2026-11-04" or a full ISO string into a Date (UTC midnight for date-only). */
export function parseDate(s) {
  if (s instanceof Date) return s;
  if (s == null) return null;
  const str = String(s);
  if (/^\d{4}-\d{2}$/.test(str)) return new Date(Date.UTC(+str.slice(0, 4), +str.slice(5, 7) - 1, 1));
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return new Date(Date.UTC(+str.slice(0, 4), +str.slice(5, 7) - 1, +str.slice(8, 10)));
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fmtDate(s, opts = {}) {
  const d = parseDate(s);
  if (!d) return '—';
  const dateOnly = /^\d{4}-\d{2}(-\d{2})?$/.test(String(s));
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: dateOnly ? 'UTC' : TZ, ...opts });
}

export function fmtMonthYear(s) {
  const d = parseDate(s);
  if (!d) return '—';
  return d.toLocaleDateString('en-AU', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function fmtDateShort(s) { return fmtDate(s, { year: undefined }); }

export function fmtTime(s) {
  const d = parseDate(s);
  if (!d) return '';
  return d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', timeZone: TZ }).replace(' ', '');
}

export function fmtDateTime(s) {
  const d = parseDate(s);
  if (!d) return '—';
  return `${d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ })}, ${fmtTime(d)}`;
}

export function fmtInspection(ins) {
  if (!ins?.start) return '';
  const start = parseDate(ins.start);
  const end = ins.end ? parseDate(ins.end) : null;
  const day = start.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ });
  return end ? `${day}, ${fmtTime(start)}–${fmtTime(end)}` : `${day}, ${fmtTime(start)}`;
}

export function relTime(s, now = Date.now()) {
  const d = parseDate(s);
  if (!d) return 'unknown';
  const diff = Math.max(0, now - d.getTime());
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const hrs = Math.round(m / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  if (days < 31) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  return `${Math.round(months / 12)} year${Math.round(months / 12) === 1 ? '' : 's'} ago`;
}

export function daysSince(s, now = Date.now()) {
  const d = parseDate(s);
  if (!d) return null;
  return Math.max(0, Math.floor((now - d.getTime()) / 86400000));
}

// ---------- feedback ----------

let toastTimer;
export function toast(msg, { kind = 'info', ms = 4000 } = {}) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/** Trigger a file download from a string. */
export function downloadText(filename, text, type = 'application/octet-stream') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const prefersDark = () => {
  const t = document.documentElement.dataset.theme;
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
};

/** A small "$1,500,000" hint that tracks a money input's value. */
export function moneyHint(input) {
  const el = h('span', { class: 'hint', 'aria-hidden': 'true' });
  const sync = () => { const n = Number(input.value); el.textContent = input.value !== '' && Number.isFinite(n) && n > 0 ? fmtMoneyFull(n) : ''; };
  input.addEventListener('input', sync);
  sync();
  return el;
}
