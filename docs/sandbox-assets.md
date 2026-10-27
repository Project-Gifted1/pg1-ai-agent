# Sandbox viewer: assets and licences

Every model, texture and effect the Sandbox viewer draws is made in code or
comes from three.js. Nothing is downloaded from a model or texture library,
so there are no third-party asset licences to track and no download size
beyond the code itself.

| What | Where | Made how | Licence |
|---|---|---|---|
| Every kind's model (people, houses, towers, cars, buses, bikes, planes, boats, …) | `public/sandbox/models.js`, `kit.js` | primitives in code, merged per model | this repository's |
| Period models (benin-warri template, when merged) | `public/sandbox/period-models.js` | primitives in code | this repository's |
| Streets: asphalt, markings, kerbs, pavements, crossings, street lamps | `public/sandbox/streets.js` | geometry in code from the road data | this repository's |
| Coasts: rocks, stones, surf | `public/sandbox/coast.js` | instanced primitives, a canvas gradient | this repository's |
| Close-up grass and flowers | `public/sandbox/foliage.js` | blades made in code, wind in the shader | this repository's |
| Ground, plaster and paint textures | `public/sandbox/textures/` | `scripts/make-sandbox-textures.mjs` (seeded noise) | CC0 1.0 (see the folder's LICENSE.txt) |
| Water normals, pools of lamplight, star field, planet surfaces | `environment.js`, `streets.js`, `sandbox-scene.js` | canvas, in the browser | this repository's |
| Sky (Preetham), cascaded shadows, post-processing (GTAO, bloom, SMAA, TAA, depth of field), mirror reflection | `public/vendor/three/addons/` | three.js r180 add-ons, unchanged but for the import path | MIT (`public/vendor/three/LICENSE.txt`) |

Added in this change: `postprocessing/BokehPass.js`, `shaders/BokehShader.js`
and `objects/Reflector.js` from three.js r180 (npm package `three@0.180.0`),
with `from 'three'` pointed at `../../three.module.min.js` like the other add-ons.

Size: the viewer's own code and the textures are well under 15 MB.

Why no downloaded CC0 models: the build machine for this change could not
reach the asset libraries (Poly Haven, Kenney, and the like), and models made
in code stay small, load instantly on a phone and can be changed with the
code. If downloaded CC0 models are wanted later, each one goes in this table
with its source URL and licence.
