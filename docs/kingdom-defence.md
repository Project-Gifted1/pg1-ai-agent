# PG1 City (Kingdom Defence)

The operator's live 3D view of PG1 defending its Command Centre: **PG1 City**, an original near-future city at dusk (the PG1 Tower, a glass spire with the shield near the top, the Command Centre deck, an emblem ring and a beacon at the tip; a skyline of glass and steel towers with procedural lit windows running to the haze; a river with an arched bridge, the toll gantry and the harbour pier; street lights and car light trails), drawn only from real defence events. No island, walls or moat; no third-party assets.

Open it with `/kingdom`, the **Kingdom** button on the threat radar card or radar screen, or the mini-view above the thread (the latest real event in one line).

## Ground rules

- **Real events only.** Every attacker, ship and gadget action comes from one event in `/api/defense-feed`. When nothing happens, the city is calm: guards walk the wall, PG1's own patrol drones circle, the sea moves, the sun follows Dublin's. Nothing is staged for a recording either.
- **PG1 only defends.** The feature only reads PG1's own database; it sends nothing to any caller or third party.
- **Operator only.** `/api/defense-feed` uses the same sign-in check as `/api/home-context` (401 for anyone else) and is outside the wildcard CORS rule.
- **Privacy.** An event carries its time, kind, gadget, severity, country (ISO code or null, "the fog"), an 8-character caller hash, the PG1 check, the verdict code, PG1's own reason codes and a count. Never an IP, a user agent, a key, a wallet, a domain, a caller's made-up tool name or any message content. `check_agent_message` content never reaches the recorder: only the verdict, reason codes and the declared kind (`skill_md`, `message`, `other`). The same for `check_repo_trap`: the verdict and reason codes, never a path, a project name or any file content.

## Data (`lib/defenseFeed.mjs`, `lib/defenseEvents.mjs`)

| Source | Events |
|---|---|
| `agent_telemetry` | unknown-tool and unknown-method probes, malformed calls, 402 challenges, failed and settled x402 payments, refused payers, rate-limit hits, caller-fault and PG1-fault errors, signed results (while signing is on) |
| `pg1_defense_events` (new) | `check_agent_message` and (1.22.0, migration `20261116120000`) `check_repo_trap` malicious/suspicious, flagged `check_hostname_reputation`, `check_domain_age`, `check_wallet_sanctions`, `check_package`, `preflight_check` |
| `pg1_screening_events` | payers refused by the sanctions screen |
| `pg1_auth_events` | failed operator sign-ins and burst alerts: a count in a 10-minute slot only |
| `pg1_operator_reports`, tasks and actions | reports landed, approvals waiting |
| honeypot, firewall | reserved adapters, idle until their logs exist |

Waves: rows of the same kind, check, verdict, country and caller in one minute are one event with a count. The view polls every 5 s while open (`?since=`); the mini-view every 30 s while the page is visible. No server-sent events: a held-open Vercel function costs more than a small poll.

Country: Vercel's `x-vercel-ip-country` header at ingest. Migration `20261115120000_pg1_defense_events.sql` (additive, not run by PG1) adds `agent_telemetry.country_code` and `pg1_defense_events`. Until it runs, telemetry inserts retry once without the column and the verdict rows are dropped silently.

## The gadgets

Truth Lens (`check_agent_message`), Repo Trap Scanner (`check_repo_trap`, 1.22.0: a Trojan workspace, a booby-trapped project crate slung under a dark carrier, is sealed in a gold lattice and sinks with its reason code; only real `check_repo_trap` verdicts, never a path or file content), Sanctions Gate (`check_wallet_sanctions`, payer screening: the blast doors slam), Phishing Net (`check_hostname_reputation`, `check_domain_age`), Supply Inspector (`check_package`, at the port), Preflight Ward (`preflight_check`), Toll Bridge (x402: unpaid callers stop at the toll, payers' boats arrive and light a bollard), Seal Forge (Ed25519 signed results), Passkey Vault (operator sign-in; a burst alert slides out the blast shutter), Rate Shield (the dome thickens under floods of siege drones), Gate Wardens (probes and caller faults turned away), Keep Wall (PG1's own faults, shown honestly), Watchtower Beacons (reports and approvals), Fog Wall (no country). Reserved: Honeypot Decoys and Firewall Ramparts. The legend lists each with the real check and today's count; the text feed beside the scene lists the same events for reading and screen readers.

## Engine and performance

