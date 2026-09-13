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

    const expectedSellerId = process.env.GUMROAD_SELLER_ID;
    if (!expectedSellerId) {
      return res.status(500).json({ error: 'Server misconfigured: seller verification unavailable.' });
    }
    if (!payload.seller_id || payload.seller_id !== expectedSellerId) {
      return res.status(401).json({ error: 'Unauthorized seller identity' });
    }

    const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\s+/g, '');
    const supabaseKey = (process.env.SUPABASE_SERVICE_ROLEKEY || '').replace(/\s+/g, '');

    if (!supabaseUrl || !supabaseKey) {
      return res.status(200).json({ status: 'received_no_storage' });
    }

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

    try {
      var upsertUrl = saleId
        ? `${supabaseUrl}/rest/v1/sales_ledger?on_conflict=sale_id`
        : `${supabaseUrl}/rest/v1/sales_ledger`;

      await fetch(upsertUrl, {
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
    } catch (dbErr) {
      console.error(`[GUMROAD WEBHOOK] Supabase insert exception: ${dbErr.message}`);
    }

    return res.status(200).json({ status: 'received', event_type: eventType });
  } catch (err) {
    if (!res.headersSent) {
      return res.status(500).json({ error: err.message });
    }
  }
}
