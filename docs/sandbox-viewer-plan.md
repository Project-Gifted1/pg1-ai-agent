# Sandbox viewer: the high-quality spec, what is in and what is left

The PR F prompt asked for a high-quality 3D viewer. The Sandbox PR ships a working viewer. **This follow-up pull request tracks everything else. Nothing below marked "left" is done.**

## In the Sandbox PR already

| part | what ships | how it falls short of the spec |
|---|---|---|
| Tone mapping | ACES filmic (`renderer.toneMapping = THREE.ACESFilmicToneMapping`), exposure raised in space | none |
| Sky and sun | a sky shader with the sun's height and colour from the time of day (`day_steps`), stars, moonlight | a gradient shader, **not** a physically based sky |
| Shadows | one sun shadow map, PCF soft, on fine pointers (off on phones) | **not** cascaded |
| Terrain | island heights, beaches, seabed, a canvas-generated detail texture, climate colours, grass and trees | procedural, not CC0 PBR textures |
| Water | a sea plane with its own material | **not** a water shader (no waves, reflection or refraction) |
| Models | procedural models for every catalogue kind, merged per layer and batched (up to 1,000 entities) | flat colours, not PBR materials |
| Cameras | tour, overview, follow (locked to the selected thing) and space views; a minimap | no cinematic camera |
| Inspector | a selected thing's kind, id and properties; a person's name, age, job, partner and what they are saying | no creator, when, intent or edit history |
| Labels | names, and speech above the people talking (**Names**); see into buildings (**See inside**) | none |
| Fallback | a 2D map with reduced motion or without WebGL | none |

## Left (this pull request)

### Physics
- [ ] **Deterministic rigid-body physics** with `@dimforge/rapier3d-deterministic`:
  - pinned to `0.21.0`; licence checked: **Apache-2.0**, 5.0 MB unpacked (the `-compat` build inlines the WebAssembly at 15 MB, too large for the first-frame budget);
  - the WebAssembly vendored under `/vendor/rapier/` (the CSP allows only self scripts);
  - the server engine stays authoritative; the viewer replays from the world seed.
- [ ] **Materials** (friction, restitution, density per catalogue class), **joints** (hinges for doors and bridges, fixed joints for structures) and **collapse** (a structure whose supports are removed falls, deterministically).

### Rendering
- [ ] **PBR materials:**
  - with CC0 textures checked into the repository (source and licence recorded for each, e.g. ambientCG or Poly Haven);
  - albedo, normal and roughness/metalness packed;
  - KTX2 or WebP within the first-frame budget.
- [ ] **A physically based sky** (Preetham or Hillaire) with the sun from the time of day.
- [ ] **Cascaded soft shadows** (three cascades at High, two at Medium, none at Low).
- [ ] **A water shader:** waves, Fresnel reflection, depth colour, foam at the shore.
- [ ] **Textured terrain:** splatting by height and slope with the CC0 set.
- [ ] **Post-processing:**
  - SMAA (and TAA at Ultra);
  - SSAO (High and above);
  - subtle bloom (sun, lamps, glows at night).
- [ ] **Adaptive quality tiers:**
  - **Ultra / High / Medium / Low**, picked from the device and lowered automatically when frame time stays over budget;
  - a manual override in the viewer.
- [ ] **Performance targets:**
  - 60 fps at High on a Pixel 9a with 500 bodies;
  - first frame within 15 MB transferred;
  - both measured and recorded in this PR (Playwright with CPU throttling, plus a real-device run). Neither is claimed until measured.

### Tools for watching
- [ ] **Builders panel:** every agent that built something in the world, with counts.
- [ ] **Colour by builder** and a **per-agent filter**.
  - Each entity's creator comes from the black box: the long chain's `add_entity` and `update_entity` records.
- [ ] **Object inspector:** creator, when, intent (the agent's stated reason, where given) and edit history, read from the black box.
- [ ] **Time-lapse replay:**
  - from the world's seed and its recorded steps, at any speed;
  - with a cinematic camera (spline paths between points of interest).
- [ ] **Photo mode:** hide the interface, free camera, depth of field, save a PNG.

## How this pull request will be checked

- The browser tests at 380 px with screenshots for each tier.
- A performance test that fails on a first frame over 15 MB or on High under 60 fps in the throttled profile.
- Determinism: the same seed gives the same physics positions after N steps, in the browser and in Node.
- A licence file listing every vendored library and texture with its source.
