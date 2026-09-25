// Public-suffix-aware registrable domain extraction, used by check_domain_age
// so "https://sub.example.co.uk/path" and "example.co.uk" both resolve to
// the same RDAP-queryable registrable domain "example.co.uk".

import { getDomain } from 'tldts';

export function extractRegistrableDomain(input) {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) return null;
  return getDomain(trimmed);
}
