#!/usr/bin/env node
// Verifies PG1's payment configuration without paying for anything
// (lib/paymentConfigCheck.mjs). Exit code 1 when any check fails.
//
//   node scripts/verify-payment-config.mjs                 repo-only checks
//   node scripts/verify-payment-config.mjs --live          + production
//   node scripts/verify-payment-config.mjs --live <url>    + another deployment
//   ... --pay-to 0x...                                     expected payee
//
// The live checks send unpaid requests only (no X-Free-Tier header, no
// payment), so they spend no free-tier quota and move no money. See
// docs/payment-test-plan.md for the paid end-to-end steps.

import { livePaymentChecks, PROD_BASE_URL, staticPaymentChecks } from '../lib/paymentConfigCheck.mjs';

const argv = process.argv.slice(2);
const liveAt = argv.indexOf('--live');
const payToAt = argv.indexOf('--pay-to');
const base = liveAt >= 0 && argv[liveAt + 1] && !argv[liveAt + 1].startsWith('--') ? argv[liveAt + 1].replace(/\/+$/, '') : PROD_BASE_URL;
const payTo = payToAt >= 0 ? argv[payToAt + 1] : undefined;

const results = [...staticPaymentChecks()];
if (liveAt >= 0) results.push(...(await livePaymentChecks(base, { payTo })));

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed${liveAt >= 0 ? ` (live: ${base})` : ' (repo only; add --live to check production)'}`);
process.exit(failed ? 1 : 0);
