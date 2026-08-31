export const maxDuration = 30;
export const dynamic = 'force-dynamic';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const payload = req.body;
    if (!payload || !payload.sale_id) {
      return res.status(400).json({ error: 'Invalid webhook payload structure.' });
    }

    const supabaseUrl = process.env.SUPABASE_URL || '';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASEAPI_KEY || process.env.SUPABASE_ANON_KEY || '';

    res.status(200).json({ status: 'received', sale_id: payload.sale_id });

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
          sale_id: String(payload.sale_id),
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
