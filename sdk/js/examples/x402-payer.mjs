// Paying with x402 once the free tier is used up. The payer receives PG1's
// PaymentRequired and returns a signed PaymentPayload. This sketch uses the
// x402 reference client; adapt it to your wallet stack.
//
//   npm i @x402/core @x402/evm viem
import { PG1Client } from '../index.mjs';
// import { x402Client } from '@x402/core/client';
// import { registerExactEvmScheme } from '@x402/evm/exact/client';
// import { privateKeyToAccount } from 'viem/accounts';
// const client = new x402Client();
// registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.AGENT_WALLET_KEY) });

const pg1 = new PG1Client({
  payer: async (paymentRequired) => {
    // return client.createPaymentPayload(paymentRequired);
    throw new Error('wire your x402 signer here');
  }
});
console.log(await pg1.getCveDetails('CVE-2021-44228').catch((e) => e.message));
