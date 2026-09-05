export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization;
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized pulse request' });
  }

  try {
    const timestamp = new Date().toISOString();
    console.log(`[PG1-AGENT:HEARTBEAT] Pulse logged at ${timestamp}`);

    return res.status(200).json({ 
      status: 'HEARTBEAT_ACTIVE',
      pulse_time: timestamp,
      message: 'Sprint 3 background loop successfully executed.'
    });
  } catch (error) {
    console.error('[PG1-AGENT:HEARTBEAT] Critical Error:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
