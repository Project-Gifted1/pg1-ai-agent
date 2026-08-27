# Supabase Setup (Phase 1 Agent Foundation)

1. Create a Supabase project.
2. Enable `pgvector` and run the migration:
   - `supabase/migrations/20260827160000_phase1_agent_foundation.sql`
3. Configure environment variables:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `AGENT_ALLOWED_ORIGINS` (comma-separated origins)
4. Optional budget/security controls:
   - `MAX_MESSAGE_LENGTH`
   - `ALLOWED_ORIGINS`
5. Deploy API routes under `/api/agent/*`.

If Supabase variables are missing, the runtime uses in-memory fallback storage so local development still works.
