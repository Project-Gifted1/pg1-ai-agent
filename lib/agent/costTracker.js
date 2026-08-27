const MODEL_PRICING_CENTS_PER_1K = {
  'gemini-1.5-flash': { input: 0.035, output: 0.105 },
  'deepseek/deepseek-chat': { input: 0.014, output: 0.028 },
  default: { input: 0.05, output: 0.1 }
};

function estimateTokens(text = '') {
  return Math.max(1, Math.ceil(String(text).length / 4));
}

function toCents(inputTokens, outputTokens, pricing) {
  const inputCost = (inputTokens / 1000) * pricing.input;
  const outputCost = (outputTokens / 1000) * pricing.output;
  return Number((inputCost + outputCost).toFixed(6));
}

export class CostTracker {
  constructor(store) {
    this.store = store;
  }

  calculateCost({ model, inputText = '', outputText = '', inputTokens, outputTokens }) {
    const resolvedInput = inputTokens || estimateTokens(inputText);
    const resolvedOutput = outputTokens || estimateTokens(outputText);
    const pricing = MODEL_PRICING_CENTS_PER_1K[model] || MODEL_PRICING_CENTS_PER_1K.default;
    const costCents = toCents(resolvedInput, resolvedOutput, pricing);

    return {
      model,
      input_tokens: resolvedInput,
      output_tokens: resolvedOutput,
      cost_cents: costCents,
      pricing
    };
  }

  async recordCost({ taskId, sessionId, provider, model, inputText, outputText, inputTokens, outputTokens }) {
    const cost = this.calculateCost({ model, inputText, outputText, inputTokens, outputTokens });
    const row = {
      task_id: taskId,
      session_id: sessionId,
      provider,
      ...cost
    };

    await this.store.insert('agent_costs', row);
    return row;
  }

  async getSummary({ taskId, sessionId }) {
    const filters = {};
    if (taskId) filters.task_id = taskId;
    if (sessionId) filters.session_id = sessionId;

    const rows = await this.store.select('agent_costs', { filters, limit: 1000, orderBy: 'created_at', ascending: false });
    const totalCostCents = rows.reduce((sum, row) => sum + Number(row.cost_cents || 0), 0);

    return {
      count: rows.length,
      total_cost_cents: Number(totalCostCents.toFixed(6)),
      rows
    };
  }

  async assertWithinBudget({ taskId, sessionId, budgetCents }) {
    if (budgetCents === undefined || budgetCents === null) return { allowed: true };

    const summary = await this.getSummary({ taskId, sessionId });
    const allowed = summary.total_cost_cents <= Number(budgetCents);
    return {
      allowed,
      budget_cents: Number(budgetCents),
      current_cost_cents: summary.total_cost_cents
    };
  }
}
