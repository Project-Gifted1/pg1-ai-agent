// REST mirror of the hosting_advisor tool (lib/hosting/advisor.mjs).
//
//   POST /api/hosting-advisor  { workload_type, latency_regions, data_residency?,
//                                privacy_priority?, uptime_target?,
//                                budget_usd_month?, requirements? }
//
// Paid like the other paid tools (the shared free tier first, then 0.01 USD
// via x402 or a licence key); the result is signed. Not legal advice.

import { makePaidRestHandler } from './preflight.mjs';
import { HOSTING_TOOL } from '../lib/hosting/advisor.mjs';

export const config = { maxDuration: 15 };

export default makePaidRestHandler({
  tool: HOSTING_TOOL,
  endpoint: '/api/hosting-advisor',
  argsFrom: (req) => {
    const b = req.method === 'POST' && req.body && typeof req.body === 'object' ? req.body : null;
    return b && b.workload_type && b.latency_regions ? b : null;
  },
  usage: 'POST a JSON body with workload_type and latency_regions. Example: {"workload_type":"web_api","latency_regions":["eu_central"],"data_residency":["eu"],"privacy_priority":"high"}'
});
