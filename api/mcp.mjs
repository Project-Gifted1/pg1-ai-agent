// ---------------------------------------------------------------------
// PATCH PART 3 for mcp.mjs (built on top of mcp_fixed.mjs)
//
// Adds the two gaps Glama's Completeness score named explicitly:
//   1. get_cve_batch            — true batch CVE lookup (N ids in, N
//                                  results out), not the vendor/product
//                                  search shape of get_cve_by_product
//   2. get_threat_actor_profile — MITRE ATT&CK-backed dossier: group
//                                  info, associated techniques, and
//                                  associated malware/tools
//
// Both reuse functions already defined in mcp_fixed.mjs:
//   fetchNvdCveDetails, fetchEpssScore, getKevCatalog  (for the batch tool)
// Nothing about handler()'s auth flow needs to change — both tools
// go through the same Gumroad/x402 gate as your other three.
// ---------------------------------------------------------------------


// =======================================================================
// 1. get_cve_batch
// =======================================================================

const CVE_BATCH_MAX = 20; // keep this well under maxDuration: 30s — NVD + EPSS
                           // are two fetches per CVE, run in parallel per-id,
                           // but 20 concurrent ids is already pushing it.

async function handleCveBatch(args) {
  const cveIds = args?.cve_ids;
  if (!Array.isArray(cveIds) || cveIds.length === 0) {
    throw new Error('cve_ids is required and must be a non-empty array of strings.');
  }
  if (cveIds.length > CVE_BATCH_MAX) {
    throw new Error(`cve_ids exceeds the maximum batch size of ${CVE_BATCH_MAX}.`);
  }

  const kevCatalog = await getKevCatalog().catch(() => ({}));

  const results = await Promise.all(cveIds.map(async (rawId) => {
    const cveId = String(rawId || '').toUpperCase();
    if (!/^CVE-\d{4}-\d{4,}$/i.test(cveId)) {
      return { cve_id: rawId, found: false, error: "Malformed CVE id — expected 'CVE-YYYY-NNNN'." };
    }

    const [nvd, epss] = await Promise.all([
      fetchNvdCveDetails(cveId).catch((e) => ({ error: e.message })),
      fetchEpssScore(cveId).catch(() => null)
    ]);

    if (!nvd || nvd.error) {
      return { cve_id: cveId, found: false, error: nvd?.error || 'CVE not found in NVD.' };
    }

    const kevEntry = kevCatalog[cveId];

    return {
      cve_id: cveId,
      found: true,
      nvd: {
        description: nvd.description,
        cvss_v3_score: nvd.cvss_score,
        cvss_vector: nvd.cvss_vector,
        severity: nvd.cvss_severity,
        published: nvd.published
      },
      epss: epss ? { score: epss.epss_score, percentile: epss.epss_percentile } : null,
      cisa_kev: {
        is_known_exploited: !!kevEntry,
        due_date: kevEntry ? kevEntry.dueDate : null
      }
    };
  }));

  return {
    total_requested: cveIds.length,
    total_found: results.filter((r) => r.found).length,
    results
  };
}

const CVE_BATCH_TOOL = {
  name: 'get_cve_batch',
  description: "PG1 Sovereign Threat Intelligence: looks up multiple CVE identifiers in a single call, each enriched with NVD description/CVSS, FIRST.org EPSS score, and CISA KEV status — same enrichment as get_cve_details, batched. Payment required: $0.01 via x402 (X-PAYMENT header) or a valid Gumroad license key (X-API-KEY header). SIBLING DIFFERENTIATION: Use for looking up several known CVE ids at once (e.g. from an SBOM or scan report). Do NOT use for a single CVE (use get_cve_details, lower overhead) or for discovering CVEs by vendor/product (use get_cve_by_product). BEHAVIOR: Accepts up to " + CVE_BATCH_MAX + " ids per call; malformed or not-found ids are reported per-entry rather than failing the whole batch.",
  inputSchema: {
    type: 'object',
    properties: {
      cve_ids: {
        type: 'array',
        items: { type: 'string' },
        description: "Array of CVE identifiers, each formatted 'CVE-YYYY-NNNN'. Max " + CVE_BATCH_MAX + " per call."
      }
    },
    required: ['cve_ids']
  }
};


// =======================================================================
// 2. get_threat_actor_profile
// =======================================================================

