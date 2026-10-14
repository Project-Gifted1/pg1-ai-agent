// PG1's tools in LangChain JS.   npm i @langchain/core
import { DynamicStructuredTool } from '@langchain/core/tools';
import { PG1Client } from '../index.mjs';
import { langchainTools } from '../frameworks.mjs';

const tools = await langchainTools(new PG1Client(), { DynamicStructuredTool }, { only: ['preflight_check', 'check_agent_card'] });
console.log(tools.map((t) => t.name));
// Bind them to any tool-calling chat model: model.bindTools(tools)
