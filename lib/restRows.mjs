// BULK INSERTS over PostgREST: every object in one request must have the
// same keys, or PostgREST refuses the whole request with 400 PGRST102 ("All
// object keys must match"). Production, 20 Oct (19:13, 19:17 and 19:18 UTC,
// and ordinary turns at 05:20 and 13:16-13:19): the chat sent the operator's
// message with speaker (and a relayed one with relay_name too) and PG1's
// reply without them, so the exchange was never saved.
//
// Rule: a bulk insert names every column on every row, with null where a
// row has no value (never a missing key, never undefined, which JSON drops).
// uniformRows() checks that before anything is sent and throws
// MixedKeysError, so a mixed batch fails loudly in tests and in the log
// instead of silently at PostgREST.

export class MixedKeysError extends Error {
  constructor(table, expected, got, index) {
    super(`bulk insert into ${table}: row ${index} has keys [${got.join(', ')}], row 0 has [${expected.join(', ')}]`);
    this.code = 'MIXED_KEYS';
    this.table = table;
  }
}

const keysOf = (row) => Object.keys(row || {}).filter((k) => row[k] !== undefined).sort();

// The rows, unchanged, when every row has the same keys (undefined values
// count as missing, as they are in JSON); else MixedKeysError.
export function uniformRows(rows, table = 'table') {
  const list = Array.isArray(rows) ? rows : [rows];
  if (list.length < 2) return list;
  const first = keysOf(list[0]);
  list.forEach((row, i) => {
    const got = keysOf(row);
    if (got.join(',') !== first.join(',')) throw new MixedKeysError(table, first, got, i);
  });
  return list;
}
