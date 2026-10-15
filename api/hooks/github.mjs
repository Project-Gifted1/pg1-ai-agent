// /api/hooks/github: GitHub webhook (workflow_run, pull_request,
// check_suite), verified with X-Hub-Signature-256 and GITHUB_WEBHOOK_SECRET.
// A finished lab run syncs its experiment at once; any watched PR, run or
// lab experiment that changed state gets its report (lib/watches).
// Unsigned or wrongly signed events are refused and logged without their
// payload. See docs/watches.md for setting the webhook up.
//
// A Web handler (POST, no default export) on purpose: Vercel then skips its
// Node body parsing, and the HMAC is checked over the exact bytes GitHub
// signed (asWebHandler). A default (req, res) export would get them parsed
// and every delivery would fail with bad_signature or no_raw_body.

import { createGithubHookHandler, asWebHandler } from '../../lib/watches/hooks.mjs';

export const config = { maxDuration: 30 };

export const POST = asWebHandler(createGithubHookHandler());
