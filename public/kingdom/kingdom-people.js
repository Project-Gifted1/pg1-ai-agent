// PG1 City: detailed walkers for close range (the level of detail nearest
// the camera). Only on the High, Cinematic and Showcase tiers; the phone
// tiers keep the light figures of kingdom-life.js (personGeometry), so the
// A07's draw calls, triangles and frame rate do not change.
//
// One merged geometry, one draw call for the whole near crowd. Each vertex
// knows its part (aPart: clothes, skin, trousers, shoes, hair, bag) and its
// limb (aLimb: left or right leg or arm, the bag in the right hand); the
// vertex shader swings the limbs about the hip and the shoulder from each
// walker's stride phase (aWalk.x) and stride (aWalk.y: 0 standing, 1
// walking), so legs and arms move in opposition, with a little knee bend.
// Per walker: top colour (instance colour), trousers, skin, hair, a bag or
// none (aWalk.z), a coat or a jacket (aWalk.w lengthens the hem), and a
// height (the instance's scale).
//
//   walkerGeometry(THREE)            the merged figure, about 1.75 m tall
//   walkerMaterial(THREE)            its material (limb swing in the shader)
//   walkerLook(i)                    the i-th walker's look (pure, for tests)
//   WALKER_RANGE                     metres from the camera drawn detailed

export const WALKER_RANGE = 150;
export const WALKER_CAP = { balanced: 260, cinematic: 420, showcase: 520 };

const PART = { top: 1, skin: 2, trousers: 3, shoes: 4, hair: 5, bag: 6, coat: 7 };
const LIMB = { body: 0, legL: 1, legR: 2, armL: 3, armR: 4, bag: 5 };
export const HIP_Y = 0.93;
export const SHOULDER_Y = 1.45;

// Varied clothing, never the enemy red (kingdom-life.js LIFE_COLOURS rule).
export const TOPS = [0x2b3340, 0x4a3a6a, 0x44506a, 0xc8b89a, 0x5a4a3a, 0x2f5d8a, 0x36454f, 0xb8902c, 0x6b6f7a, 0x55703f, 0x3d5a4a, 0x2f6d6a, 0x8a6a3a, 0xd9d4c7, 0x1d2430, 0x7a5c8e, 0xa8734a, 0x5b7f9e, 0xe0c060, 0x3f6f4f];
export const TROUSERS = [[0.16, 0.17, 0.2], [0.2, 0.27, 0.42], [0.12, 0.12, 0.13], [0.42, 0.37, 0.3], [0.3, 0.31, 0.33], [0.24, 0.3, 0.46], [0.36, 0.3, 0.24]];
export const HAIR = [[0.1, 0.075, 0.06], [0.05, 0.045, 0.04], [0.35, 0.24, 0.14], [0.55, 0.45, 0.3], [0.6, 0.6, 0.62], [0.2, 0.12, 0.08]];
export const SKIN = [[0.55, 0.38, 0.27], [0.78, 0.6, 0.47], [0.36, 0.24, 0.17], [0.88, 0.72, 0.6], [0.67, 0.48, 0.35], [0.45, 0.31, 0.22]];
const hash = (i, k) => { let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(k + 1, 0xc2b2ae35); h ^= h >>> 13; h = Math.imul(h, 0x27d4eb2f); h ^= h >>> 16; return (h >>> 0) / 4294967296; };

// The i-th walker's look: stable for a walker, varied across the crowd.
export function walkerLook(i) {
  return {
    top: TOPS[Math.floor(hash(i, 1) * TOPS.length)],
    trousers: TROUSERS[Math.floor(hash(i, 2) * TROUSERS.length)],
    hair: HAIR[Math.floor(hash(i, 3) * HAIR.length)],
    skin: SKIN[Math.floor(hash(i, 4) * SKIN.length)],
    bag: hash(i, 5) < 0.3 ? 1 : 0,
    coat: hash(i, 6) < 0.35 ? 1 : 0,
    height: 0.9 + hash(i, 7) * 0.19,   // 1.58 to 1.91 m
    build: 0.92 + hash(i, 8) * 0.16
  };
}

