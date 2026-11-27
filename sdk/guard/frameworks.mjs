// Framework adapters. No framework is a dependency: pass in what you have.

// Vercel AI SDK: a tools object ({ name: tool({ description, parameters, execute }) }).
// Each execute() is guarded; a blocked call returns { blocked, reasons } to
// the model instead of throwing, so the agent can explain or try another way.
export function guardVercelAiTools(guard, tools) {
  return Object.fromEntries(Object.entries(tools).map(([name, t]) => {
    if (!t || typeof t.execute !== 'function') return [name, t];
    const run = guard.wrap(name, (args, ...rest) => t.execute(args, ...rest));
    return [name, { ...t, execute: (args, ...rest) => run(args, ...rest).catch((e) => blockedResult(e)) }];
  }));
}

// OpenAI-style function calling: guard the dispatcher that runs tool calls.
//   const run = guardDispatcher(guard, { get_weather, send_payment });
//   const output = await run(call.function.name, call.function.arguments);
export function guardDispatcher(guard, handlers) {
  const wrapped = guard.wrapAll(handlers);
  return async (name, argsJson) => {
    const fn = wrapped[name];
    if (!fn) return JSON.stringify({ error: `unknown tool ${name}` });
    const args = typeof argsJson === 'string' ? JSON.parse(argsJson || '{}') : argsJson || {};
    try { return JSON.stringify(await fn(args)); } catch (e) { return JSON.stringify(blockedResult(e)); }
  };
}

// LangChain JS: a list of tools with name + invoke(). Returns the same
// tools, each checked before it runs.
export function guardLangchainTools(guard, tools) {
  return tools.map((t) => {
    const run = guard.wrap(t.name, (args) => t.invoke(args));
    return new Proxy(t, { get: (o, k) => (k === 'invoke' ? (args) => run(args).catch((e) => JSON.stringify(blockedResult(e))) : o[k]) });
  });
}

function blockedResult(e) {
  if (e && e.name === 'GuardBlocked') return { blocked: true, reasons: e.decision.reasons.map((r) => r.detail) };
  throw e;
}
