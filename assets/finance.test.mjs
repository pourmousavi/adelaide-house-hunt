import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stampDutySA, transferFeeSA, monthlyRepayment, totalInterest, lvr, lmiEstimate,
  forecastRepayments, computeFinance,
} from './finance.js';

const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${a} !~ ${b}`);

test('SA stamp duty at each band boundary (RevenueSA general rates)', () => {
  assert.equal(stampDutySA(0), 0);
  assert.equal(stampDutySA(6000), 60);
  assert.equal(stampDutySA(12000), 120);
  assert.equal(stampDutySA(30000), 480);
  assert.equal(stampDutySA(50000), 1080);
  assert.equal(stampDutySA(100000), 2830);
  assert.equal(stampDutySA(200000), 6830);
  assert.equal(stampDutySA(250000), 8955);
  assert.equal(stampDutySA(300000), 11330);
  assert.equal(stampDutySA(500000), 21330);
});

test('SA stamp duty inside bands and for a typical zone price', () => {
  near(stampDutySA(20000), 120 + 8000 * 0.02);
  near(stampDutySA(400000), 11330 + 100000 * 0.05);
  near(stampDutySA(1500000), 21330 + 1000000 * 0.055); // 76,330
  near(stampDutySA(1850000), 95580);
  assert.equal(stampDutySA(-5), 0);
  assert.equal(stampDutySA('abc'), 0);
});

test('LSSA transfer registration fee (2025-26 schedule)', () => {
  assert.equal(transferFeeSA(4000), 198);
  assert.equal(transferFeeSA(20000), 221);
  assert.equal(transferFeeSA(40000), 243);
  assert.equal(transferFeeSA(50000), 342);
  assert.equal(transferFeeSA(50001), 444);
  assert.equal(transferFeeSA(60000), 444);
  assert.equal(transferFeeSA(550000), 5442);
  assert.equal(transferFeeSA(1005000), 10134);
  assert.equal(transferFeeSA(1500000), 342 + 102 * 145);
});

test('monthly repayment matches the standard amortisation formula', () => {
  near(monthlyRepayment(1000000, 6, 30), 5995.51);
  near(monthlyRepayment(500000, 5.9, 25), 3191.01, 0.01);
  near(monthlyRepayment(120000, 0, 10), 1000);
  assert.equal(monthlyRepayment(0, 6, 30), 0);
});

test('total interest over the life of the loan', () => {
  near(totalInterest(1000000, 6, 30), 5995.51 * 360 - 1000000, 5);
  near(totalInterest(120000, 0, 10), 0);
});

test('LVR and LMI bands', () => {
  near(lvr(1000000, 200000), 80);
  near(lvr(1000000, 100000), 90);
  assert.equal(lvr(0, 100), 0);
  assert.equal(lmiEstimate(800000, 80), 0);
  near(lmiEstimate(850000, 85), 8500);
  near(lmiEstimate(900000, 90), 17100);
});

test('forecast repayments shift the mortgage rate by the cash-rate change', () => {
  const rows = forecastRepayments({
    loan: 1000000, ratePct: 6, years: 30, cashCurrent: 3.6,
    cashForecast: [{ date: '2027-03', value: 3.35, lo: 3.1, hi: 3.6 }],
  });
  assert.equal(rows.length, 1);
  near(rows[0].rate, 5.75);
  near(rows[0].rateLo, 5.5);
  near(rows[0].rateHi, 6.0);
  near(rows[0].repay, monthlyRepayment(1000000, 5.75, 30));
  assert.ok(rows[0].repayLo < rows[0].repay && rows[0].repay < rows[0].repayHi);
  assert.deepEqual(forecastRepayments({ loan: 1, ratePct: 6, years: 30 }), []);
});

test('computeFinance ties the pieces together', () => {
  const macro = { cashRate: { current: 3.6, forecast: [{ date: '2027-03', value: 3.35, lo: 3.1, hi: 3.6 }] }, mortgageRate: { current: 5.9 } };
  const r = computeFinance({ price: 1500000, deposit: 300000, incomes: [150000, 90000], termYears: 30, ratePct: '' }, macro);
  assert.equal(r.loan, 1200000);
  near(r.lvrPct, 80);
  assert.equal(r.lmi, 0);
  near(r.stampDuty, 76330);
  assert.equal(r.ratePct, 5.9);
  near(r.monthly, monthlyRepayment(1200000, 5.9, 30));
  near(r.repayToIncome, (r.monthly * 12) / 240000 * 100);
  assert.ok(r.bufferedMonthly > r.monthly);
  assert.equal(r.forecast.length, 1);
  assert.equal(r.incomeAnnual, 240000);
});

test('computeFinance deposit as a percentage and clamps', () => {
  const r = computeFinance({ price: 1000000, depositMode: 'pct', depositPct: 10, incomes: [], termYears: 30, ratePct: 6 });
  assert.equal(r.deposit, 100000);
  near(r.lvrPct, 90);
  assert.ok(r.lmi > 0);
  assert.equal(r.repayToIncome, null);
  assert.equal(r.bufferVerdict, null);
  const r2 = computeFinance({ price: 1000000, deposit: 5000000, incomes: [], termYears: 30, ratePct: 6 });
  assert.equal(r2.loan, 0);
  assert.equal(r2.monthly, 0);
});
