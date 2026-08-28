'use strict';

const { requestPipelineSync } = require('./lib/pipeline-telemetry');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const action = String(body.action || '');

  if (action === 'refresh_status') {
    return res.status(200).json({ ok: true, message: 'Status refresh requested.' });
  }

  if (action !== 'request_sync') {
    return res.status(400).json({ ok: false, message: 'Unknown action.' });
  }

  try {
    const result = await requestPipelineSync({
      confirmed: Boolean(body.confirmed),
      reason: body.reason
    });

    return res.status(result.status).json({ ok: result.ok, message: result.message });
  } catch (error) {
    return res.status(500).json({ ok: false, message: `Unable to request sync: ${error.message}` });
  }
};
