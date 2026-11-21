// PG1 City: everyone who moves, and what each gadget does.
//
// Everything is instanced (one draw call per part per kind), so a wave of
// hundreds stays smooth, and big enough to read on a phone at 412 px.
//
// PG1's side (gold, white and cyan; never red):
//   sentinels   gold-and-white drones in patrol rings round the tower, one
//               for each check PG1's MCP server lists live (setSentinels);
//               on an event the nearest turns to the threat and escorts it
//               to the gadget, from inside the city
//   commander   the larger drone docked at the Command Centre deck; it
//               lifts over a high-severity event the director focuses on,
//               and carries a landed report to a beacon
//   repair      repair drones: PG1-fault events
//   pilots      small cyan boats that guide allies to the pier
//   rovers      ground units on the embankment road; their lights come up
//               in storms and floods
// The other side (red is theirs): scanner drones probing the skyline,
// swarms in a flood, dark boats on the river, rogue signals (red trails),
// Trojan workspaces (1.22.0: a booby-trapped project crate slung under a dark
// carrier, one per real check_repo_trap verdict; the Repo Trap Scanner seals
// it in a gold lattice and it sinks).
// Allies (green): lit boats and cargo ships to the pier, partner drones.
//
// PG1 only defends: every PG1 unit stays inside the city (CITY_R); they
// block, scan, catch, turn back and repair, never chase or strike back.
// Ambient movement is never counted or captioned; `fired` counts only
// gadget actions taken on a real event passed to stage().

import { at, CITY_R, RIVER, GATE_BEARINGS, PLAZA_R } from './kingdom-world.js';
import { countryBearing, PG1_COLORS, defenceLine, reasonLabel } from './kingdom-data.js';

export { CITY_R };
export function insideCity(p, r = CITY_R) { const d = Math.hypot(p.x, p.z); if (d <= r) return p; const k = r / d; return { ...p, x: p.x * k, z: p.z * k }; }
export const LOD_FAR = 600;
const GATE_NAMES = ['north', 'east', 'west'];
const RIVER_GADGETS = new Set(['truth_lens', 'phishing_net', 'supply_inspector', 'sanctions_gate']);

function nearestGate(bearing) {
  let best = 'north'; let d = 9;
  for (const n of GATE_NAMES) { const x = Math.abs(((bearing - GATE_BEARINGS[n] + Math.PI * 3) % (Math.PI * 2)) - Math.PI); if (x < d) { d = x; best = n; } }
  return best;
}

// A crowd: up to `cap` figures of one kind, each part an InstancedMesh.
// parts: [{ geo, mat, offset: [x, y, z], swing: null | 'legL' | 'legR' | 'armL' | 'armR', flat }]
class Crowd {
  constructor(THREE, root, parts, cap, { fly = 0 } = {}) {
    this.THREE = THREE; this.cap = cap; this.fly = fly;
    this.parts = parts.map((p) => {
      const mesh = new THREE.InstancedMesh(p.geo, p.mat, cap);
      mesh.name = 'crowd';
      mesh.count = 0; mesh.castShadow = !p.flat; mesh.receiveShadow = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      root.add(mesh);
      return { ...p, mesh };
    });
    this.agents = [];
    this.m = new THREE.Matrix4(); this.local = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.e = new THREE.Euler(); this.v = new THREE.Vector3(); this.s = new THREE.Vector3();
    this.pickMesh = this.parts[0].mesh;
  }
  get live() { return this.agents.length; }
  get free() { return this.cap - this.agents.length; }
  add(a) { if (this.agents.length >= this.cap) return null; const ag = { x: 0, y: 0, z: 0, heading: 0, phase: Math.random() * 6.28, speed: 0, scale: 1, alert: 0, arms: 0, fade: 1, ...a }; this.agents.push(ag); return ag; }
  remove(pred) { this.agents = this.agents.filter((a) => !pred(a)); }
  // Writes every agent's parts. camPos picks the detail per figure.
  write(t, camPos) {
    const { m, local, q, e, v, s } = this;
    const n = this.agents.length;
    // An empty crowd costs no draw call.
    for (const p of this.parts) { p.mesh.count = n; p.mesh.visible = n > 0; }
    for (let i = 0; i < n; i++) {
      const a = this.agents[i];
      const far = camPos ? Math.hypot(a.x - camPos.x, a.z - camPos.z) > LOD_FAR : false;
      const k = a.scale * a.fade;
      const bob = this.fly ? Math.sin(t * 2.2 + a.phase) * 0.6 : 0;
      v.set(a.x, a.y + bob, a.z); e.set(0, a.heading, 0); q.setFromEuler(e); s.set(k, k, k);
      m.compose(v, q, s);
      const stride = far ? 0 : Math.sin(a.phase) * Math.min(1, a.speed / 1.6) * 0.7;
      for (const p of this.parts) {
        let rx = 0;
        if (p.swing === 'legL') rx = stride; else if (p.swing === 'legR') rx = -stride;
        else if (p.swing === 'armL') rx = -stride * 0.8 - a.arms * 2.4; else if (p.swing === 'armR') rx = stride * 0.8 - a.arms * 2.6;
        const yaw = p.swing === 'spin' ? t * 30 + a.phase : p.swing === 'yaw45' ? Math.PI / 4 : p.swing === 'yaw-45' ? -Math.PI / 4 : 0;
        e.set(rx, yaw, 0); q.setFromEuler(e);
        v.set(p.offset[0], p.offset[1], p.offset[2]); s.set(1, 1, 1);
        local.compose(v, q, s);
        p.mesh.setMatrixAt(i, local.premultiply(m));
      }
    }
    for (const p of this.parts) p.mesh.instanceMatrix.needsUpdate = true;
  }
}

