# Proprietary signals (design only, off)

Status: **design only. `PG1_SIGNALS` is `off` by default and nothing records a signal.** Enabling it needs the privacy notice and terms changes in `docs/drafts/` reviewed (EU/GDPR) and published first, and a migration that is not written yet.

## What it would add

PG1 sees many agents check the same wallets, domains, packages and CVEs. Aggregated, that is a signal no single upstream source has: "40+ distinct callers checked this wallet this week; 60% of those checks came back flagged" or "this package is suddenly checked by many agents right after its first publish". Signals would be returned as an extra, clearly labelled field next to the existing `reasons`, never as a reason code that changes `status` on its own until it has been evaluated in the lab (P4) and promoted through the gate.

## Privacy by design

| Rule | How |
|---|---|
| No raw identifiers | Callers are the salted HMAC `caller_hash` already used by telemetry (`lib/telemetry.mjs`). Targets are hashed with the same salt (`kind:target`), so the store holds neither a raw caller nor a raw target. |
| k-anonymity | A signal is published only when at least **k = 10** distinct caller hashes contributed (`aggregateSignal`). Counts are bucketed (10-24, 25-49, 50-99, 100+); the flagged share is rounded to 5%. No caller list is ever returned. |
| Retention | Observations are deleted after **90 days** (retention job); aggregates older than the window are recomputed, not kept. |
| Purpose limitation | Used only to compute public, aggregate threat signals. Never sold as raw data, never used to profile a caller. |
| Opt-out | A caller can send `X-PG1-Signals: 0` to have its checks excluded (to implement with the feature). Licence holders can opt out account-wide. |
| Lawful basis | Legitimate interest (fraud and abuse prevention, Art. 6(1)(f) GDPR), with a balancing test recorded before launch. A DPIA is recommended because of the scale. |

## Licensing

Signals are derived from PG1's own observations (our own data), so they can be sold. Upstream results that feed them keep their own licences: only the PG1 status (`no_flags`/`flagged`/`unknown`) is observed, never the upstream payload.

## What exists in code

- `lib/signals.mjs`: `signalsEnabled` (off unless `PG1_SIGNALS=on`), `buildObservation` (returns null while off), `aggregateSignal` (k-anonymity, buckets, 90-day window). Nothing calls it.
- Tests: `tests/edge.test.mjs` asserts signals are off by default and that no observation is built while off.

## To launch (not done)

1. Legal review of `docs/drafts/privacy-notice-signals.md` and `docs/drafts/terms-signals.md`; publish them.
2. DPIA and legitimate-interest assessment.
3. Migration for `pg1_signal_observations` (RLS on, service role only, 90-day purge).
4. Record observations from the check handlers behind `signalsEnabled`; add the opt-out header.
5. Evaluate signal quality in the lab; promote through the P4 gate.