export function walkerGeometry(THREE) {
  const parts = [];
  const add = (g, part, limb) => {
    const n = g.index ? g.toNonIndexed() : g; if (n !== g) g.dispose();
    const c = n.attributes.position.count;
    n.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(c).fill(part), 1));
    n.setAttribute('aLimb', new THREE.BufferAttribute(new Float32Array(c).fill(limb), 1));
    if (n.attributes.uv) n.deleteAttribute('uv');
    parts.push(n);
  };
  const cyl = (rt, rb, h, seg = 10) => new THREE.CylinderGeometry(rt, rb, h, seg, 2, false);
  for (const [s, legLimb, armLimb] of [[-1, LIMB.legL, LIMB.armL], [1, LIMB.legR, LIMB.armR]]) {
    const x = s * 0.1;
    // Leg: thigh and shin, tapered; a shoe with a toe.
    const thigh = cyl(0.085, 0.07, 0.46); thigh.translate(x, HIP_Y - 0.23, 0); add(thigh, PART.trousers, legLimb);
    const shin = cyl(0.068, 0.055, 0.44); shin.translate(x, HIP_Y - 0.46 - 0.22 + 0.01, 0); add(shin, PART.trousers, legLimb);
    const shoe = new THREE.BoxGeometry(0.11, 0.075, 0.27, 1, 1, 2); shoe.translate(x, 0.037, 0.045); add(shoe, PART.shoes, legLimb);
    const toe = new THREE.SphereGeometry(0.056, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2); toe.scale(1, 0.7, 1.1); toe.translate(x, 0.05, 0.16); add(toe, PART.shoes, legLimb);
    // Arm: sleeve (upper and fore), a hand.
    const ax = s * 0.245;
    const upper = cyl(0.062, 0.054, 0.31, 8); upper.translate(ax, SHOULDER_Y - 0.16, 0); add(upper, PART.top, armLimb);
    const fore = cyl(0.053, 0.045, 0.28, 8); fore.translate(ax, SHOULDER_Y - 0.45, 0.01); add(fore, PART.top, armLimb);
    const hand = new THREE.SphereGeometry(0.05, 8, 6); hand.scale(0.8, 1.15, 0.9); hand.translate(ax, SHOULDER_Y - 0.64, 0.015); add(hand, PART.skin, armLimb);
  }
  // A shoulder bag or shopping bag in the right hand (shown per walker).
  const bag = new THREE.BoxGeometry(0.3, 0.32, 0.11); bag.translate(0.29, SHOULDER_Y - 0.86, 0.02); add(bag, PART.bag, LIMB.bag);
  const handle = new THREE.TorusGeometry(0.07, 0.012, 4, 10, Math.PI); handle.translate(0.29, SHOULDER_Y - 0.7, 0.02); add(handle, PART.bag, LIMB.bag);
  // Hips and belt, torso, chest, shoulders, collar, neck.
  const hips = cyl(0.175, 0.17, 0.17, 12); hips.scale(1, 1, 0.75); hips.translate(0, HIP_Y + 0.02, 0); add(hips, PART.trousers, LIMB.body);
  const belt = cyl(0.178, 0.178, 0.035, 12); belt.scale(1, 1, 0.76); belt.translate(0, HIP_Y + 0.11, 0); add(belt, PART.shoes, LIMB.body);
  const torso = cyl(0.215, 0.18, 0.42, 12); torso.scale(1, 1, 0.68); torso.translate(0, HIP_Y + 0.33, 0); add(torso, PART.top, LIMB.body);
  // The coat's skirt below the waist (scaled to nothing on a jacket: aWalk.w).
  const skirt = cyl(0.19, 0.215, 0.36, 12); skirt.scale(1, 1, 0.72); skirt.translate(0, HIP_Y - 0.08, 0); add(skirt, PART.coat, LIMB.body);
  const chest = new THREE.SphereGeometry(0.225, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2); chest.scale(1, 0.42, 0.7); chest.translate(0, SHOULDER_Y - 0.02, 0); add(chest, PART.top, LIMB.body);
  const collar = cyl(0.075, 0.09, 0.05, 10); collar.translate(0, SHOULDER_Y + 0.07, 0); add(collar, PART.top, LIMB.body);
  const neck = cyl(0.052, 0.058, 0.1, 8); neck.translate(0, SHOULDER_Y + 0.1, 0); add(neck, PART.skin, LIMB.body);
  // Head: skull, jaw, nose, ears; hair.
  const head = new THREE.SphereGeometry(0.108, 14, 10); head.scale(0.92, 1.12, 1.0); head.translate(0, SHOULDER_Y + 0.27, 0.005); add(head, PART.skin, LIMB.body);
  const nose = new THREE.ConeGeometry(0.018, 0.04, 6); nose.rotateX(Math.PI / 2); nose.translate(0, SHOULDER_Y + 0.255, 0.112); add(nose, PART.skin, LIMB.body);
  for (const s of [-1, 1]) { const ear = new THREE.SphereGeometry(0.022, 6, 4); ear.scale(0.5, 1, 0.8); ear.translate(s * 0.1, SHOULDER_Y + 0.26, 0); add(ear, PART.skin, LIMB.body); }
  const hair = new THREE.SphereGeometry(0.116, 14, 6, 0, Math.PI * 2, 0, Math.PI * 0.52); hair.scale(0.95, 1.08, 1.06); hair.translate(0, SHOULDER_Y + 0.29, -0.012); add(hair, PART.hair, LIMB.body);
  const back = new THREE.SphereGeometry(0.112, 12, 6, Math.PI * 0.2, Math.PI * 0.6, Math.PI * 0.3, Math.PI * 0.4); back.rotateY(Math.PI); back.translate(0, SHOULDER_Y + 0.25, -0.01); add(back, PART.hair, LIMB.body);
  const n = parts.reduce((k, g) => k + g.attributes.position.count, 0);
  const out = new THREE.BufferGeometry();
  for (const [name, size] of [['position', 3], ['normal', 3], ['aPart', 1], ['aLimb', 1]]) {
    const arr = new Float32Array(n * size); let o = 0;
    for (const g of parts) { arr.set(g.attributes[name].array, o); o += g.attributes[name].array.length; }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  for (const g of parts) g.dispose();
  out.computeBoundingSphere();
  return out;
}

