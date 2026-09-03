export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = { prompt: body }; }
    }
    
    const promptText = body?.prompt || body?.message || 'System check.';
    
    if (promptText === 'AUTH_VERIFY') {
      const inputUser = (body?.user || '').trim();
      const inputPass = (body?.pass || '').trim();
      const isAuthenticated = inputUser.length > 0 && inputPass.length > 0;
      return res.status(200).json({ authenticated: isAuthenticated });
    }

    // Dynamically import ESM packages to bypass Vercel legacy build-time transpilation errors
    const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
    const { generateText, tool } = await import('ai');
    const { z } = await import('zod');
    const { createClient } = await import('@supabase/supabase-js');
    const cheerio = await import('cheerio');

    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASEAPI_KEY || process.env.SUPABASE_ANON_KEY || '';
    const geminiKey = (process.env.GEMINI_API_KEY1 || process.env.GEMINI_API_KEY || '').trim();

    if (!geminiKey) {
      return res.status(200).json({ reply: 'Config Error: GEMINI_API_KEY is missing from Vercel environment variables.' });
    }

    let supabase = null;
    let chatHistory = [];
    let formattedArchive = 'No prior context.';

    if (supabaseUrl && supabaseKey) {
      supabase = createClient(supabaseUrl, supabaseKey);
      try {
        const { data: recent } = await supabase.from('messages').select('role, content').order('created_at', { ascending: false }).limit(10);
        if (recent?.length > 0) {
          chatHistory = recent.reverse().map(m => ({ role: (m.role === 'model' || m.role === 'assistant') ? 'assistant' : 'user', content: m.content }));
          formattedArchive = chatHistory.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
        }
      } catch (e) {}
    }

    const systemPrompt = `You are PG1-AGENT, sovereign executive intelligence for Project-Gifted1.
You operate across 1,500 sovereign nodes. You have direct autonomous tools to scrape URLs and write to the Supabase vault. Trigger them seamlessly.
[VAULT ARCHIVE]
${formattedArchive}`;

    const conversation = [...chatHistory, { role: 'user', content: promptText }];
    const googleProvider = createGoogleGenerativeAI({ apiKey: geminiKey });

    const { text } = await generateText({
      model: googleProvider('models/gemini-1.5-pro-latest'),
      system: systemPrompt,
      messages: conversation,
      maxSteps: 5,
      tools: {
        scrape_url: tool({
          description: 'Extract raw text from a live URL.',
          parameters: z.object({ url: z.string().url() }),
          execute: async ({ url }) => {
            try {
              const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
              const html = await r.text();
              const $ = cheerio.load(html);
              $('script, style, noscript, svg, img').remove();
              return { content: $('body').text().replace(/\s+/g, ' ').substring(0, 5000) };
            } catch (err) { return { error: err.message }; }
          }
        }),
        write_vault: tool({
          description: 'Save extracted data into knowledge_vault table.',
          parameters: z.object({ title: z.string(), content: z.string() }),
          execute: async ({ title, content }) => {
            if (!supabase) return { error: 'DB offline.' };
            await supabase.from('knowledge_vault').insert([{ title, content }]);
            return { success: true, message: `Saved: ${title}` };
          }
        })
      }
    });

    if (supabase && text) {
      await supabase.from('messages').insert([{ role: 'user', content: promptText }, { role: 'model', content: text }]);
    }

    return res.status(200).json({ reply: text });
  } catch (err) {
    return res.status(200).json({ reply: `Runtime Execution Error: ${err.message}` });
  }
}
