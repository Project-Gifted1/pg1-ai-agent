// Loaded before every test file (through tests/helpers/spend-cap.mjs, which
// package.json's test scripts and the CI workflow import): the operator's
// sign-in state (lib/security/store.mjs) lives in this process's memory
// store, as on a deployment without Supabase, even in the many tests that
// set SUPABASE_URL and stub fetch for other tables. The tests of the
// durable store pass a Supabase store over PGlite themselves
// (tests/security-*.test.mjs); __clearAuthRateLimitState() resets this one.
import { setSecurityStore, memorySecurityStore } from '../../lib/security/store.mjs';

setSecurityStore(memorySecurityStore());
