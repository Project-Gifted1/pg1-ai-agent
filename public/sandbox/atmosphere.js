// PG1 Sandbox viewer: what the weather and the time of day add round the
// camera. Visual only: nothing here is simulated or sent anywhere.
//
//   - rain: streaks falling past the camera, slanted by the wind (one draw
//     call; the drops stay put in the world as the camera moves);
//   - snow: flakes drifting down, swaying (one draw call);
//   - lightning in a thunderstorm: a flash that lights the scene for a
//     moment, twice in quick succession, every several seconds;
//   - birds: small flocks circling over the islands by day, flapping, gone at
//     night and in heavy rain (one draw call for all of them).
// How many of each follows the tier (ATMOSPHERE_COUNTS); none above the
// clouds or in space.
//
//   createAtmosphere(THREE, scene, { tier, coarse }) -> { setIslands(list), update(dt, now, o), flash, counts(), dispose() }

export const ATMOSPHERE_COUNTS = Object.freeze({
  low: Object.freeze({ rain: 700, snow: 500, flocks: 1, birds: 7 }),
  medium: Object.freeze({ rain: 1500, snow: 1000, flocks: 2, birds: 9 }),
  high: Object.freeze({ rain: 3000, snow: 1800, flocks: 3, birds: 11 }),
  ultra: Object.freeze({ rain: 4000, snow: 2400, flocks: 3, birds: 12 }),
  cinematic: Object.freeze({ rain: 4000, snow: 2400, flocks: 3, birds: 12 })
});
// Weather particles live in a box round the camera (metres).
const BOX = 48; const HEIGHT = 36;

function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

const FALL_VERT = `
uniform vec3 uCam; uniform float uTime; uniform float uSpeed; uniform float uLen; uniform vec2 uWind; uniform float uSway; uniform float uPx;
attribute vec3 aSeed; attribute float aEnd;
varying float vFade;
void main() {
  float box = ${BOX.toFixed(1)}; float h = ${HEIGHT.toFixed(1)};
  float y = mod(aSeed.y * h - uTime * uSpeed * (0.85 + aSeed.x * 0.3), h);
  vec2 xz = uCam.xz + mod(aSeed.xz * box - uCam.xz, box) - box * 0.5;
  vec3 p = vec3(xz.x, uCam.y + y - h * 0.4, xz.y);
  p.xz += uWind * (h - y) * 0.06;
  p.x += sin(uTime * 1.3 + aSeed.z * 30.0) * uSway; p.z += cos(uTime * 1.1 + aSeed.x * 30.0) * uSway;
  vec3 dir = normalize(vec3(uWind.x, -uSpeed, uWind.y));
  p -= dir * uLen * aEnd;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  // Flakes: bigger near the camera, sized for the screen's pixel density.
  gl_PointSize = uPx * clamp(2.5 + 40.0 / max(1.0, -mv.z), 2.5, 11.0) * (0.75 + aSeed.y * 0.5);
  vFade = (1.0 - smoothstep(box * 0.25, box * 0.55, length(p.xz - uCam.xz))) * (uLen > 0.0 ? 0.55 + 0.45 * aEnd : 1.0);
}`;
const FALL_FRAG = `
uniform vec3 uColor; uniform float uOpacity; varying float vFade;
void main() { gl_FragColor = vec4(uColor, uOpacity * vFade); }`;
const SNOW_FRAG = `
uniform vec3 uColor; uniform float uOpacity; varying float vFade;
void main() { float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard; gl_FragColor = vec4(uColor, uOpacity * vFade * (1.0 - r * r)); }`;

