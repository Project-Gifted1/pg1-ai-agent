// A small CBOR decoder (RFC 8949), enough for WebAuthn: the attestation
// object a browser sends at passkey registration and the COSE public key
// inside it. Major types 0-5 and 7 (false, true, null, undefined); no
// floats, tags or indefinite lengths, which neither of those uses. Anything
// else throws, so a malformed or unexpected value is refused, never guessed.

export class CborError extends Error {}

const MAX_DEPTH = 16;
const MAX_ITEMS = 4096;

function readLength(buf, pos, info) {
  if (info < 24) return { value: info, pos };
  if (info === 24) { need(buf, pos, 1); return { value: buf[pos], pos: pos + 1 }; }
  if (info === 25) { need(buf, pos, 2); return { value: buf.readUInt16BE(pos), pos: pos + 2 }; }
  if (info === 26) { need(buf, pos, 4); return { value: buf.readUInt32BE(pos), pos: pos + 4 }; }
  if (info === 27) {
    need(buf, pos, 8);
    const big = buf.readBigUInt64BE(pos);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new CborError('integer too large');
    return { value: Number(big), pos: pos + 8 };
  }
  throw new CborError('unsupported length');
}

function need(buf, pos, n) {
  if (pos + n > buf.length) throw new CborError('truncated');
}

function decodeItem(buf, pos, depth) {
  if (depth > MAX_DEPTH) throw new CborError('too deep');
  need(buf, pos, 1);
  const first = buf[pos];
  const major = first >> 5;
  const info = first & 0x1f;
  pos += 1;
  if (major === 7) {
    if (info === 20) return { value: false, pos };
    if (info === 21) return { value: true, pos };
    if (info === 22) return { value: null, pos };
    if (info === 23) return { value: undefined, pos };
    throw new CborError('unsupported simple value');
  }
  const len = readLength(buf, pos, info);
  pos = len.pos;
  const n = len.value;
  if (major === 0) return { value: n, pos };
  if (major === 1) return { value: -1 - n, pos };
  if (major === 2) { need(buf, pos, n); return { value: Buffer.from(buf.subarray(pos, pos + n)), pos: pos + n }; }
  if (major === 3) { need(buf, pos, n); return { value: buf.toString('utf8', pos, pos + n), pos: pos + n }; }
  if (n > MAX_ITEMS) throw new CborError('too many items');
  if (major === 4) {
    const out = [];
    for (let i = 0; i < n; i++) { const r = decodeItem(buf, pos, depth + 1); out.push(r.value); pos = r.pos; }
    return { value: out, pos };
  }
  if (major === 5) {
    const out = new Map();
    for (let i = 0; i < n; i++) {
      const k = decodeItem(buf, pos, depth + 1);
      if (typeof k.value !== 'number' && typeof k.value !== 'string') throw new CborError('unsupported map key');
      const v = decodeItem(buf, k.pos, depth + 1);
      out.set(k.value, v.value);
      pos = v.pos;
    }
    return { value: out, pos };
  }
  throw new CborError('unsupported major type');
}

// Decodes one item from the start of buf: { value, length } (length: the
// bytes it took, so a caller can find what follows it, as WebAuthn's
// authenticator data needs for the public key and any extensions).
export function decodeFirst(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const r = decodeItem(b, 0, 0);
  return { value: r.value, length: r.pos };
}

// Decodes a buffer that holds exactly one item.
export function decode(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const r = decodeItem(b, 0, 0);
  if (r.pos !== b.length) throw new CborError('trailing bytes');
  return r.value;
}

// The encoder: only what the tests' software authenticator needs to build
// attestation objects and COSE keys (unsigned and negative integers, byte
// and text strings, arrays, Maps and plain objects with string keys).
function head(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
}

export function encode(value) {
  if (value === false) return Buffer.from([0xf4]);
  if (value === true) return Buffer.from([0xf5]);
  if (value === null) return Buffer.from([0xf6]);
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new CborError('integers only');
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === 'string') { const s = Buffer.from(value, 'utf8'); return Buffer.concat([head(3, s.length), s]); }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) { const b = Buffer.from(value); return Buffer.concat([head(2, b.length), b]); }
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(encode)]);
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, v]) => [encode(k), encode(v)])]);
}
