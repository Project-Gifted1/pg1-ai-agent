const globalStoreKey = '__PG1_AGENT_MEMORY_STORE__';

function getInMemoryStore() {
  if (!globalThis[globalStoreKey]) {
    globalThis[globalStoreKey] = {
      agent_tasks: [],
      agent_execution_logs: [],
      agent_memory: [],
      agent_conversations: [],
      agent_costs: [],
      agent_approvals: [],
      agent_metrics: []
    };
  }
  return globalThis[globalStoreKey];
}

function getSupabaseConfig() {
  const baseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceRoleKey) return null;
  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    serviceRoleKey
  };
}

function createSupabaseHeaders(serviceRoleKey, extra = {}) {
  return {
    apikey: serviceRoleKey,
    Authorization: 'Bearer ' + serviceRoleKey,
    'Content-Type': 'application/json',
    ...extra
  };
}

function buildFilterQuery(filters = {}) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    params.set(key, `eq.${String(value)}`);
  });
  return params;
}

export class AgentStore {
  constructor() {
    this.memory = getInMemoryStore();
  }

  async insert(table, row) {
    const withId = {
      id: row.id || crypto.randomUUID(),
      created_at: row.created_at || new Date().toISOString(),
      updated_at: row.updated_at || new Date().toISOString(),
      ...row
    };

    const supabase = getSupabaseConfig();
    if (!supabase) {
      this.memory[table].push(withId);
      return withId;
    }

    try {
      const response = await fetch(`${supabase.baseUrl}/rest/v1/${table}`, {
        method: 'POST',
        headers: createSupabaseHeaders(supabase.serviceRoleKey, { Prefer: 'return=representation' }),
        body: JSON.stringify(withId)
      });
      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || `insert failed: ${response.status}`);
      }
      const data = await response.json();
      return data[0] || withId;
    } catch (error) {
      console.error('[AgentStore] Supabase insert fallback:', error.message);
      this.memory[table].push(withId);
      return withId;
    }
  }

  async update(table, filters, patch) {
    const nextPatch = {
      ...patch,
      updated_at: new Date().toISOString()
    };

    const supabase = getSupabaseConfig();
    if (!supabase) {
      const rows = this.memory[table];
      rows.forEach((row) => {
        if (matches(row, filters)) Object.assign(row, nextPatch);
      });
      return rows.filter((row) => matches(row, filters));
    }

    try {
      const params = buildFilterQuery(filters);
      params.set('select', '*');
      const response = await fetch(`${supabase.baseUrl}/rest/v1/${table}?${params.toString()}`, {
        method: 'PATCH',
        headers: createSupabaseHeaders(supabase.serviceRoleKey, { Prefer: 'return=representation' }),
        body: JSON.stringify(nextPatch)
      });
      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || `update failed: ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      console.error('[AgentStore] Supabase update fallback:', error.message);
      const rows = this.memory[table];
      rows.forEach((row) => {
        if (matches(row, filters)) Object.assign(row, nextPatch);
      });
      return rows.filter((row) => matches(row, filters));
    }
  }

  async select(table, { filters = {}, limit = 50, orderBy = 'created_at', ascending = false } = {}) {
    const supabase = getSupabaseConfig();

    if (!supabase) {
      const filtered = this.memory[table].filter((row) => matches(row, filters));
      const sorted = filtered.sort((a, b) => {
        const av = a[orderBy] || '';
        const bv = b[orderBy] || '';
        return ascending ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
      });
      return sorted.slice(0, limit);
    }

    try {
      const params = buildFilterQuery(filters);
      params.set('select', '*');
      params.set('limit', String(limit));
      params.set('order', `${orderBy}.${ascending ? 'asc' : 'desc'}`);

      const response = await fetch(`${supabase.baseUrl}/rest/v1/${table}?${params.toString()}`, {
        method: 'GET',
        headers: createSupabaseHeaders(supabase.serviceRoleKey)
      });
      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || `select failed: ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      console.error('[AgentStore] Supabase select fallback:', error.message);
      const filtered = this.memory[table].filter((row) => matches(row, filters));
      return filtered.slice(0, limit);
    }
  }
}

function matches(row, filters) {
  return Object.entries(filters).every(([key, value]) => row[key] === value);
}
