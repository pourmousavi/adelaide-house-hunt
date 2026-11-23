import { test } from 'node:test';
import assert from 'node:assert/strict';
import { yearlyCpi, cpiIndex, deflate, realGrowth } from './inflation.js';

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} !~ ${b}`);
const hist = [
  { date: '2020-03', value: 2.2 }, { date: '2020-12', value: 0.9 }, { date: '2020-09', value: 0.7 },
  { date: '2021-12', value: 3.5 }, { date: '2022-12', value: 7.8 },
  { date: '2023-03', value: 7.0 }, { date: '2023-06', value: 6.0 },
];

test('yearlyCpi uses the December quarter, else the latest quarter of that year', () => {
  assert.deepEqual(yearlyCpi(hist), { 2020: 0.9, 2021: 3.5, 2022: 7.8, 2023: 6.0 });
  assert.deepEqual(yearlyCpi(null), {});
});

test('cpiIndex compounds yearly CPI from the first year and stops at a gap', () => {
  const idx = cpiIndex(hist, 2020, 2025);
  assert.equal(idx[2020], 1);
  near(idx[2021], 1.035);
  near(idx[2022], 1.035 * 1.078);
  near(idx[2023], 1.035 * 1.078 * 1.06);
  assert.equal(idx[2024], undefined);
});

test('deflate restates a past value in later dollars', () => {
  const idx = cpiIndex(hist, 2020, 2022);
  near(deflate(100, 2020, idx, 2022), 100 * 1.035 * 1.078);
  assert.equal(deflate(100, 2022, idx, 2022), 100);
  near(deflate(100, 2010, idx, 2020), 100); // before the index: clamped
});

test('realGrowth: nominal vs inflation vs real, per year', () => {
  const g = realGrowth([{ year: 2020, median: 1000000 }, { year: 2021, median: 1100000 }, { year: 2022, median: 1300000 }], hist);
  assert.equal(g.firstYear, 2020); assert.equal(g.lastYear, 2022); assert.equal(g.years, 2);
  near(g.nominalPct, 30);
  near(g.inflationPct, (1.035 * 1.078 - 1) * 100);
  near(g.realPct, (1.3 / (1.035 * 1.078) - 1) * 100);
  near(g.realPctPa, (Math.pow(1.3 / (1.035 * 1.078), 0.5) - 1) * 100);
});

test('realGrowth ignores years without CPI and returns null when it cannot compare', () => {
  const g = realGrowth([{ year: 2022, median: 1 }, { year: 2023, median: 2 }, { year: 2024, median: 3 }], hist);
  assert.equal(g.lastYear, 2023);
  assert.equal(realGrowth([{ year: 2020, median: 1 }], hist), null);
  assert.equal(realGrowth([{ year: 2020, median: 1 }, { year: 2021, median: 2 }], []), null);
});
