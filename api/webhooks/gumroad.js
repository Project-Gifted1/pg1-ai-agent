export const maxDuration = 30;
export const dynamic = 'force-dynamic';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Parse URL-encoded form data sent by Gumroad webhooks
    let payload = {};
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      payload = req.body;
    } else {
      const rawBody = typeof req.body === 'string' ? req.body : '';
      const params = new URLSearchParams(rawBody);
      payload = Object.fromEntries(params.entries());
    }

    const saleId = payload.sale_id || payload.id || 'sale_' + Date.now();

    // Security check: Validate seller ID if configured
    const expectedSellerId = process.env.GUMROAD_SELLER_ID;
    if (expectedSellerId && payload.seller_id && payload.seller_id !== expectedSellerId) {
      return res.status(401).json({ error: 'Unauthorized seller identity' });
    }

    const supabaseUrl = process.env.SUPABASE_URL || '';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASEAPI_KEY || process.env.SUPABASE_ANON_KEY || '';

    // Immediate 200 OK handshake to prevent Gumroad retry loops
    res.status(200).json({ status: 'received', sale_id: saleId });

    if (supabaseUrl && supabaseKey) {
      await fetch(`${supabaseUrl}/rest/v1/gumroad_sales`, {
        method: 'POST',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify({
          sale_id: String(saleId),
          product_id: String(payload.product_id || ''),
          product_name: String(payload.product_name || ''),
          email: String(payload.email || ''),
          price: Number(payload.price || 0),
          currency: String(payload.currency || 'usd'),
          license_key: String(payload.license_key || ''),
          raw_payload: payload,
          created_at: new Date().toISOString()
        })
      });
    }
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
}
