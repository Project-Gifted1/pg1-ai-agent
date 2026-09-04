export const maxDuration = 10;
export const dynamic = 'force-dynamic';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const supabaseUrl = process.env.SUPABASE_URL || '';
    const uploadKey = process.env.SUPABASE_ANON_KEY || '';
    const signingKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASEAPI_KEY || uploadKey;
    const fileName = typeof req.body?.fileName === 'string' ? req.body.fileName : '';

    if (!supabaseUrl || !uploadKey) {
      return res.status(500).json({ error: 'Vault credentials missing from environment.' });
    }

    if (fileName) {
      const signedUrlResponse = await fetch(
        `${supabaseUrl}/storage/v1/object/sign/pg1-vault/${encodeURIComponent(fileName)}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: signingKey,
            Authorization: `Bearer ${signingKey}`,
          body: JSON.stringify({ expiresIn: 3600 })
        }
      );

      if (!signedUrlResponse.ok) {
        const errorText = await signedUrlResponse.text();
        return res.status(500).json({ error: errorText || 'Signed vault URL generation failed.' });
      }

      const signedUrlPayload = await signedUrlResponse.json();
      const signedPath = signedUrlPayload?.signedURL || signedUrlPayload?.signedUrl || signedUrlPayload?.url;

      if (!signedPath) {
        return res.status(500).json({ error: 'Vault signed URL missing from Supabase response.' });
      }

      const signedUrl = signedPath.startsWith('http')
        ? signedPath
        : `${supabaseUrl}/storage/v1${signedPath.startsWith('/') ? '' : '/'}${signedPath}`;

      return res.status(200).json({ signedUrl });
    }

    return res.status(200).json({ url: supabaseUrl, key: uploadKey });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
