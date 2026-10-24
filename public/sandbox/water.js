// PG1 Sandbox viewer: the water shader (High and Ultra; quality.js).
//
// No mirror pass (that would draw the whole scene a second time each
// frame): two layers of wave normals scroll across each other, the surface
// reflects the sky's own colours by the Fresnel term, the sun leaves a
// glitter path, and the colour runs from turquoise over the shallows to
// deep blue, with foam where the sea meets an island. The shallows and the
// shore come from the islands' shapes (centre and radius), the same ones
// the terrain is built from, so nothing has to be baked or downloaded.

const MAX_ISLANDS = 12;

const VERT = `
varying vec3 vWorld;
#include <fog_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = `
uniform sampler2D uNormals;
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform float uIslands[${MAX_ISLANDS * 3}];
uniform int uIslandCount;
uniform float uFoam;
varying vec3 vWorld;
#include <fog_pars_fragment>
float shoreEdge(vec2 p) {
  float best = -1e9;
  for (int i = 0; i < ${MAX_ISLANDS}; i++) {
    if (i >= uIslandCount) break;
    vec2 c = vec2(uIslands[i * 3], uIslands[i * 3 + 1]);
    float rr = uIslands[i * 3 + 2];
    float d = distance(p, c);
    // An island (r > 0) is land inside its circle; a lake (r < 0) is water inside.
    best = max(best, rr >= 0.0 ? rr - d : d + rr);
  }
  return best; // > 0 on land, < 0 at sea: metres from the coast
}
void main() {
  vec2 uv = vWorld.xz;
  vec3 n1 = texture2D(uNormals, uv / 38.0 + vec2(uTime * 0.012, uTime * 0.007)).xyz * 2.0 - 1.0;
  vec3 n2 = texture2D(uNormals, uv / 11.0 - vec2(uTime * 0.021, -uTime * 0.017)).xyz * 2.0 - 1.0;
  vec3 n = normalize(vec3(n1.x + n2.x * 0.6, 3.2, n1.y + n2.y * 0.6));
  vec3 v = normalize(cameraPosition - vWorld);
  float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  vec3 r = reflect(-v, n);
  vec3 sky = mix(uHorizon, uZenith, pow(clamp(r.y, 0.0, 1.0), 0.5));
  float spec = pow(max(dot(r, normalize(uSunDir)), 0.0), 220.0) * 3.0 + pow(max(dot(r, normalize(uSunDir)), 0.0), 24.0) * 0.12;
  float edge = shoreEdge(uv);
  float shallow = smoothstep(-180.0, -8.0, edge);
  vec3 body = mix(uDeep, uShallow, shallow * 0.85);
  vec3 col = mix(body, sky, fres) + uSunColor * spec * step(0.0, uSunDir.y);
  // Foam: a broken band along the coast.
  float foamBand = smoothstep(-26.0, -4.0, edge) * (1.0 - smoothstep(-4.0, 1.0, edge));
  float foamNoise = texture2D(uNormals, uv / 6.0 + vec2(uTime * 0.03, 0.0)).r;
  col = mix(col, vec3(0.92, 0.95, 0.97) * (0.35 + 0.65 * max(uSunColor.r, 0.2)), foamBand * smoothstep(0.42, 0.62, foamNoise) * uFoam);
  gl_FragColor = vec4(col, 0.94);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

// islands: [{ sx, sz, r }] in scene coordinates; a lake is one circle with r < 0.
export function createWaterMaterial(THREE, normals, islands = []) {
  const flat = new Float32Array(MAX_ISLANDS * 3);
  islands.slice(0, MAX_ISLANDS).forEach((i, k) => { flat[k * 3] = i.sx; flat[k * 3 + 1] = i.sz; flat[k * 3 + 2] = i.r; });
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    uNormals: { value: normals }, uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0.3, 0.8, 0.2) }, uSunColor: { value: new THREE.Color(1, 0.96, 0.9) },
    uZenith: { value: new THREE.Color('#2a6fd6') }, uHorizon: { value: new THREE.Color('#bcd9f2') },
    uDeep: { value: new THREE.Color('#0b3550') }, uShallow: { value: new THREE.Color('#2bb3b1') },
    uIslands: { value: Array.from(flat) }, uIslandCount: { value: Math.min(MAX_ISLANDS, islands.length) }, uFoam: { value: 1 }
  }]);
  uniforms.uNormals.value = normals;
  const m = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms, transparent: true, fog: true, depthWrite: true });
  m.userData.water = true;
  return m;
}
