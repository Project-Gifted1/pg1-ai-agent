// PG1 City: wet streets in the rain without a mirror (kingdom-look.js wet).
//
// The Showcase drew a second view of the whole city for its wet-street
// mirror; a budget phone cannot. This is the cheap version, two draw calls:
//   - a ground layer on both banks: dark, glossy asphalt (a CC0 normal and
//     roughness map, public/showcase/textures/asphalt_02_*), faded in with
//     the real wetness, lit by the scene's lights and environment;
//   - light streaks: one instanced quad under each street lamp and each
//     car's headlights, lying on the road and stretched towards the camera,
//     as reflected lights are on a wet street (additive, no second render).
// Decoration only: it follows the real Dublin weather (the feed) and never
// changes what the City shows.

const STREAK_VS = `attribute vec4 aSpot; // x, z, warmth (0 cool .. 1 warm), length scale
varying vec2 vUv; varying float vWarm;
uniform float uLen;
void main(){
  vUv = uv; vWarm = aSpot.z;
  vec2 c = aSpot.xy;
  vec2 toCam = cameraPosition.xz - c;
  float d = max(length(toCam), 1.0);
  vec2 dir = toCam / d;
  vec2 side = vec2(-dir.y, dir.x);
  // Longer the further the light is (a wet road smears a far light more), within reason.
  float len = uLen * aSpot.w * clamp(d / 160.0, 0.6, 2.2);
  vec2 p = c + side * position.x * 1.6 + dir * (position.y + 0.5) * len;
  gl_Position = projectionMatrix * viewMatrix * vec4(p.x, 0.12, p.y, 1.0);
}`;
const STREAK_FS = `uniform float uWet; uniform float uNight; varying vec2 vUv; varying float vWarm;
void main(){
  float across = 1.0 - abs(vUv.x - 0.5) * 2.0;
  float along = smoothstep(0.0, 0.12, vUv.y) * (1.0 - vUv.y);
  float a = pow(max(across, 0.0), 2.2) * along * uWet * uNight;
  vec3 warm = vec3(1.0, 0.72, 0.42); vec3 cool = vec3(0.78, 0.86, 1.0);
  gl_FragColor = vec4(mix(cool, warm, vWarm) * a * 0.9, 1.0);
}`;

export function createWetStreets(THREE, scene, { lamps = [], heads = null, maxHeads = 160, banks = [], texture = null } = {}) {
  const group = new THREE.Group();
  group.name = 'wet-streets';
  // The glossy layer.
  const mat = new THREE.MeshStandardMaterial({ color: 0x0b0d10, roughness: 0.18, metalness: 0.0, transparent: true, opacity: 0, depthWrite: false });
  if (texture) { mat.normalMap = texture.normalMap; mat.roughnessMap = texture.roughnessMap; mat.normalScale = new THREE.Vector2(0.6, 0.6); }
  // Both banks in one geometry: one draw call.
  if (banks.length) {
    const pos = []; const uvs = []; const nor = [];
    for (const b of banks) {
      const x0 = (b.x || 0) - b.width / 2; const x1 = (b.x || 0) + b.width / 2; const z0 = b.z - b.depth / 2; const z1 = b.z + b.depth / 2;
      const q = [[x0, z1], [x1, z1], [x1, z0], [x0, z1], [x1, z0], [x0, z0]];
      for (const [x, z] of q) { pos.push(x, 0.07, z); uvs.push(x / 24, z / 24); nor.push(0, 1, 0); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    const m = new THREE.Mesh(g, mat); m.name = 'wet-street-layer'; m.renderOrder = 1;
    group.add(m);
  }
  // The streaks: lamps first (fixed), then the headlights (copied per frame).
  const cap = lamps.length + maxHeads;
  const quad = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index; geo.setAttribute('position', quad.attributes.position); geo.setAttribute('uv', quad.attributes.uv);
  const spots = new Float32Array(cap * 4);
  lamps.forEach((l, i) => { spots.set([l.x, l.z, 1, 1], i * 4); });
  const spotAttr = new THREE.InstancedBufferAttribute(spots, 4); spotAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aSpot', spotAttr);
  geo.instanceCount = lamps.length;
  const streakMat = new THREE.ShaderMaterial({ uniforms: { uWet: { value: 0 }, uNight: { value: 0 }, uLen: { value: 26 } }, vertexShader: STREAK_VS, fragmentShader: STREAK_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const streaks = new THREE.Mesh(geo, streakMat); streaks.name = 'wet-light-streaks'; streaks.frustumCulled = false; streaks.renderOrder = 3;
  group.add(streaks);
  group.visible = false;
  scene.add(group);
  const m4 = new THREE.Matrix4(); const p = new THREE.Vector3();
  return {
    group,
    // wet 0..1 (the real weather), night 0..1.
    update(wet, night) {
      const w = Math.max(0, Math.min(1, wet || 0));
      group.visible = w > 0.05;
      if (!group.visible) return;
      mat.opacity = 0.55 * w;
      streakMat.uniforms.uWet.value = w;
      streakMat.uniforms.uNight.value = 0.25 + 0.75 * Math.max(0, Math.min(1, night || 0));
      let n = lamps.length;
      if (heads && heads.count) {
        const k = Math.min(heads.count, maxHeads);
        for (let i = 0; i < k; i++) { heads.getMatrixAt(i, m4); p.setFromMatrixPosition(m4); spots[n * 4] = p.x; spots[n * 4 + 1] = p.z; spots[n * 4 + 2] = 0.15; spots[n * 4 + 3] = 0.55; n++; }
        spotAttr.needsUpdate = true;
      }
      geo.instanceCount = n;
    },
    dispose() { group.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); mat.dispose(); streakMat.dispose(); group.removeFromParent(); }
  };
}
