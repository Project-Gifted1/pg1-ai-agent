// node examples/preflight.mjs 0xWALLET
import { PG1Client } from '../index.mjs';

const pg1 = new PG1Client();
const { result, verified, paymentRequired } = await pg1.preflight('pay', process.argv[2] || '0x0000000000000000000000000000000000000000', { chain: 'base' });
if (paymentRequired) {
  console.log('Free tier used up: set a payer (x402) or a licence key.');
} else {
  console.log(result.decision, result.reasons.map((r) => r.code), 'signature:', verified && verified.reason);
  if (result.decision !== 'no_flags') process.exitCode = 1; // fail closed: unknown is not clean
}
