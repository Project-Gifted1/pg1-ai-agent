# Inside PG1 City · 24 November 2026

Built by `scripts/social-inside-city.mjs` from the Showcase render (`scripts/showcase-render.mjs --reel inside-city`: desktop profile, showcase quality, render scale 1.0, no UI overlays, no clock or debug labels).

## Data

- **Window:** the defence feed's last 7 days, read only, up to 2026-11-24T00:14:54.000Z (UTC).
- **Events:** real PG1 events, last 7 days to 2026-11-24T00:14:54.000Z (213 shown of 216; payments and caller hashes left out).
- **Counts shown:** probes and checks from 12 countries (CA, CZ, DE, FI, FR, GB, HK, IL, KR, NL, RU, US), events dated 20 Nov, 23:47 to 23 Nov, 23:36. Countries come from IP geolocation and are approximate. No payment figure is shown anywhere.
- **Weather:** Dublin, recorded (Open-Meteo archive (ERA5 reanalysis)): 2026-11-23T05:00 51 (rain) then 2026-11-23T06:00 3 (clearing), Europe/Dublin time. Weather data by Open-Meteo.com (CC BY 4.0). Not live.
- **Privacy:** no caller hash, IP or anything identifying a caller is in the renders, the reel or this file.

## Reel (`reel-1080x1920.mp4`)

30.0 s, 1080 x 1920, H.264 (libx264 -preset veryfast -crf 18), yuv420p, 30 fps, 0.5 s crossfades, no audio.

| Shot | Lower third | In the reel | Real data replayed |
|---|---|---|---|
| The crown tower | "Every event is real" | 3.2 s | none (no event staged) |
| A real probe arrives | "Probes from 12 countries" | 3.2 s | probe US mcp_router MALFORMED_REQUEST (23 Nov, 23:36) |
| A result is signed | left out: no real signed result in the last 7 days | - | none (no event staged) |
| Lane traffic at a junction | "Traffic keeps its lanes" | 3.2 s | none (no event staged) |
| The river and the arched bridge | "Boats on the river" | 3.2 s | none (no event staged) |
| Patrols meet real probes | "Patrols meet real probes" | 3.2 s | check_verdict DE check_agent_message malicious (23 Nov, 12:16); check_verdict US check_repo_trap malicious (21 Nov, 00:28); approval operator_task NEEDS_APPROVAL (23 Nov, 07:30); probe DE mcp_router UNKNOWN_METHOD (23 Nov, 22:35) |
| Real Dublin weather | "Real Dublin weather" | 3.2 s | recorded weather 2026-11-23T05:00 → 2026-11-23T06:00 |
| Street level in the plaza | "People in the plaza" | 3.2 s | none (no event staged) |
| The tram line by day | "Trams on the line" | 3.2 s | none (no event staged) |
| The city by day | "The city by day" | 3.2 s | none (no event staged) |
| Day to night | "Windows follow Dublin time" | 3.2 s | none (no event staged) |
| Director mode | left out: cut in the edit: its follow camera ends in a dark close-up on the river; the whole-city shot replays the same director events | - | none (no event staged) |
| The whole city | "Inside PG1 City" | 3.2 s | check_verdict DE check_agent_message malicious (23 Nov, 12:16); check_verdict US check_repo_trap malicious (21 Nov, 00:28); approval operator_task NEEDS_APPROVAL (23 Nov, 07:30); probe DE mcp_router UNKNOWN_METHOD (23 Nov, 22:35) |

## Post caption (ready to paste)

Inside PG1 City: a live 3D city drawn from PG1's real activity. 213 real events in 7 days (17 Nov–24 Nov 2026), with probes and checks from 12 countries, replayed as they happened. Boats, trams, traffic and Dublin's recorded weather fill in the rest; every event in it is real.

Free checks for AI agents: link in bio.

Project-Gifted1™

## Carousel (1080 x 1350) and Story

### 1. Inside PG1 City · 24 November 2026

A tour of the live 3D city that shows PG1's real activity: probes, checks and signed results. Every event in it is real.

_Image: the "city-wide" shot._

### 2. The PG1 shield · The crown tower

The tallest tower carries PG1's shield, drawn from the brand file itself. Its beacons follow PG1's real state: one lights when a report lands, and one stays lit for each approval waiting.

_Image: the "crown-tower" shot._

**Note:** The crown tower and its shield: public/kingdom/kingdom-world.js (the tower, emblemY) and public/kingdom/kingdom-emblem.js (the shield read from /brand/pg1-shield.svg at runtime). Beacons: lib/defenseState.mjs and the beacons gadget in lib/defenseFeed.mjs (report landed, approvals waiting).

### 3. Real probes and checks · From 12 countries · 17 Nov–24 Nov

Every arrival is one event PG1 logged: unknown tools and methods, malformed calls, flagged checks. Its origin country shows as a flag and an arc on the mini-globe, and the Gate Wardens turn probes back.

_Image: the "probe-arrives" shot._

**Note:** Real events: lib/defenseFeed.mjs reads PG1's own logs (agent_telemetry, pg1_defense_events and more), groups them into waves and never carries an IP; the reel replays them read only (scripts/showcase-render.mjs --reel). Flags and arcs: public/kingdom/kingdom-globe.js and kingdom-data.js flagOf. Gate Wardens: the gate_wardens gadget (unknown-tool and unknown-method probes, malformed calls). Countries come from IP geolocation at the network edge and are approximate.

### 4. Every result signed · Signed results

When PG1 signs a tool result (Ed25519), the Seal Forge stamps a seal that rises into the tower. Anyone can check a result offline with PG1's public key, or with verify_result.

_Image: the "city-day" shot._

**Note:** The Seal Forge: public/kingdom/kingdom-actors.js (stageKingdom, case seal_forge) on signed_result events (lib/defenseFeed.mjs, while signing is on); signing is Ed25519 (lib/signing.mjs) and verify_result checks a result against PG1's public key.

### 5. Lanes, rain and real weather · Traffic and weather

Cars keep to their lanes, queue at red lights and clear on green. The sky follows Dublin's real weather and time of day; in rain the streets turn wet and mirror the lights.

_Image: the "junction-traffic" shot._

**Note:** Traffic: public/kingdom/kingdom-traffic.js (lanes, signal phases per junction, queues at the stop line). Weather: lib/cityWeather.mjs (Open-Meteo, Dublin, the sky only, never an event) and public/kingdom/kingdom-weather.js and kingdom-wet.js (rain, wet streets). The reel's weather shot replays Dublin's recorded hourly weather, dated below.

### 6. The river and the patrols · River and drones

Boats pass under the arched bridge, with lamp pools along the promenade. PG1's drones patrol in rings round the tower, one for each live check, with navigation lights at night.

_Image: the "drone-patrol" shot._

**Note:** The river, bridges and promenade lamps: public/kingdom/kingdom-world.js; river life: public/kingdom/kingdom-life.js. Drones: public/kingdom/kingdom-actors.js (sentinels, one per live check from the MCP tool list; lit bodies, nav lights, strobe and night underglow since 23 Nov).

### 7. Link in bio

Free checks for AI agents.

Story: `story-1080x1920.png` (the cover at 1080 x 1920). Footer on every slide: Project-Gifted1™.
