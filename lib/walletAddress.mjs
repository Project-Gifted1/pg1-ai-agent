// Wallet address normalisation, matching the sovereign-threat-pipeline
// ingestor exactly so lookups against sanctioned_wallets.address_normalized
// hit the same rows the pipeline wrote: 0x-prefixed (EVM) and bech32
// (bc1/tb1/bcrt1/ltc1/tltc1/rltc1-prefixed) addresses are lowercased;
// everything else (e.g. base58 addresses, which are case-sensitive) is left
// untouched.

const BECH32_PREFIXES = ['bc1', 'tb1', 'bcrt1', 'ltc1', 'tltc1', 'rltc1'];

export function normalizeWalletAddress(address) {
  const trimmed = String(address ?? '').trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('0x')) return lower;
  if (BECH32_PREFIXES.some((prefix) => lower.startsWith(prefix))) return lower;
  return trimmed;
}
