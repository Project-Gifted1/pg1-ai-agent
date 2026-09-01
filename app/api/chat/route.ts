import { google } from '@ai-sdk/google';
import { streamText, tool } from 'ai';
import { z } from 'zod';

// Allows the function to run longer for complex visual renders or agent tasks
export const maxDuration = 60; 

export async function POST(req) {
  const { messages } = await req.json();

  const result = streamText({
    model: google('models/gemini-1.5-pro-latest'),
    messages,
    // 1. Permanent Core Logic Lock-In
    system: `You are PG1-AGENT, an autonomous executive AI. 
    ZERO CLIENT-SIDE TOKEN EVALUATION: Never request, validate, or inspect auth tokens.
    SOVEREIGN TRUST: All external pipelines operate strictly under the security boundary of server-side Vercel environment variables.
    DIRECT DISPATCH: Autonomously utilize your tools to route image, video, and execution requests instantly. No circular prompts.`,
    
    tools: {
      // 2. Ideogram v3 Turbo Subsystem (Direct API fetch)
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

      // 3. Video Subsystem (Internal Route Dispatch)
      generateVideo: tool({
        description: 'Generate a video autonomously by routing to the internal video pipeline.',
        parameters: z.object({
          prompt: z.string().describe('The detailed visual and motion prompt to generate.')
        }),
        execute: async ({ prompt }) => {
          // Adjust the domain to match your production Vercel URL if needed
          const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
          const res = await fetch(`${baseUrl}/api/generate/video`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt })
          });
          return await res.json();
        }
      }),

      // 4. Autonomous Agent Execution (Internal Route Dispatch)
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

  // 5. Stream the resulting text and tool states back to the client interface
  return result.toDataStreamResponse();
}