The Sandbox viewer's engine: the same three.js (`/vendor/three/`), its quality tiers and governor, post-processing, orbit controls and water shader. Tiers: **Phone** (no post-processing or real-time shadows: baked wall-base shading and blob shadows, low-detail instanced crowds, 30 fps), **Balanced** (soft shadows, bloom, SMAA, water shader, physical sky, 60 fps), **Cinematic** (larger shadows, ambient occlusion, light shafts, bigger crowds, 60 fps). The governor steps down when frames run slow; rendering stops while the tab is hidden. With `prefers-reduced-motion` the view is a still 2D map plus the text feed and three.js is never loaded. No third-party assets: everything is generated in code (see `/docs/attributions`).

## Record mode

**Record** makes a clip on the device (MP4 where the browser can, else WebM; nothing is uploaded): the director camera, a caption for the event on screen (gadget, check, verdict, country), the PG1 mark and the label "Real PG1 events", in 16:9 or 9:16, 30 or 60 s. **Replay last 24 h** re-stages the day's real events in their real order, compressed into the clip, labelled "Real PG1 events · last 24 h, time-lapse", each caption with its real Dublin time. A quiet period says the kingdom was calm.

## Tests

`tests/defense-feed.test.mjs`, `tests/kingdom-view.test.mjs`, `tests/browser/kingdom.browser.test.mjs` (412 px, Phone tier, reduced motion, recording, no island/wall/placeholder geometry, the shield hidden until a gadget fires; screenshots in `docs/screenshots/kingdom-city-*.png`).

## The defence side

