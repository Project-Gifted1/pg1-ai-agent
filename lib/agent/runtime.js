import { AgentStore } from './store.js';
import { ExecutionLogger } from './logger.js';
import { CostTracker } from './costTracker.js';
import { ApprovalManager } from './approval.js';
import { MemoryLayer } from './memoryLayer.js';
import { AgentOrchestrator } from './agent.js';

const globalKey = '__PG1_AGENT_RUNTIME__';

export function getAgentRuntime() {
  if (!globalThis[globalKey]) {
    const store = new AgentStore();
    const logger = new ExecutionLogger(store);
    const memory = new MemoryLayer(store);
    const costTracker = new CostTracker(store);
    const approval = new ApprovalManager(store);
    const orchestrator = new AgentOrchestrator({ store, logger, memory, costTracker, approval });

    globalThis[globalKey] = {
      store,
      logger,
      memory,
      costTracker,
      approval,
      orchestrator
    };
  }

  return globalThis[globalKey];
}
