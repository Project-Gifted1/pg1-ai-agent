// PG1 Kingdom Defence: everyone who moves, and what each gadget does.
//
// Crowds are instanced (one draw call per body part per kind), so a wave of
// hundreds stays smooth; the Phone tier draws fewer parts (no arms, a baked
// blob shadow instead of a real one) and the camera's distance picks a
// lower detail for far figures (legs stop swinging past LOD_FAR).
//
//   guardians  sentinels walking the wall, archers on the towers, two
//              gatekeepers at each gate and the commander on the keep:
//              idle, patrol, alert (an attacker near: arms up) and action
//   raiders    hooded figures: probes, malformed calls, unpaid calls,
//              refused payers, flagged checks
//   drones     siege drones: rate-limit floods
//   shadows    shadow creatures: malicious or suspicious agent messages,
//              failed sign-ins (they fly at the vault)
//   ships      allies: settled payments sail into the harbour
//
// stage(event, delta) turns one real event into figures and the gadget's
// answer; nothing is ever staged without an event.

import { at, WALL_R, MOAT_OUT, SHORE_R, ISLAND_R, islandHeight, GATE_BEARINGS } from './kingdom-world.js';
import { countryBearing, GADGET_META } from './kingdom-data.js';

export const LOD_FAR = 260;
const GATE_NAMES = Object.keys(GATE_BEARINGS);

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
    for (const p of this.parts) p.mesh.count = n;
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

// Body parts, shared by the humanoid crowds. Limbs hang from their joints
// (the pivot moves the geometry so it swings from the hip or shoulder).
function humanoidParts(THREE, { body, skin, hood = null, cloak = null, phone = false, eyes = null }) {
  const leg = new THREE.BoxGeometry(0.28, 0.9, 0.3); leg.translate(0, -0.45, 0);
  const arm = new THREE.BoxGeometry(0.22, 0.8, 0.24); arm.translate(0, -0.4, 0);
  const torso = new THREE.CylinderGeometry(0.34, 0.42, 0.95, 10);
  const head = new THREE.SphereGeometry(0.26, 12, 10);
  const parts = [
    { geo: torso, mat: cloak || body, offset: [0, 1.38, 0], swing: null },
    { geo: head, mat: hood ? hood : skin, offset: [0, 2.06, 0], swing: null },
    { geo: leg, mat: body, offset: [-0.16, 0.92, 0], swing: 'legL' },
    { geo: leg, mat: body, offset: [0.16, 0.92, 0], swing: 'legR' }
  ];
  if (hood) parts.push({ geo: new THREE.ConeGeometry(0.33, 0.62, 10), mat: hood, offset: [0, 2.3, -0.02], swing: null });
  if (eyes) parts.push({ geo: new THREE.BoxGeometry(0.26, 0.05, 0.05), mat: eyes, offset: [0, 2.07, 0.24], swing: null });
  if (!phone) {
    parts.push({ geo: arm, mat: cloak || body, offset: [-0.46, 1.8, 0], swing: 'armL' });
    parts.push({ geo: arm, mat: cloak || body, offset: [0.46, 1.8, 0], swing: 'armR' });
  } else {
    const blob = new THREE.CircleGeometry(0.6, 12); blob.rotateX(-Math.PI / 2);
    parts.push({ geo: blob, mat: new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false }), offset: [0, 0.06, 0], swing: null, flat: true });
  }
  return parts;
}