- **PG1 Tower state** (`lib/defenseState.mjs`, the feed's `state` on full loads, cached a minute): beacon steady gold when the latest production deploy is Ready, an amber pulse when auto-merge is paused or production pinned, dim when a deploy failed, neutral when it could not be read. Emblems: the SealKeeper SEAL tier (`SEAL_TIER_RECORD`, Bronze; changes only by a reviewed edit or `PG1_SEALKEEPER_TIER`), a passkey symbol once a passkey exists, the Ed25519 seal while signing is on.
- **Guardians** (ambient, never counted or captioned): sentinel drones, one per tool in the live MCP tool list; the commander drone at the deck (lifts over a high-severity event the director focuses on, carries a landed report to a beacon); repair drones; cyan harbour pilots; embankment rovers. Every PG1 unit stays inside the city (`CITY_R`); they block, scan, catch, turn back and repair, never chase or strike back. PG1 units use gold, white and cyan; red is the other side's; allies glow green.
- **The other side**: scanner drones probing the skyline (probes, caller faults, unpaid calls), swarms (rate-limit floods), dark boats on the river (agent-message verdicts, look-alike domains, malicious packages, sanctioned payers), red rogue-signal trails (failed sign-ins), Trojan workspaces (repo-trap verdicts).
- **Allies**: lit boats to the pier (settled x402), cargo ships (paid A2A jobs), partner drones (licensed integrations, never named).
- **HUD**: "Defences active: n checks live · x threats turned away today", all from the data (threats only; no payment figures are shown anywhere). Captions pair the other side's line with PG1's answer: "<gadget> · <check>: <verdict> (<reason code>)".
- **Rooftop beacons** lit = approvals waiting. The **shield** is invisible until a gadget fires.
- **Camera**: a slow aerial flyover from the east, the river leading to the tower; the director (on by default) moves in close when an event plays and pulls back after; the camera never goes below the roofline. **Light**: Dusk (the hero look, default and always in Record mode) or the live sun over Dublin. Clips end on the tower with the day's counts and the note that countries come from IP geolocation and are approximate.

## Test fixtures (never in the app)

`tests/helpers/kingdomFixtures.mjs` builds realistic rows for the browser tests: real salted per-caller hashes of documentation-range addresses, times spread over the day, and a 402 only on a paid skill. Screenshots made from it are named `*-test-fixture.png`. `tests/kingdom-view.test.mjs` fails if anything under `public/`, `api/` or `lib/` imports it or carries a literal caller hash; the view shows "—" for a placeholder hash or a source with no caller. A 402 on a free tool (`check_package` and the other free tools) is never a Toll Gantry event.

## Live, and "real, not a simulation"

- **Live arrivals**: the view polls `/api/defense-feed?since=` every 5 s. Each new real event is staged as it lands (its attackers and the gadget's answer start at once), takes the caption "LIVE · <seconds> ago", and the director cuts to it. A burst that keeps landing grows its formation and its running count. Events already logged when the view opens are replayed first and captioned "Earlier today · <time>", never "LIVE".
- **Ticker** under the HUD: the newest live events (flag, ISO code, enemy, check, verdict). With nothing new it says "Quiet · last event <time> ago"; nothing is generated to fill a quiet period.
- **Badge**, always in view: "● LIVE · Real PG1 events — not a simulation", pulsing only while the feed answers. After two failed polls it reads "Feed paused — showing last real events" and no new animation plays. A 24 h replay clip reads "Real PG1 events — time-lapsed replay, not a simulation".
- **Countries**: a permanent counter "<flags> Hostile traffic from N countries · last 24 h" (top origins, then "+M"; N from the feed's `origins`), and each live arrival pops its flag and ISO code. The globe opening (arcs from the real origins converging on PG1 in Dublin, flags at least 24 px) plays when the view opens, then dives into the city; a mini-globe in the corner draws live arcs as events land. Flags appear on the globe, arcs, HUD, captions, ticker and feed, never on a model. No country is "fog".
- **Record mode**: the badge and the counter are in every frame; the end card reads "Real PG1 events, <date> — not a simulation · Hostile traffic from N countries in 24 h", with "Visualised live from PG1's logs. Location = traffic origin (IP geolocation), not attacker identity." and the IP geolocation note.

## The city, in detail

- **Architecture** (instanced, one facade shader): glass curtain walls with mullions and spandrel bands, stone and brick mid-rises with punched windows, low-rise blocks along the river; podiums, setbacks, tapered and twisted towers, angled glass crowns, rooftop plant, antennas, helipads, red aircraft lights.
- **Windows** are lit from inside with depth (a parallax back wall that moves with the view), warm and cool, a few switching over time. They are anti-aliased: where a pane nears a pixel the pattern blends to its average, and per-building seeds are whole numbers so interpolation can never reach the hash (that was the shimmer). The browser test measures frame noise at 70 m, 320 m and 1,300 m.
- **River**: a mirror on Cinematic, the water shader on Balanced; light streaks from the banks that ripple; wakes behind boats; stone embankments with railings and lamps; a solid arched bridge with hangers and deck lights, a smaller bridge downstream, moored boats at the pier.
- **Streets**: lane markings, traffic lights that cycle, car head and tail lights, pedestrians as light dots, trees, four parks, a lit plaza at the tower's foot.
- **Light**: a dusk sky from a warm horizon to deep blue, clouds lit on the side towards the sun, ACES tone mapping, blue-hour height fog (thicker low down), bloom, soft shadows, ambient occlusion on Balanced and Cinematic. The tower has a brighter beacon, a lit crown and a gold accent line up the spire.
- **Camera**: the hero shot runs low along the river towards the tower. The director cuts to live events and frames them from outside; every frame the camera is lifted clear of any building box on its line of sight (smoothly, but never left inside one). The tests count frames with the camera inside a building: zero.
- **Units** carry a soft glow and a light trail, sized to read at 412 px in the default view; formations follow the real counts, capped per tier.

## PG1's emblem

Built from the brand asset itself: `public/kingdom/kingdom-emblem.js` reads `/brand/pg1-shield.svg` (the shield and the "1", with their fills `#f3c623` and `#0a0a0b`) at runtime, so the emblem is never redrawn or approximated; without the file there is no emblem. On the tower's crown: the extruded, bevelled shield in brushed gold (PBR, reflects the sky), the "1" in black enamel set into it, and a thin glowing gold rim. Above the beacon at night, a slowly turning hologram with scan lines; on the glass, a soft projection. Also, sparingly: inlaid and lit in the plaza paving, on a rooftop helipad, on PG1's drones' hulls and the pilots' boats, and on the two billboards. Never on an attacker. When a gadget fires on a real event the emblem pulses once in gold; on a high-severity event it brightens and the shield's ripple starts from it.

## The city's own life (ambient)

Decoration only: never captioned, counted or shown as an event, and never in the enemy red (tail and stop lights are deep amber; rooftop lights blink warm). `public/kingdom/kingdom-life.js`: cars, taxis and buses at real scale that stop at the traffic lights; an elevated tram with lit carriages over the avenue; water taxis and ferries with wakes and moored boats rocking; aircraft blinking high on approach and birds at dusk; pedestrians as small figures, busiest round the plaza; steam from rooftop vents, a turning radar, a construction crane with a blinking light; lamp posts with warm light pools, pavements, kerbs, zebra crossings, manhole covers; fountains and benches in the plaza. Windows follow the hour in Dublin (offices lit in the evening and dimming late, homes later); ground floors spill warm shop-front light. Some days have light rain (wet, reflective roads) or mist, chosen by the Dublin date: scenery, not a weather report, and never tied to threats.

**Billboards** show only numbers from the feed: hostile countries in 24 h, threats turned away today, checks live ("not read" when missing). **Light**: real Dublin time by default; Dusk is the hero look and what Record mode uses. **Sound** is off by default: a soft city ambience, and a gentle chime when a real gadget fires.

The Phone tier keeps the emblem at full detail and thins everything else (about a third of the cars, people and boats).
