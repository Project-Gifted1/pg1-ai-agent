// /api/hooks/lab: the lab runner's result notice (the notify job at the end
// of .github/workflows/lab.yml), signed with PG1_LAB_DISPATCH_SECRET over
// "<timestamp>.<body>" and refused when older than 10 minutes. PG1 answers
// at once and syncs the experiment right after (its run is still finishing
// when the notice arrives), then reports it if watched (lib/watches).

import { waitUntil } from '@vercel/functions';
import { createLabHookHandler } from '../../lib/watches/hooks.mjs';

export const config = { maxDuration: 60 };

export default createLabHookHandler({ waitUntil });
