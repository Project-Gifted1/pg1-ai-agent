// /api/hooks/vercel: deployment webhooks (created, succeeded, error,
// canceled), verified with x-vercel-signature and VERCEL_WEBHOOK_SECRET.
// Production deploys are watched automatically; a watched deploy that ends
// gets its report (lib/watches). Unsigned or wrongly signed events are
// refused and logged without their payload. See docs/watches.md.
//
// A Web handler (POST, no default export) so the HMAC is checked over the
// exact bytes Vercel signed, not a parsed body (see api/hooks/github.mjs).

import { createVercelHookHandler, asWebHandler } from '../../lib/watches/hooks.mjs';

export const config = { maxDuration: 30 };

export const POST = asWebHandler(createVercelHookHandler());
