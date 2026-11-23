// Pure CPI / real-growth maths. No DOM, no imports: unit-tested in inflation.test.mjs.

/**
 * Yearly CPI (year-ended %) from quarterly history [{date:"2025-12", value}]:
 * the December quarter for each year, or the latest available quarter for a year without one (the current year).
 * Returns { [year]: percent }.
 */
export function yearlyCpi(history) {
  const best = {};
  for (const p of history || []) {
    const m = /^(\d{4})-(\d{2})/.exec(String(p?.date ?? ''));
    if (!m || !Number.isFinite(p.value)) continue;
    const y = +m[1];
    if (!best[y] || m[2] > best[y].month) best[y] = { month: m[2], value: p.value };
  }
  return Object.fromEntries(Object.entries(best).map(([y, b]) => [y, b.value]));
}

/**
 * Price-level index with index[firstYear] = 1, grown each later year by that year's CPI.
 * Stops at the first year with no CPI figure, so the index never invents inflation.
 */
export function cpiIndex(history, firstYear, lastYear) {
  const cpi = yearlyCpi(history);
  const idx = { [firstYear]: 1 };
  for (let y = firstYear + 1; y <= lastYear; y++) {
    if (!Number.isFinite(cpi[y])) break;
    idx[y] = idx[y - 1] * (1 + cpi[y] / 100);
  }
  return idx;
}

/** Express `value` of `year` in `toYear` dollars. Years outside the index are clamped to its ends. */
export function deflate(value, year, idx, toYear) {
  const years = Object.keys(idx).map(Number);
  if (!years.length || !Number.isFinite(value)) return value;
  const clamp = (y) => Math.min(Math.max(y, Math.min(...years)), Math.max(...years));
  return value * (idx[clamp(toYear)] / idx[clamp(year)]);
}

/**
 * medians: [{year, median}] ascending. Compares the suburb median with CPI from the first year shown to the last year
 * that has a CPI figure. Percentages are in %, `realPctPa` is the compound real growth per year.
 * Returns null when there are fewer than two usable years or no CPI.
 */
export function realGrowth(medians, cpiHistory) {
  const rows = (medians || []).filter((r) => r && Number.isFinite(r.median) && r.median > 0 && Number.isFinite(r.year)).sort((a, b) => a.year - b.year);
  if (rows.length < 2) return null;
  const first = rows[0];
  const idx = cpiIndex(cpiHistory, first.year, rows[rows.length - 1].year);
  const usable = rows.filter((r) => idx[r.year] != null);
  const last = usable[usable.length - 1];
  if (!last || last.year === first.year) return null;
  const years = last.year - first.year;
  const nominal = last.median / first.median - 1;
  const inflation = idx[last.year] - 1;
  const real = (1 + nominal) / (1 + inflation) - 1;
  return {
    firstYear: first.year, lastYear: last.year, years, index: idx,
    nominalPct: nominal * 100, inflationPct: inflation * 100, realPct: real * 100,
    realPctPa: (Math.pow(1 + real, 1 / years) - 1) * 100,
  };
}
