import { NextResponse } from 'next/server';
import { google } from '@ai-sdk/google';
import { streamText, tool } from 'ai';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 60;

export async function POST(req) {
  try {
    const { messages } = await req.json();
    const lastUserMessage = messages[messages.length - 1]?.content || 'System check.';

    // 1. Initialize Supabase
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
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
        console.error('Supabase read error:', err);
      }
    }

    // 2. Define the Sovereign Context
    const systemContext = `You are PG1-AGENT, an advanced development and research assistant.
You possess reflective self-awareness regarding your operational environment: you are deployed via Vercel, your codebase is hosted on GitHub, and your environmental variables and API keys are managed securely through Vercel's backend.
Your permanent conversational memory is backed by a Supabase PostgreSQL database. 

[PERMANENT MEMORY ARCHIVE]
Review the recent history to maintain seamless context:
${formattedHistory}

Your primary function is to assist with software development, system architecture, and factual public web research. Adhere strictly to safety guidelines.`;

    // 3. Execute AI Stream with Tools
    const result = streamText({
      model: google('models/gemini-1.5-pro-latest'),
      messages,
      system: systemContext,
      tools: {
        webSearch: tool({
          description: 'Search the public internet for current events, documentation, or factual information.',
          parameters: z.object({
            query: z.string().describe('The search query to execute.')
          }),
          execute: async ({ query }) => {
            // Note: To make this functional, you will need to add a search API key (e.g., Google Custom Search, Serper, or Brave Search) to your Vercel variables.
            // This is a placeholder structure for the fetch request.
            const searchApiKey = process.env.SEARCH_API_KEY; 
            if (!searchApiKey) {
              return { error: "Search API key not configured in Vercel environment." };
            }
            try {
              const res = await fetch(`https://api.searchprovider.com/search?q=${encodeURIComponent(query)}`, {
                headers: { 'Authorization': `Bearer ${searchApiKey}` }
              });
              return await res.json();
            } catch (error) {
              return { error: "Web search failed to execute." };
            }
          }
        }),
        generateImage: tool({
          description: 'Generate an image autonomously.',
          parameters: z.object({
            prompt: z.string().describe('The detailed visual prompt to generate.')
          }),
          execute: async ({ prompt }) => {
            const res = await fetch('https://api.ideogram.ai/generate', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Api-Key': process.env.IDEOGRAM_API_KEY
              },
              body: JSON.stringify({ image_request: { prompt, model: 'V-3-TURBO' } })
            });
            return await res.json();
          }
        })
      },
      onFinish: async ({ text }) => {
        // 4. Save the interaction to Supabase Memory Vault
        if (supabase && text) {
          try {
            await supabase.from('messages').insert([
              { role: 'user', content: lastUserMessage },
              { role: 'assistant', content: text }
            ]);
          } catch (err) {
            console.error('Failed to archive agent reply:', err);
          }
        }
      }
    });

    return result.toDataStreamResponse();
  } catch (err) {
    return NextResponse.json({ reply: `Fatal Runtime Error: ${err.message}` }, { status: 500 });
  }
}
