// Prints a new PG1_SIGNING_KEY (an Ed25519 seed) and its public JWK.
// Usage: node scripts/signing-key.mjs
import { generateSigningKey, publicJwks } from '../lib/signing.mjs';

const { PG1_SIGNING_KEY } = generateSigningKey();
console.log(`PG1_SIGNING_KEY=${PG1_SIGNING_KEY}`);
console.log(`public JWKS: ${JSON.stringify(publicJwks({ PG1_SIGNING_KEY }))}`);
