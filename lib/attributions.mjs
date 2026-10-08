// Third-party data sources PG1 serves data from, with their licences: the
// single source of truth for the public /docs/attributions page
// (scripts/build-docs.mjs attributionsMarkdown) and for check_package's
// `attribution` field.
//
// check_package (1.17.0) reads three kinds of public data:
//   - OSV.dev (api.osv.dev), which aggregates advisory databases, each under
//     its own licence. check_package shows advisories only from the
//     databases listed under OSV_ADVISORY_SOURCES (by advisory id prefix);
//     anything else OSV returns is left out and counted in
//     `vulnerabilities_omitted`. Distribution-specific databases (Ubuntu,
//     Debian and the like, some of them CC-BY-SA) are never used.
//   - The npm public registry and PyPI, for package metadata (does it exist,
//     publish dates, deprecation, install scripts), under each registry's
//     own terms: one package per request, cached, with a short timeout and
//     an identifying User-Agent, and never crawled in bulk.
//
// Every entry: the name as its maintainers write it, what PG1 uses it for,
// a link to the source, and the licence (or terms) with a link.

export const ATTRIBUTIONS_ROUTE = '/docs/attributions';
export const ATTRIBUTIONS_URL = `https://pg1-ai-agent.vercel.app${ATTRIBUTIONS_ROUTE}`;

const CC_BY_4 = Object.freeze({ licence: 'CC-BY 4.0', licence_url: 'https://creativecommons.org/licenses/by/4.0/' });
const CC0 = Object.freeze({ licence: 'CC0 1.0', licence_url: 'https://creativecommons.org/publicdomain/zero/1.0/' });
const APACHE_2 = Object.freeze({ licence: 'Apache-2.0', licence_url: 'https://www.apache.org/licenses/LICENSE-2.0' });

// Advisory databases served through OSV.dev. `id_prefixes` are the OSV id
// prefixes each database publishes under; check_package keeps an advisory
// only when its id starts with one of these.
export const OSV_ADVISORY_SOURCES = Object.freeze([
  Object.freeze({ name: 'OpenSSF Malicious Packages', url: 'https://github.com/ossf/malicious-packages', id_prefixes: Object.freeze(['MAL-']), used_for: 'reports of malicious packages (reported_malicious, malicious_reports)', ...APACHE_2 }),
  Object.freeze({ name: 'GitHub Advisory Database', url: 'https://github.com/github/advisory-database', id_prefixes: Object.freeze(['GHSA-']), used_for: 'vulnerability ids and severity', ...CC_BY_4 }),
  Object.freeze({ name: 'PyPI Advisory Database', url: 'https://github.com/pypa/advisory-database', id_prefixes: Object.freeze(['PYSEC-']), used_for: 'vulnerability ids and severity for PyPI packages', ...CC_BY_4 }),
  Object.freeze({ name: 'Go Vulnerability Database', url: 'https://vuln.go.dev', id_prefixes: Object.freeze(['GO-']), used_for: 'vulnerability ids and severity, when OSV returns them', ...CC_BY_4 }),
  Object.freeze({ name: 'RustSec Advisory Database', url: 'https://rustsec.org', id_prefixes: Object.freeze(['RUSTSEC-']), used_for: 'vulnerability ids and severity, when OSV returns them', ...CC0 })
]);

export const OSV_SERVICE = Object.freeze({ name: 'OSV.dev', url: 'https://osv.dev', used_for: 'the query service that serves the advisory databases above' });

export const PACKAGE_REGISTRIES = Object.freeze([
  Object.freeze({ name: 'npm public registry', url: 'https://www.npmjs.com', used_for: 'npm package metadata: whether a package and version exist, publish dates, deprecation and install scripts', licence: 'npm Open-Source Terms', licence_url: 'https://docs.npmjs.com/policies/open-source-terms' }),
  Object.freeze({ name: 'PyPI (the Python Package Index)', url: 'https://pypi.org', used_for: 'PyPI package metadata: whether a package and version exist, and publish dates', licence: 'PyPI Terms of Use', licence_url: 'https://policies.python.org/pypi.org/Terms-of-Use/' })
]);

// Every OSV id prefix check_package may show.
export const ALLOWED_OSV_ID_PREFIXES = Object.freeze(OSV_ADVISORY_SOURCES.flatMap((s) => s.id_prefixes));

export const PACKAGE_CHECK_ATTRIBUTION_TEXT = 'Malicious-package reports: OpenSSF Malicious Packages (Apache-2.0). Vulnerabilities: GitHub Advisory Database and PyPI Advisory Database (CC-BY 4.0), via OSV.dev. Package metadata: the npm public registry and PyPI. Full list and licences at the url.';

// The /docs/attributions page, as Markdown (scripts/build-docs.mjs).
export function attributionsMarkdown() {
  const row = (s) => `| [${s.name}](${s.url}) | ${s.used_for} | [${s.licence}](${s.licence_url}) |`;
  return [
    '# Data sources and licences',
    '',
    'PG1 credits every third-party data source it serves data from. This page lists the sources behind the `check_package` tool and the licence or terms each is used under. Each `check_package` response links here in its `attribution` field.',
    '',
    '## Advisory databases',
    '',
    `Malicious-package reports and vulnerability ids come from these databases, queried through [${OSV_SERVICE.name}](${OSV_SERVICE.url}), ${OSV_SERVICE.used_for}. PG1 shows only an advisory's id and severity, never its text.`,
    '',
    '| Source | Used for | Licence |',
    '|---|---|---|',
    ...OSV_ADVISORY_SOURCES.map(row),
    '',
    `Only advisories whose id starts with ${ALLOWED_OSV_ID_PREFIXES.map((p) => `\`${p}\``).join(', ').replace(/, (?=[^,]*$)/, ' or ')} are shown. Anything else the query service returns is left out and counted in \`vulnerabilities_omitted\`. Distribution-specific databases (for example Ubuntu or Debian security notices) are never used.`,
    '',
    '"Reported malicious" means a public report exists in OpenSSF Malicious Packages. Such reports can be false positives, so PG1 never words them as a finding of its own.',
    '',
    '## Package registries',
    '',
    '| Source | Used for | Terms |',
    '|---|---|---|',
    ...PACKAGE_REGISTRIES.map(row),
    '',
    'PG1 looks up one package per request, caches each answer (registry metadata for 1 hour, malicious-package status for 15 minutes), uses short timeouts, identifies itself in its User-Agent, and never crawls a registry in bulk.',
    '',
    '## What PG1 keeps',
    '',
    'Nothing from a check is stored beyond the in-memory caches above. Usage telemetry records the tool name, how the call ended, its latency and a salted hash of the caller IP, never the package name or version.',
    ''
  ].join('\n');
}
