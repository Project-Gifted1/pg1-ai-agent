// PG1 Sandbox viewer: PBR detail from the CC0 textures in
// /sandbox/textures/ (scripts/make-sandbox-textures.mjs), Medium tier and up.
//
//   loadTextures(THREE)                   the five materials' maps, or null
//   applyTerrain(material, tex)           the ground: grass, sand, rock and
//                                          snow blended by a per-vertex
//                                          `splat` weight (environment.js),
//                                          each with its own normal and
//                                          roughness, over the climate
//                                          colours already in the vertices
//   addSurfaceDetail(material, tex)       buildings and vehicles: plaster
//                                          detail projected on three axes
//                                          (no texture coordinates needed)
//
// The textures change brightness, bumps and roughness around their own
// average, so the colours of the world stay as they are. Detail fades with
// distance, where it would only shimmer. Both hooks chain onto any
// onBeforeCompile already set, so set up cascaded shadows first (their
// setupMaterial replaces it).

const NAMES = ['grass', 'sand', 'rock', 'snow', 'plaster'];

export async function loadTextures(THREE, base = '/sandbox/textures/') {
  const loader = new THREE.TextureLoader();
  const load = (url, srgb) => new Promise((resolve, reject) => loader.load(url, (t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    resolve(t);
  }, undefined, reject));
  try {
    const out = {};
    await Promise.all(NAMES.map(async (n) => { out[n] = { albedo: await load(`${base}${n}_albedo.png`, true), nr: await load(`${base}${n}_nr.png`, false) }; }));
    return out;
  } catch (e) { return null; }
}

function chain(material, fn, key) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => { if (prev) prev.call(material, shader, renderer); fn(shader); };
  const prevKey = material.customProgramCacheKey ? material.customProgramCacheKey.bind(material) : () => '';
  material.customProgramCacheKey = () => `${prevKey()}|${key}`;
  material.needsUpdate = true;
  return material;
}

const VARYINGS = `
varying vec3 vPgWorld;
varying vec3 vPgWorldNormal;`;

function withWorld(shader, extraVert = '') {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>${VARYINGS}${extraVert}`)
    .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
      vec4 pgWp = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        pgWp = instanceMatrix * pgWp;
      #endif
      pgWp = modelMatrix * pgWp;
      vPgWorld = pgWp.xyz;
      vPgWorldNormal = normalize(mat3(modelMatrix) * objectNormal);`);
}

// The ground (a MeshStandardMaterial with vertex colours).
export function applyTerrain(m, tex) {
  if (!tex || !m || m.userData.pgTerrain) return m;
  m.userData.pgTerrain = true;
  const u = {
    pgA0: { value: tex.grass.albedo }, pgN0: { value: tex.grass.nr },
    pgA1: { value: tex.sand.albedo }, pgN1: { value: tex.sand.nr },
    pgA2: { value: tex.rock.albedo }, pgN2: { value: tex.rock.nr },
    pgA3: { value: tex.snow.albedo }, pgN3: { value: tex.snow.nr }
  };
  return chain(m, (shader) => {
    Object.assign(shader.uniforms, u);
    withWorld(shader, '\nattribute vec4 splat;\nvarying vec4 vPgSplat;');
    shader.vertexShader = shader.vertexShader.replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n      vPgSplat = splat;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>${VARYINGS}
varying vec4 vPgSplat;
uniform sampler2D pgA0; uniform sampler2D pgN0; uniform sampler2D pgA1; uniform sampler2D pgN1;
uniform sampler2D pgA2; uniform sampler2D pgN2; uniform sampler2D pgA3; uniform sampler2D pgN3;
float pgLum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
// One layer: brightness around its own average (the smallest mip), the bumps, the roughness.
void pgLayer(sampler2D a, sampler2D nr, vec2 uv, float w, inout float lum, inout vec2 bump, inout float rough) {
  if (w <= 0.001) return;
  float l = pgLum(texture2D(a, uv).rgb) / max(0.05, pgLum(textureLod(a, uv, 12.0).rgb));
  vec3 t = texture2D(nr, uv).rgb;
  lum += l * w; bump += (t.xy * 2.0 - 1.0) * w; rough += t.z * w;
}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
  vec4 pgW = vPgSplat / max(0.001, vPgSplat.x + vPgSplat.y + vPgSplat.z + vPgSplat.w);
  float pgDist = distance(cameraPosition, vPgWorld);
  float pgFade = 1.0 - smoothstep(250.0, 2600.0, pgDist);
  float pgL = 0.0; vec2 pgBump = vec2(0.0); float pgRough = 0.0;
  pgLayer(pgA0, pgN0, vPgWorld.xz / 4.0, pgW.x, pgL, pgBump, pgRough);
  pgLayer(pgA1, pgN1, vPgWorld.xz / 6.0, pgW.y, pgL, pgBump, pgRough);
  pgLayer(pgA2, pgN2, vPgWorld.xz / 11.0, pgW.z, pgL, pgBump, pgRough);
  pgLayer(pgA3, pgN3, vPgWorld.xz / 8.0, pgW.w, pgL, pgBump, pgRough);
  diffuseColor.rgb *= mix(1.0, pgL, 0.85 * pgFade);`)
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = mix(0.95, pgRough, pgFade);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
  normal = normalize(normal + (viewMatrix * vec4(pgBump.x, 0.0, pgBump.y, 0.0)).xyz * 0.9 * pgFade);`);
  }, 'pg-terrain');
}

