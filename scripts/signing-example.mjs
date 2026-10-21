/**
 * The worked example of a signed PG1 result (README "Verify a result",
 * /docs/agents): one real fixture result (check_wallet_sanctions, the
 * FLAGGED test wallet) signed exactly as /api/mcp signs it, but with the
 * DOCUMENTATION EXAMPLE KEY, never the production key. Its seed is the
 * SHA-256 of a public sentence, so anyone can rebuild it; production
 * results carry the production kid and verify against
 * /.well-known/pg1-signing-key.
 *
 * Writes:
 *   public/docs/signed-result-example.json       the request, result and signature
 *   public/docs/signed-result-example-jwks.json  the example key's public JWKS
 *
 * Ed25519 is deterministic, so tests/signing-discovery.test.mjs rebuilds
 * both and fails if the committed files drift. Run after changing the
 * fixture or the signing code:
 *
 *   node scripts/signing-example.mjs
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EXAMPLE_KID = 'pg1-docs-example';
export const EXAMPLE_SEED_SENTENCE = 'PG1 documentation example signing key. Never used in production.';
export const EXAMPLE_TIME = '2026-10-21T12:00:00.000Z';
export const EXAMPLE_VERSION = '1.20.2';
export const EXAMPLE_REQUEST_ID = '00000000-0000-4000-8000-000000000001';
export const EXAMPLE_FILE = 'public/docs/signed-result-example.json';
export const EXAMPLE_JWKS_FILE = 'public/docs/signed-result-example-jwks.json';
export const EXAMPLE_JWKS_URL = 'https://pg1-ai-agent.vercel.app/docs/signed-result-example-jwks.json';

export const exampleEnv = () => ({
  PG1_SIGNING_KEY: crypto.createHash('sha256').update(EXAMPLE_SEED_SENTENCE).digest('base64url'),
  PG1_SIGNING_KEY_ID: EXAMPLE_KID
});

export async function buildSigningExample() {
  const { FIXTURE_VALUES } = await import('../lib/fixtures.mjs');
  const { resolveTestFixture } = await import('../api/mcp.mjs');
  const { signResult, publicJwks } = await import('../lib/signing.mjs');
  const tool = 'check_wallet_sanctions';
  const args = { address: FIXTURE_VALUES.wallet.FLAGGED };
  const outcome = resolveTestFixture(tool, args);
  // The fixture's check times are "now"; the example pins them.
  const result = { ...outcome.result, checks: outcome.result.checks.map((c) => ({ ...c, checked_at: EXAMPLE_TIME, data_as_of: EXAMPLE_TIME })), request_id: EXAMPLE_REQUEST_ID };
  const env = exampleEnv();
  const signature = signResult({ tool, args, result, env, now: new Date(EXAMPLE_TIME), version: EXAMPLE_VERSION });
  return {
    example: {
      note: 'Signed with the PG1 documentation example key (kid pg1-docs-example), not the production key. Its public key is at ' + EXAMPLE_JWKS_URL + '. Production results verify against https://pg1-ai-agent.vercel.app/.well-known/pg1-signing-key.',
      request: { tool, arguments: args },
      result,
      signature
    },
    jwks: publicJwks(env)
  };
}

const write = (file, value) => fs.writeFileSync(path.join(ROOT, file), JSON.stringify(value, null, 2) + '\n');

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const { example, jwks } = await buildSigningExample();
  write(EXAMPLE_FILE, example);
  write(EXAMPLE_JWKS_FILE, jwks);
  console.log(`wrote ${EXAMPLE_FILE} and ${EXAMPLE_JWKS_FILE} (kid ${example.signature.kid})`);
}
