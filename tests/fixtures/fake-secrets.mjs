// Fake credentials for the Send to Code secret-stripping tests
// (tests/handoff*.test.mjs). None of these is real. Each one is assembled
// at runtime from parts so the source never contains a literal
// token-shaped string for secret scanners to flag, yet every value has
// the exact shape of the real credential it stands in for, so the
// stripping patterns are exercised just as hard. Every value carries a
// "PG1"/"pg1" test-fixture marker; tests/handoff.test.mjs checks the shapes
// and the marker.

const join = (...parts) => parts.join('');
const b64url = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

export const FAKE = {
  // HS256 JWT with a service_role claim for a made-up project ref, and a
  // signature that is just readable text.
  supabaseJwt: [
    b64url({ alg: 'HS256', typ: 'JWT' }),
    b64url({ iss: 'supabase', ref: 'pg1-test-fixture', role: 'service_role' }),
    b64url('not-a-real-signature-pg1-test-fixture')
  ].join('.'),
  supabaseSecretKey: join('sb_', 'secret_', 'PG1TestFixture'.padEnd(32, '0')),
  googleKey: join('AI', 'za', 'Sy', 'PG1TESTFIXTURE'.padEnd(33, 'x')),
  anthropicKey: join('sk-', 'ant-', 'api03-', 'pg1-test-fixture-'.padEnd(40, 'x')),
  openaiKey: join('sk-', 'proj-', 'PG1TESTFIXTURE'.padEnd(24, 'X')),
  githubPat: join('gh', 'p_', 'PG1TestFixture'.padEnd(36, '0')),
  githubFineGrainedPat: join('github', '_pat_', '11PG1TESTFIXTURE'.padEnd(22, '0'), '_', 'pg1TestFixture'.padEnd(59, 'x')),
  awsAccessKeyId: join('AK', 'IA', 'PG1TESTFIXTURE00'),
  bearerToken: join('pg1-test-', 'fixture-', 'bearer-0001'),
  privateKeyBlock: join(
    '-----BEGIN RSA PRIVATE', ' KEY-----\n',
    'PG1TESTFIXTURE\n',
    '-----END RSA PRIVATE', ' KEY-----'
  ),
  dbUser: join('pg1', '_fixture'),
  dbPassword: join('pg1', '-fixture-', 'pw-01'),
  passkey: join('Pg1', '-Fixture-', '0001!'),
  envSecretValue: join('pg1-fixture-', 'value-0001'),
  longToken: join('PG1Test', 'Fixture', 'LongToken', '0123456789')
};

export const bearerHeader = (token = FAKE.bearerToken) => join('Authorization: ', 'Bear', 'er ', token);
export const postgresUrl = (user = FAKE.dbUser, password = FAKE.dbPassword) => join('postgres', '://', user, ':', password, '@db.example.invalid:5432/pg1');