function fallGeometry(THREE, n, seed, line) {
  const r = rng(seed); const per = line ? 2 : 1;
  const s = new Float32Array(n * per * 3); const e = new Float32Array(n * per); const pos = new Float32Array(n * per * 3);
  for (let i = 0; i < n; i++) {
    const a = r(); const b = r(); const c = r();
    for (let k = 0; k < per; k++) { const j = i * per + k; s[j * 3] = a; s[j * 3 + 1] = b; s[j * 3 + 2] = c; e[j] = line ? k : 0; }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(s, 3));
  g.setAttribute('aEnd', new THREE.BufferAttribute(e, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return g;
}

function fallMaterial(THREE, frag, color) {
  return new THREE.ShaderMaterial({
    uniforms: { uCam: { value: new THREE.Vector3() }, uTime: { value: 0 }, uSpeed: { value: 9 }, uLen: { value: 0.8 }, uWind: { value: new THREE.Vector2() }, uSway: { value: 0 }, uPx: { value: 1 }, uColor: { value: new THREE.Color(color) }, uOpacity: { value: 0 } },
    vertexShader: FALL_VERT, fragmentShader: frag, transparent: true, depthWrite: false, fog: false
  });
}

// A bird: two wings in a shallow V (the instance's y scale flaps them).
function birdGeometry(THREE) {
  const g = new THREE.BufferGeometry();
  const v = new Float32Array([
    0, 0, 0.18, -0.55, 0.12, -0.05, 0, 0, -0.12,
    0, 0, 0.18, 0, 0, -0.12, 0.55, 0.12, -0.05
  ]);
  g.setAttribute('position', new THREE.BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

export function createAtmosphere(THREE, scene, { tier = 'medium', coarse = false } = {}) {
  const C = ATMOSPHERE_COUNTS[tier] || ATMOSPHERE_COUNTS.medium;
  const rainN = Math.round(C.rain * (coarse && (tier === 'cinematic' || tier === 'ultra') ? 0.45 : 1));
  const rainMat = fallMaterial(THREE, FALL_FRAG, 0xaab4c0);
  const rain = new THREE.LineSegments(fallGeometry(THREE, rainN, 7, true), rainMat);
  rain.frustumCulled = false; rain.renderOrder = 5; rain.visible = false; rain.name = 'rain';
  const snowMat = fallMaterial(THREE, SNOW_FRAG, 0xf4f6fa);
  const snow = new THREE.Points(fallGeometry(THREE, C.snow, 11, false), snowMat);
  snow.frustumCulled = false; snow.renderOrder = 5; snow.visible = false; snow.name = 'snow';
  snow.onBeforeRender = (r) => { snowMat.uniforms.uPx.value = r.getPixelRatio(); };
  scene.add(rain); scene.add(snow);

  // Birds: flocks over the islands nearest the camera.
  const nb = C.flocks * C.birds;
  const birdMat = new THREE.MeshLambertMaterial({ color: 0x24272c, side: THREE.DoubleSide });
  const birds = new THREE.InstancedMesh(birdGeometry(THREE), birdMat, nb);
  birds.name = 'birds'; birds.frustumCulled = false; birds.visible = false; birds.count = 0;
  scene.add(birds);
  const r = rng(29);
  const bird = Array.from({ length: nb }, (_, i) => ({ flock: Math.floor(i / C.birds), rad: 60 + r() * 70, alt: 26 + r() * 30, ph: r() * Math.PI * 2, speed: 0.1 + r() * 0.05, flap: 7 + r() * 4, size: 0.85 + r() * 0.35, bob: r() * 6 }));
  let islands = [];
  const lookDir = new THREE.Vector3();
  const m4 = new THREE.Matrix4(); const q = new THREE.Quaternion(); const e = new THREE.Euler(); const v = new THREE.Vector3(); const sc = new THREE.Vector3();

  let flash = 0; let nextFlash = 0; let flicker = 0;
  const out = {
    get flash() { return flash; },
    // [{ x, z, y }] island centres in scene metres (the ground under the flock).
    setIslands(list) { islands = Array.isArray(list) ? list.slice() : []; },
    // o: { camera, weather, day, space, alt (camera above the ground), now }
    update(dt, now, { camera, weather, day = 1, space = 0, alt = 0, heightAt = null, target = null } = {}) {
      const t = now / 1000;
      const low = space < 0.05 && alt < 260;
      const W = weather || {};
      // Rain and snow round the camera.
      const wind = (W.wind || 0) * 7;
      for (const [obj, m, amount, speed, len, sway] of [[rain, rainMat, W.rain || 0, 11, 1.6, 0], [snow, snowMat, W.snow || 0, 1.4, 0, 0.6]]) {
        obj.visible = low && amount > 0.02;
        if (!obj.visible) continue;
        const u = m.uniforms;
        // The volume sits along the line of sight (up to 22 m out), so the
        // rain fills what the camera looks at, not the air behind it.
        u.uCam.value.copy(camera.position);
        if (target) { lookDir.copy(target).sub(camera.position); const d = lookDir.length(); if (d > 0.01) u.uCam.value.addScaledVector(lookDir, Math.min(22, d * 0.5) / d); }
        u.uTime.value = t; u.uSpeed.value = speed; u.uLen.value = len; u.uSway.value = sway;
        u.uWind.value.set(wind * 0.8, wind * 0.35);
        u.uOpacity.value = Math.min(1, amount * 1.3) * (obj === rain ? 0.5 + 0.3 * day : 0.8);
        u.uColor.value.setRGB(obj === rain ? 0.55 + 0.25 * day : 0.9, obj === rain ? 0.6 + 0.25 * day : 0.92, obj === rain ? 0.66 + 0.24 * day : 0.96);
        // Fewer drops in light rain: the draw range follows the amount.
        const per = obj === rain ? 2 : 1; const total = obj.geometry.attributes.aEnd.count / per;
        obj.geometry.setDrawRange(0, Math.max(1, Math.round(total * Math.min(1, 0.15 + amount))) * per);
      }
      // Lightning: in a storm, a flash every 5-14 s, a second flicker after it.
      if (W.lightning && space < 0.2) {
        if (now > nextFlash) { flash = 1; flicker = now + 120 + Math.random() * 120; nextFlash = now + 5000 + Math.random() * 9000; }
        if (flicker && now > flicker) { flash = Math.max(flash, 0.7); flicker = 0; }
      }
      flash *= Math.exp(-dt * 9);
      if (flash < 0.01) flash = 0;
      // Birds: by day, out of heavy rain, below the clouds.
      const show = islands.length && low && day > 0.35 && (W.rain || 0) < 0.5 && (W.snow || 0) < 0.5;
      birds.visible = !!show;
      if (show) {
        const cx = camera.position.x; const cz = camera.position.z;
        const near = islands.map((p) => ({ p, d: Math.hypot(p.x - cx, p.z - cz) })).sort((a, b) => a.d - b.d).slice(0, C.flocks);
        let n = 0;
        for (const b of bird) {
          const isl = near[b.flock]; if (!isl) continue;
          const a = b.ph + t * b.speed * (1 + (W.wind || 0));
          const x = isl.p.x + Math.cos(a) * b.rad; const z = isl.p.z + Math.sin(a) * b.rad;
          const ground = heightAt ? Math.max(0, heightAt(x, z)) : (isl.p.y || 0);
          v.set(x, ground + b.alt + Math.sin(t * 0.7 + b.bob) * 2.5, z);
          e.set(Math.sin(t * 0.5 + b.bob) * 0.15, -a, Math.sin(t * 0.9 + b.ph) * 0.25); q.setFromEuler(e);
          const flap = 0.35 + 0.65 * Math.abs(Math.sin(t * b.flap + b.ph));
          sc.set(b.size, b.size * flap * 2.2, b.size);
          m4.compose(v, q, sc); birds.setMatrixAt(n++, m4);
        }
        birds.count = n; birds.instanceMatrix.needsUpdate = true;
        birdMat.color.setRGB(0.12 + 0.1 * day, 0.13 + 0.1 * day, 0.15 + 0.1 * day);
      }
    },
    counts: () => ({ rain: rain.visible ? rain.geometry.drawRange.count / 2 : 0, snow: snow.visible ? snow.geometry.drawRange.count : 0, birds: birds.visible ? birds.count : 0, flash }),
    dispose() { for (const o of [rain, snow, birds]) { scene.remove(o); o.geometry.dispose(); o.material.dispose(); } }
  };
  return out;
}
