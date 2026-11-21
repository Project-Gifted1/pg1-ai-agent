// PG1 Showcase look: what only the offline Showcase profile draws
// (quality.js SHOWCASE_SETTINGS). Never loaded by a phone tier or by Auto:
// the scenes import it only when showcase is on, so the live tiers keep their
// cost.
//
//   loadHdri(THREE, renderer, name)        a CC0 HDRI (public/showcase/hdri/) as
//                                          a prefiltered environment map
//   loadPbr(THREE, name, repeat)           a CC0 PBR set (public/showcase/textures/):
//                                          { normalMap, roughnessMap }
//   GRADES, gradeShader(mood)              the colour grade: lift / gain split
//                                          toning (teal and orange at night,
//                                          warm at dawn), contrast, saturation,
//                                          vignette and film grain, after the
//                                          tone mapping (OutputPass)
//   createWetGround(THREE, Reflector, o)   a rain-wet ground: a mirror of the
//                                          scene broken up by ripples and a
//                                          roughness map, faded by wetness
//   oncePerFrame(reflector)                a mirror drawn once a frame (not once
//                                          per TAA sample)
//   createHeadlightCones(THREE, cap)       soft volumetric cones ahead of each car
//   createMistLayers(THREE, o)             dawn mist in layers over the water
//
// Assets and their licences: docs/assets-licences.md.

export const SHOWCASE_BASE = '/showcase/';

export async function loadHdri(THREE, renderer, name) {
  const { HDRLoader } = await import('/vendor/three/addons/loaders/HDRLoader.js');
  const tex = await new HDRLoader().loadAsync(`${SHOWCASE_BASE}hdri/${name}.hdr`);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  const pm = new THREE.PMREMGenerator(renderer);
  const env = pm.fromEquirectangular(tex).texture;
  pm.dispose(); tex.dispose();
  return env;
}

export async function loadPbr(THREE, name, repeat = 1) {
  const loader = new THREE.TextureLoader();
  const one = (suffix, srgb) => new Promise((resolve, reject) => loader.load(`${SHOWCASE_BASE}textures/${name}_${suffix}.jpg`, (t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat, repeat); t.anisotropy = 16;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    resolve(t);
  }, undefined, reject));
  // Normal and roughness only: the scenes keep their own colours.
  const [normalMap, roughnessMap] = await Promise.all([one('nor_gl', false), one('rough', false)]);
  return { normalMap, roughnessMap };
}

// The grades. shadows / highlights: colours added (lift) and multiplied
// (gain); contrast and saturation around mid-grey; vignette and grain amounts.
export const GRADES = Object.freeze({
  night: Object.freeze({ shadows: [0.0, 0.035, 0.06], highlights: [1.08, 0.98, 0.86], contrast: 1.12, saturation: 1.12, vignette: 0.42, grain: 0.035 }),
  rain: Object.freeze({ shadows: [0.0, 0.04, 0.07], highlights: [1.1, 0.97, 0.84], contrast: 1.16, saturation: 1.08, vignette: 0.48, grain: 0.04 }),
  dawn: Object.freeze({ shadows: [0.03, 0.02, 0.05], highlights: [1.1, 1.0, 0.84], contrast: 1.06, saturation: 1.06, vignette: 0.36, grain: 0.03 }),
  day: Object.freeze({ shadows: [0.0, 0.012, 0.03], highlights: [1.05, 1.01, 0.94], contrast: 1.08, saturation: 1.1, vignette: 0.3, grain: 0.025 }),
  space: Object.freeze({ shadows: [0.0, 0.0, 0.012], highlights: [1.04, 1.0, 0.96], contrast: 1.1, saturation: 1.05, vignette: 0.3, grain: 0.018 })
});

