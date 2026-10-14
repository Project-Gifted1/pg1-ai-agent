// One pricing rule for everything PG1 sells or promotes: the price is at
// least MIN_PRICE_MULTIPLIER (1.5) times the worst-case cost of serving it.
// Used by the promotion gate (lib/lab/gate.mjs), A2A jobs, preflight,
// watchlists and Foundry tools, and asserted at startup and in tests.

export const MIN_PRICE_MULTIPLIER = 1.5;

export function priceCoversCost(priceUsd, worstCaseCostUsd, multiplier = MIN_PRICE_MULTIPLIER) {
  const p = Number(priceUsd);
  const c = Number(worstCaseCostUsd);
  if (!Number.isFinite(p) || !Number.isFinite(c) || p < 0 || c < 0) return false;
  return p + 1e-9 >= c * multiplier;
}

// The lowest price the rule allows, rounded up to 0.001 USD below one
// dollar and to the cent above.
export function minimumPrice(worstCaseCostUsd, multiplier = MIN_PRICE_MULTIPLIER) {
  const raw = Math.max(0, Number(worstCaseCostUsd) || 0) * multiplier;
  const step = raw < 1 ? 0.001 : 0.01;
  return Number((Math.ceil(raw / step - 1e-9) * step).toFixed(6));
}

// Throws when any priced item breaks the rule: { name, priceUsd, worstCaseCostUsd }.
export function assertPricing(items) {
  const bad = (items || []).filter((i) => !priceCoversCost(i.priceUsd, i.worstCaseCostUsd));
  if (bad.length) throw new Error(`pricing below ${MIN_PRICE_MULTIPLIER}x worst-case cost: ${bad.map((b) => `${b.name} ($${b.priceUsd} vs cost $${b.worstCaseCostUsd})`).join(', ')}`);
  return true;
}
