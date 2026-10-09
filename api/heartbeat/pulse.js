import { checkCronAuth } from '../../lib/cronAuth.mjs';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = checkCronAuth(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.status === 401 ? 'Unauthorized pulse request' : auth.error });
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
