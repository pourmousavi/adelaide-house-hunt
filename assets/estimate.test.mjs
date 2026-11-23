import test from 'node:test';
import assert from 'node:assert/strict';
import { estimatePrices, hasPool, buildYear } from './estimate.js';

test('estimates unpriced listings from priced comps, more rooms cost more', () => {
  const comps = [];
  for (let i = 0; i < 30; i++) {
    const beds = 3 + (i % 3), baths = 1 + (i % 2);
    const p = 900000 * 1.15 ** (beds - 3) * 1.1 ** (baths - 1) * (1 + ((i * 7) % 5 - 2) / 100);
    comps.push({ suburb: 'X', bedrooms: beds, bathrooms: baths, carspaces: 2, priceLow: p, priceHigh: p });
  }
  const small = { suburb: 'X', bedrooms: 3, bathrooms: 1, carspaces: 2, priceLow: null, priceHigh: null };
  const big = { suburb: 'X', bedrooms: 5, bathrooms: 2, carspaces: 2, priceLow: null, priceHigh: null };
  assert.equal(estimatePrices([...comps, small, big], null), 2);
  assert.ok(small.estimate.low <= small.estimate.mid && small.estimate.mid <= small.estimate.high);
  assert.ok(Math.abs(small.estimate.mid - 900000) < 60000, `small ${small.estimate.mid}`);
  assert.ok(big.estimate.mid > small.estimate.mid * 1.3, `big ${big.estimate.mid}`);
  assert.equal(comps[0].estimate, undefined); // priced listings are never estimated
  assert.deepEqual(small.estimate.basis, ['bedrooms', 'bathrooms']); // constant columns (cars, type) dropped
});

test('too few comps: no estimate', () => {
  const l = [{ bedrooms: 4, priceLow: null }, { bedrooms: 3, priceLow: 1e6, priceHigh: 1e6 }];
  assert.equal(estimatePrices(l, null), 0);
  assert.equal(l[0].estimate, undefined);
});

test('pool and build year parsed from text', () => {
  assert.equal(hasPool({ description: 'Solar-heated pool and spa' }), 1);
  assert.equal(hasPool({ features: ['Pool table room'] }), 0);
  assert.equal(buildYear({ description: 'Built in 1985 by Rossdale' }), 1985);
  assert.equal(buildYear({ headline: 'Brand new family home' }), new Date().getFullYear());
  assert.equal(buildYear({ description: '' }), null);
});
