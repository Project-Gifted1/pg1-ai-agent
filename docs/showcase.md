# PG1 Showcase render

Art-directed, offline renders of PG1 City and PG1 Universe: one hero subject
a shot, a scripted camera, depth of field on the hero, night or dawn light,
weather where it helps. Not real time: each frame takes as long as it needs.

## Running it

**On GitHub:** Actions → **PG1 Showcase render** → **Run workflow**
(`.github/workflows/showcase.yml`). Inputs: the shots, the frame size
(`1080x1920` vertical by default), whether to read PG1's real data (read
only), and whether to build the post visuals too. The run's artifact holds
an MP4 and a PNG still for each shot and `manifest.json`. GitHub's runners
have no GPU, so the frames are drawn in software, one shot per core; the
full set takes a few hours.

**Locally** (Chromium from `npx playwright install chromium`, and ffmpeg):

```sh
node scripts/showcase-render.mjs --jobs 4 --out showcase-out
node scripts/showcase-render.mjs --shots city-night --size 1920x1080 --gpu
node scripts/social-build.mjs --from showcase-out --out docs/social/2026-11
```

Options: `--shots`, `--size WxH`, `--frames N` (fewer frames, for a look),
`--warmup N` (settle frames before the first saved one), `--jobs N`,
`--gpu` (use this computer's GPU instead of software 3D), `--keep-frames`.

## The shots (`lib/showcase/shots.mjs`)

| Shot | Scene | Move |
| --- | --- | --- |
| `city-night` | PG1 City, 23:10 in Dublin | dolly and crane up along the river to the tower: drones, lamp pools, the beacons PG1's real state lights |
| `city-rain` | PG1 City, Dublin rain at night | drifting orbit over the river: traffic in its lanes, the wet streets and the tower's reflection |
| `first-universe` | PG1's first universe (`aba0e1ed-…`) | descent from orbit to a town square |
| `benin-warri` | Benin–Warri c. 1610, step 0 (dawn), light mist | from a canoe on the river, a crane up and push in to the walls of Benin and a gate |
| `deep-space` | the universe's planets | slow orbit and push-in on a planet, its star beyond |

## How a frame is made (`scripts/showcase-render.mjs`)

1. The script serves `public/` on 127.0.0.1 with two bare pages: the City's
   scene or the Sandbox viewer's scene, created with `showcase: true` on a
   desktop viewport (no touch, fine pointer). No app overlays; the
   Sandbox's "Simulation · day · time" stamp stays in the frame.
2. The page's clock is virtual: `requestAnimationFrame`, `performance.now()`
   and `Date.now()` move only when the script steps them, exactly 1000/30 ms
   a frame (the viewer's recorder rate, `public/sandbox/capture.js`).
3. Each frame: the camera's pose for that moment is set
   (`setShowcasePose`), the clock steps, the frame is saved as a PNG.
4. ffmpeg: `-c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p`.

## The Showcase profile (`public/sandbox/quality.js`)

`SHOWCASE_SETTINGS`: Cinematic plus 32 ambient-occlusion samples, four
4096 shadow cascades, the planar water mirror, full foliage, the longest
full-detail distance, depth of field, and temporal AA settled on every frame
(16 jittered samples, never accumulated across frames, so a moving camera is
as clean as a still one). The City's version is `kingdomShowcaseSettings`.

It is not one of the tiers: Auto, the probe, the governor, `?quality=` and
the Quality menu can never choose it, and on a phone (coarse pointer) it is
refused and the ordinary tier is kept (`tests/showcase.test.mjs`).

## Data: read only, real only

- **PG1 City:** with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` set, the
  last 24 hours of real events and PG1's real state (beacons, emblems)
  through `lib/defenseFeed.mjs` and `lib/defenseState.mjs`. Nothing is staged
  for a shot; without the database the City is calm. Payments never appear:
  no payment events, no toll gantry, billboards with the mark only.
- **First universe:** read through a store that throws on every write, so it
  is never stepped, reset or changed. Without the database it cannot be
  read; the shot then shows a new world made in memory from the universe
  template, and `manifest.json` says so.
- **Benin–Warri c. 1610** and **deep space**: worlds made in memory from
  their templates; period-correct (canoes, earthworks and gates, the river).

CI runs only a 2-frame smoke test (`tests/browser/showcase-smoke.browser.test.mjs`).