// A quadcopter: body, four arms, four spinning rotors, a camera pod and a
// light (red on an attacker's siege drone, cyan on PG1's patrols).
function quadParts(THREE, M, light) {
  const parts = [
    { geo: new THREE.BoxGeometry(0.9, 0.28, 0.9), mat: M(0x2a2e34, { metalness: 0.7, roughness: 0.35 }), offset: [0, 0, 0], swing: null },
    { geo: new THREE.BoxGeometry(0.42, 0.3, 0.42), mat: M(0x15181c, { metalness: 0.5, roughness: 0.3 }), offset: [0, -0.3, 0.1], swing: null },
    { geo: new THREE.SphereGeometry(0.1, 8, 6), mat: new THREE.MeshBasicMaterial({ color: light }), offset: [0, -0.1, 0.5], swing: null, flat: true }
  ];
  const arm = new THREE.BoxGeometry(2.2, 0.08, 0.12);
  parts.push({ geo: arm, mat: parts[0].mat, offset: [0, 0.05, 0], swing: 'yaw45' });
  parts.push({ geo: arm, mat: parts[0].mat, offset: [0, 0.05, 0], swing: 'yaw-45' });
  const rotor = new THREE.CylinderGeometry(0.5, 0.5, 0.03, 14);
  const rm = new THREE.MeshBasicMaterial({ color: 0xb8c2cc, transparent: true, opacity: 0.3, depthWrite: false });
  for (const [x, z] of [[0.78, 0.78], [-0.78, 0.78], [0.78, -0.78], [-0.78, -0.78]]) parts.push({ geo: rotor, mat: rm, offset: [x, 0.16, z], swing: 'spin', flat: true });
  return parts;
}

function textSprite(THREE, text, color = '#ffffff') {
  const cv = document.createElement('canvas');
  const g = cv.getContext('2d');
  const fs = 44; g.font = `600 ${fs}px Inter, system-ui, sans-serif`;
  const w = Math.ceil(g.measureText(text).width) + 36;
  cv.width = w; cv.height = 72;
  g.font = `600 ${fs}px Inter, system-ui, sans-serif`;
  g.fillStyle = 'rgba(10,10,11,0.72)';
  if (g.roundRect) { g.beginPath(); g.roundRect(0, 0, w, 72, 16); g.fill(); } else g.fillRect(0, 0, w, 72);
  g.fillStyle = color; g.textBaseline = 'middle'; g.fillText(text, 18, 38);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
  sp.scale.set(w / 72 * 2.2, 2.2, 1);
  sp.renderOrder = 20;
  return sp;
}