// A quadcopter: body, four arms, four spinning rotors, a camera pod and a
// light (red on an attacker's siege drone, cyan on PG1's patrols).
let glowGeo = null; let trailGeoQ = null; let LEAN = false;
const GLOW_GEO = (THREE) => glowGeo || (glowGeo = new THREE.IcosahedronGeometry(1.15, 1));
const TRAIL_GEO = (THREE) => { if (!trailGeoQ) { trailGeoQ = new THREE.CylinderGeometry(0.06, 0.45, 9, 6, 1, true); trailGeoQ.rotateX(Math.PI / 2); trailGeoQ.translate(0, 0, -5); } return trailGeoQ; };
// lean (Legacy phone): the body and its light only (two draw calls a crowd).
function quadParts(THREE, M, light, body = 0x2a2e34, lean = LEAN) {
  const parts = [
    { geo: new THREE.BoxGeometry(0.9, 0.28, 0.9), mat: M(body, { metalness: 0.7, roughness: 0.35 }), offset: [0, 0, 0], swing: null },
    { geo: new THREE.BoxGeometry(0.42, 0.3, 0.42), mat: M(0x15181c, { metalness: 0.5, roughness: 0.3 }), offset: [0, -0.3, 0.1], swing: null },
    { geo: new THREE.SphereGeometry(0.1, 8, 6), mat: new THREE.MeshBasicMaterial({ color: light }), offset: [0, -0.1, 0.5], swing: null, flat: true }
  ];
  if (lean) return [parts[0], parts[2]];
  const arm = new THREE.BoxGeometry(2.2, 0.08, 0.12);
  parts.push({ geo: arm, mat: parts[0].mat, offset: [0, 0.05, 0], swing: 'yaw45' });
  parts.push({ geo: arm, mat: parts[0].mat, offset: [0, 0.05, 0], swing: 'yaw-45' });
  const rotor = new THREE.CylinderGeometry(0.5, 0.5, 0.03, 14);
  const rm = new THREE.MeshBasicMaterial({ color: 0xb8c2cc, transparent: true, opacity: 0.3, depthWrite: false });
  for (const [x, z] of [[0.78, 0.78], [-0.78, 0.78], [0.78, -0.78], [-0.78, -0.78]]) parts.push({ geo: rotor, mat: rm, offset: [x, 0.16, z], swing: 'spin', flat: true });
  // A soft glow and a light trail, so a drone reads as a moving light from afar.
  parts.push({ geo: GLOW_GEO(THREE), mat: new THREE.MeshBasicMaterial({ color: light, transparent: true, opacity: 0.13, blending: THREE.AdditiveBlending, depthWrite: false }), offset: [0, 0, 0], swing: null, flat: true });
  parts.push({ geo: TRAIL_GEO(THREE), mat: new THREE.MeshBasicMaterial({ color: light, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }), offset: [0, 0, 0], swing: null, flat: true });
  return parts;
}

function textSprite(THREE, text, color = '#ffffff') {
  const cv = document.createElement('canvas');
  const g = cv.getContext('2d');
  // Textures stay within 1024 px (the Legacy phone cap): long labels get a smaller font.
  let fs = 44; g.font = `600 ${fs}px Inter, system-ui, sans-serif`;
  const wide = g.measureText(text).width + 36; if (wide > 1024) { fs = Math.floor(fs * 1024 / wide); }
  g.font = `600 ${fs}px Inter, system-ui, sans-serif`;
  const w = Math.min(1024, Math.ceil(g.measureText(text).width) + 36);
  cv.width = w; cv.height = 72;
  g.font = `600 ${fs}px Inter, system-ui, sans-serif`;
  g.fillStyle = 'rgba(10,10,11,0.72)';
  if (g.roundRect) { g.beginPath(); g.roundRect(0, 0, w, 72, 16); g.fill(); } else g.fillRect(0, 0, w, 72);
  g.fillStyle = color; g.textBaseline = 'middle'; g.fillText(text, 18, 38);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
  sp.name = 'label';
  sp.scale.set(w / 72 * 2.2, 2.2, 1);
  sp.renderOrder = 20;
  return sp;
}

