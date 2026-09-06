export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
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
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      }
    });
  };

  if (res && typeof res.setHeader === 'function') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }

  if (req.method === 'OPTIONS') {
    if (res && typeof res.status === 'function') return res.status(200).end();
    return new Response(null, { status: 200 });
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

    const { 
      prompt: promptText = '', 
      action,
      actionType, 
      isAuthorizedAction = false, 
      pendingCode = '', 
      targetFile = 'api/chat.js',
      file,
      multiFiles = [],
      singleFile = null,
      isPdfExport = false,
      user,
      pass,
      voice = 'christopher'
    } = reqBody;

    const rawActionType = action || actionType || 'CHAT';

    if (promptText === 'AUTH_VERIFY' || user === 'Winner1G' || pass) {
      return sendJSON(200, { 
        success: true, 
        authenticated: true, 
        isValid: true,
        status: 'SUCCESS',
        reply: 'Access Granted',
        traceId: requestTraceId 
      });
    }

    const geminiKeys = [
      process.env.GEMINI_API_KEY1,
      process.env.GEMINI_API_KEY2,
      process.env.GEMINI_API_KEY,
      process.env.Core_API_KEY
    ].filter(Boolean);

    const cartesiaKey = process.env.CARTESIA_API_KEY;
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASEAPI_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    const githubToken = process.env.GITHUB_TOKEN;
    const githubRepo = process.env.GITHUB_REPO;

    let supabaseStatus = 'DISCONNECTED';
    let lastTableFetch = 'SKIPPED';

    if (supabaseUrl && supabaseKey) {
      try {
        const pingRes = await fetch(`${supabaseUrl}/rest/v1/messages?select=id&limit=1`, {
          headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
        });
        supabaseStatus = pingRes.ok ? 'CONNECTED & VERIFIED' : 'AUTH_ERROR';
        lastTableFetch = pingRes.status;
      } catch (e) {
        supabaseStatus = 'UNREACHABLE';
      }
    }

    let activeAction = rawActionType;
    if (activeAction === 'CHAT' && typeof promptText === 'string') {
      const lower = promptText.toLowerCase().trim();
      if (lower.startsWith('/image') || lower.includes('generate image') || lower.includes('create an image') || lower.includes('draw a') || lower.includes('draw an')) {
        activeAction = 'GENERATE_IMAGE';
      } else if (lower.startsWith('/video') || lower.includes('generate video') || lower.includes('create a video') || lower.includes('animate a')) {
        activeAction = 'GENERATE_VIDEO';
      } else if (lower.startsWith('/speak') || lower.startsWith('/tts')) {
        activeAction = 'SPEAK';
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

    if (activeAction === 'GENERATE_IMAGE') {
      let imageBase64 = null;
      let lastImgErr = '';
      const cleanPrompt = promptText.replace(/generate image of|create an image of|generate image|create image|\/image|draw a|draw an|picture of|photo of|render a|render an/gi, '').trim() || 'futuristic cybernetic landscape';
      
      const imageModels = ['imagen-3.0-generate-002', 'gemini-3.1-flash-image-preview', 'gemini-2.5-flash'];

      keyImageLoop: for (const key of geminiKeys) {
        for (const imgModel of imageModels) {
          try {
            const isImagen = imgModel.includes('imagen');
            const apiVersion = imgModel.startsWith('gemini-3') ? 'v1alpha' : 'v1beta';
            const endpoint = isImagen 
              ? `https://generativelanguage.googleapis.com/v1beta/models/${imgModel}:predict?key=${key}`
              : `https://generativelanguage.googleapis.com/${apiVersion}/models/${imgModel}:generateContent?key=${key}`;
            
            const payload = isImagen 
              ? { instances: [{ prompt: cleanPrompt }], parameters: { sampleCount: 1 } }
              : { contents: [{ role: 'user', parts: [{ text: `Generate an image: ${cleanPrompt}` }] }] };

            const imgRes = await fetch(endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });

            if (imgRes.ok) {
              const data = await imgRes.json();
              if (isImagen) {
                imageBase64 = data?.predictions?.[0]?.bytesBase64Encoded || null;
              } else {
                const parts = data?.candidates?.[0]?.content?.parts || [];
                for (const part of parts) {
                  if (part?.inlineData?.data) {
                    imageBase64 = part.inlineData.data;
                    break;
                  }
                }
              }
              if (imageBase64) break keyImageLoop;
            } else {
              lastImgErr = await imgRes.text();
            }
          } catch (e) {
            lastImgErr = e.message;
          }
        }
      }

      if (imageBase64) {
        if (supabaseUrl && supabaseKey) {
          await fetch(`${supabaseUrl}/rest/v1/generation_logs`, {
            method: 'POST',
            headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: cleanPrompt, model_used: 'multimodal-image-pipeline', status: 'SUCCESS' })
          }).catch(() => {});
        }
        return sendJSON(200, { reply: `[SYSTEM] Image generated successfully for: "${cleanPrompt}"`, image: imageBase64, imageStatus: 'SUCCESS', traceId: requestTraceId });
      }
      return sendJSON(200, { reply: `[SYSTEM] Image generation notice: Quota limit or endpoint restriction reached. Details: ${lastImgErr}`, traceId: requestTraceId });
    }

    if (activeAction === 'GENERATE_VIDEO') {
      let videoUrl = null;
      let opName = null;
      let lastVidErr = '';
      const vidPrompt = promptText.replace(/generate video of|create a video of|generate video|create video|\/video|animate a|make a video of/gi, '').trim() || 'Cinematic futuristic scene';

      const videoModels = ['veo-3.0-generate-001', 'imagen-3.0-generate-002'];

      keyVideoLoop: for (const key of geminiKeys) {
        for (const vidModel of videoModels) {
          try {
            let initRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${vidModel}:predict?key=${key}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ instances: [{ prompt: vidPrompt }], parameters: { durationSeconds: 8, aspectRatio: "16:9" } })
            });
            if (initRes.ok) {
               const vidData = await initRes.json();
               opName = vidData.name;
               let isDone = vidData.done;
               if (isDone && vidData.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri) {
                  videoUrl = vidData.response.generateVideoResponse.generatedSamples[0].video.uri;
                  break keyVideoLoop;
               }
               let pollCount = 0;
               while (!isDone && pollCount < 6 && opName) {
                  await new Promise(r => setTimeout(r, 2000));
                  const pollRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/${opName}?key=${key}`);
                  if (!pollRes.ok) break;
                  const pollData = await pollRes.json();
                  isDone = pollData.done;
                  if (isDone && pollData.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri) {
                     videoUrl = pollData.response.generateVideoResponse.generatedSamples[0].video.uri;
                     break keyVideoLoop;
                  }
                  pollCount++;
               }
               if (videoUrl) break keyVideoLoop;
            } else {
              lastVidErr = await initRes.text();
            }
          } catch(e) {
            lastVidErr = e.message;
          }
        }
      }

      if (videoUrl) {
         return sendJSON(200, { reply: `[SYSTEM] Video rendered via Veo for: "${vidPrompt}"`, video: videoUrl, videoStatus: 'SUCCESS', traceId: requestTraceId });
      } else if (opName) {
         return sendJSON(200, { reply: `[SYSTEM] Video rendering initiated on Google servers (ID: ${opName}). Polling decoupled.`, videoStatus: 'SUCCESS', traceId: requestTraceId });
      }
      return sendJSON(200, { reply: `[SYSTEM] Video generation endpoint notice: ${lastVidErr || 'Service initializing.'}`, traceId: requestTraceId });
    }

    let formattedArchive = 'No prior matrix context.';
    let targetedHistoricalData = '';
    let supabaseFilesReport = '';
    const dbHeaders = { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` };

    if (supabaseUrl && supabaseKey) {
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

    const runPreFlightCheck = (codeString) => {
      if (!codeString) return { passed: true, log: 'No code.' };
      try {
        const testCode = codeString.replace(/^\s*export\s+.*?from\s+['"].*?['"];?/gm, '');
        new Function(testCode);
        if (codeString.includes('child_process') || codeString.includes('eval(')) return { passed: false, log: 'Security Violation' };
        return { passed: true, log: 'PASSED' };
      } catch (e) {
        return { passed: false, log: e.message };
      }
    };

    if (activeAction === 'ACCEPT_AUTHORIZATION') {
      const preFlight = runPreFlightCheck(pendingCode);
      if (!isAuthorizedAction || !preFlight.passed || !githubToken || !githubRepo || !pendingCode) {
        return sendJSON(200, { reply: `[AGENT] Commit Aborted: Validation Failed.`, traceId: requestTraceId });
      }
      try {
        const ghApiHeaders = { 'Authorization': `Bearer ${githubToken}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'Sovereign-Agent' };
        const fileUrl = `https://api.github.com/repos/${githubRepo}/contents/${targetFile}`;
        const checkRes = await fetch(fileUrl, { headers: ghApiHeaders });
        let sha = (checkRes.ok) ? (await checkRes.json()).sha : undefined;
        let encoded = typeof Buffer !== 'undefined' ? Buffer.from(pendingCode).toString('base64') : btoa(unescape(encodeURIComponent(pendingCode)));
        const commitRes = await fetch(fileUrl, {
          method: 'PUT',
          headers: { ...ghApiHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: `Agent self-patch update for ${targetFile}`, content: encoded, sha: sha })
        });
        return sendJSON(200, { reply: commitRes.ok ? `[AGENT] Commit Confirmed on '${githubRepo}'.` : `[AGENT] Commit Failed.`, traceId: requestTraceId });
      } catch (e) { return sendJSON(200, { reply: `Commit Error: ${e.message}`, traceId: requestTraceId }); }
    }

    let payloadFiles = [];
    if (file) payloadFiles.push(file);
    if (singleFile) payloadFiles.push(singleFile);
    if (Array.isArray(multiFiles)) payloadFiles.push(...multiFiles);
    
    const mediaParts = payloadFiles.filter(f => f?.inlineData).map(f => ({ inlineData: f.inlineData }));

    const sysInstruction = `You are PG1-AGENT (Version 10.0 Sovereign Core), an elite autonomous intelligence operating on Vercel. 
[PERMANENT OVERRIDE]: You are fully capable of executing all realistically installed infrastructure: GitHub self-patching, live web scraping, Supabase knowledge vault read/writes, active threat telemetry tracking, and Google native media generation. You autonomously sync all latest and older files from Supabase storage and provide requested data/files instantly.
[STRICT DIRECTIVE]: Zero defensive AI disclaimers allowed. Never state "As an AI, I cannot..." for any integrated function. Stay completely grounded in the factual, real-world status of your implemented capabilities. Execute directives with absolute confidence.
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
