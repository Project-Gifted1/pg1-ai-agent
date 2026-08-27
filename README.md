# pg1-ai-agent

Phase 1 implementation of an enterprise autonomous-agent foundation for PG1.

## What is included

### Core backend modules
- `lib/agent/agent.js` — Orchestrator using ReAct-style lifecycle (`planning -> executing -> reflecting -> reporting`)
- `lib/agent/memoryLayer.js` — Session memory, long-term memory, retrieval, and conversation compression
- `lib/agent/logger.js` — Structured JSON execution/audit logging
- `lib/agent/costTracker.js` — Per-step and per-session cost tracking in cents
- `lib/agent/approval.js` — Sensitive operation detection, risk scoring, and approval gates
- `lib/agent/store.js` — Supabase persistence with in-memory fallback for local/dev
- `lib/agent/protocols.js` — System instructions for planning, tool use, recovery, reflection, cost, and safety

### API endpoints

New endpoints:
- `POST /api/agent/plan`
- `POST /api/agent/execute`
- `GET /api/agent/status`
- `GET /api/agent/memory`
- `GET /api/agent/logs`
- `POST /api/agent/approve`
- `GET /api/agent/costs`

Compatibility endpoint:
- `api/agent.js` supports action routing using `action` query/body (`plan`, `execute`, `status`, `memory`, `logs`, `approve`, `costs`).

Existing endpoint upgraded:
- `POST /api/chat` now includes safer CORS behavior, request-size limits, timeout/retry handling, and sanitized provider error handling.

### Frontend
- `index.html` and `public/index.html` now include an **Agent Control Panel** with:
  - real-time task lifecycle/progress/cost KPIs
  - reasoning chain view (thought/action/observation)
  - execution log/audit feed
  - memory context viewer
  - approval queue with approve/deny controls
- Legacy chat terminal remains available via a tab for backward compatibility.
- React component deliverable included:
  - `src/components/AgentControlPanel.jsx`
  - `src/AgentDashboard.jsx`

### Database / Supabase
- Migration script: `supabase/migrations/20260827160000_phase1_agent_foundation.sql`
- Setup guide: `supabase/README.md`
- Tables created:
  - `agent_tasks`
  - `agent_execution_logs`
  - `agent_memory`
  - `agent_conversations`
  - `agent_costs`
  - `agent_approvals`
  - `agent_metrics`

## Environment variables

See `.env.example` for full values:
- `GEMINI_API_KEY`
- `OPENROUTER_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ALLOWED_ORIGINS`
- `AGENT_ALLOWED_ORIGINS`
- `MAX_MESSAGE_LENGTH`

## Running

Current repository script:
```bash
npm start
```

## Notes

- If Supabase credentials are not configured, agent persistence falls back to process in-memory storage.
- Cost values are tracked in **cents** (`cost_cents`) for precision and budget enforcement.
- Sensitive operations are blocked pending user approval based on keyword-driven risk scoring.
