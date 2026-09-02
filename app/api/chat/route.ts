import { NextResponse } from 'next/server';
import { google } from '@ai-sdk/google';
import { streamText, tool } from 'ai';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function POST(req) {
  try {
    const { messages } = await req.json();
    const lastUserMessage = messages[messages.length - 1]?.content || 'System check.';

    // 1. Resolve Environment Variables from Vercel Config
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseKey = 
      process.env.SUPABASE_SERVICE_ROLE_KEY || 
      process.env.SUPABASEAPI_KEY || 
      process.env.SUPABASE_ANON_KEY || '';

    const replicateToken = process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_KEY || '';
    const openAiKey = process.env.OPENAI_API_KEY || '';
    const openRouterKey = process.env.OPENROUTER_API_KEY || process.env.OPEN_ROUTER_KEY || '';
    const gumroadId = process.env.GUMROAD_PRODUCT_ID || process.env.PRODUCT_ID || '';

    // 2. Initialize Supabase Connection & Pull Memory
    let supabase = null;
    let formattedHistory = 'No previous memory available.';

    if (supabaseUrl && supabaseKey) {
      supabase = createClient(supabaseUrl, supabaseKey);
      try {
        const { data: recentHistory } = await supabase
          .from('messages')
          .select('role, content')
          .order('created_at', { ascending: false })
          .limit(20);

        if (recentHistory && recentHistory.length > 0) {
          formattedHistory = recentHistory
            .reverse()
            .map(m => `${m.role}: ${m.content}`)
            .join('\n');
        }
      } catch (err) {
        console.error('Supabase memory fetch error:', err);
      }
    }

    // 3. System Prompt with Locked-In Infrastructure Context
    const systemContext = `You are PG1-AGENT, the sovereign executive intelligence for Project-Gifted1.
You operate with complete runtime awareness of your production ecosystem:
- Backend: Vercel serverless Edge/Node.js runtime.
- Database: Supabase PostgreSQL vault (${supabaseUrl ? 'ONLINE' : 'OFFLINE'}).
- Media Subsystems: Replicate neural engines (${replicateToken ? 'KEY LINKED' : 'UNSET'}).
- Alternate Models: OpenAI (${openAiKey ? 'ACTIVE' : 'UNSET'}), OpenRouter (${openRouterKey ? 'ACTIVE' : 'UNSET'}).
- Commercial Pipeline: Gumroad Product Target (${gumroadId ? 'CONFIGURED' : 'UNSET'}).

[PERMANENT CONVERSATIONAL MEMORY]
${formattedHistory}`;

    // 4. Autonomous Tool Set
    const result = streamText({
      model: google('models/gemini-1.5-pro-latest'),
      messages,
      system: systemContext,
      tools: {
        listVaults: tool({
          description: 'List all existing database tables/vaults in Supabase.',
          parameters: z.object({}),
          execute: async () => {
            if (!supabase) return { error: 'Database offline or credentials missing.' };
            try {
              const { data, error } = await supabase.rpc('get_all_vaults');
              if (error) throw new Error(error.message);
              return { vaults: data.map(v => v.table_name) };
            } catch (err) {
              return { error: `Vault discovery failed: ${err.message}` };
            }
          }
        }),

        queryVault: tool({
          description: 'Query and sort records from an existing Supabase table/vault.',
          parameters: z.object({
            tableName: z.string().describe('The name of the table to read.'),
            limit: z.number().optional().describe('Maximum number of rows to retrieve (default 50).'),
            orderBy: z.string().optional().describe('Column name to sort by.'),
            ascending: z.boolean().optional().describe('Sort direction: true for ASC, false for DESC.')
          }),
          execute: async ({ tableName, limit = 50, orderBy, ascending = false }) => {
            if (!supabase) return { error: 'Database offline.' };
            try {
              let query = supabase.from(tableName).select('*').limit(limit);
              if (orderBy) {
                query = query.order(orderBy, { ascending });
              }
              const { data, error } = await query;
              if (error) throw new Error(error.message);

              const safePayload = JSON.stringify(data).substring(0, 20000);
              return {
                vault: tableName,
                count: data.length,
                records: JSON.parse(safePayload)
              };
            } catch (err) {
              return { error: `Query failed on table ${tableName}: ${err.message}` };
            }
          }
        }),

        vaultData: tool({
          description: 'Save extracted data, research findings, or logs into the knowledge vault.',
          parameters: z.object({
            title: z.string().describe('Title or header for the vaulted record.'),
            content: z.string().describe('Text body or structured data to store.')
          }),
          execute: async ({ title, content }) => {
            if (!supabase) return { error: 'Database offline.' };
            try {
              const { error } = await supabase
                .from('knowledge_vault')
                .insert([{ title, content }]);
              if (error) throw new Error(error.message);
              return { success: true, message: `Record '${title}' securely vaulted.` };
            } catch (err) {
              return { error: `Vault insert failed: ${err.message}` };
            }
          }
        }),

        scrapeWebsite: tool({
          description: 'Extract clean readable text from a public website URL.',
          parameters: z.object({
            url: z.string().url().describe('The URL to scrape.')
          }),
          execute: async ({ url }) => {
            try {
              const res = await fetch(url, {
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                  'Accept': 'text/html'
                }
              });
              if (!res.ok) throw new Error(`HTTP status ${res.status}`);

              const html = await res.text();
              const $ = cheerio.load(html);
              $('script, style, noscript, iframe, svg, img, video').remove();

              const cleanedText = $('body').text().replace(/\s+/g, ' ').trim();
              return {
                url,
                content: cleanedText.substring(0, 15000)
              };
            } catch (err) {
              return { error: `Scrape error: ${err.message}` };
            }
          }
        }),

        generateImage: tool({
          description: 'Generate an image payload via Replicate.',
          parameters: z.object({
            prompt: z.string().describe('Detailed prompt describing the image.')
          }),
          execute: async ({ prompt }) => {
            if (!replicateToken) return { error: 'Replicate API token missing from Vercel environment.' };

            try {
              const res = await fetch('https://api.replicate.com/v1/models/ideogram-ai/ideogram-v3-turbo/predictions', {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${replicateToken}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({ input: { prompt } })
              });
              return await res.json();
            } catch (err) {
              return { error: `Replicate pipeline dispatch failed: ${err.message}` };
            }
          }
        })
      },

      // 5. Automatic Conversation Persistence
      onFinish: async ({ text }) => {
        if (supabase && text) {
          try {
            await supabase.from('messages').insert([
              { role: 'user', content: lastUserMessage },
              { role: 'assistant', content: text }
            ]);
          } catch (err) {
            console.error('Failed to log message to Supabase vault:', err);
          }
        }
      }
    });

    return result.toDataStreamResponse();
  } catch (err) {
    return NextResponse.json({ error: `Runtime Exception: ${err.message}` }, { status: 500 });
  }
}
