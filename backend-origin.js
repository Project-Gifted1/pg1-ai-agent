/**
 * backend-origin.js
 * Single source of truth for the PG1 backend API base URL.
 *
 * Both static entrypoints (index.html and public/index.html) load this file
 * before making any API requests so they always resolve against the correct
 * absolute origin regardless of where the frontend is hosted.
 *
 * Priority order:
 *   1. window.PG1_BACKEND_ORIGIN – set by the host page for overrides
 *   2. VERCEL_URL env-like meta tag injected at build time
 *   3. Same origin as the current page (works for Vercel preview / local dev)
 */
(function () {
  'use strict';

  if (typeof window === 'undefined') return;

  // Allow the host page to pin a specific origin (e.g. staging vs production).
  if (window.PG1_BACKEND_ORIGIN) return;

  // Try a <meta name="pg1-backend-origin" content="https://..."> tag.
  var metaTag = document.querySelector('meta[name="pg1-backend-origin"]');
  if (metaTag && metaTag.content) {
    window.PG1_BACKEND_ORIGIN = metaTag.content.replace(/\/$/, '');
    return;
  }

  // Fall back to the current page's origin so relative /api/* paths still work
  // when the frontend and backend share the same host (Vercel, local dev, etc.).
  window.PG1_BACKEND_ORIGIN = window.location.origin;
})();
