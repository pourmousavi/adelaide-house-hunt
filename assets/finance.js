// Pure finance maths. No DOM, no imports: unit-tested in finance.test.mjs.
// All money in AUD. Rates in percent per year unless stated.

/** SA stamp duty (RevenueSA general rates, established home, no concession). */
export function stampDutySA(price) {
  const v = Math.max(0, Number(price) || 0);
  if (v <= 12000) return v * 0.01;
  if (v <= 30000) return 120 + (v - 12000) * 0.02;
  if (v <= 50000) return 480 + (v - 30000) * 0.03;
  if (v <= 100000) return 1080 + (v - 50000) * 0.035;
  if (v <= 200000) return 2830 + (v - 100000) * 0.04;
  if (v <= 250000) return 6830 + (v - 200000) * 0.0425;
  if (v <= 300000) return 8955 + (v - 250000) * 0.0475;
  if (v <= 500000) return 11330 + (v - 300000) * 0.05;
  return 21330 + (v - 500000) * 0.055;
}

/** Land Services SA transfer registration fee, 2025-26 schedule (rough estimate). */
export function transferFeeSA(price) {
  const v = Math.max(0, Number(price) || 0);
  if (v <= 5000) return 198;
  if (v <= 20000) return 221;
  if (v <= 40000) return 243;
  if (v <= 50000) return 342;
  return 342 + 102 * Math.ceil((v - 50000) / 10000);
}

/** Mortgage registration fee (LSSA document lodgement, flat). */
export const MORTGAGE_REGISTRATION_FEE = 198;

/** Monthly P&I repayment for a loan at an annual rate over a term in years. */
export function monthlyRepayment(principal, annualRatePct, years) {
  const P = Math.max(0, Number(principal) || 0);
  const n = Math.max(1, Math.round((Number(years) || 0) * 12));
  const r = (Number(annualRatePct) || 0) / 100 / 12;
  if (P === 0) return 0;
  if (r === 0) return P / n;
  return (P * r) / (1 - Math.pow(1 + r, -n));
}

export function totalInterest(principal, annualRatePct, years) {
  const n = Math.max(1, Math.round((Number(years) || 0) * 12));
  return monthlyRepayment(principal, annualRatePct, years) * n - (Number(principal) || 0);
}

export function lvr(price, deposit) {
  const p = Number(price) || 0;
  if (p <= 0) return 0;
  return Math.max(0, (p - (Number(deposit) || 0)) / p) * 100;
}

/** Very rough lenders mortgage insurance estimate as a one-off premium. */
export function lmiEstimate(loan, lvrPct) {
  const L = Number(loan) || 0;
  if (lvrPct <= 80) return 0;
  if (lvrPct <= 85) return L * 0.01;
  if (lvrPct <= 90) return L * 0.019;
  if (lvrPct <= 95) return L * 0.035;
  return L * 0.045;
}

/**
 * Shift the mortgage rate by the forecast change in the cash rate.
 * cashForecast: [{date, value, lo, hi}], cashCurrent: number.
 * Returns one row per forecast point with the implied monthly repayment and its band.
 */
export function forecastRepayments({ loan, ratePct, years, cashForecast = [], cashCurrent }) {
  if (!Array.isArray(cashForecast) || cashForecast.length === 0 || cashCurrent == null) return [];
  return cashForecast
    .filter((f) => f && f.value != null)
    .map((f) => {
      const d = f.value - cashCurrent;
      const dLo = (f.lo ?? f.value) - cashCurrent;
      const dHi = (f.hi ?? f.value) - cashCurrent;
      const rate = ratePct + d;
      const rateLo = ratePct + dLo;
      const rateHi = ratePct + dHi;
      return {
        date: f.date,
        rate,
        rateLo,
        rateHi,
        repay: monthlyRepayment(loan, rate, years),
        repayLo: monthlyRepayment(loan, rateLo, years),
        repayHi: monthlyRepayment(loan, rateHi, years),
      };
    });
}

/**
 * Full calculation for the finance panel.
 * inputs: { price, deposit, depositPct, incomes:[..], termYears, ratePct, bufferPct }
 * macro: { cashRate:{current, forecast}, mortgageRate:{current} } (optional)
 */
export function computeFinance(inputs, macro) {
  const price = Math.max(0, Number(inputs.price) || 0);
  let deposit = Number(inputs.deposit);
  if (!Number.isFinite(deposit)) deposit = 0;
  if (inputs.depositMode === 'pct') deposit = price * ((Number(inputs.depositPct) || 0) / 100);
  deposit = Math.min(Math.max(0, deposit), price);
  const termYears = Math.min(40, Math.max(1, Number(inputs.termYears) || 30));
  const ratePct = Number.isFinite(Number(inputs.ratePct)) && inputs.ratePct !== '' && inputs.ratePct != null
    ? Number(inputs.ratePct)
    : (macro?.mortgageRate?.current ?? 6);
  const bufferPct = Number.isFinite(Number(inputs.bufferPct)) ? Number(inputs.bufferPct) : 3;
  const incomes = (inputs.incomes || []).map((x) => Number(x) || 0);
  const incomeAnnual = incomes.reduce((a, b) => a + b, 0);

  const stampDuty = stampDutySA(price);
  const transferFee = transferFeeSA(price);
  const loan = Math.max(0, price - deposit);
  const lvrPct = lvr(price, deposit);
  const lmi = lmiEstimate(loan, lvrPct);
  const monthly = monthlyRepayment(loan, ratePct, termYears);
  const interest = totalInterest(loan, ratePct, termYears);
  const upfront = stampDuty + transferFee + MORTGAGE_REGISTRATION_FEE + lmi;
  const cashNeeded = deposit + upfront;
  const repayToIncome = incomeAnnual > 0 ? (monthly * 12) / incomeAnnual * 100 : null;
  const bufferedMonthly = monthlyRepayment(loan, ratePct + bufferPct, termYears);
  const bufferedToIncome = incomeAnnual > 0 ? (bufferedMonthly * 12) / incomeAnnual * 100 : null;
  // A common lender rule of thumb: buffered repayments under ~30-35% of gross income.
  const bufferVerdict = bufferedToIncome == null ? null : bufferedToIncome <= 30 ? 'comfortable' : bufferedToIncome <= 38 ? 'tight' : 'unlikely';
  const forecast = forecastRepayments({
    loan,
    ratePct,
    years: termYears,
    cashForecast: macro?.cashRate?.forecast || [],
    cashCurrent: macro?.cashRate?.current,
  });

  return {
    price, deposit, termYears, ratePct, bufferPct, incomeAnnual,
    stampDuty, transferFee, mortgageRegistration: MORTGAGE_REGISTRATION_FEE,
    loan, lvrPct, lmi, upfront, cashNeeded,
    monthly, interest, repayToIncome,
    bufferedMonthly, bufferedToIncome, bufferVerdict,
    forecast,
  };
}
