// Fills alert_subscriptions.license_key_hash for rows stored before keys
// were hashed. Run with the production env (SUPABASE_URL, the service-role
// key and TELEMETRY_IP_SALT exactly as deployed, so the hashes match what
// the live code computes):
//   node scripts/alert-subscriptions-backfill-hash.mjs           dry run, counts only
//   node scripts/alert-subscriptions-backfill-hash.mjs --apply   writes the hashes
// Prints counts only, never a key or a hash. Never touches license_key.
import { getSupabaseCreds } from '../lib/supabase.mjs';
import { backfillAlertSubscriptionHashes } from '../lib/alertSubscriptionsBackfill.mjs';

const apply = process.argv.includes('--apply');
if (!String(process.env.TELEMETRY_IP_SALT || '').trim()) {
  console.warn('TELEMETRY_IP_SALT is not set: the hash falls back to a salt derived from the service-role key. Use exactly the env production uses.');
}
const { supUrl, supKey } = getSupabaseCreds();
const result = await backfillAlertSubscriptionHashes({ supUrl, supKey, apply });
console.log(JSON.stringify(result));
