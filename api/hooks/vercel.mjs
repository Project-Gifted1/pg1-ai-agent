// /api/hooks/vercel: deployment webhooks (created, succeeded, error,
// canceled), verified with x-vercel-signature and VERCEL_WEBHOOK_SECRET.
// Production deploys are watched automatically; a watched deploy that ends
// gets its report (lib/watches). Unsigned or wrongly signed events are
// refused and logged without their payload. See docs/watches.md.

import { createVercelHookHandler } from '../../lib/watches/hooks.mjs';

export const config = { maxDuration: 30 };

export default createVercelHookHandler();
