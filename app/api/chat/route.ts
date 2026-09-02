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

    // 1. Initialize Supabase Client
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
    
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
        console.error('Supabase history retrieval error:', err);
      }
    }

    // 2. Sovereign Context & System Instructions
    const systemContext = `You are PG1-AGENT, the sovereign executive intelligence for Project-Gifted1.
You operate with persistent awareness of your production environment:
- Hosted on Vercel with GitHub repository integration.
- Backed by Supabase PostgreSQL for permanent contextual memory and vaults.
- Empowered with native tools to inspect databases, scrape public web targets, and save research.

[PERMANENT MEMORY ARCHIVE]
${formattedHistory}`;

    // 3. AI Stream with Native Tooling
    const result = streamText({
      model: google('models/gemini-1.5-pro-latest'),
      messages,
      system: systemContext,
      tools: {
        listVaults: tool({
          description: 'Discover and list all available tables/vaults in the Supabase database.',
          parameters: z.object({}),
          execute: async () => {
            if (!supabase) return { error: 'Database connection offline.' };
            try {
              const { data, error } = await supabase.rpc('get_all_vaults');
              if (error) throw new Error(error.message);
              return { vaults: data.map(v => v.table_name) };
            } catch (err) {
              return { error: `Discovery failed: ${err.message}` };
            }
          }
        }),

        queryVault: tool({
          description: 'Query, read, and sort data from any existing Supabase table/vault.',
          parameters: z.object({
            tableName: z.string().describe('The name of the table to inspect.'),
            limit: z.number().optional().describe('Maximum number of rows to retrieve (default 50).'),
            orderBy: z.string().optional().describe('Column name to sort by (e.g., created_at, id).'),
            ascending: z.boolean().optional().describe('Sort direction: true for ASC, false for DESC.')
          }),
          execute: async ({ tableName, limit = 50, orderBy, ascending = false }) => {
            if (!supabase) return { error: 'Database connection offline.' };
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
          description: 'Save extracted data, research findings, or operational logs into the knowledge vault.',
          parameters: z.object({
            title: z.string().describe('Title or descriptor for the entry.'),
            content: z.string().describe('Data payload or text summary to preserve.')
          }),
          execute: async ({ title, content }) => {
            if (!supabase) return { error: 'Database connection offline.' };
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
          description: 'Extract raw readable text content from a public website URL.',
          parameters: z.object({
            url: z.string().url().describe('The target URL to scrape.')
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
          description: 'Render an image payload using Ideogram v3 Turbo.',
          parameters: z.object({
            prompt: z.string().describe('Detailed prompt describing the image.')
          }),
          execute: async ({ prompt }) => {
            const apiKey = process.env.IDEOGRAM_API_KEY;
            if (!apiKey) return { error: 'IDEOGRAM_API_KEY missing from environment variables.' };

            try {
              const res = await fetch('https://api.ideogram.ai/generate', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Api-Key': apiKey
                },
                body: JSON.stringify({
                  image_request: { prompt, model: 'V-3-TURBO' }
                })
              });
              return await res.json();
            } catch (err) {
              return { error: `Image generation pipeline failed: ${err.message}` };
            }
          }
        })
      },

      // 4. Automatic Context Archiving
      onFinish: async ({ text }) => {
        if (supabase && text) {
          try {
            await supabase.from('messages').insert([
              { role: 'user', content: lastUserMessage },
              { role: 'assistant', content: text }
            ]);
          } catch (err) {
            console.error('Failed to write message memory to Supabase:', err);
          }
        }
      }
    });

    return result.toDataStreamResponse();
  } catch (err) {
    return NextResponse.json({ error: `Runtime Exception: ${err.message}` }, { status: 500 });
  }
}
