# Asset licences

Assets in `public/showcase/` are used by the offline Showcase render only
(`docs/showcase.md`). Every one is CC0 (public domain dedication) or PG1's
own work released CC0. Nothing else may be added here.

## HDRIs (`public/showcase/hdri/`, 1k Radiance .hdr)

| File | Source | Author | Licence | Used for |
| --- | --- | --- | --- | --- |
| `modern_buildings_night.hdr` | Poly Haven, "Modern Buildings Night" | Poly Haven | CC0 1.0 | PG1 City at night and in the rain: light and reflections |
| `misty_dawn.hdr` | Poly Haven, "Misty Dawn" | Poly Haven | CC0 1.0 | Benin–Warri c. 1610 at dawn; dawn in the Universe |
| `kloofendal_48d_partly_cloudy_puresky.hdr` | Poly Haven, "Kloofendal 48d Partly Cloudy (Pure Sky)" | Poly Haven | CC0 1.0 | daytime in the Universe |

## Textures (`public/showcase/textures/`, 1k JPEG; normal and roughness maps only)

| Files | Source | Licence | Used for |
| --- | --- | --- | --- |
| `asphalt_02_nor_gl.jpg`, `asphalt_02_rough.jpg` | Poly Haven, "Asphalt 02" | CC0 1.0 | rain-wet streets: ripples and puddles |
| `concrete_tile_facade_nor_gl.jpg`, `concrete_tile_facade_rough.jpg` | Poly Haven, "Concrete Tile Facade" | CC0 1.0 | masonry relief on City facades |

Poly Haven's licence: every asset is CC0, https://polyhaven.com/license.

## Models (`public/showcase/models/`, GLB, each under 2 MB)

| File | Size | Source | Licence |
| --- | --- | --- | --- |
| `canoe.glb` | 1.3 MB | PG1, authored in code (`scripts/build-showcase-models.mjs`): a carved dugout canoe with three paddlers in wrappers with leaf-bladed paddles, and cargo (a basket of fish, salt cakes, a coiled net), wood grain drawn in code | PG1 original, CC0 1.0 |
| `car.glb` | 0.09 MB | PG1, authored in code (same script): a saloon car body, glass and wheels | PG1 original, CC0 1.0 |

Not added: a European ship. The only CC0 ship found (Poly Haven "Dutch Ship
Medium") is about 9 MB at its smallest, over the 2 MB limit, and no
showcase shot shows a ship. No drone model either: PG1 City's drones are a
few pixels in every shot, so their own geometry stays.

## Code

`public/vendor/three/addons/loaders/GLTFLoader.js`, `loaders/HDRLoader.js`,
`utils/BufferGeometryUtils.js` and `exporters/GLTFExporter.js` are three.js
r180's own add-ons (MIT, `public/vendor/three/LICENSE.txt`), with their
`three` import pointed at the vendored build.
