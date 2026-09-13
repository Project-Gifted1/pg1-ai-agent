export const maxDuration = 30;
export const dynamic = 'force-dynamic';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    let payload = {};
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      payload = req.body;
    } else {
      const rawBody = typeof req.body === 'string' ? req.body : '';
      const params = new URLSearchParams(rawBody);
      payload = Object.fromEntries(params.entries());
    }

    // Mandatory seller verification. Gumroad doesn't sign webhooks (no HMAC), so
    // matching seller_id is the only real check available — it must never be optional.
    const expectedSellerId = process.env.GUMROAD_SELLER_ID;
    if (!expectedSellerId) {
      console.error('[GUMROAD WEBHOOK] GUMROAD_SELLER_ID env var not set — refusing all requests until configured.');
      return res.status(500).json({ error: 'Server misconfigured: seller verification unavailable.' });
    }
    if (!payload.seller_id || payload.seller_id !== expectedSellerId) {
      return res.status(401).json({ error: 'Unauthorized seller identity' });
    }

    const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\s+/g, '');
    const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASEAPI_KEY || process.env.SUPABASE_ANON_KEY || '').replace(/\s+/g, '');

    if (!supabaseUrl || !supabaseKey) {
      console.error('[GUMROAD WEBHOOK] Supabase credentials missing — event acknowledged but NOT persisted.');
      return res.status(200).json({ status: 'received_no_storage' });
    }

    // Gumroad reuses this same webhook URL for refunds, disputes, and chargebacks —
    // not just fresh sales. Reflect the real event so the ledger isn't corrupted.
    var isChargebacked = payload.chargebacked === 'true' || payload.chargebacked === true;
    var isDisputed = payload.disputed === 'true' || payload.disputed === true;
    var isRefunded = payload.refunded === 'true' || payload.refunded === true;
    var eventType = isChargebacked ? 'gumroad_chargeback'
      : isDisputed ? 'gumroad_dispute'
      : isRefunded ? 'gumroad_refund'
      : 'gumroad_sale';

    var saleId = String(payload.sale_id || payload.id || '').trim();

    var record = {
      event_type: eventType,
      sale_id: saleId || null,
      buyer_email: String(payload.email || 'unknown'),
      product_id: String(payload.product_id || 'unknown'),
      price_cents: Number(payload.price || 0)
    };

    // IMPORTANT: this insert is awaited BEFORE the response is sent. Vercel's serverless
    // runtime can freeze/recycle a function immediately after res.status().json() runs,
    // so work started after the response was not reliably completing before.
    //
    // Uses upsert (on_conflict=sale_id) so a Gumroad retry (which happens on any
    // non-2xx response or timeout) updates the same row instead of duplicating it.
    // Requires a UNIQUE constraint on the sale_id column in sales_ledger — add one via:
    //   ALTER TABLE sales_ledger ADD CONSTRAINT sales_ledger_sale_id_key UNIQUE (sale_id);
    try {
      var upsertUrl = saleId
        ? `${supabaseUrl}/rest/v1/sales_ledger?on_conflict=sale_id`
        : `${supabaseUrl}/rest/v1/sales_ledger`;

      var insertRes = await fetch(upsertUrl, {
        method: 'POST',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          'Prefer': saleId ? 'resolution=merge-duplicates,return=minimal' : 'return=minimal'
        },
        body: JSON.stringify(record),
        cache: 'no-store'
      });

      if (!insertRes.ok) {
        var errText = await insertRes.text();
        console.error(`[GUMROAD WEBHOOK] Supabase insert failed (${insertRes.status}): ${errText}`);
        // Still ack Gumroad with 200 below — we don't want infinite retries on a payload
        // whose failure is already logged for you to investigate.
      }
    } catch (dbErr) {
      console.error(`[GUMROAD WEBHOOK] Supabase insert exception: ${dbErr.message}`);
    }

    return res.status(200).json({ status: 'received', event_type: eventType });

  } catch (err) {
    console.error(`[GUMROAD WEBHOOK] Unhandled exception: ${err.message}`);
    if (!res.headersSent) {
      return res.status(500).json({ error: err.message });
    }
  }
}