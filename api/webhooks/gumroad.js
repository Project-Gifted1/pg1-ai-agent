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
    if (expectedSellerId && payload.seller_id && payload.seller_id !== expectedSellerId) {
      return res.status(401).json({ error: 'Unauthorized seller identity' });
    }

    const supabaseUrl = process.env.SUPABASE_URL || '';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASEAPI_KEY || process.env.SUPABASE_ANON_KEY || '';

    // Immediate 200 OK handshake to prevent Gumroad retry loops
    res.status(200).json({ status: 'received', event_type: 'gumroad_sale' });

    if (supabaseUrl && supabaseKey) {
      // Pushing directly to the new sales_ledger table matching the exact schema created
      await fetch(`${supabaseUrl}/rest/v1/sales_ledger`, {
        method: 'POST',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          event_type: 'gumroad_sale',
          buyer_email: String(payload.email || 'unknown'),
          product_id: String(payload.product_id || 'unknown'),
          price_cents: Number(payload.price || 0)
        })
      });
    }
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
}
