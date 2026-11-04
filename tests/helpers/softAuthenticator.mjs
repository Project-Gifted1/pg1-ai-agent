// A software passkey for the tests: a P-256 (or Ed25519) key pair that
// answers navigator.credentials.create() / .get() options the way a phone
// does, as the page would send the result to api/security.mjs (base64url
// fields). It signs for real, so the server's checks run on real data.
// Knobs to make it misbehave: origin, rpId, uv (user verification), the
// counter, a tampered signature.

import crypto from 'node:crypto';
import { encode } from '../../lib/security/cbor.mjs';
import { b64url, fromB64url } from '../../lib/security/webauthn.mjs';

export function createSoftAuthenticator({ origin, rpId, alg = 'ES256', counter = 0 } = {}) {
  const pair = alg === 'EdDSA' ? crypto.generateKeyPairSync('ed25519') : crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const credentialId = crypto.randomBytes(32);
  let count = counter;
  const jwk = pair.publicKey.export({ format: 'jwk' });
  const cose = alg === 'EdDSA'
    ? new Map([[1, 1], [3, -8], [-1, 6], [-2, fromB64url(jwk.x)]])
    : new Map([[1, 2], [3, -7], [-1, 1], [-2, fromB64url(jwk.x)], [-3, fromB64url(jwk.y)]]);

  function authData({ rp, flags, withCredential }) {
    const head = Buffer.alloc(37);
    crypto.createHash('sha256').update(rp).digest().copy(head, 0);
    head[32] = flags;
    head.writeUInt32BE(count, 33);
    if (!withCredential) return head;
    const len = Buffer.alloc(2); len.writeUInt16BE(credentialId.length);
    return Buffer.concat([head, Buffer.alloc(16), len, credentialId, encode(cose)]);
  }
  const clientData = (type, challenge, o) => Buffer.from(JSON.stringify({ type, challenge, origin: o, crossOrigin: false }));

  return {
    credentialId: b64url(credentialId),
    // navigator.credentials.create({ publicKey: options })
    create(options, { originOverride, rpOverride, uv = true } = {}) {
      const rp = rpOverride || rpId || options.rp.id;
      const cd = clientData('webauthn.create', options.challenge, originOverride || origin);
      const ad = authData({ rp, flags: 0x01 | (uv ? 0x04 : 0) | 0x40 | 0x08 | 0x10, withCredential: true });
      const att = encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', ad]]));
      return { id: b64url(credentialId), rawId: b64url(credentialId), type: 'public-key', response: { clientDataJSON: b64url(cd), attestationObject: b64url(att), transports: ['internal', 'hybrid'] } };
    },
    // navigator.credentials.get({ publicKey: options })
    get(options, { originOverride, rpOverride, uv = true, tamper = false, bump = 1, challenge } = {}) {
      count += bump;
      const rp = rpOverride || rpId || options.rpId;
      const cd = clientData('webauthn.get', challenge || options.challenge, originOverride || origin);
      const ad = authData({ rp, flags: 0x01 | (uv ? 0x04 : 0) | 0x08 | 0x10, withCredential: false });
      const signed = Buffer.concat([ad, crypto.createHash('sha256').update(cd).digest()]);
      let sig = alg === 'EdDSA' ? crypto.sign(null, signed, pair.privateKey) : crypto.sign('sha256', signed, { key: pair.privateKey, dsaEncoding: 'der' });
      if (tamper) { sig = Buffer.from(sig); sig[sig.length - 1] ^= 0xff; }
      return { id: b64url(credentialId), rawId: b64url(credentialId), type: 'public-key', response: { clientDataJSON: b64url(cd), authenticatorData: b64url(ad), signature: b64url(sig), userHandle: b64url(Buffer.from('pg1-operator')) } };
    },
    setCounter(n) { count = n; }
  };
}
