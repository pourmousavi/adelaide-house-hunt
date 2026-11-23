import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monotonePath } from './charts.js';

const nums = (d) => d.match(/-?\d+(\.\d+)?/g).map(Number);

test('monotonePath keeps flat runs flat and never overshoots the data range', () => {
  const P = [[0, 50], [10, 50], [20, 50], [30, 10], [40, 10], [50, 30]];
  const d = monotonePath(P);
  assert.match(d, /^M0\.0,50\.0C/);
  const ys = nums(d).filter((_, i) => i % 2 === 1);
  assert.ok(Math.min(...ys) >= 10 && Math.max(...ys) <= 50, `control points stay within [10,50]: ${ys}`);
  // the flat segment 0→20 has all control points at y=50
  assert.deepEqual(nums(d.split('C')[1]).filter((_, i) => i % 2 === 1), [50, 50, 50]);
});

test('monotonePath falls back to straight lines for two points', () => {
  assert.equal(monotonePath([[0, 0], [10, 5]]), 'M0.0,0.0L10.0,5.0');
});