export function gradeShader(mood = 'night') {
  const g = GRADES[mood] || GRADES.night;
  return {
    name: 'PG1ShowcaseGrade',
    uniforms: {
      tDiffuse: { value: null }, uTime: { value: 0 },
      uLift: { value: g.shadows.slice() }, uGain: { value: g.highlights.slice() },
      uContrast: { value: g.contrast }, uSaturation: { value: g.saturation }, uVignette: { value: g.vignette }, uGrain: { value: g.grain }, uAspect: { value: 1 }
    },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform sampler2D tDiffuse; uniform float uTime; uniform vec3 uLift; uniform vec3 uGain; uniform float uContrast; uniform float uSaturation; uniform float uVignette; uniform float uGrain; uniform float uAspect; varying vec2 vUv;
      float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)) + uTime * 0.618) * 43758.5453); }
      void main(){
        vec4 c = texture2D(tDiffuse, vUv);
        vec3 x = c.rgb;
        float l = dot(x, vec3(0.2126, 0.7152, 0.0722));
        // Split toning: the lift in the shadows, the gain in the highlights.
        x += uLift * (1.0 - smoothstep(0.0, 0.55, l));
        x *= mix(vec3(1.0), uGain, smoothstep(0.35, 1.0, l));
        x = (x - 0.5) * uContrast + 0.5;
        float l2 = dot(x, vec3(0.2126, 0.7152, 0.0722));
        x = mix(vec3(l2), x, uSaturation);
        // A soft vignette, round on any frame shape.
        vec2 d = (vUv - 0.5) * vec2(uAspect, 1.0) / max(uAspect, 1.0);
        x *= 1.0 - uVignette * smoothstep(0.25, 0.85, length(d) * 1.35);
        // Film grain, a little stronger in the shadows, never on pure black.
        float n = (h(gl_FragCoord.xy) + h(gl_FragCoord.yx + 17.0) - 1.0) * uGrain * (1.0 - 0.6 * l2);
        x += n * step(0.004, l2);
        gl_FragColor = vec4(clamp(x, 0.0, 1.0), c.a);
      }`
  };
}

// A mirror that renders the scene at most once per frame: TAA renders the
// scene many times a frame, and the reflection barely changes between its
// sub-pixel samples.
// Only the main camera's view counts: a call from inside another mirror's
// reflection, or from a pass that draws with an override material (ambient
// occlusion, depth of field), keeps the frame's image.
export function oncePerFrame(reflector, camera = null) {
  const draw = reflector.onBeforeRender.bind(reflector);
  let frame = -1;
  reflector.userData.frame = 0;
  reflector.userData.camera = camera;
  reflector.onBeforeRender = (renderer, scene, cam, ...rest) => {
    const main = reflector.userData.camera;
    if ((main && cam !== main) || scene.overrideMaterial) return;
    if (frame === reflector.userData.frame) return;
    frame = reflector.userData.frame; draw(renderer, scene, cam, ...rest);
  };
  return reflector;
}

// Rain-wet ground: the scene's mirror image, rippled by a normal map and
// broken up by a roughness map (dry patches reflect little, puddles a lot).
export function createWetGround(THREE, Reflector, { width, depth, y = 0.08, textureWidth = 1024, textureHeight = 1024, normalMap = null, roughnessMap = null } = {}) {
  const shader = {
    name: 'PG1WetGround',
    uniforms: { color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null }, tNormal: { value: normalMap }, tRough: { value: roughnessMap }, uWet: { value: 1 }, uTime: { value: 0 }, uScale: { value: 1 / 6 } },
    vertexShader: `uniform mat4 textureMatrix; varying vec4 vUv; varying vec3 vW;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main(){ vUv = textureMatrix * vec4(position, 1.0); vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w;
      #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `uniform sampler2D tDiffuse; uniform sampler2D tNormal; uniform sampler2D tRough; uniform float uWet; uniform float uTime; uniform float uScale; varying vec4 vUv; varying vec3 vW;
      #include <logdepthbuf_pars_fragment>
      void main(){
        #include <logdepthbuf_fragment>
        vec2 p = vW.xz * uScale;
        vec3 n = texture2D(tNormal, p).xyz * 2.0 - 1.0;
        // Rain rings: fine ripples that move.
        vec3 r = texture2D(tNormal, p * 3.7 + vec2(uTime * 0.07, -uTime * 0.05)).xyz * 2.0 - 1.0;
        float rough = texture2D(tRough, p * 0.5).r;
        float puddle = smoothstep(0.55, 0.35, rough);
        vec4 uv = vUv; uv.xy += (n.xy * mix(0.05, 0.01, puddle) + r.xy * 0.008) * uv.w;
        // Wet asphalt stretches lights into vertical streaks: a few taps along the mirror's vertical.
        vec3 refl = vec3(0.0); float wsum = 0.0;
        for (int k = -3; k <= 3; k++) { float fk = float(k); float wk = exp(-fk * fk * 0.18); vec4 q = uv; q.y += fk * mix(0.014, 0.004, puddle) * q.w; refl += texture2DProj(tDiffuse, q).rgb * wk; wsum += wk; }
        refl /= wsum;
        vec3 v = normalize(cameraPosition - vW);
        float fres = 0.04 + 0.96 * pow(1.0 - clamp(v.y, 0.0, 1.0), 5.0);
        float a = uWet * mix(0.5, 0.95, puddle) * mix(0.65, 1.0, fres);
        gl_FragColor = vec4(refl * 1.35, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`
  };
  const mirror = new Reflector(new THREE.PlaneGeometry(width, depth), { textureWidth, textureHeight, clipBias: 0.003, shader });
  mirror.rotation.x = -Math.PI / 2; mirror.position.y = y;
  mirror.material.transparent = true; mirror.material.depthWrite = false;
  mirror.renderOrder = 1; mirror.name = 'showcase-wet-ground';
  return oncePerFrame(mirror);
}

// Soft light cones ahead of the headlights (additive, no depth write).
export function createHeadlightCones(THREE, cap) {
  const geo = new THREE.CylinderGeometry(0.35, 4.2, 22, 20, 1, true);
  geo.rotateX(Math.PI / 2); geo.translate(0, 0, 11);
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    uniforms: { uColor: { value: new THREE.Color(1.0, 0.92, 0.78) }, uStrength: { value: 0 } },
    vertexShader: 'varying float vZ; varying vec3 vN; varying vec3 vV; void main(){ vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0); vZ = position.z / 22.0; vN = normalize(mat3(modelMatrix * instanceMatrix) * normal); vV = normalize(cameraPosition - w.xyz); gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: 'uniform vec3 uColor; uniform float uStrength; varying float vZ; varying vec3 vN; varying vec3 vV; void main(){ float edge = pow(abs(dot(normalize(vN), normalize(vV))), 1.6); float fall = (1.0 - smoothstep(0.0, 1.0, vZ)) * smoothstep(0.0, 0.06, vZ); gl_FragColor = vec4(uColor * edge * fall * uStrength, 1.0); }'
  });
  const mesh = new THREE.InstancedMesh(geo, mat, cap);
  mesh.name = 'showcase-headlight-cones'; mesh.frustumCulled = false; mesh.count = 0; mesh.renderOrder = 3;
  return mesh;
}

// Dawn mist in layers: a few wide, soft sheets at different heights that
// drift slowly; thicker low over the water, never in front of the hero.
export function createMistLayers(THREE, { centre, radius = 900, layers = 5, color = 0xf2dcc8 } = {}) {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  let seed = 11; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  g.clearRect(0, 0, 256, 256);
  for (let i = 0; i < 60; i++) { const x = rnd() * 256; const y = rnd() * 256; const r = 30 + rnd() * 70; const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, 'rgba(255,255,255,0.22)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 256, 256); }
  const tex = new THREE.CanvasTexture(c); tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  const group = new THREE.Group(); group.name = 'showcase-mist';
  const mats = [];
  for (let i = 0; i < layers; i++) {
    const m = new THREE.MeshBasicMaterial({ map: tex, color, transparent: true, opacity: 0.16 - i * 0.022, depthWrite: false, fog: true, side: THREE.DoubleSide });
    m.map = tex.clone(); m.map.needsUpdate = true; m.map.repeat.set(3 + i, 3 + i);
    const p = new THREE.Mesh(new THREE.CircleGeometry(radius * (1 + i * 0.35), 48), m);
    p.rotation.x = -Math.PI / 2; p.position.set(centre[0], 1.2 + i * 3.5 + i * i * 1.5, centre[2]);
    p.renderOrder = 4; group.add(p); mats.push(m);
  }
  group.userData.update = (t) => { mats.forEach((m, i) => { m.map.offset.set(t * 0.004 * (i % 2 ? 1 : -1), t * 0.003); }); };
  return group;
}

// A hero model (public/showcase/models/<name>.glb), loaded once.
const heroCache = new Map();
export function loadHero(name) {
  if (!heroCache.has(name)) heroCache.set(name, import('/vendor/three/addons/loaders/GLTFLoader.js').then(({ GLTFLoader }) => new GLTFLoader().loadAsync(`${SHOWCASE_BASE}models/${name}.glb`)).then((g) => g.scene));
  return heroCache.get(name);
}

// Small-scale ripples for close water (a tiling normal map made in code).
export function rippleNormals(THREE) {
  const N = 256; const c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d'); const img = g.createImageData(N, N);
  const waves = [[1, 0, 1.0], [0, 2, 0.8], [3, 1, 0.5], [-2, 3, 0.45], [5, -3, 0.3], [-6, -5, 0.25], [9, 4, 0.15], [-11, 7, 0.12]];
  const h = (x, y) => waves.reduce((t, [a, b, k]) => t + k * Math.sin((a * x + b * y) * Math.PI * 2 / N + a * 1.3 + b * 0.7), 0);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = h(x + 1, y) - h(x - 1, y); const dy = h(x, y + 1) - h(x, y - 1); const l = Math.hypot(dx, dy, 1.2); const i = (y * N + x) * 4;
    img.data[i] = (-dx / l * 0.5 + 0.5) * 255; img.data[i + 1] = (-dy / l * 0.5 + 0.5) * 255; img.data[i + 2] = (1.2 / l * 0.5 + 0.5) * 255; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
}
