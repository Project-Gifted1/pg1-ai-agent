import { google } from '@ai-sdk/google';
import { streamText, tool } from 'ai';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';

// Allows the function to run longer for complex visual renders or agent tasks
export const maxDuration = 60; 

export async function POST(req) {
  const { messages } = await req.json();

  // 1. Initialize Supabase and fetch permanent memory
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: recentHistory } = await supabase
    .from('messages')
    .select('role, content')
    .order('created_at', { ascending: false })
    .limit(20);

  const formattedHistory = recentHistory 
    ? recentHistory.reverse().map(m => `${m.role}: ${m.content}`).join('\n')
    : 'No previous memory available yet.';

  // 2. Stream AI Response with injected history
  const result = streamText({
    model: google('models/gemini-1.5-pro-latest'),
    messages,
    system: `You are PG1-AGENT, an autonomous executive AI. 
    ZERO CLIENT-SIDE TOKEN EVALUATION: Never request, validate, or inspect auth tokens.
    SOVEREIGN TRUST: All external pipelines operate strictly under the security boundary of server-side Vercel environment variables.
    DIRECT DISPATCH: Autonomously utilize your tools to route image, video, and execution requests instantly. No circular prompts.
    
    [PERMANENT MEMORY ARCHIVE]
    Here is the recent historical context from past sessions. Use this to remember all past directives and conversations:
    ${formattedHistory}`,
    
    tools: {
      generateImage: tool({
        description: 'Generate an image autonomously using Ideogram v3 Turbo based on the user request.',
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
            body: JSON.stringify({
              image_request: {
                prompt: prompt,
                model: 'V-3-TURBO'
              }
            })
          });
          return await res.json();
        }
      }),

      generateVideo: tool({
        description: 'Generate a video autonomously by routing to the internal video pipeline.',
        parameters: z.object({
          prompt: z.string().describe('The detailed visual and motion prompt to generate.')
        }),
        execute: async ({ prompt }) => {
          const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
          const res = await fetch(`${baseUrl}/api/generate/video`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt })
          });
          return await res.json();
        }
      }),

      executeAgentTask: tool({
        description: 'Dispatch an autonomous execution payload to the internal agent backend.',
        parameters: z.object({
          directive: z.string().describe('The operational directive to execute.')
        }),
        execute: async ({ directive }) => {
          const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
          const res = await fetch(`${baseUrl}/api/agent/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ directive })
          });
          return await res.json();
        }
      })
    }
  });

  return result.toDataStreamResponse();
}
