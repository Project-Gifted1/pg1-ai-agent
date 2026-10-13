// The reply font (Source Serif 4, loaded by public/index.html from Google
// Fonts) served from tests/fixtures/fonts for the browser tests: CI blocks
// every non-loopback request from Chromium (tests/ci/no-network.mjs), and
// the screenshots should show the real font, not a fallback. Call
// routeReplyFont(context) before the first page.goto.

import { readFileSync } from 'node:fs';

const FONT_DIR = new URL('../fixtures/fonts/', import.meta.url);
const FILES = {
  normal: readFileSync(new URL('source-serif-4-latin-normal.woff2', FONT_DIR)),
  italic: readFileSync(new URL('source-serif-4-latin-italic.woff2', FONT_DIR))
};

const CSS = `@font-face { font-family: 'Source Serif 4'; font-style: normal; font-weight: 200 900; font-display: swap; src: url(https://fonts.gstatic.com/pg1-test/source-serif-4-normal.woff2) format('woff2'); }
@font-face { font-family: 'Source Serif 4'; font-style: italic; font-weight: 200 900; font-display: swap; src: url(https://fonts.gstatic.com/pg1-test/source-serif-4-italic.woff2) format('woff2'); }
`;

export async function routeReplyFont(context) {
  const cors = { 'Access-Control-Allow-Origin': '*' };
  await context.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/css; charset=utf-8', headers: cors, body: CSS }));
  await context.route('https://fonts.gstatic.com/**', (route) => {
    const file = /italic/.test(route.request().url()) ? FILES.italic : FILES.normal;
    return route.fulfill({ status: 200, contentType: 'font/woff2', headers: cors, body: file });
  });
}
