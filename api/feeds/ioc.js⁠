export const config = {
  api: {
    bodyParser: true,
  },
};

import { v4 as uuidv4 } from 'uuid';

export default async function handler(req, res) {
  // CORS Headers for B2B API access
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 1. EXTRACT LICENSE KEY
  const clientLicenseKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  
  if (!clientLicenseKey) {
    return res.status(401).json({ error: 'Unauthorized: Missing Gumroad License Key in x-api-key header.' });
  }

  try {
    // 2. VALIDATE GUMROAD SUBSCRIPTION
    const gumroadVerifyUrl = 'https://api.gumroad.com/v2/licenses/verify';
    const gumroadParams = new URLSearchParams({
      product_id: process.env.GUMROAD_PRODUCT_ID,
      license_key: clientLicenseKey,
    });

    const gumroadRes = await fetch(gumroadVerifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: gumroadParams
    });

    const gumroadData = await gumroadRes.json();

    if (!gumroadData.success || gumroadData.purchase.refunded || gumroadData.purchase.chargebacked) {
      return res.status(403).json({ error: 'Forbidden: Invalid, expired, or refunded Gumroad License Key.' });
    }

    // 3. FETCH TELEMETRY VIA SUPABASE SERVICE ROLE (Bypassing Anon RLS)
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    const threatRes = await fetch(`${supabaseUrl}/rest/v1/threat_ioc_telemetry?select=*&order=last_seen.desc&limit=500`, {
      method: 'GET',
      headers: {
        'apikey': serviceRoleKey,
        'Authorization': `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!threatRes.ok) {
      throw new Error(`Supabase Vault Error: ${threatRes.status}`);
    }

    const rawTelemetry = await threatRes.json();

    // 4. FORMAT TO STIX 2.1 JSON BUNDLE
    const timestamp = new Date().toISOString();
    const stixObjects = rawTelemetry.map((record) => {
      const createdTime = record.first_seen ? new Date(record.first_seen).toISOString() : timestamp;
      const modifiedTime = record.last_seen ? new Date(record.last_seen).toISOString() : timestamp;

      return {
        type: 'indicator',
        spec_version: '2.1',
        id: `indicator--${uuidv4()}`,
        created: createdTime,
        modified: modifiedTime,
        name: `Malicious Host: ${record.ip_address}`,
        description: `Active malicious IPv4 detected across 4-node x402 core grid. Threat Vector: ${record.attack_vector}. Confidence: ${record.confidence}%.`,
        indicator_types: ['malicious-activity'],
        pattern: `[ipv4-addr:value = '${record.ip_address}']`,
        pattern_type: 'stix',
        pattern_version: '2.1',
        valid_from: createdTime,
        confidence: record.confidence ?? 100,
        labels: ['ioc-telemetry', 'x402-core-4node', 'realtime-threat']
      };
    });

    const stixBundle = {
      type: 'bundle',
      id: `bundle--${uuidv4()}`,
      spec_version: '2.1',
      objects: stixObjects
    };

    // 5. DISPATCH PAYLOAD
    return res.status(200).json(stixBundle);

  } catch (error) {
    console.error('IOC Feed Error:', error);
    return res.status(500).json({ error: 'Internal Server Error: Vault connection failed.' });
  }
}
