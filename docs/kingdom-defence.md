# PG1 Kingdom Defence

The operator's live 3D view of PG1 defending its Command Centre: a modern island city (a glass spire HQ with PG1's shield, a ring of glass towers that light up at dusk, a concrete perimeter with sensor towers, four security gates, the channel and its bridges, the port), drawn only from real defence events.

Open it with `/kingdom`, the **Kingdom** button on the threat radar card or radar screen, or the mini-view above the thread (the latest real event in one line).

## Ground rules

- **Real events only.** Every attacker, ship and gadget action comes from one event in `/api/defense-feed`. When nothing happens, the city is calm: guards walk the wall, PG1's own patrol drones circle, the sea moves, the sun follows Dublin's. Nothing is staged for a recording either.
- **PG1 only defends.** The feature only reads PG1's own database; it sends nothing to any caller or third party.
- **Operator only.** `/api/defense-feed` uses the same sign-in check as `/api/home-context` (401 for anyone else) and is outside the wildcard CORS rule.
- **Privacy.** An event carries its time, kind, gadget, severity, country (ISO code or null, "the fog"), an 8-character caller hash, the PG1 check, the verdict code, PG1's own reason codes and a count. Never an IP, a user agent, a key, a wallet, a domain, a caller's made-up tool name or any message content. `check_agent_message` content never reaches the recorder: only the verdict, reason codes and the declared kind (`skill_md`, `message`, `other`).

## Data (`lib/defenseFeed.mjs`, `lib/defenseEvents.mjs`)

| Source | Events |
|---|---|
| `agent_telemetry` | unknown-tool and unknown-method probes, malformed calls, 402 challenges, failed and settled x402 payments, refused payers, rate-limit hits, caller-fault and PG1-fault errors, signed results (while signing is on) |
| `pg1_defense_events` (new) | `check_agent_message` malicious/suspicious, flagged `check_hostname_reputation`, `check_domain_age`, `check_wallet_sanctions`, `check_package`, `preflight_check` |
| `pg1_screening_events` | payers refused by the sanctions screen |
| `pg1_auth_events` | failed operator sign-ins and burst alerts: a count in a 10-minute slot only |
| `pg1_operator_reports`, tasks and actions | reports landed, approvals waiting |
| honeypot, firewall | reserved adapters, idle until their logs exist |

Waves: rows of the same kind, check, verdict, country and caller in one minute are one event with a count. The view polls every 5 s while open (`?since=`); the mini-view every 30 s while the page is visible. No server-sent events: a held-open Vercel function costs more than a small poll.

Country: Vercel's `x-vercel-ip-country` header at ingest. Migration `20261115120000_pg1_defense_events.sql` (additive, not run by PG1) adds `agent_telemetry.country_code` and `pg1_defense_events`. Until it runs, telemetry inserts retry once without the column and the verdict rows are dropped silently.

## The gadgets

Truth Lens (`check_agent_message`), Sanctions Gate (`check_wallet_sanctions`, payer screening: the blast doors slam), Phishing Net (`check_hostname_reputation`, `check_domain_age`), Supply Inspector (`check_package`, at the port), Preflight Ward (`preflight_check`), Toll Bridge (x402: unpaid callers stop at the toll, payers' boats arrive and light a bollard), Seal Forge (Ed25519 signed results), Passkey Vault (operator sign-in; a burst alert slides out the blast shutter), Rate Shield (the dome thickens under floods of siege drones), Gate Wardens (probes and caller faults turned away), Keep Wall (PG1's own faults, shown honestly), Watchtower Beacons (reports and approvals), Fog Wall (no country). Reserved: Honeypot Decoys and Firewall Ramparts. The legend lists each with the real check and today's count; the text feed beside the scene lists the same events for reading and screen readers.

## Engine and performance

The Sandbox viewer's engine: the same three.js (`/vendor/three/`), its quality tiers and governor, post-processing, orbit controls and water shader. Tiers: **Phone** (no post-processing or real-time shadows: baked wall-base shading and blob shadows, low-detail instanced crowds, 30 fps), **Balanced** (soft shadows, bloom, SMAA, water shader, physical sky, 60 fps), **Cinematic** (larger shadows, ambient occlusion, light shafts, bigger crowds, 60 fps). The governor steps down when frames run slow; rendering stops while the tab is hidden. With `prefers-reduced-motion` the view is a still 2D map plus the text feed and three.js is never loaded. No third-party assets: everything is generated in code (see `/docs/attributions`).

## Record mode

**Record** makes a clip on the device (MP4 where the browser can, else WebM; nothing is uploaded): the director camera, a caption for the event on screen (gadget, check, verdict, country), the PG1 mark and the label "Real PG1 events", in 16:9 or 9:16, 30 or 60 s. **Replay last 24 h** re-stages the day's real events in their real order, compressed into the clip, labelled "Real PG1 events · last 24 h, time-lapse", each caption with its real Dublin time. A quiet period says the kingdom was calm.

## Tests

`tests/defense-feed.test.mjs`, `tests/kingdom-view.test.mjs`, `tests/browser/kingdom.browser.test.mjs` (412 px, Phone tier, reduced motion, recording; screenshots in `docs/screenshots/kingdom-*.png`).