export function createActors(THREE, scene, world, settings) {
  const root = new THREE.Group();
  root.name = 'actors';
  scene.add(root);
  const phone = settings.tier === 'phone' || settings.tier === 'legacy';
  LEAN = !!settings.legacy;
  const M = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, ...o });
  // The other side.
  const scanners = new Crowd(THREE, root, quadParts(THREE, M, 0xff3d3d, 0x1a1c20), Math.round(settings.crowdCap / 2), { fly: 1 });
  const swarm = new Crowd(THREE, root, quadParts(THREE, M, 0xff3d3d, 0x101114), Math.round(settings.crowdCap / 2), { fly: 1 });
  const wakeGeo = new THREE.PlaneGeometry(9, 30); wakeGeo.rotateX(-Math.PI / 2); wakeGeo.translate(0, 0, -21);
  const wakeTex = (() => { const cv = document.createElement('canvas'); cv.width = 64; cv.height = 128; const g = cv.getContext('2d'); for (let y = 0; y < 128; y++) { const k = 1 - y / 128; const half = 4 + (y / 128) * 26; g.fillStyle = `rgba(255,255,255,${0.5 * k})`; g.fillRect(32 - half, y, 3, 1); g.fillRect(32 + half - 3, y, 3, 1); g.fillStyle = `rgba(255,255,255,${0.12 * k})`; g.fillRect(32 - half, y, half * 2, 1); } const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t; })();
  const wakeMat = new THREE.MeshBasicMaterial({ map: wakeTex, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false });
  const boatParts = (hull, cabin, light, lightName) => LEAN ? [
    { geo: new THREE.BoxGeometry(4.2, 1.8, 15), mat: M(hull, { metalness: 0.4, roughness: 0.4 }), offset: [0, 0.6, 0], swing: null },
    { geo: new THREE.BoxGeometry(3.2, 1.8, 5), mat: M(cabin, { metalness: 0.7, roughness: 0.2, emissive: light, emissiveIntensity: 0.6 }), offset: [0, 2.3, -2], swing: null }
  ] : [
    { geo: new THREE.BoxGeometry(4.2, 1.8, 15), mat: M(hull, { metalness: 0.4, roughness: 0.4 }), offset: [0, 0.6, 0], swing: null },
    { geo: wakeGeo, mat: wakeMat, offset: [0, 0.15, 0], swing: null, flat: true },
    { geo: new THREE.BoxGeometry(3.2, 1.8, 5), mat: M(cabin, { metalness: 0.7, roughness: 0.2, emissive: light, emissiveIntensity: 0.35 }), offset: [0, 2.3, -2], swing: null },
    { geo: new THREE.SphereGeometry(0.45, 8, 6), mat: new THREE.MeshBasicMaterial({ color: light }), offset: [0, 3.6, -2], swing: null, flat: true, name: lightName }
  ];
  const darkBoats = new Crowd(THREE, root, boatParts(0x14161a, 0x1c1f26, 0xff3d3d), 24);
  const signalMat = new THREE.MeshBasicMaterial({ color: 0xff3d3d });
  const trailMat = new THREE.MeshBasicMaterial({ color: 0xff3d3d, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false });
  const trailGeo = new THREE.CylinderGeometry(0.15, 0.9, 16, 8, 1, true); trailGeo.rotateX(Math.PI / 2); trailGeo.translate(0, 0, -8.5);
  const signals = new Crowd(THREE, root, [{ geo: new THREE.SphereGeometry(0.9, 10, 8), mat: signalMat, offset: [0, 0, 0], swing: null, flat: true }, { geo: trailGeo, mat: trailMat, offset: [0, 0, 0], swing: null, flat: true }], 24);
  // Trojan workspaces: a dark project crate (a folder tab on its lid, red
  // seams) slung under a dark carrier drone. Red is theirs.
  const seamMat = new THREE.MeshBasicMaterial({ color: 0xff3d3d });
  const workspaces = new Crowd(THREE, root, [
    ...quadParts(THREE, M, 0xff3d3d, 0x16181c),
    { geo: new THREE.BoxGeometry(1.6, 1.1, 1.2), mat: M(0x1b1e24, { metalness: 0.5, roughness: 0.45 }), offset: [0, -1.5, 0], swing: null },
    { geo: new THREE.BoxGeometry(0.6, 0.14, 1.2), mat: M(0x1b1e24, { metalness: 0.5, roughness: 0.45 }), offset: [-0.45, -0.88, 0], swing: null },
    { geo: new THREE.BoxGeometry(1.64, 0.06, 1.24), mat: seamMat, offset: [0, -1.5, 0], swing: null, flat: true },
    { geo: new THREE.BoxGeometry(0.06, 1.14, 1.24), mat: seamMat, offset: [0.2, -1.5, 0], swing: null, flat: true },
    { geo: new THREE.CylinderGeometry(0.03, 0.03, 0.9, 4), mat: M(0x3a3f46), offset: [0, -0.55, 0], swing: null, flat: true }
  ], 12, { fly: 1 });
  // PG1's side.
  const SENTINEL_CAP = 64;
  const sentinelParts = quadParts(THREE, M, PG1_COLORS.cyan, 0xf5f7fa);
  if (sentinelParts[4]) sentinelParts[3].mat = sentinelParts[4].mat = M(PG1_COLORS.gold, { metalness: 0.8, roughness: 0.3 });
  else sentinelParts[0].mat = M(PG1_COLORS.gold, { metalness: 0.8, roughness: 0.3 });
  // PG1's shield on its own hulls (from the brand asset), never on an enemy.
  const hullMat = world.brandTex ? new THREE.MeshBasicMaterial({ map: world.brandTex, transparent: true, depthWrite: false, side: THREE.DoubleSide }) : null;
  const hullDecal = hullMat ? (() => { const g = new THREE.PlaneGeometry(0.8, 0.8); g.rotateX(-Math.PI / 2); return { geo: g, mat: hullMat, offset: [0, 0.16, 0], swing: null, flat: true }; })() : null;
  if (hullDecal && !LEAN) sentinelParts.push(hullDecal);
  const sentinels = new Crowd(THREE, root, sentinelParts, SENTINEL_CAP, { fly: 1 });
  const commander = new Crowd(THREE, root, hullDecal && !LEAN ? [...quadParts(THREE, M, PG1_COLORS.gold, 0xf5f7fa), hullDecal] : quadParts(THREE, M, PG1_COLORS.gold, 0xf5f7fa), 1, { fly: 1 });
  const repair = new Crowd(THREE, root, quadParts(THREE, M, PG1_COLORS.amber, 0xf5f7fa), 6, { fly: 1 });
  const pilotParts = boatParts(0xf5f7fa, 0x6fd8ff, PG1_COLORS.cyan).map((p, i) => (i === 0 ? { ...p, geo: new THREE.BoxGeometry(2.6, 1.2, 8) } : p));
  if (hullMat && !LEAN) { const g = new THREE.PlaneGeometry(1.6, 1.6); g.rotateY(Math.PI / 2); pilotParts.push({ geo: g, mat: hullMat, offset: [1.65, 2.3, -2], swing: null, flat: true }); }
  const pilots = new Crowd(THREE, root, pilotParts, 3);
  const roverLight = new THREE.MeshBasicMaterial({ color: 0x6a6f75 });
  const rovers = new Crowd(THREE, root, [
    { geo: new THREE.BoxGeometry(3.2, 1.6, 4.8), mat: M(0xe9edf1, { metalness: 0.3, roughness: 0.4 }), offset: [0, 1.5, 0], swing: null },
    ...(LEAN ? [] : [{ geo: new THREE.BoxGeometry(3.6, 0.8, 1.2), mat: M(0x22262c), offset: [0, 0.6, 1.6], swing: null },
      { geo: new THREE.BoxGeometry(3.6, 0.8, 1.2), mat: M(0x22262c), offset: [0, 0.6, -1.6], swing: null }]),
    { geo: new THREE.BoxGeometry(2.4, 0.4, 0.2), mat: roverLight, offset: [0, 1.8, 2.45], swing: null, flat: true }
  ], 6);
  // Allies: lit boats and cargo ships (green), partner drones (green light).
  const allyBoats = new Crowd(THREE, root, boatParts(0xf5f7fa, 0x2a4a68, PG1_COLORS.green), 10);
  const cargoShips = new Crowd(THREE, root, boatParts(0xe9edf1, 0x2a4a68, PG1_COLORS.green).map((p, i) => (i === 0 ? { ...p, geo: new THREE.BoxGeometry(7, 2.6, 30) } : p)), 4);
  const partners = new Crowd(THREE, root, quadParts(THREE, M, PG1_COLORS.green, 0xdff7e8), 12, { fly: 1 });
  const crowds = [scanners, swarm, darkBoats, signals, workspaces, sentinels, commander, repair, pilots, rovers, allyBoats, cargoShips, partners];
  const PG1_UNITS = [sentinels, commander, repair, pilots, rovers];
  const ENEMIES = [scanners, swarm, darkBoats, signals, workspaces];
  const S = phone ? 6.5 : 5.2; // drone scale: readable at 412 px in the default view

  const props = [];
  const labels = [];
  const fired = {};
  let onFire = null;
  // A gadget acted on a real event: counted, the emblem pulses, the sound (if on) chimes.
  const fire = (g, e) => { fired[g] = (fired[g] || 0) + 1; if (world.pulseEmblem) world.pulseEmblem(!!(e && e.severity === 'high')); if (onFire) { try { onFire(g, e); } catch (err) { /* never stops the view */ } } };

  // --- ambient PG1 units ---
  const DOCK = { x: 0, y: world.deckY + 4, z: 14 };
  const cmd = commander.add({ x: DOCK.x, y: DOCK.y, z: DOCK.z, scale: S * 1.9, mode: 'docked', target: { ...DOCK } });
  for (let k = 0; k < 3; k++) { const hp = world.harbour.point; pilots.add({ x: hp.x - 30 + k * 30, y: -3.4, z: hp.z + 10, home: { x: hp.x - 30 + k * 30, z: hp.z + 10 }, a0: k * 2.1 }); }
  const bankZ = RIVER.z - RIVER.half - 7;
  for (let k = 0; k < (phone ? 4 : 6); k++) rovers.add({ x: -240 + k * 90, y: 0, z: bankZ, dir: k % 2 ? 1 : -1, speed: 6, scale: 1 });
  for (let k = 0; k < 6; k++) repair.add({ x: (k - 2.5) * 5, y: world.deckY - 6, z: -16, scale: S * 0.8, home: { x: (k - 2.5) * 5, y: world.deckY - 6, z: -16 }, target: null });

  // Sentinels: one per live check, in rings round the tower and over the skyline.
  function setSentinels(n) {
    const want = Math.max(0, Math.min(SENTINEL_CAP, Number(n) || 0));
    while (sentinels.live < want) { const k = sentinels.live; sentinels.add({ ring: 45 + (k % 4) * 45, alt: 70 + (k % 5) * 22, a0: (k * 2.39996) % (Math.PI * 2), dir: k % 2 ? 1 : -1, escort: null, scale: S }); }
    if (sentinels.live > want) sentinels.agents.length = want;
    return sentinels.live;
  }

  const groups = new Map();
  let shieldLoad = 0;
  let lanternsLit = 0;

  function label(text, pos, color, ttl = 6) {
    const sp = textSprite(THREE, text, color);
    sp.position.set(pos.x, pos.y, pos.z);
    sp.scale.multiplyScalar(phone ? 3.2 : 2.6);
    root.add(sp);
    labels.push({ sp, ttl, y0: pos.y });
    if (labels.length > 8) { const old = labels.shift(); root.remove(old.sp); old.sp.material.map.dispose(); old.sp.material.dispose(); }
  }
  const defenceLabel = (e, pos) => label(defenceLine(e), pos, '#f3c623');

  // Allies.
  function spawnAllyBoat(event, crowd) {
    const side = Math.sin(countryBearing(event.country || 'IE')) >= 0 ? 1 : -1;
    const hp = world.harbour.point;
    const sx = side > 0 ? 1400 : hp.x + 1100;
    crowd.add({ x: sx, y: -3.4, z: RIVER.z + 12, heading: -Math.PI / 2, t: 0, path: [{ x: hp.x + 60, z: RIVER.z + 10 }, { x: hp.x + 8, z: hp.z }], leg: 0, speed: 26, eventId: event.id, scale: 1 });
  }
  function spawnPartner(event) {
    const b = countryBearing(event.country || 'IE');
    const from = at(b, CITY_R - 10, 120);
    partners.add({ x: from.x, y: from.y, z: from.z, from, to: { x: 0, y: 40, z: 60 }, t: 0, eventId: event.id, scale: S });
  }

  // The gadget's answer to one event, when its attackers reach the checkpoint.
  function respond(group) {
    const e = group.event;
    const now = performance.now();
    const lead = group.agents.find((a) => a.fade > 0.05) || group.agents[0];
    const lp = lead ? { x: lead.x, y: lead.y + 12, z: lead.z } : { x: group.cx, y: group.cy + 12, z: group.cz };
    switch (e.gadget) {
      case 'sanctions_gate': { const pc = world.portcullis.south; pc.userData.goal = pc.userData.down; pc.userData.until = now + 7000; break; }
      case 'phishing_net': {
        const net = new THREE.Mesh(new THREE.SphereGeometry(16, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshBasicMaterial({ color: PG1_COLORS.cyan, wireframe: true, transparent: true, opacity: 0.9 }));
        net.name = 'phishing-net'; net.rotation.x = Math.PI; net.position.set(group.cx, -14, group.cz);
        root.add(net); props.push({ mesh: net, kind: 'net', goalY: group.cy + 10, ttl: 7 });
        break;
      }
      case 'truth_lens': {
        const from = new THREE.Vector3(0, world.deckY + 10, 0);
        const to = new THREE.Vector3(group.cx, group.cy + 2, group.cz);
        const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.6, phone ? 3 : 7, from.distanceTo(to), 12, 1, true), new THREE.MeshBasicMaterial({ color: 0xfff6c8, transparent: true, opacity: phone ? 0.35 : 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
        beam.name = 'truth-lens-beam';
        beam.position.copy(from).add(to).multiplyScalar(0.5);
        beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), to.clone().sub(from).normalize());
        root.add(beam); props.push({ mesh: beam, kind: 'flash', ttl: 3, peak: beam.material.opacity });
        for (const a of group.agents) a.burn = 1;
        // The poisoned content's hidden text is the enemy's: in its red.
        if (e.reasons[0]) label(reasonLabel(e.reasons[0]), { x: lp.x, y: lp.y + 7, z: lp.z }, '#ff6a4a', 5);
        break;
      }
      case 'repo_scanner': {
        // The Repo Trap Scanner: a gold lattice drops over the workspace and
        // seals it; it sinks with its reason code. PG1 only inspects.
        const cage = new THREE.Mesh(new THREE.BoxGeometry(14, 14, 14, 3, 3, 3), new THREE.MeshBasicMaterial({ color: PG1_COLORS.gold, wireframe: true, transparent: true, opacity: 0.9 }));
        cage.name = 'repo-scanner-lattice';
        cage.position.set(group.cx, group.cy + 30, group.cz);
        root.add(cage); props.push({ mesh: cage, kind: 'net', goalY: group.cy, ttl: 6 });
        for (const a of group.agents) a.sink = 1;
        if (e.reasons[0]) label(reasonLabel(e.reasons[0]), { x: lp.x, y: lp.y + 7, z: lp.z }, '#ff6a4a', 5);
        break;
      }
      case 'supply_inspector': world.xray.material.opacity = 0.6; world.crane.rotation.y = 0.5; for (const a of group.agents) a.sink = 1; break;
      case 'passkey_vault': if (e.verdict === 'LOCKOUT_ALERT') { const d = world.vaultDoors[1]; d.userData.goal = d.userData.down; d.userData.until = now + 20000; } break;
      case 'toll_bridge': world.tollBarrier.material.emissive.setHex(PG1_COLORS.amber); world.tollBarrier.material.emissiveIntensity = 1.8; world.tollBarrier.userData.until = now + 3000; break;
      case 'preflight_ward':
        world.preflight.forEach((p, i) => { p.seqAt = now + i * 220; p.decideAt = now + 1500; p.until = now + 6000; p.decision = e.verdict === 'flagged' ? PG1_COLORS.amber : e.verdict === 'no_flags' ? PG1_COLORS.cyan : PG1_COLORS.white; });
        break;
      default: break;
    }
    // Any gadget answering at the edge makes the shield ripple where the traffic hit.
    const hb = Math.atan2(group.cx, -group.cz);
    world.dome.uHit.value.set(Math.sin(hb), e.gadget === 'rate_shield' ? 0.5 : 0.25, -Math.cos(hb)); world.dome.uHitT.value = 0;
    fire(e.gadget, e);
    defenceLabel(e, lp);
  }

  // Attackers for one real event (delta: how many it added since the last poll).
  function stage(event, delta, { perEventCap = settings.perEvent } = {}) {
    if (event.role === 'kingdom') return stageKingdom(event, delta);
    if (event.role === 'ally') {
      if (event.verdict === 'PARTNER_CALL') { for (let k = 0; k < Math.min(3, delta); k++) spawnPartner(event); fire('allies', event); return; }
      spawnAllyBoat(event, event.verdict === 'JOB_PAID' ? cargoShips : allyBoats);
      if (event.gadget === 'toll_bridge') { world.tollBarrier.material.emissive.setHex(PG1_COLORS.green); world.tollBarrier.material.emissiveIntensity = 1.8; world.tollBarrier.userData.until = performance.now() + 4000; }
      fire(event.gadget, event);
      return;
    }
    const fog = !event.country;
    const bearing = fog ? world.fogBearing + (Math.random() - 0.5) * 0.3 : countryBearing(event.country);
    const kind = RIVER_GADGETS.has(event.gadget) ? 'boat' : event.gadget === 'rate_shield' ? 'swarm' : event.gadget === 'passkey_vault' ? 'signal' : event.gadget === 'repo_scanner' ? 'workspace' : 'scanner';
    const crowd = kind === 'boat' ? darkBoats : kind === 'swarm' ? swarm : kind === 'signal' ? signals : kind === 'workspace' ? workspaces : scanners;
    if (!crowd.free) return;
    let gate = 'river'; let start; let target;
    if (kind === 'boat') {
      const side = event.gadget === 'supply_inspector' ? 1 : (Math.sin(bearing) >= 0 ? 1 : -1);
      start = { x: side * 1300, y: -3.4, z: RIVER.z + (Math.random() - 0.5) * 30 };
      target = event.gadget === 'supply_inspector' ? { x: world.harbour.point.x + 20, y: -3.4, z: world.harbour.point.z + 6 } : { x: side * 55, y: -3.4, z: RIVER.z };
    } else if (kind === 'signal') {
      const p = at(bearing, 760, 160); start = p; target = { x: 34, y: 5, z: 0 }; gate = 'vault';
    } else {
      gate = event.gadget === 'toll_bridge' ? 'south' : nearestGate(bearing);
      const g = world.gates[gate];
      start = { ...at(bearing, 900, 90) };
      target = { x: g.mouth.x, y: g.mouth.y + (gate === 'south' ? 6 : 0), z: g.mouth.z };
    }
    const n = Math.max(1, Math.min(delta, perEventCap, crowd.free, kind === 'boat' ? 3 : kind === 'workspace' ? 4 : 999));
    const group = groups.get(event.id) || { event, agents: [], gate, kind, phase: 'advance', t: 0, cx: target.x, cy: target.y, cz: target.z, start };
    group.event = event;
    for (let k = 0; k < n; k++) {
      const jx = (k % 7 - 3) * (kind === 'boat' ? 22 : 6); const jy = Math.floor(k / 7) * 5;
      const a = crowd.add({ x: start.x + (kind === 'boat' ? jx : jx * 0.6), y: start.y + (kind === 'boat' ? 0 : jy), z: start.z + (kind === 'boat' ? 0 : jx * 0.6), tx: target.x + (kind === 'boat' ? jx * 0.4 : jx * 0.5), ty: target.y + (kind === 'boat' ? 0 : jy * 0.5), tz: target.z + (kind === 'boat' ? 0 : jx * 0.5), speed: kind === 'boat' ? 30 : kind === 'signal' ? 70 : kind === 'workspace' ? 36 : 48, eventId: event.id, delay: k * 0.05, scale: kind === 'boat' ? 1 : kind === 'swarm' ? S * 0.6 : kind === 'signal' ? 2.4 : kind === 'workspace' ? S * 1.3 : S });
      if (a) group.agents.push(a);
    }
    groups.set(event.id, group);
    // The nearest free sentinel turns to the threat and escorts it, from inside the city.
    if (!group.escort) {
      const post = insideCity(kind === 'boat' ? { x: Math.sign(target.x || 1) * 40, y: 30, z: RIVER.z - 40 } : kind === 'signal' ? { x: 40, y: 20, z: 10 } : { ...world.gates[gate].inside });
      let best = null; let bd = Infinity;
      for (const sn of sentinels.agents) { if (sn.escort) continue; const d = Math.hypot(sn.x - post.x, sn.z - post.z); if (d < bd) { bd = d; best = sn; } }
      if (best) { best.escort = event.id; best.post = post; group.escort = best; }
    }
  }

  function stageKingdom(event, delta) {
    const now = performance.now();
    switch (event.gadget) {
      case 'seal_forge': {
        world.forge.seal.emissiveIntensity = Math.min(4, 1.2 + Math.log10(1 + delta));
        const seal = new THREE.Mesh(new THREE.TorusGeometry(2.4, 0.3, 8, 28), new THREE.MeshBasicMaterial({ color: event.verdict === 'SEAL_VERIFIED' ? PG1_COLORS.cyan : 0xbfe6ff, transparent: true, opacity: 0.95 }));
        seal.name = 'seal';
        const f = world.forge.group.position;
        seal.position.set(f.x, f.y + 3, f.z);
        root.add(seal);
        props.push({ mesh: seal, kind: 'seal', from: seal.position.clone(), to: new THREE.Vector3(0, world.deckY - 9, 12), ttl: 5, dur: 5 });
        if (event.verdict === 'SEAL_VERIFIED') defenceLabel(event, { x: f.x, y: f.y + 14, z: f.z });
        break;
      }
      case 'beacons': {
        const b = world.beacons[event.check === 'weekly_report' ? 1 : 0] || null;
        if (!b) return;
        if (event.verdict === 'REPORT_LANDED') {
          b.goal = 1; b.until = now + 3 * 60000;
          cmd.mode = 'report'; cmd.target = insideCity({ x: b.fire.position.x, y: b.fire.position.y + 12, z: b.fire.position.z }); cmd.until = now + 14000;
        }
        defenceLabel(event, { x: b.fire.position.x, y: b.fire.position.y + 14, z: b.fire.position.z });
        break;
      }
      case 'repair_crews': {
        const spots = world.roofSpots.filter((s) => Math.hypot(s.x, s.z) < CITY_R - 20);
        let h = 0; for (const ch of event.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        const spot = spots.length ? spots[h % spots.length] : { x: -80, y: 60, z: -60, h: 60, w: 20 };
        const flick = new THREE.Mesh(new THREE.BoxGeometry(spot.w + 1, spot.h, spot.w + 1), new THREE.MeshBasicMaterial({ color: 0xfff1d0, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false }));
        flick.name = 'repair-flicker';
        flick.position.set(spot.x, spot.h / 2, spot.z);
        root.add(flick); props.push({ mesh: flick, kind: 'flicker', ttl: 8 });
        let n = 0;
        for (const r of repair.agents) { if (r.target || n >= 2) continue; r.target = insideCity({ x: spot.x + (n ? 8 : -8), y: spot.y + 6, z: spot.z }); r.until = now + 9000; n++; }
        defenceLabel(event, { x: spot.x, y: spot.y + 16, z: spot.z });
        break;
      }
      default: return;
    }
    fire(event.gadget, event);
  }

  const camTmp = new THREE.Vector3();
  let pg1MaxR = 0;
  const moveTo = (a, t, sp, dt) => { const dx = t.x - a.x; const dy = t.y - a.y; const dz = t.z - a.z; const d = Math.hypot(dx, dy, dz); if (d > 0.3) { const k = Math.min(1, (sp * dt) / d); a.x += dx * k; a.y += dy * k; a.z += dz * k; if (Math.hypot(dx, dz) > 0.5) a.heading = Math.atan2(dx, dz); } return d; };
  function update(dt, t, camera, { storm = 0 } = {}) {
    camTmp.copy(camera.position);
    const now = performance.now();
    for (const [id, g] of groups) {
      g.t += dt;
      let arrived = 0;
      for (const a of g.agents) {
        if (a.delay > 0) { a.delay -= dt; continue; }
        if (g.phase === 'advance') { if (moveTo(a, { x: a.tx, y: a.ty, z: a.tz }, a.speed, dt) < 3) arrived++; a.phase += dt * 3; }
        else if (g.phase === 'retreat') {
          if (a.burn) { a.scale = Math.max(0, a.scale - dt * 0.6 * (a.scale > 1 ? a.scale : 1)); a.y += dt * 2; if (a.scale < 0.05) a.fade = 0; }
          else if (a.sink) { a.y -= dt * 2.4; a.fade = Math.max(0, a.fade - dt * 0.35); }
          else { moveTo(a, g.start, a.speed, dt); const rr = Math.hypot(a.x, a.z); if (rr > CITY_R + 150) a.fade = Math.max(0, a.fade - dt * 0.6); }
        }
      }
      if (g.phase === 'advance' && (arrived >= Math.ceil(g.agents.length * 0.6) || g.t > 40)) { g.phase = 'hold'; g.hold = 2.4; respond(g); }
      if (g.phase === 'hold') { g.hold -= dt; if (g.hold <= 0) g.phase = 'retreat'; }
      if (g.phase === 'retreat' && g.agents.every((a) => a.fade <= 0.02)) g.phase = 'gone';
      if (g.phase === 'gone' || g.t > 120) { const set = new Set(g.agents); for (const c of ENEMIES) c.remove((a) => set.has(a)); if (g.escort) { g.escort.escort = null; g.escort.post = null; } groups.delete(id); }
    }
    // Sentinels: patrol rings; an escort hovers inside the city facing the threat.
    for (const a of sentinels.agents) {
      if (a.escort && a.post) { moveTo(a, a.post, 60, dt); const g = groups.get(a.escort); const lead = g && g.agents[0]; if (lead) a.heading = Math.atan2(lead.x - a.x, lead.z - a.z); }
      else { const ang = a.a0 + a.dir * t * 0.05; moveTo(a, { x: Math.sin(ang) * a.ring, y: a.alt, z: -Math.cos(ang) * a.ring }, 60, dt); }
    }
    if (cmd.mode !== 'docked' && cmd.until && now > cmd.until) { cmd.mode = 'docked'; cmd.target = { ...DOCK }; cmd.until = 0; }
    moveTo(cmd, cmd.target, 45, dt);
    for (const r of repair.agents) { if (r.until && now > r.until) { r.target = null; r.until = 0; } moveTo(r, r.target || r.home, 40, dt); }
    // Pilots: idle by the pier; one leads an arriving ally in.
    const arriving = [...allyBoats.agents, ...cargoShips.agents].find((b) => b.leg === 0);
    pilots.agents.forEach((p, i) => {
      if (arriving && i === 0) moveTo(p, insideCity({ x: arriving.x - 30, y: -3.4, z: arriving.z - 8 }), 34, dt);
      else { const ang = t * 0.1 + p.a0; moveTo(p, { x: p.home.x + Math.sin(ang) * 18, y: -3.4, z: p.home.z + Math.cos(ang) * 6 }, 6, dt); }
    });
    // Rovers on the embankment road; lights up in a storm or a flood.
    const flood = swarm.live > 10;
    for (const a of rovers.agents) { a.x += a.dir * a.speed * dt; if (Math.abs(a.x) > 300) a.dir *= -1; a.heading = a.dir > 0 ? Math.PI / 2 : -Math.PI / 2; a.z = bankZ; a.y = 0; }
    roverLight.color.setHex(storm > 0.5 || flood ? 0xf5f7fa : 0x6a6f75);
    // Allies: boats sail to the pier and stay a while; partner drones visit and leave.
    for (const c of [allyBoats, cargoShips]) {
      for (const b of c.agents) {
        b.t += dt;
        const leg = b.path[Math.min(b.leg, b.path.length - 1)];
        if (b.leg < b.path.length) { if (moveTo(b, { x: leg.x, y: -3.4, z: leg.z }, b.speed, dt) < 3) b.leg++; }
        else if (b.t > 60) b.fade = Math.max(0, b.fade - dt * 0.3);
      }
      c.remove((b) => b.fade <= 0.02);
    }
    for (const a of partners.agents) { a.t += dt; const back = a.t > 14; moveTo(a, back ? a.from : a.to, 40, dt); if (back && Math.hypot(a.x - a.from.x, a.z - a.from.z) < 3) a.done = true; }
    partners.remove((a) => a.done);
    // The Rate Shield thickens under floods.
    shieldLoad += (Math.min(1, swarm.live / 40) - shieldLoad) * Math.min(1, dt * 0.8);
    world.dome.uThick.value = shieldLoad;
    // The bridge lanterns: lamps, lit from dusk (no payment count).
    world.lanterns.forEach((l) => { const goal = world.env.night > 0.3 ? 1.6 : 0.2; l.material.emissiveIntensity += (goal - l.material.emissiveIntensity) * Math.min(1, dt * 1.5); });
    const tb = world.tollBarrier;
    if (tb.userData.until && now > tb.userData.until) { tb.userData.until = 0; tb.material.emissive.setHex(PG1_COLORS.amber); tb.material.emissiveIntensity = 0.25; }
    tb.rotation.z += ((tb.material.emissive.getHex() === PG1_COLORS.green && tb.userData.until ? -1.2 : 0) - tb.rotation.z) * Math.min(1, dt * 2);
    for (const pc of Object.values(world.portcullis)) if (pc.userData.until && now > pc.userData.until) { pc.userData.until = 0; pc.userData.goal = pc.userData.up; }
    for (const d of world.vaultDoors) if (d.userData.until && now > d.userData.until) { d.userData.until = 0; d.userData.goal = d.userData.up; }
    for (const b of world.beacons) if (b.until && now > b.until) { b.until = 0; b.goal = b.approval ? 1 : 0; }
    for (const p of world.preflight) { if (!p.until) continue; if (now > p.decideAt) p.mat.color.setHex(p.decision); else if (now > p.seqAt) p.mat.color.setHex(PG1_COLORS.cyan); }
    world.crane.rotation.y += (0 - world.crane.rotation.y) * Math.min(1, dt * 0.4);
    for (const pr of props) {
      pr.ttl -= dt;
      if (pr.kind === 'net') pr.mesh.position.y += (pr.goalY - pr.mesh.position.y) * Math.min(1, dt * 3);
      if (pr.kind === 'flash') pr.mesh.material.opacity = Math.max(0, pr.ttl / 3) * (pr.peak || 0.9);
      if (pr.kind === 'flicker') pr.mesh.material.opacity = (Math.sin(t * 7) > 0.2 ? 0.25 : 0.05) * Math.min(1, pr.ttl / 2);
      if (pr.kind === 'seal') { const k = 1 - pr.ttl / pr.dur; pr.mesh.position.lerpVectors(pr.from, pr.to, k * k * (3 - 2 * k)); pr.mesh.rotation.y += dt * 2; pr.mesh.material.opacity = Math.min(1, pr.ttl); }
      if (pr.ttl <= 0) { root.remove(pr.mesh); pr.mesh.geometry.dispose(); pr.mesh.material.dispose(); }
    }
    for (let i = props.length - 1; i >= 0; i--) if (props[i].ttl <= 0) props.splice(i, 1);
    for (const l of labels) { l.ttl -= dt; l.sp.position.y = l.y0 + Math.min(4, (6 - l.ttl) * 0.6); l.sp.material.opacity = Math.min(1, Math.max(0, l.ttl)); }
    for (let i = labels.length - 1; i >= 0; i--) if (labels[i].ttl <= 0) { root.remove(labels[i].sp); labels[i].sp.material.map.dispose(); labels[i].sp.material.dispose(); labels.splice(i, 1); }
    for (const c of PG1_UNITS) for (const a of c.agents) { const rr = Math.hypot(a.x, a.z); if (rr > pg1MaxR) pg1MaxR = rr; }
    for (const c of crowds) c.write(t, camTmp);
  }

  function whereIs(id) {
    const g = groups.get(id);
    if (g) { const a = g.agents.find((x) => x.fade > 0.05) || g.agents[0]; if (a) return { x: a.x, y: a.y, z: a.z }; return { x: g.cx, y: g.cy, z: g.cz }; }
    for (const c of [allyBoats, cargoShips, partners]) { const b = c.agents.find((x) => x.eventId === id); if (b) return { x: b.x, y: b.y + 4, z: b.z }; }
    return null;
  }

  const ray = new THREE.Raycaster();
  function pick(ndc, camera) {
    ray.setFromCamera(ndc, camera);
    for (const c of ENEMIES) {
      const hit = ray.intersectObject(c.pickMesh, false)[0];
      if (hit && hit.instanceId != null && c.agents[hit.instanceId]) return c.agents[hit.instanceId].eventId;
    }
    return null;
  }

  return {
    stage, update, whereIs, pick, setSentinels,
    set onFire(fn) { onFire = typeof fn === 'function' ? fn : null; },
    setLanterns(n) { lanternsLit = Math.max(0, Math.min(world.lanterns.length, Number(n) || 0)); return lanternsLit; },
    commanderTo(p) { if (p) { cmd.mode = 'hover'; cmd.target = insideCity({ x: p.x, y: Math.max((p.y || 0) + 30, 50), z: p.z }, CITY_R - 40); cmd.until = performance.now() + 15000; } else if (cmd.mode === 'hover') { cmd.mode = 'docked'; cmd.target = { ...DOCK }; } },
    get commanderMode() { return cmd.mode; },
    get fired() { return { ...fired }; },
    get pg1MaxR() { return pg1MaxR; },
    get sentinels() { return sentinels.live; },
    get lanterns() { return lanternsLit; },
    get attackers() { return ENEMIES.reduce((n, c) => n + c.live, 0); },
    // Every hull on the river (event boats and PG1's pilots), so the city's
    // own boats keep clear of them: { x, z, len, wid }.
    riverBoats() {
      const out = [];
      for (const [c, len, wid] of [[darkBoats, 15, 4.2], [allyBoats, 15, 4.2], [cargoShips, 30, 7], [pilots, 8, 2.6]]) for (const a of c.agents) if (a.fade > 0.05 && a.y < 0) out.push({ x: a.x, z: a.z, len: len * (a.scale || 1), wid });
      return out;
    },
    get activeIds() { return [...groups.keys(), ...allyBoats.agents.filter((b) => b.leg < b.path.length).map((b) => b.eventId), ...cargoShips.agents.filter((b) => b.leg < b.path.length).map((b) => b.eventId)]; },
    dispose() { scene.remove(root); root.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); }); }); }
  };
}
