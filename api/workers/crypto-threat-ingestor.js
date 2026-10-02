// Fetches the current threat list from the Crypto Threat Signals API.
// The API key is read from the CRYPTO_THREAT_SIGNALS_API_KEY environment
// variable and never lives in the source; the route answers 503 until it
// is configured.
export default async function handler(req, res) {
  const targetUrl = 'https://crypto-threat-signals-api.onrender.com/threats';
  const apiKey = process.env.CRYPTO_THREAT_SIGNALS_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'CRYPTO_THREAT_SIGNALS_API_KEY is not configured' });
  }
  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: { 'X-API-Key': apiKey, 'Accept': 'application/json', 'User-Agent': 'PG1-Sovereign-Core/10.0-Live' }
    });
    const data = await response.json();
    return res.status(200).json({ status: 'SUCCESS', data: data });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
