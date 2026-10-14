// PG1's tools in the Vercel AI SDK.   npm i ai @ai-sdk/anthropic
import { generateText, tool, jsonSchema } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { PG1Client } from '../index.mjs';
import { vercelAiTools } from '../frameworks.mjs';

const tools = await vercelAiTools(new PG1Client(), { tool, jsonSchema }, { only: ['preflight_check', 'check_package', 'check_x402_endpoint'] });
const { text } = await generateText({ model: anthropic('claude-sonnet-5-5'), tools, maxSteps: 4, prompt: 'Before installing the npm package left-pad, run a preflight check and tell me whether to proceed.' });
console.log(text);