// Reuses the same MITRE ATT&CK enterprise-attack STIX bundle referenced
// in the earlier ATT&CK-mapping bolt-on — cached the same way (24h TTL,
// warm-invocation cache). If you already added that bolt-on to your
// deployment, dedupe this against it rather than fetching the bundle twice.
let attackCache = null;
let attackCacheTime = 0;
const ATTACK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function getAttackBundle() {
  const now = Date.now();
  if (attackCache && (now - attackCacheTime) < ATTACK_CACHE_TTL_MS) return attackCache;

  const res = await fetch('https://raw.githubusercontent.com/mitre/cti/master/enterprise-attack/enterprise-attack.json');
  if (!res.ok) {
    if (attackCache) return attackCache;
    throw new Error('MITRE ATT&CK STIX bundle fetch failed: ' + res.status);
  }
  const bundle = await res.json();
  attackCache = bundle;
  attackCacheTime = now;
  return attackCache;
}

async function handleThreatActorProfile(args) {
  const actorName = args?.actor_name?.trim();
  if (!actorName) {
    throw new Error('actor_name is required.');
  }

  const bundle = await getAttackBundle();
  const objects = bundle.objects || [];
  const needle = actorName.toLowerCase();

  const group = objects.find((o) => {
    if (o.type !== 'intrusion-set') return false;
    if ((o.name || '').toLowerCase() === needle) return true;
    const aliases = (o.aliases || []).map((a) => a.toLowerCase());
    return aliases.includes(needle);
  });

  if (!group) {
    const err = new Error(`No ATT&CK group found matching '${actorName}'.`);
    err.notFound = true;
    throw err;
  }

  const attackId = (group.external_references || []).find((r) => r.source_name === 'mitre-attack');
  const relationships = objects.filter((o) => o.type === 'relationship' && o.source_ref === group.id);

  const techniquesById = {};
  const softwareById = {};
  objects.forEach((o) => {
    if (o.type === 'attack-pattern') {
      const ref = (o.external_references || []).find((r) => r.source_name === 'mitre-attack');
      if (ref) techniquesById[o.id] = { technique_id: ref.external_id, name: o.name };
    }
    if (o.type === 'malware' || o.type === 'tool') {
      softwareById[o.id] = { name: o.name, type: o.type };
    }
  });

  const techniques = [];
  const software = [];
  relationships.forEach((rel) => {
    if (rel.relationship_type === 'uses') {
      if (techniquesById[rel.target_ref]) techniques.push(techniquesById[rel.target_ref]);
      if (softwareById[rel.target_ref]) software.push(softwareById[rel.target_ref]);
    }
  });

  return {
    actor_name: group.name,
    attack_group_id: attackId ? attackId.external_id : null,
    aliases: group.aliases || [],
    description: group.description || null,
    associated_techniques: techniques,
    associated_software: software,
    source: 'MITRE ATT&CK Enterprise'
  };
}

const THREAT_ACTOR_PROFILE_TOOL = {
  name: 'get_threat_actor_profile',
  description: "PG1 Sovereign Threat Intelligence: returns a dossier for a known threat actor / APT group — aliases, description, associated MITRE ATT&CK techniques, and associated malware/tooling. Sourced from MITRE ATT&CK Enterprise. Payment required: $0.01 via x402 (X-PAYMENT header) or a valid Gumroad license key (X-API-KEY header). SIBLING DIFFERENTIATION: Use for actor/group-level profiling. Do NOT use for single-indicator lookups (use get_ioc_context) or vulnerability data (use get_cve_details / get_cve_batch). USAGE EXCLUSIONS: Coverage is limited to groups tracked in MITRE ATT&CK — not all threat actors have an entry. BEHAVIOR: Returns 404 if no matching group or alias is found.",
  inputSchema: {
    type: 'object',
    properties: {
      actor_name: {
        type: 'string',
        description: "Group name or known alias, e.g. 'APT29' or 'Cozy Bear'. Matching is case-insensitive against both the group's primary name and its known aliases."
      }
    },
    required: ['actor_name']
  }
};


// =======================================================================
// Wire-in for mcp_fixed.mjs
// =======================================================================

// 1. Add both tool definitions to the TOOLS array:
//      const TOOLS = [ ...existing 3..., CVE_BATCH_TOOL, THREAT_ACTOR_PROFILE_TOOL ];
//
// 2. Add both handlers to TOOL_HANDLERS:
//      const TOOL_HANDLERS = {
//        ...existing 3...,
//        get_cve_batch: handleCveBatch,
//        get_threat_actor_profile: handleThreatActorProfile
//      };
//
// 3. No changes needed to the auth/payment flow in handler() — both
//    tools are looked up via TOOL_HANDLERS[toolName] exactly like your
//    existing three, so they inherit the same Gumroad → x402 gate.
//
// 4. Bump version once more (e.g. 1.5.0) in both the GET health check
//    and initialize's serverInfo — same pattern as the 1.3.2 -> 1.4.0
//    bump — and update server.json to match before republishing to
//    the MCP Registry. 