// Per walker (instanced): aWalk (phase, stride, bag, coat), aLegs, aSkin, aHair.
export function walkerAttributes(THREE, n) {
  const walk = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4); walk.setUsage(THREE.DynamicDrawUsage);
  const legs = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3); legs.setUsage(THREE.DynamicDrawUsage);
  const skin = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3); skin.setUsage(THREE.DynamicDrawUsage);
  const hair = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3); hair.setUsage(THREE.DynamicDrawUsage);
  return { walk, legs, skin, hair };
}

export function walkerMaterial(THREE) {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82 });
  const swing = `
    float pg1Swing(float limb, vec4 w, out float pivot, out float knee) {
      float s = sin(w.x) * w.y; pivot = ${HIP_Y.toFixed(3)}; knee = 0.0;
      if (limb < 0.5) return 0.0;
      if (limb < 1.5) { knee = max(0.0, -cos(w.x)) * 0.5 * w.y; return 0.42 * s; }
      if (limb < 2.5) { knee = max(0.0, cos(w.x)) * 0.5 * w.y; return -0.42 * s; }
      pivot = ${SHOULDER_Y.toFixed(3)};
      if (limb < 3.5) return -0.34 * s;
      return 0.34 * s * (limb > 4.5 ? 0.55 : 1.0);
    }
    vec3 pg1Rot(vec3 p, float a, float py) { float c = cos(a); float sn = sin(a); vec2 q = vec2(p.y - py, p.z); return vec3(p.x, py + q.x * c - q.y * sn, q.x * sn + q.y * c); }`;
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nattribute float aPart;\nattribute float aLimb;\nattribute vec4 aWalk;\nattribute vec3 aLegs;\nattribute vec3 aSkin;\nattribute vec3 aHair;\nvarying vec3 vPg1Col;\n${swing}`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n{ float pv; float kn; float a = pg1Swing(aLimb, aWalk, pv, kn); objectNormal = pg1Rot(objectNormal, a, 0.0); }`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          float pv; float kn; float a = pg1Swing(aLimb, aWalk, pv, kn);
          // The shin and shoe bend back at the knee on the leg's back swing.
          if (aLimb > 0.5 && aLimb < 2.5 && transformed.y < ${(HIP_Y - 0.46).toFixed(3)}) transformed = pg1Rot(transformed, -kn, ${(HIP_Y - 0.46).toFixed(3)});
          transformed = pg1Rot(transformed, a, pv);
          // No bag: the bag folds away; a jacket: no coat skirt.
          if (aPart > 5.5 && aPart < 6.5 && aWalk.z < 0.5) transformed = vec3(0.29, ${(SHOULDER_Y - 0.64).toFixed(3)}, 0.0);
          if (aPart > 6.5 && aWalk.w < 0.5) transformed.y = max(transformed.y, ${(HIP_Y + 0.08).toFixed(3)});
        }`)
      .replace('#include <color_vertex>', `#include <color_vertex>
        vPg1Col = vec3(1.0);
        #ifdef USE_INSTANCING_COLOR
          vPg1Col = instanceColor.xyz;
        #endif
        if (aPart > 1.5 && aPart < 2.5) vPg1Col = aSkin;
        else if (aPart > 2.5 && aPart < 3.5) vPg1Col = aLegs;
        else if (aPart > 3.5 && aPart < 4.5) vPg1Col = vec3(0.07, 0.065, 0.07);
        else if (aPart > 4.5 && aPart < 5.5) vPg1Col = aHair;
        else if (aPart > 5.5 && aPart < 6.5) vPg1Col = vPg1Col * 0.55 + vec3(0.12, 0.09, 0.06);
        else if (aPart > 6.5) vPg1Col = vPg1Col * 0.85;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPg1Col;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vPg1Col;');
  };
  m.customProgramCacheKey = () => 'pg1-walker';
  return m;
}