// Buildings and vehicles: plaster detail, projected along whichever axis faces most.
export function addSurfaceDetail(material, tex, { strength = 0.5, scale = 2.5 } = {}) {
  if (!tex || !material || material.userData.pgDetail) return material;
  material.userData.pgDetail = true;
  const u = { pgPa: { value: tex.plaster.albedo }, pgPn: { value: tex.plaster.nr } };
  return chain(material, (shader) => {
    Object.assign(shader.uniforms, u);
    withWorld(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>${VARYINGS}
uniform sampler2D pgPa; uniform sampler2D pgPn;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
  vec3 pgB = pow(abs(normalize(vPgWorldNormal)), vec3(4.0)); pgB /= (pgB.x + pgB.y + pgB.z + 1e-4);
  vec2 pgUx = vPgWorld.zy / ${scale.toFixed(2)}; vec2 pgUy = vPgWorld.xz / ${scale.toFixed(2)}; vec2 pgUz = vPgWorld.xy / ${scale.toFixed(2)};
  float pgFade = 1.0 - smoothstep(60.0, 700.0, distance(cameraPosition, vPgWorld));
  float pgMean = dot(textureLod(pgPa, vec2(0.5), 12.0).rgb, vec3(0.299, 0.587, 0.114));
  float pgL = (dot(texture2D(pgPa, pgUx).rgb, vec3(0.299, 0.587, 0.114)) * pgB.x + dot(texture2D(pgPa, pgUy).rgb, vec3(0.299, 0.587, 0.114)) * pgB.y + dot(texture2D(pgPa, pgUz).rgb, vec3(0.299, 0.587, 0.114)) * pgB.z) / max(0.05, pgMean);
  vec3 pgT = texture2D(pgPn, pgUx).rgb * pgB.x + texture2D(pgPn, pgUy).rgb * pgB.y + texture2D(pgPn, pgUz).rgb * pgB.z;
  diffuseColor.rgb *= mix(1.0, pgL, ${strength.toFixed(2)} * pgFade);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
  roughnessFactor = clamp(roughnessFactor * mix(1.0, 0.6 + pgT.z * 0.6, pgFade), 0.04, 1.0);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
  vec2 pgD = (pgT.xy * 2.0 - 1.0) * 0.35 * pgFade;
  normal = normalize(normal + (viewMatrix * vec4(pgD.x * (pgB.y + pgB.z), pgD.y * (pgB.x + pgB.z), pgD.x * pgB.x + pgD.y * pgB.y, 0.0)).xyz);`);
  }, `pg-detail-${strength}-${scale}`);
}
