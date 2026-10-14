// Framework tool wrappers. No framework is a dependency: pass in the
// helpers from your framework and get PG1's tools in its shape.
//
// All wrappers start from pg1ToolSpecs(client): { name, description,
// parameters (JSON Schema), execute(args) } per PG1 tool, read live from
// tools/list. execute() returns the parsed result plus `verified`, and
// throws when a signature does not verify (fail closed).

export async function pg1ToolSpecs(client, { only = null } = {}) {
  const tools = await client.listTools();
  return tools.filter((t) => !only || only.includes(t.name)).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
    async execute(args) {
      const r = await client.call(t.name, args || {});
      if (r.paymentRequired) return { payment_required: true, detail: 'This PG1 tool needs an x402 payment or a licence key; configure a payer on the PG1Client.' };
      if (r.verified && !r.verified.valid) throw new Error(`PG1 result signature did not verify (${r.verified.reason})`);
      return { ...r.result, verified: r.verified };
    }
  }));
}

// Vercel AI SDK: import { tool, jsonSchema } from 'ai'.
export async function vercelAiTools(client, { tool, jsonSchema }, opts) {
  const specs = await pg1ToolSpecs(client, opts);
  return Object.fromEntries(specs.map((s) => [s.name, tool({ description: s.description, parameters: jsonSchema(s.parameters), execute: s.execute })]));
}

// LangChain JS: import { DynamicStructuredTool } from '@langchain/core/tools'.
// Recent versions accept a JSON Schema as `schema`.
export async function langchainTools(client, { DynamicStructuredTool }, opts) {
  const specs = await pg1ToolSpecs(client, opts);
  return specs.map((s) => new DynamicStructuredTool({ name: s.name, description: s.description, schema: s.parameters, func: async (args) => JSON.stringify(await s.execute(args)) }));
}

// OpenAI-style function tools (Chat Completions / Responses), plus a
// dispatcher for the tool calls the model makes.
export async function openAiFunctionTools(client, opts) {
  const specs = await pg1ToolSpecs(client, opts);
  return {
    tools: specs.map((s) => ({ type: 'function', function: { name: s.name, description: s.description, parameters: s.parameters } })),
    async run(name, argsJson) {
      const s = specs.find((x) => x.name === name);
      if (!s) throw new Error(`unknown PG1 tool ${name}`);
      return JSON.stringify(await s.execute(typeof argsJson === 'string' ? JSON.parse(argsJson || '{}') : argsJson));
    }
  };
}
