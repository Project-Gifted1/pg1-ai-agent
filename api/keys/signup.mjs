// /api/keys/signup (1.23.0): see lib/keysApi.mjs.
import { createKeysHandler } from '../../lib/keysApi.mjs';

export const config = { maxDuration: 10 };

export default createKeysHandler('signup');