export function createActors(THREE, scene, world, settings) {
  const root = new THREE.Group();
  root.name = 'actors';
  scene.add(root);
  const phone = settings.tier === 'phone';
  const M = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, ...o });
  const skin = M(0xd9a982);
  const guardians = new Crowd(THREE, root, humanoidParts(THREE, { body: M(0x1d232c), skin: M(0x22272f, { metalness: 0.4, roughness: 0.35 }), cloak: M(0x26303c, { metalness: 0.3, roughness: 0.5 }), phone, eyes: new THREE.MeshBasicMaterial({ color: 0x6fd8ff }) }), 64);
  const raiders = new Crowd(THREE, root, humanoidParts(THREE, { body: M(0x2b2522), skin, hood: M(0x3a2f2b), cloak: M(0x4a3a33), phone, eyes: new THREE.MeshBasicMaterial({ color: 0xff6a4a }) }), settings.crowdCap);
  const shadows = new Crowd(THREE, root, humanoidParts(THREE, { body: M(0x0d0b12, { transparent: true, opacity: 0.85 }), skin, hood: M(0x15121c, { emissive: 0x2a1040, emissiveIntensity: 0.6 }), phone, eyes: new THREE.MeshBasicMaterial({ color: 0xb04cff }) }), Math.round(settings.crowdCap / 3));
  const drones = new Crowd(THREE, root, quadParts(THREE, M, 0xff3d3d), Math.round(settings.crowdCap / 3), { fly: 1 });
  // PG1's own patrol drones, circling the city (ambient: always there, never an event).
  const patrol = new Crowd(THREE, root, quadParts(THREE, M, 0x6fd8ff), 8, { fly: 1 });
  for (let k = 0; k < (phone ? 4 : 8); k++) patrol.add({ ring: 40 + (k % 3) * 18, a0: (k / 8) * Math.PI * 2, alt: 30 + (k % 4) * 9, dir: k % 2 ? 1 : -1, scale: 1.3 });
  const crowds = [guardians, raiders, shadows, drones, patrol];

  // Ships (allies) and nets, scrolls and crates (gadget props): small pools.
  const shipGeo = new THREE.BoxGeometry(3, 1.2, 9); const sailGeo = new THREE.BoxGeometry(2.4, 1.2, 4);
  const ships = [];
  const props = [];
  const labels = [];

  // --- guardians: posts and patrols ---
  const posts = [];
  for (let k = 0; k < 12; k++) posts.push({ role: 'sentinel', ring: WALL_R - 0.4, a0: (k / 12) * Math.PI * 2, y: 2.2 + 8.3, dir: k % 2 ? 1 : -1 });
  for (const n of GATE_NAMES) for (const s of [-1, 1]) { const p = at(GATE_BEARINGS[n] + s * 0.07, WALL_R + 5); posts.push({ role: 'gatekeeper', x: p.x, z: p.z, y: 2.2, a0: GATE_BEARINGS[n], gate: n }); }
  for (let k = 0; k < 8; k++) { const p = at((k / 8) * Math.PI * 2 + Math.PI / 8, WALL_R); posts.push({ role: 'archer', x: p.x, z: p.z, y: 2.2 + 18.6, a0: (k / 8) * Math.PI * 2 + Math.PI / 8 }); }
  posts.push({ role: 'commander', x: -6, z: 10, y: 2.2 + 7, a0: 0 });
  for (const p of posts) guardians.add({ post: p, x: p.x || 0, y: p.y, z: p.z || 0, heading: p.a0 + Math.PI, scale: p.role === 'commander' ? 1.15 : 1 });

  const gateState = Object.fromEntries(GATE_NAMES.map((n) => [n, { alert: 0 }]));
  const groups = new Map(); // event id -> { event, agents, gate, phase, t, done }
  let shieldLoad = 0;
  let lanternsLit = 0;
  const pending = [];

  function label(text, pos, color, ttl = 6) {
    const sp = textSprite(THREE, text, color);
    sp.position.set(pos.x, pos.y, pos.z);
    root.add(sp);
    labels.push({ sp, ttl, y0: pos.y });
    if (labels.length > 6) { const old = labels.shift(); root.remove(old.sp); old.sp.material.map.dispose(); old.sp.material.dispose(); }
  }

  function spawnShip(event) {
    const b = countryBearing(event.country || 'IE');
    const start = at(b, 900, 0);
    const g = new THREE.Group();
    const hull = new THREE.Mesh(shipGeo, M(0xe9edf1, { metalness: 0.2, roughness: 0.4 })); hull.position.y = 0.5; g.add(hull);
    const cabin = new THREE.Mesh(sailGeo, M(0x1c3a58, { metalness: 0.9, roughness: 0.08, emissive: 0xffe2b0, emissiveIntensity: 0.5 })); cabin.position.set(0, 1.7, -0.6); g.add(cabin);
    const banner = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.12, 0.12), new THREE.MeshBasicMaterial({ color: GADGET_META.toll_bridge.color })); banner.position.set(0, 2.5, 1.8); g.add(banner);
    g.position.set(start.x, 0.2, start.z);
    root.add(g);
    ships.push({ g, from: start, to: world.harbour.point, t: 0, dur: 14, event });
    if (ships.length > 8) { const old = ships.shift(); root.remove(old.g); }
  }

  // The gadget's answer to one event, when its figures reach the gate.
  function respond(group) {
    const e = group.event; const gate = group.gate;
    const where = world.gates[gate] || world.gates.east;
    const p = where.mouth;
    const color = '#' + ((GADGET_META[e.gadget] || {}).color || 0xffffff).toString(16).padStart(6, '0');
    switch (e.gadget) {
      case 'sanctions_gate':
        for (const n of GATE_NAMES) world.portcullis[n].userData.goal = world.portcullis[n].userData.down;
        setTimeout(() => { for (const n of GATE_NAMES) world.portcullis[n].userData.goal = world.portcullis[n].userData.up; }, 6000);
        break;
      case 'phishing_net': {
        const net = new THREE.Mesh(new THREE.SphereGeometry(4.5, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x36d1c4, wireframe: true, transparent: true, opacity: 0.9 }));
        net.position.set(group.cx, 30, group.cz);
        root.add(net);
        props.push({ mesh: net, kind: 'net', goalY: group.cy, ttl: 7 });
        break;
      }
      case 'truth_lens':
        for (const a of group.agents) a.burn = 1;
        break;
      case 'supply_inspector':
        for (const a of group.agents) a.sink = 1;
        break;
      case 'passkey_vault':
        if (e.verdict === 'LOCKOUT_ALERT') { world.vaultDoors[1].userData.goal = world.vaultDoors[1].userData.down; setTimeout(() => { world.vaultDoors[1].userData.goal = world.vaultDoors[1].userData.up; }, 20000); }
        break;
      case 'toll_bridge':
        world.tollBarrier.rotation.z = 0;
        break;
      default:
        break;
    }
    const lead = group.agents[0];
    const lp = lead ? { x: lead.x, y: lead.y + 4.2, z: lead.z } : { x: p.x, y: p.y + 4, z: p.z };
    const code = e.reasons[0] ? e.reasons[0].replace(/^(?:AGENT_MESSAGE|HOSTNAME|PACKAGE|DOMAIN|WALLET)_/, '') : e.verdict;
    label(`${code}${e.count > 1 ? ` ×${e.count}` : ''}`, lp, color);
    gateState[gate].alert = 1;
  }

  // Figures for one real event (delta: how many it added since the last poll).
  function stage(event, delta, { perEventCap = settings.perEvent } = {}) {
    if (event.role === 'kingdom') return stageKingdom(event, delta);
    if (event.role === 'ally') { spawnShip(event); lanternsLit = Math.min(world.lanterns.length, lanternsLit + 1); return; }
    const fog = !event.country;
    const bearing = fog ? world.fogBearing + (Math.random() - 0.5) * 0.4 : countryBearing(event.country);
    const crowd = event.gadget === 'rate_shield' ? drones : (event.gadget === 'truth_lens' || event.gadget === 'passkey_vault') ? shadows : raiders;
    let gate = nearestGate(bearing);
    if (event.gadget === 'toll_bridge') gate = 'south';
    let target = (world.gates[gate] || world.gates.east).mouth;
    if (event.gadget === 'supply_inspector') target = world.harbour.point;
    if (event.gadget === 'passkey_vault') target = { x: 16, y: 6, z: 0 };
    const n = Math.max(1, Math.min(delta, perEventCap, crowd.free));
    if (!crowd.free) return;
    const group = groups.get(event.id) || { event, agents: [], gate, phase: 'advance', t: 0, cx: target.x, cy: target.y, cz: target.z };
    group.event = event;
    const fly = crowd === drones || event.gadget === 'passkey_vault';
    const start = at(bearing, fly ? SHORE_R + 30 : SHORE_R + (fog ? 10 : 0));
    for (let k = 0; k < n; k++) {
      const jitter = (k % 7 - 3) * 1.4; const row = Math.floor(k / 7) * 1.8;
      const sx = start.x + Math.cos(bearing) * jitter - Math.sin(bearing) * row; const sz = start.z + Math.sin(bearing) * jitter + Math.cos(bearing) * row;
      const a = crowd.add({ x: sx, z: sz, y: fly ? 14 : islandHeight(SHORE_R), tx: target.x + Math.cos(bearing) * jitter * 0.6, tz: target.z + Math.sin(bearing) * jitter * 0.6, ty: fly ? (event.gadget === 'passkey_vault' ? 8 : 18) : target.y, speed: fly ? 9 : 3.2 + Math.random() * 0.6, eventId: event.id, fly, delay: k * 0.06 });
      if (a) group.agents.push(a);
    }
    groups.set(event.id, group);
  }

  function stageKingdom(event, delta) {
    switch (event.gadget) {
      case 'seal_forge':
        world.forge.seal.emissiveIntensity = Math.min(4, 1.2 + Math.log10(1 + delta));
        break;
      case 'beacons': {
        const b = world.beacons[(event.verdict === 'NEEDS_APPROVAL' ? 1 : 0) + (event.check === 'weekly_report' ? 2 : 0)] || world.beacons[0];
        b.goal = 1; b.until = performance.now() + (event.verdict === 'NEEDS_APPROVAL' ? 10 * 60000 : 3 * 60000);
        label(event.verdict === 'NEEDS_APPROVAL' ? 'Needs Gift' : 'Report landed', { x: b.fire.position.x, y: b.fire.position.y + 4, z: b.fire.position.z }, '#ffb300', 8);
        break;
      }
      case 'keep_wall': {
        const flash = new THREE.Mesh(new THREE.SphereGeometry(2.4, 12, 10), new THREE.MeshBasicMaterial({ color: 0xff7a45, transparent: true, opacity: 0.9, depthWrite: false }));
        flash.position.set(-9.4, 14 + Math.random() * 8, (Math.random() - 0.5) * 12);
        root.add(flash);
        props.push({ mesh: flash, kind: 'flash', ttl: 2.2 });
        label(event.verdict === 'SOURCE_FAULT' ? 'Source fault' : 'PG1 fault', { x: -10, y: 30, z: 0 }, '#ff7a45', 6);
        break;
      }
      default:
        break;
    }
  }

  const camTmp = new THREE.Vector3();
  function update(dt, t, camera) {
    camTmp.copy(camera.position);
    const anyNear = { north: 0, east: 0, south: 0, west: 0 };
    // Attackers: advance to the gate, are answered, then retreat (or burn, or sink).
    for (const [id, g] of groups) {
      g.t += dt;
      let arrived = 0;
      for (const a of g.agents) {
        if (a.delay > 0) { a.delay -= dt; continue; }
        if (g.phase === 'advance') {
          const dx = a.tx - a.x; const dz = a.tz - a.z; const d = Math.hypot(dx, dz);
          if (d > 1.2) { const s = Math.min(d, a.speed * dt); a.x += (dx / d) * s; a.z += (dz / d) * s; a.heading = Math.atan2(dx, dz); a.phase += s * 2.6; if (!a.fly) a.y = islandHeight(Math.hypot(a.x, a.z)) + (Math.hypot(a.x, a.z) < MOAT_OUT + 6 ? 0.4 : 0); else a.y += (a.ty - a.y) * Math.min(1, dt); }
          else arrived++;
        } else if (g.phase === 'retreat') {
          const r = Math.hypot(a.x, a.z) || 1;
          if (a.burn) { a.scale = Math.max(0, a.scale - dt * 0.5); a.y += dt * 0.6; }
          else if (a.sink) { a.y -= dt * 1.4; a.fade = Math.max(0, a.fade - dt * 0.35); }
          else { a.x += (a.x / r) * a.speed * dt; a.z += (a.z / r) * a.speed * dt; a.heading = Math.atan2(a.x, a.z); a.phase += a.speed * dt * 2.6; if (!a.fly) a.y = islandHeight(r); if (r > SHORE_R - 6) a.fade = Math.max(0, a.fade - dt * 0.6); }
        }
        if (g.phase !== 'gone') anyNear[g.gate] += 1;
      }
      if (g.phase === 'advance' && (arrived >= Math.ceil(g.agents.length * 0.6) || g.t > 45)) { g.phase = 'hold'; g.hold = 2.2; respond(g); }
      if (g.phase === 'hold') { g.hold -= dt; if (g.hold <= 0) g.phase = 'retreat'; }
      if (g.phase === 'retreat' && g.agents.every((a) => a.fade <= 0.02 || a.scale <= 0.02)) g.phase = 'gone';
      if (g.phase === 'gone') { const set = new Set(g.agents); for (const c of crowds) c.remove((a) => set.has(a)); groups.delete(id); }
    }
    // Guardians: patrol the wall, turn to an alert gate, raise arms.
    for (const a of guardians.agents) {
      const p = a.post;
      if (p.role === 'sentinel') {
        const ang = p.a0 + p.dir * t * 0.035;
        a.x = Math.sin(ang) * p.ring; a.z = -Math.cos(ang) * p.ring; a.heading = ang + (p.dir > 0 ? Math.PI / 2 : -Math.PI / 2); a.speed = 1.6; a.phase += dt * 4.2;
      } else {
        a.speed = 0;
        const near = p.gate ? anyNear[p.gate] : 0;
        a.arms += ((near ? 1 : 0) - a.arms) * Math.min(1, dt * 3);
        if (p.role === 'commander') a.heading = Math.sin(t * 0.2) * 1.2;
      }
    }
    for (const n of GATE_NAMES) gateState[n].alert = Math.max(0, gateState[n].alert - dt * 0.2);
    // The Rate Shield thickens under floods and thins again.
    const flood = drones.live;
    shieldLoad += (Math.min(1, flood / 40) - shieldLoad) * Math.min(1, dt * 0.8);
    world.dome.uThick.value = shieldLoad;
    // Ships.
    for (const s of ships) {
      s.t += dt; const k = Math.min(1, s.t / s.dur); const e = k * k * (3 - 2 * k);
      s.g.position.set(s.from.x + (s.to.x - s.from.x) * e, 0.3 + Math.sin(t * 1.3) * 0.15, s.from.z + (s.to.z - s.from.z) * e);
      s.g.rotation.y = Math.atan2(s.to.x - s.from.x, s.to.z - s.from.z);
    }
    // Lanterns: one lit per payment that crossed while the view was open.
    world.lanterns.forEach((l, i) => { const goal = i < lanternsLit ? 2.2 : 0; l.material.emissiveIntensity += (goal - l.material.emissiveIntensity) * Math.min(1, dt * 1.5); });
    world.tollBarrier.rotation.z += ((ships.some((s) => s.t < s.dur) ? -1.2 : 0) - world.tollBarrier.rotation.z) * Math.min(1, dt * 2);
    for (const b of world.beacons) if (b.until && performance.now() > b.until) { b.goal = 0; b.until = 0; }
    // Props and labels.
    for (const pr of props) {
      pr.ttl -= dt;
      if (pr.kind === 'net') { pr.mesh.position.y += (pr.goalY + 0.5 - pr.mesh.position.y) * Math.min(1, dt * 3); }
      if (pr.kind === 'flash') pr.mesh.material.opacity = Math.max(0, pr.ttl / 2.2) * 0.9;
      if (pr.ttl <= 0) { root.remove(pr.mesh); pr.mesh.geometry.dispose(); pr.mesh.material.dispose(); }
    }
    for (let i = props.length - 1; i >= 0; i--) if (props[i].ttl <= 0) props.splice(i, 1);
    for (const l of labels) { l.ttl -= dt; l.sp.position.y = l.y0 + Math.min(2, (6 - l.ttl) * 0.3); l.sp.material.opacity = Math.min(1, Math.max(0, l.ttl)); }
    for (let i = labels.length - 1; i >= 0; i--) if (labels[i].ttl <= 0) { root.remove(labels[i].sp); labels[i].sp.material.map.dispose(); labels[i].sp.material.dispose(); labels.splice(i, 1); }
    for (const a of patrol.agents) { const ang = a.a0 + a.dir * t * 0.06; a.x = Math.sin(ang) * a.ring; a.z = -Math.cos(ang) * a.ring; a.y = a.alt; a.heading = ang + (a.dir > 0 ? Math.PI / 2 : -Math.PI / 2); }
    for (const c of crowds) c.write(t, camTmp);
  }

  // Where a staged event is now (its first figure, or its gate), for the camera.
  function whereIs(id) {
    const g = groups.get(id);
    if (g) { const a = g.agents.find((x) => x.fade > 0.05) || g.agents[0]; if (a) return { x: a.x, y: a.y, z: a.z }; return { x: g.cx, y: g.cy, z: g.cz }; }
    const s = ships.find((x) => x.event.id === id);
    if (s) return { x: s.g.position.x, y: 2, z: s.g.position.z };
    return null;
  }

  // The event under a tap (raycast on the crowds' first part).
  const ray = new THREE.Raycaster();
  function pick(ndc, camera) {
    ray.setFromCamera(ndc, camera);
    for (const c of [raiders, shadows, drones]) {
      const hit = ray.intersectObject(c.pickMesh, false)[0];
      if (hit && hit.instanceId != null && c.agents[hit.instanceId]) return c.agents[hit.instanceId].eventId;
    }
    return null;
  }

  return {
    stage, update, whereIs, pick,
    get attackers() { return raiders.live + shadows.live + drones.live; },
    get guardians() { return guardians.live; },
    get activeIds() { return [...groups.keys(), ...ships.filter((s) => s.t < s.dur).map((s) => s.event.id)]; },
    setCap(cap) { for (const c of [raiders]) c.cap = Math.min(c.cap, cap); },
    dispose() { scene.remove(root); root.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); }); }); }
  };
}
