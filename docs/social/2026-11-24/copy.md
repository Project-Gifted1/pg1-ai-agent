# Inside PG1 City · 24 November 2026

Built by `scripts/social-inside-city.mjs` from the Showcase render (`scripts/showcase-render.mjs --reel inside-city`: desktop profile, showcase quality, render scale 1.0, no UI overlays, no clock or debug labels).

## Data

- **Window:** the defence feed's last 7 days, read only, up to 2026-11-24T00:14:54.000Z (UTC).
- **Events:** real PG1 events, last 7 days to 2026-11-24T00:14:54.000Z (212 shown of 215; payments and caller hashes left out).
- **Counts shown:** probes and checks from 12 countries (CA, CZ, DE, FI, FR, GB, HK, IL, KR, NL, RU, US), events dated 20 Nov, 23:47 to 23 Nov, 23:36. Countries come from IP geolocation and are approximate. No payment figure is shown anywhere.
- **Weather:** Dublin, recorded (Open-Meteo archive (ERA5 reanalysis)): 2026-11-23T05:00 51 (rain) then 2026-11-23T06:00 3 (clearing), Europe/Dublin time. Weather data by Open-Meteo.com (CC BY 4.0). Not live.
- **Privacy:** no caller hash, IP or anything identifying a caller is in the renders, the reel or this file.

## Reel (`reel-1080x1920.mp4`)

Download: [reel-1080x1920.mp4](https://github.com/Project-Gifted1/pg1-ai-agent/releases/download/social-2026-11-24/reel-1080x1920.mp4) (release asset `social-2026-11-24`; the MP4 is kept out of git).

24.2 s, 1080 x 1920, H.264 (libx264 -preset veryfast -crf 18), yuv420p, 30 fps, 0.2 s crossfades, no audio.

6 shots in this order; each lower third is on screen for the whole shot, the first from the first frame. No city or place name in any caption or label.

| Shot | Lower third | In the reel | Real data replayed |
|---|---|---|---|
| The crown tower | "A city built from real AI-agent activity" | 4.2 s | none (no event staged) |
| A real probe arrives | "212 real events in 7 days" | 4.2 s | probe US Gate Wardens: malformed call (23 Nov, 23:36) |
| The river and the arched bridge | "One week, replayed as it happened" | 4.2 s | none (no event staged) |
| Patrols meet real probes | "Probes and checks from 12 countries" | 4.2 s | check verdict DE Truth Lens: malicious (23 Nov, 12:16); check verdict US Repo Trap Scanner: malicious (21 Nov, 00:28); probe DE Gate Wardens: unknown method probe (23 Nov, 22:35); report Watchtower Beacons: report landed (23 Nov, 07:30) |
| Recorded weather | "Real weather, real time of day" | 4.2 s | recorded weather 2026-11-23T05:00 → 2026-11-23T06:00 |
| The whole city | "Free checks for AI agents · Link in bio" | 4.2 s | check verdict DE Truth Lens: malicious (23 Nov, 12:16); check verdict US Repo Trap Scanner: malicious (21 Nov, 00:28); probe DE Gate Wardens: unknown method probe (23 Nov, 22:35); report Watchtower Beacons: report landed (23 Nov, 07:30) |

Rendered for the carousel only (not in the reel): a result is signed, lane traffic at a junction, street level in the plaza, the tram line by day, the city by day, day to night.

## Post captions (ready to paste)

### Instagram / TikTok

One week of real AI-agent activity, rendered as a city.

212 events from 12 countries: every probe and check PG1 logged, replayed as it happened.

PG1 checks AI agents before they act. Free for agents and developers. Link in bio.

#AIagents #AIsecurity #MCP #DevTools

### X (link in the first reply)

One week of real AI-agent activity, rendered as a city.

212 events. 12 countries. Every probe and check PG1 logged, replayed as it happened.

PG1 checks AI agents before they act. Free for developers.

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

### 4. Signed results you can check · Signed results

When PG1 signs a tool result (Ed25519), the Seal Forge stamps a seal that rises into the tower. Anyone can check a result offline with PG1's public key, or with verify_result.

_Image: the "city-day" shot._

**Note:** The Seal Forge: public/kingdom/kingdom-actors.js (stageKingdom, case seal_forge) on signed_result events (lib/defenseFeed.mjs, while signing is on); signing is Ed25519 (lib/signing.mjs) and verify_result checks a result against PG1's public key.

### 5. Lanes, rain and real weather · Traffic and weather

Cars keep to their lanes, queue at red lights and clear on green. The sky follows the real weather and time of day; in rain the streets turn wet and mirror the lights.

_Image: the "junction-traffic" shot._

**Note:** Traffic: public/kingdom/kingdom-traffic.js (lanes, signal phases per junction, queues at the stop line). Weather: lib/cityWeather.mjs (Open-Meteo, Dublin, the sky only, never an event) and public/kingdom/kingdom-weather.js and kingdom-wet.js (rain, wet streets). The reel's weather shot replays Dublin's recorded hourly weather, dated below.

### 6. The river and the patrols · River and drones

Boats pass under the arched bridge, with lamp pools along the promenade. PG1's drones patrol in rings round the tower, one for each live check, with navigation lights at night.

_Image: the "drone-patrol" shot._

**Note:** The river, bridges and promenade lamps: public/kingdom/kingdom-world.js; river life: public/kingdom/kingdom-life.js. Drones: public/kingdom/kingdom-actors.js (sentinels, one per live check from the MCP tool list; lit bodies, nav lights, strobe and night underglow since 23 Nov).

### 7. Link in bio

Free checks for AI agents.

Story: `story-1080x1920.png` (the cover at 1080 x 1920). Footer on every slide: Project-Gifted1™.
