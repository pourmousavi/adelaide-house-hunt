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

test('suburbKey falls back to the name when postcode is missing', async () => {
  const { suburbKey } = await import('./estimate.js');
  const S = { 'Glen Osmond|5064': {}, 'Glenunga|5064': {} };
  assert.equal(suburbKey({ suburb: 'Glen Osmond', postcode: null }, S), 'Glen Osmond|5064');
  assert.equal(suburbKey({ suburb: 'glenunga', postcode: 5064 }, S), 'Glenunga|5064');
  assert.equal(suburbKey({ suburb: 'Nowhere' }, S), null);
});

test('unit, subdivided lot and vacant-land rules', async () => {
  const { isAttached, isSubdivided, estimatePrices } = await import('./estimate.js');
  assert.equal(isAttached({ address: '6/6 Collyer Court, Linden Park' }), 1);
  assert.equal(isAttached({ address: 'Lot 806/23 Wootoona Terrace' }), 0);
  assert.equal(isAttached({ address: '12 Main St', propertyType: 'Townhouse' }), 1);
  assert.equal(isSubdivided({ address: '22A Sherwood Terrace' }), 1);
  assert.equal(isSubdivided({ address: '22 Sherwood Terrace' }), 0);
  const comps = Array.from({ length: 12 }, (_, i) => ({ address: `${i} X St`, bedrooms: 3 + (i % 2), priceLow: 1e6 + i * 1e4, priceHigh: 1e6 + i * 1e4 }));
  const land = { address: 'Lot 3/4 Allawah Ave', bedrooms: null, priceLow: null };
  estimatePrices([...comps, land, { address: '1 Y St', bedrooms: 0, priceLow: 5e5, priceHigh: 5e5 }], null);
  assert.equal(land.estimate, undefined);
});

test('recorded sales train the model; sold homes are not estimated', async () => {
  const { estimatePrices } = await import('./estimate.js');
  const sales = Array.from({ length: 10 }, (_, i) => ({ address: `${i} S St`, bedrooms: 3 + (i % 2), sold: true, soldPrice: 1e6 + i * 2e4 }));
  const target = { address: '1 T St', bedrooms: 3, priceLow: null };
  const withheld = { address: '2 T St', bedrooms: 3, sold: true, soldPrice: null };
  estimatePrices([...sales, target, withheld], null);
  assert.equal(target.estimate.sold, 10);
  assert.equal(withheld.estimate, undefined);
});
