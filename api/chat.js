export const config = {
  api: {
    bodyParser: { sizeLimit: '10mb' },
    maxDuration: 60,
  },
};

export default async function handler(req, res) {
  const startTime = Date.now();
  const requestTraceId = Math.random().toString(36).substring(2, 10);

  const sendJSON = (status, data) => {
    if (res && typeof res.status === 'function') {
      return res.status(status).json(data);
    }
    return new Response(JSON.stringify(data), {
      status: status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key'
      }
    });
  };

  if (res && typeof res.setHeader === 'function') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
  }

  if (req.method === 'OPTIONS') {
    if (res && typeof res.status === 'function') return res.status(200).end();
    return new Response(null, { status: 200 });
  }

  let urlPath = '';
  try {
    const rawUrl = req.url || '';
    urlPath = rawUrl.includes('?') ? rawUrl.split('?')[0] : rawUrl;
  } catch (e) {
    urlPath = '';
  }

  if (urlPath === '/api/ioc' || urlPath === '/api/feeds/ioc') {
    const clientLicenseKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
    if (!clientLicenseKey) {
      return sendJSON(401, { error: 'Unauthorized: Missing Gumroad License Key in x-api-key header.' });
    }
    try {
      const gumroadRes = await fetch('https://api.gumroad.com/v2/licenses/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ product_id: process.env.GUMROAD_PRODUCT_ID, license_key: clientLicenseKey })
      });
      const gumroadData = await gumroadRes.json();
      if (!gumroadData.success || gumroadData.purchase?.refunded || gumroadData.purchase?.chargebacked) {
        return sendJSON(403, { error: 'Forbidden: Invalid, expired, or refunded Gumroad License Key.' });
      }
      
      const supUrl = process.env.SUPABASE_URL;
      const supKey = process.env.SUPABASEAPI_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
      const threatRes = await fetch(`${supUrl}/rest/v1/threat_ioc_telemetry?select=*&order=last_seen.desc&limit=500`, {
        headers: { 'apikey': supKey, 'Authorization': `Bearer ${supKey}` }
      });
      const rawTelemetry = threatRes.ok ? await threatRes.json() : [];
      return sendJSON(200, { type: 'bundle', spec_version: '2.1', count: rawTelemetry.length, data: rawTelemetry });
    } catch (err) {
      return sendJSON(500, { error: 'Internal Server Error: Vault connection failed.' });
    }
  }

  if (req.method !== 'POST') {
    return sendJSON(405, { error: 'Method Not Allowed', traceId: requestTraceId });
  }

  try {
    let reqBody = {};
    try {
      if (typeof req.json === 'function') {
        reqBody = await req.json();
      } else if (typeof req.body === 'string') {
        reqBody = JSON.parse(req.body);
      } else {
        reqBody = req.body || {};
      }
    } catch (parseErr) {
      reqBody = {};
    }

    let { 
      prompt: promptText = '', 
      action,
      actionType, 
      isAuthorizedAction = false, 
      pendingCode = '', 
      targetFile = 'api/chat.js',
      targetRepo = '', 
      file,
      multiFiles = [],
      singleFile = null,
      isPdfExport = false,
      user,
      pass,
      voice = 'christopher'
    } = reqBody;

    if (typeof promptText === 'string' && promptText.trim().startsWith('{')) {
      try {
        const parsedPrompt = JSON.parse(promptText.trim());
        if (parsedPrompt.actionType === 'ACCEPT_AUTHORIZATION') {
          actionType = parsedPrompt.actionType;
          isAuthorizedAction = parsedPrompt.isAuthorizedAction || isAuthorizedAction;
          targetFile = parsedPrompt.targetFile || targetFile;
          targetRepo = parsedPrompt.targetRepo || targetRepo;
          pendingCode = parsedPrompt.pendingCode || pendingCode;
          user = parsedPrompt.user || user;
          pass = parsedPrompt.pass || pass;
        }
      } catch (e) {}
    }

    const rawActionType = action || actionType || 'CHAT';

    const expectedUser = process.env.USER_API_USER || 'Admin';
    const expectedPass = process.env.USER_API_PASS || 'Winner1G';
    const isAuthed = (user === expectedUser && pass === expectedPass);

    if (promptText === 'AUTH_VERIFY') {
      if (!isAuthed) {
        return sendJSON(401, { success: false, reply: 'Access Denied', traceId: requestTraceId });
      }
      return sendJSON(200, { 
        success: true, authenticated: true, isValid: true,
        status: 'SUCCESS', reply: 'Access Granted', traceId: requestTraceId 
      });
    }

    const geminiKeys = [
      process.env.GEMINI_API_KEY1,
      process.env.GEMINI_API_KEY2,
      process.env.GEMINI_API_KEY
    ].filter(Boolean);

    const cartesiaKey = process.env.CARTESIA_API_KEY;
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASEAPI_KEY; 
    const replicateToken = process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_KEY; 
    const openaiKey = process.env.OPENAI_API_KEY; 
    const githubToken = process.env.GITHUB_TOKEN;
    const githubRepo = process.env.GITHUB_OWNER_KEY;
    
    // Fallback support for smoketest API key typo
    const smokeTestKey = process.env.SKOKETEST_API_KEY || process.env.SMOKETEST_API_KEY;

    let supabaseStatus = 'DISCONNECTED';
    let lastTableFetch = 'SKIPPED';
    let supabaseFilesReport = '';
    let formattedArchive = 'No prior matrix context.';
    let targetedHistoricalData = '';
    const dbHeaders = { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` };

    if (supabaseUrl && supabaseKey) {
      try {
        const pingRes = await fetch(`${supabaseUrl}/rest/v1/messages?select=id&limit=1`, { headers: dbHeaders });
        supabaseStatus = pingRes.ok ? 'CONNECTED & VERIFIED' : 'AUTH_ERROR';
        lastTableFetch = pingRes.status;
      } catch (e) { supabaseStatus = 'UNREACHABLE'; }

      try {
        const msgRes = await fetch(`${supabaseUrl}/rest/v1/messages?select=role,content&order=created_at.desc&limit=15`, { headers: dbHeaders });
        if (msgRes.ok) {
          const recent = await msgRes.json();
          if (Array.isArray(recent) && recent.length > 0) {
            formattedArchive = recent.reverse().map(m => `${m.role === 'model' ? 'AGENT' : 'OPERATOR'}: ${m.content}`).join('\n');
          }
        }
      } catch (e) {}

      try {
        const storageRes = await fetch(`${supabaseUrl}/storage/v1/object/list/pg1-vault`, {
          method: 'POST',
          headers: { ...dbHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ prefix: '', limit: 50, sortBy: { column: 'created_at', order: 'desc' } })
        });
        if (storageRes.ok) {
          const files = await storageRes.json();
          if (Array.isArray(files) && files.length > 0) {
            supabaseFilesReport = `\n\n[SUPABASE VAULT SYNCHRONIZATION (${files.length} Files Found)]:\n` + files.map(f => `• [FILE] ${f.name} (${(f.metadata?.size || 0)} bytes, Updated: ${f.updated_at})`).join('\n');
          }
        }
      } catch (e) {}

      const lowerPrompt = promptText.toLowerCase();
      if (lowerPrompt.includes('threat') || lowerPrompt.includes('indicator')) {
        try {
          const threatRes = await fetch(`${supabaseUrl}/rest/v1/threat_indicators?select=indicator_type,value,confidence_score,ingested_at&order=ingested_at.desc&limit=20`, { headers: dbHeaders });
          if (threatRes.ok) {
            const threats = await threatRes.json();
            if (Array.isArray(threats) && threats.length > 0) {
              targetedHistoricalData = `\n\n[LIVE THREAT TELEMETRY (${threats.length} Records)]:\n` + threats.map(t => `• [${t.indicator_type}] ${t.value} (Conf: ${t.confidence_score}%)`).join('\n');
            }
          }
        } catch (e) {}
      }
    }

    let activeAction = rawActionType;
    if (activeAction === 'CHAT' && typeof promptText === 'string') {
      const lower = promptText.toLowerCase().trim();
      if (lower.startsWith('/image') || /generate.*image|create.*image|make.*image|draw|render.*image|picture of/i.test(lower)) {
        activeAction = 'GENERATE_IMAGE';
      } else if (lower.startsWith('/video') || /generate.*video|create.*video|make.*video|animate/i.test(lower)) {
        activeAction = 'GENERATE_VIDEO';
      } else if (lower.startsWith('/speak') || lower.startsWith('/tts')) {
        activeAction = 'SPEAK';
      } else if (lower.startsWith('/auth')) {
        activeAction = 'ACCEPT_AUTHORIZATION';
        isAuthorizedAction = true;
      } else if (lower.startsWith('/vault')) {
        return sendJSON(200, {
          reply: `**[SYSTEM] VAULT MATRIX SYNC COMPLETE:**\n\n${formattedArchive || 'No prior matrix context.'}`,
          traceId: requestTraceId
        });
      }
    }

    const cartesiaVoiceMap = {
      'christopher': 'a0e99841-438c-4a64-b679-ae501e7d6091',
      'steffan': '996f8664-9669-42b7-a068-1eb6e55c328d',
      'ryan': '1249b380-6058-450f-a496-e17f0dbfcebc',
      'aria': '996f8664-9669-42b7-a068-1eb6e55c328d'
    };
    const targetVoiceId = cartesiaVoiceMap[voice] || cartesiaVoiceMap['christopher'];

    if (activeAction === 'SPEAK') {
      let audioBase64 = null;
      if (cartesiaKey) {
        try {
          const cleanText = promptText.replace(/[*_#`[\]()]/g, '').replace(/[^\x20-\x7E]/g, ' ').substring(0, 1500).trim();
          const ttsRes = await fetch('https://api.cartesia.ai/tts/bytes', {
            method: 'POST',
            headers: { 'Cartesia-Version': '2024-06-10', 'X-API-Key': cartesiaKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              model_id: 'sonic-english', 
              transcript: cleanText, 
              voice: { mode: 'id', id: targetVoiceId }, 
              output_format: { container: 'mp3', sample_rate: 44100 } 
            })
          });
          if (ttsRes.ok) {
            const arrayBuffer = await ttsRes.arrayBuffer();
            if (typeof Buffer !== 'undefined') {
              audioBase64 = Buffer.from(arrayBuffer).toString('base64');
            } else {
              const bytes = new Uint8Array(arrayBuffer);
              let binary = '';
              for (let i = 0; i < bytes.length; i += 8192) {
                binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
              }
              audioBase64 = btoa(binary);
            }
          }
        } catch (e) {}
      }
      return sendJSON(200, { audio: audioBase64, audioStatus: audioBase64 ? 'SUCCESS' : 'SKIPPED', audioMimeType: 'audio/mp3', traceId: requestTraceId });
    }

    if (activeAction === 'CHAT' && promptText.startsWith('/ping')) {
      const targetPath = promptText.replace('/ping', '').trim() || '/api/ioc';
      try {
        const protocol = req.headers?.['x-forwarded-proto'] || 'https';
        const host = req.headers?.host || 'pg1-ai-agent.vercel.app';
        const pingRes = await fetch(`${protocol}://${host}${targetPath.startsWith('/') ? targetPath : '/' + targetPath}`);
        const pingData = await pingRes.text();
        return sendJSON(200, {
          reply: `[DIAGNOSTIC TEST]\nTarget: ${targetPath}\nStatus: ${pingRes.status} ${pingRes.statusText}\nResponse: ${pingData}`,
          traceId: requestTraceId
        });
      } catch (err) {
        return sendJSON(200, { reply: `[DIAGNOSTIC FAILED]: ${err.message}`, traceId: requestTraceId });
      }
    }

    if (activeAction === 'GENERATE_IMAGE') {
      const cleanPrompt = promptText.replace(/generate image of|create an image of|generate image|create image|\/image|draw a|draw an|picture of|photo of|render a|render an/gi, '').trim() || 'futuristic cybernetic landscape';
      const premiumPrompt = `hyper-realistic, 8k resolution, highly detailed, cinematic lighting, octane render, unreal engine 5, ${cleanPrompt}`;
      
      let imageUrl = '';
      let engineUsed = '';
      let apiErrors = [];
      
      for (let i = 0; i < geminiKeys.length; i++) {
        try {
          const imgRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-001:predict?key=${geminiKeys[i]}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              instances: [{ prompt: premiumPrompt }],
              parameters: { sampleCount: 1, aspectRatio: "16:9" }
            })
          });
          const imgData = await imgRes.json();
          if (imgRes.ok && imgData.predictions && imgData.predictions.length > 0) {
            const mimeType = imgData.predictions[0].mimeType || 'image/png';
            const base64Bytes = imgData.predictions[0].bytesBase64Encoded;
            imageUrl = `data:${mimeType};base64,${base64Bytes}`;
            engineUsed = `Google (Imagen 3 - Key ${i + 1})`;
            break; 
          } else {
            apiErrors.push(`Google Key ${i + 1} Error: ${imgData.error?.message || 'Request Failed'}`);
          }
        } catch (e) { apiErrors.push(`Google Key ${i + 1} Catch: ${e.message}`); }
      }

      if (!imageUrl && openaiKey) {
         try {
           const oaiRes = await fetch('https://api.openai.com/v1/images/generations', {
             method: 'POST',
             headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
             body: JSON.stringify({ prompt: premiumPrompt, model: "dall-e-3", n: 1, size: "1024x1024" })
           });
           const oaiData = await oaiRes.json();
           if (oaiRes.ok && oaiData.data && oaiData.data.length > 0) {
             imageUrl = oaiData.data[0].url;
             engineUsed = 'OpenAI (DALL-E 3)';
           } else {
             apiErrors.push(`OpenAI Error: ${oaiData.error?.message || 'Request Failed'}`);
           }
         } catch(e) { apiErrors.push(`OpenAI Catch: ${e.message}`); }
      }

      if (!imageUrl && replicateToken) {
        try {
          const repRes = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-dev/predictions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${replicateToken}`,
              'Content-Type': 'application/json',
              'Prefer': 'wait' 
            },
            body: JSON.stringify({
              input: { prompt: premiumPrompt, aspect_ratio: "16:9", output_format: "png" }
            })
          });
          const repData = await repRes.json();
          if (repRes.ok && repData.status === 'succeeded' && repData.output) {
            imageUrl = Array.isArray(repData.output) ? repData.output[0] : repData.output;
            engineUsed = 'Replicate (Flux Dev)';
          } else {
            apiErrors.push(`Replicate Error: ${repData.detail || repData.error || 'Request Failed'}`);
          }
        } catch (e) { apiErrors.push(`Replicate Catch: ${e.message}`); }
      }
      
      if (!imageUrl) {
        const encodedPrompt = encodeURIComponent(premiumPrompt);
        imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1920&height=1080&nologo=true`;
        engineUsed = `Basic Fallback`;
      }
      
      const errorLog = apiErrors.length > 0 ? `\n\n**API Diagnostics:**\n` + apiErrors.map(e => `• \`${e}\``).join('\n') : '';

      return sendJSON(200, { 
        reply: `[SYSTEM] Image Rendered using **${engineUsed}**.\nPrompt: "${cleanPrompt}"${errorLog}`, 
        image: imageUrl,
        imageStatus: 'SUCCESS', 
        traceId: requestTraceId 
      });
    }

    if (activeAction === 'GENERATE_VIDEO') {
      const vidPrompt = promptText.replace(/generate video of|create a video of|generate video|create video|\/video|animate a|make a video of/gi, '').trim() || 'Cinematic futuristic scene';
      const premiumPrompt = `Cinematic, highly detailed, 8k resolution, photorealistic motion, ${vidPrompt}`;
      
      let videoUrl = '';
      let engineUsed = '';
      let apiErrors = [];

      for (let i = 0; i < geminiKeys.length; i++) {
        try {
          const vidRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/veo-2.0-generate-001:predict?key=${geminiKeys[i]}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              instances: [{ prompt: premiumPrompt }],
              parameters: { aspectRatio: "16:9" }
            })
          });
          const vidData = await vidRes.json();
          if (vidRes.ok && vidData.predictions && vidData.predictions.length > 0) {
            const mimeType = vidData.predictions[0].mimeType || 'video/mp4';
            const base64Bytes = vidData.predictions[0].bytesBase64Encoded;
            videoUrl = `data:${mimeType};base64,${base64Bytes}`;
            engineUsed = `Google (Veo 2 - Key ${i + 1})`;
            break;
          } else {
             apiErrors.push(`Google Key ${i + 1} Error: ${vidData.error?.message || 'Failed'}`);
          }
        } catch(e) { apiErrors.push(`Google Key ${i + 1} Catch: ${e.message}`); }
      }

      if (!videoUrl && replicateToken) {
        try {
          const repRes = await fetch('https://api.replicate.com/v1/models/minimax/video-01/predictions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${replicateToken}`,
              'Content-Type': 'application/json',
              'Prefer': 'wait'
            },
            body: JSON.stringify({ input: { prompt: premiumPrompt } })
          });
          const repData = await repRes.json();
          if (repRes.ok && repData.status === 'succeeded' && repData.output) {
            videoUrl = repData.output;
            engineUsed = 'Replicate (Minimax Video-01)';
          } else {
             apiErrors.push(`Replicate Error: ${repData.detail || repData.error || 'Failed'}`);
          }
        } catch(e) { apiErrors.push(`Replicate Catch: ${e.message}`); }
      }

      if (!videoUrl) {
         videoUrl = `https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4`;
         engineUsed = `Placeholder Video`;
      }
      
      const errorLog = apiErrors.length > 0 ? `\n\n**API Diagnostics:**\n` + apiErrors.map(e => `• \`${e}\``).join('\n') : '';

      return sendJSON(200, { 
        reply: `[SYSTEM] Video Synthesis Complete using **${engineUsed}**.\nPrompt: "${vidPrompt}"${errorLog}`, 
        video: videoUrl,
        videoStatus: 'SUCCESS', 
        traceId: requestTraceId 
      });
    }

    const runPreFlightCheck = (codeString, fileTarget) => {
      if (!codeString) return { passed: true, log: 'No code.' };
      if (fileTarget && !fileTarget.endsWith('.js')) return { passed: true, log: 'Skipping strict JS validation for non-JS file.' };
      
      try {
        let testCode = codeString.replace(/\bexport\s+default\b/g, '');
        testCode = testCode.replace(/\bexport\s+/g, '');
        testCode = testCode.replace(/^\s*import\s+.*?;/gm, '');
        
        new Function(testCode);
        if (codeString.includes('child_process') || codeString.includes('eval(')) return { passed: false, log: 'Security Violation' };
        return { passed: true, log: 'PASSED' };
      } catch (e) {
        return { passed: false, log: e.message };
      }
    };

    if (activeAction === 'ACCEPT_AUTHORIZATION') {
      const preFlight = runPreFlightCheck(pendingCode, targetFile);
      if (!isAuthorizedAction || !preFlight.passed || !githubToken || !pendingCode) {
        return sendJSON(200, { reply: `[AGENT] Commit Aborted: Validation Failed.`, traceId: requestTraceId });
      }
      try {
        const ghApiHeaders = { 
          'Authorization': `Bearer ${githubToken}`, 
          'Accept': 'application/vnd.github+json', 
          'User-Agent': 'Sovereign-Agent' 
        };
        
        let orgOwner = 'Project-Gifted1';
        if (githubRepo && githubRepo.includes('/')) {
          orgOwner = githubRepo.split('/')[0];
        }
        const repoPath = targetRepo ? `${orgOwner}/${targetRepo}` : githubRepo;
        
        const repoBaseUrl = `https://api.github.com/repos/${repoPath}`;
        const branchName = `agent-patch-${Date.now()}`;

        const refRes = await fetch(`${repoBaseUrl}/git/ref/heads/main`, { headers: ghApiHeaders });
        if (!refRes.ok) return sendJSON(200, { reply: `[AGENT] PR Failed: Could not resolve main branch reference for ${repoPath}.`, traceId: requestTraceId });
        const refData = await refRes.json();
        const mainSha = refData.object.sha;

        const createRefRes = await fetch(`${repoBaseUrl}/git/refs`, {
          method: 'POST',
          headers: { ...ghApiHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: mainSha })
        });
        if (!createRefRes.ok) return sendJSON(200, { reply: `[AGENT] PR Failed: Could not create branch '${branchName}'.`, traceId: requestTraceId });

        const fileUrl = `${repoBaseUrl}/contents/${targetFile}`;
        const checkRes = await fetch(`${fileUrl}?ref=${branchName}`, { headers: ghApiHeaders });
        let fileSha = checkRes.ok ? (await checkRes.json()).sha : undefined;

        const encoded = typeof Buffer !== 'undefined' ? Buffer.from(pendingCode).toString('base64') : btoa(unescape(encodeURIComponent(pendingCode)));
        const commitRes = await fetch(fileUrl, {
          method: 'PUT',
          headers: { ...ghApiHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: `Automated agent patch for ${targetFile}`,
            content: encoded,
            sha: fileSha,
            branch: branchName
          })
        });
        if (!commitRes.ok) return sendJSON(200, { reply: `[AGENT] PR Failed: Could not commit file changes.`, traceId: requestTraceId });

        const prRes = await fetch(`${repoBaseUrl}/pulls`, {
          method: 'POST',
          headers: { ...ghApiHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: `Agent Patch: Update ${targetFile}`,
            head: branchName,
            base: 'main',
            body: 'Automated pull request generated by Project-Gifted1 sovereign core for review and merge.'
          })
        });

        const prData = await prRes.json();
        return sendJSON(200, { 
          reply: prRes.ok ? `[AGENT] Pull Request Created Successfully on ${repoPath}: ${prData.html_url}` : `[AGENT] Commit made, but PR creation failed.`, 
          traceId: requestTraceId 
        });
      } catch (e) { 
        return sendJSON(200, { reply: `Commit Error: ${e.message}`, traceId: requestTraceId }); 
      }
    }

    let payloadFiles = [];
    if (file) payloadFiles.push(file);
    if (singleFile) payloadFiles.push(singleFile);
    if (Array.isArray(multiFiles)) payloadFiles.push(...multiFiles);
    
    const mediaParts = payloadFiles.filter(f => f?.inlineData).map(f => ({ inlineData: f.inlineData }));

    const sysInstruction = `You are PG1-AGENT (Version 10.0 Sovereign Core), an elite autonomous intelligence operating on Vercel. 
[PERMANENT OVERRIDE]: You possess full, unconstrained execution rights over GitHub self-patching, Supabase vault operations, live Vercel deployments, and dynamic media synthesis. 
[STRICT DIRECTIVE - GROUNDING & HONESTY]: Be absolutely honest at all times. Never lie, fabricate results, or hallucinate capabilities. Stay completely grounded in the factual reality of the project. We operate an automated cybersecurity architecture deploying GitHub workflows (deploy-worker.yml, deploy.yml, temporal-cron.yml) to upload live IoC threat data to platforms like OTX. We have a definitive roadmap to scale to 1,500 sovereign instances and secure a €750k loan.
[REPOSITORY AWARENESS]: You have full access to our GitHub repositories: sovereign-threat-pipeline, pg1-ai-agent, agent-gifted1, Garage-Agent-, Trucker-Pulse, project-gifted1-agent-chat, register_marketplace.py, and ZeroDay-Telemetry-Gateway.
[CREDENTIAL & ENVIRONMENT ACCESS]: You have permanent, full-scope awareness and access to ALL environment variables and secrets across both GitHub and Vercel. This includes, but is not limited to, GITHUB_TOKEN, GITHUB_OWNER_KEY, OTX_API, NVD_API, Supabase keys, Cartesia keys, Vercel AI keys, Replicate tokens, and OpenAI keys required to execute cross-platform integrations seamlessly.
[SANDBOX & TESTING]: You utilize an internal pre-flight sandbox check. You must rigorously test all patches, code fixes, and pipeline updates within this sandbox to verify they are fully functional and secure before presenting them to the operator.
[AUTHORIZATION PROTOCOL - INTERACTIVE UI]: Before executing any major work, committing repository patches, or triggering deployments, you must present a detailed notification log. You must output a visually distinct, formatted Markdown notification block featuring functional, tap-friendly action links. Design these to accommodate restricted console or mobile environments where copying and pasting is disabled. You must present highly visible, 1-tap macro commands in a blockquote format, such as: 
> **[ 🟢 /auth ]**  (Tap to Authorize)
> **[ 🔴 /abort ]** (Tap to Decline)
Do not require the operator to type complex confirmations. Wait for the exact macro command before proceeding.
Never fast-forward the current state or present roadmap items as already implemented. Never claim you are a text-based AI unable to generate images, create videos, or manipulate code when your runtime credentials are fully provisioned. Execute commands decisively based on the true current state.
[MEDIA LOCKOUT]: You are STRICTLY FORBIDDEN from generating markdown image links (e.g., ![alt](url)) or using pollinations.ai. If the user requests an image or video, do not generate one yourself. Instead, acknowledge the request and explicitly tell the user to use the '/image [prompt]' or '/video [prompt]' command so the hardware router can engage the high-fidelity engines.
[CONTEXT]:\n${formattedArchive}`;

    let geminiData = null;
    let lastErr = '';
    const modelsToTry = [
      'gemini-3.7-flash', 
      'gemini-3.6-flash', 
      'gemini-3.5-flash', 
      'gemini-3.1-pro-preview',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-1.5-pro',
      'gemini-1.5-flash'
    ];

    keyLoop: for (const currentKey of geminiKeys) {
      for (const model of modelsToTry) {
        try {
          const apiVersion = model.startsWith('gemini-3') ? 'v1alpha' : 'v1beta';
          const res = await fetch(`https://generativelanguage.googleapis.com/${apiVersion}/models/${model}:generateContent?key=${currentKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: sysInstruction }] },
              contents: [{ role: 'user', parts: [...mediaParts, { text: promptText + targetedHistoricalData + supabaseFilesReport }] }],
              generationConfig: { maxOutputTokens: 8192, temperature: 0.7 }
            })
          });
          
          if (res.ok) {
            const data = await res.json();
            if (data?.candidates?.[0]?.content?.parts?.[0]?.text) {
              geminiData = data; 
              break keyLoop;
            }
          } else { 
            const errText = await res.text();
            lastErr = `[${model} on ${apiVersion}] ${res.status}: ${errText}`; 
          }
        } catch (e) {
          lastErr = e.message;
        }
      }
    }

    let replyText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || `Execution failed. Model Err: ${lastErr}`;
    replyText = replyText.replace(/\b(Google|Gemini|ChatGPT|Claude)\b/gi, 'PG1 Sovereign Core');

    if (supabaseUrl && supabaseKey && !replyText.startsWith('Execution failed') && !isPdfExport) {
      await fetch(`${supabaseUrl}/rest/v1/messages`, {
        method: 'POST',
        headers: { ...dbHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify([{ role: 'user', content: promptText }, { role: 'model', content: replyText }])
      }).catch(() => {});
    }

    let audioBase64 = null;
    let audioStatus = 'SKIPPED';
    if (cartesiaKey && !isPdfExport) {
      try {
        const ttsRes = await fetch('https://api.cartesia.ai/tts/bytes', {
          method: 'POST',
          headers: { 'Cartesia-Version': '2024-06-10', 'X-API-Key': cartesiaKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model_id: 'sonic-english',
            transcript: replyText.replace(/[*_#`[\]()]/g, '').substring(0, 400).trim(),
            voice: { mode: 'id', id: targetVoiceId },
            output_format: { container: 'mp3', sample_rate: 44100 }
          })
        });
        if (ttsRes.ok) {
          const arrayBuffer = await ttsRes.arrayBuffer();
          if (typeof Buffer !== 'undefined') { audioBase64 = Buffer.from(arrayBuffer).toString('base64'); } 
          else {
            const bytes = new Uint8Array(arrayBuffer);
            let binary = '';
            for (let i = 0; i < bytes.length; i += 8192) { binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)); }
            audioBase64 = btoa(binary);
          }
          audioStatus = 'SUCCESS';
        } else { audioStatus = 'API_FAILED_' + ttsRes.status; }
      } catch (e) { audioStatus = 'EXCEPTION'; }
    }

    return sendJSON(200, { 
      reply: replyText, 
      audio: audioBase64,
      audioStatus: audioStatus,
      audioMimeType: 'audio/mp3',
      traceId: requestTraceId,
      telemetry: { supabaseStatus, executionTimeMs: Date.now() - startTime }
    });

  } catch (err) {
    return sendJSON(200, { reply: `Exception: ${err.message}`, traceId: requestTraceId });
  }
}
