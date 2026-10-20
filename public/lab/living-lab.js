// PG1 living lab: the lab screen's 3D scene, built in code with three.js
// (no stock assets, no video). Loaded only when the lab screen opens; three.js
// itself is served from this app (/vendor/three/), never from a CDN.
//
//   createLivingLab(container, { reducedMotion, coarse }) -> { update(state), destroy() }
//
// state (from the server, /api/watches op lab_scene; nothing is invented):
//   mode         idle | thinking | running | success | error
//   experiments  [{ id8, status }]  one orbiting ring each (queued, running,
//                done, failed, over_budget, stopped)
//   events       [{ id, kind, at }]  webhooks, scans and feed updates; each
//                new one sends a stream of particles into the core
//
// Every mode has its own colour and motion; changes fade over about a
// second and nothing flashes (no brightness change faster than 1 Hz).
// Performance: 30 fps on phones (coarse pointer or narrow screen), 60 on
// desktop; paused when off screen or the tab is hidden; quality steps down
// on a slow device (pixel ratio, particle count). prefers-reduced-motion,
// or no WebGL: a calm, still 2D drawing instead, redrawn only when the
// state changes. The canvas never blocks the page: it takes pointer input
// only for dragging the view.

const MODES = ['idle', 'thinking', 'running', 'success', 'error'];
export const MODE_STYLE = Object.freeze({
  idle: { core: 0xf3c623, rim: 0xffd84d, speed: 0.12, pulseHz: 0.2, pulse: 0.03, label: 'Idle' },
  thinking: { core: 0x8f86ff, rim: 0xf3c623, speed: 0.35, pulseHz: 0.6, pulse: 0.06, label: 'Thinking' },
  running: { core: 0xf3c623, rim: 0x36d1c4, speed: 0.55, pulseHz: 0.8, pulse: 0.05, label: 'Running' },
  success: { core: 0x3ddc84, rim: 0xf3c623, speed: 0.2, pulseHz: 0.3, pulse: 0.04, label: 'Done' },
  error: { core: 0xff5c5c, rim: 0xff9b7a, speed: 0.08, pulseHz: 0.5, pulse: 0.05, label: 'Needs attention' }
});
const RING_COLOR = { queued: 0xb08d1e, running: 0x36d1c4, done: 0x3ddc84, failed: 0xff5c5c, over_budget: 0xff9b7a, stopped: 0x8a8a92 };
const EVENT_COLOR = { webhook: 0xf3c623, scan: 0x36d1c4, feed: 0x8f86ff };
const MAX_RINGS = 8;

export function normalizeState(s) {
  const st = s && typeof s === 'object' ? s : {};
  return {
    mode: MODES.includes(st.mode) ? st.mode : 'idle',
    experiments: (Array.isArray(st.experiments) ? st.experiments : []).filter((e) => e && typeof e.id8 === 'string').slice(0, MAX_RINGS)
      .map((e) => ({ id8: e.id8.slice(0, 8), status: Object.hasOwn(RING_COLOR, e.status) ? e.status : 'queued', ...(typeof e.stage === 'string' && /^(research|build|test|gate)$/.test(e.stage) ? { stage: e.stage, error: String(e.error || '').slice(0, 160) } : {}) })),
    events: (Array.isArray(st.events) ? st.events : []).filter((e) => e && e.id && Object.hasOwn(EVENT_COLOR, e.kind)).slice(-50)
  };
}

const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;

// --- the 2D fallback ----------------------------------------------------------

function create2d(container, label) {
  const canvas = document.createElement('canvas');
  canvas.className = 'living-lab-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  container.appendChild(canvas);
  container.dataset.renderer = '2d';
  let state = normalizeState(null);
  const draw = () => {
    const r = container.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    const g = canvas.getContext('2d');
    if (!g) return;
    const w = canvas.width; const h = canvas.height; const cx = w / 2; const cy = h / 2;
    const unit = Math.min(w, h) / 10;
    const style = MODE_STYLE[state.mode];
    g.clearRect(0, 0, w, h);
    const bg = g.createRadialGradient(cx, cy, unit * 0.5, cx, cy, unit * 6);
    bg.addColorStop(0, 'rgba(20,20,24,1)'); bg.addColorStop(1, 'rgba(10,10,11,1)');
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    state.experiments.forEach((e, i) => {
      g.strokeStyle = hex(RING_COLOR[e.status]); g.globalAlpha = 0.7; g.lineWidth = Math.max(1, dpr);
      g.beginPath(); g.ellipse(cx, cy, unit * (2 + i * 0.45), unit * (0.8 + i * 0.2), (i * Math.PI) / 7, 0, Math.PI * 2); g.stroke();
    });
    g.globalAlpha = 1;
    const glow = g.createRadialGradient(cx, cy, 0, cx, cy, unit * 2.2);
    glow.addColorStop(0, hex(style.core)); glow.addColorStop(0.35, `${hex(style.core)}88`); glow.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = glow; g.beginPath(); g.arc(cx, cy, unit * 2.2, 0, Math.PI * 2); g.fill();
    // The PG1 shield in the core.
    g.save(); g.translate(cx, cy); const k = unit / 60; g.scale(k, k); g.translate(-221.76, -50);
    g.fillStyle = '#f3c623'; g.fill(new Path2D('M221.76 0L262.5 15.2V47.3C262.5 73.9 245.1 91.85 221.76 100C198.4 91.85 181 73.9 181 47.3V15.2Z'));
    g.fillStyle = '#0a0a0b'; g.fill(new Path2D('M220 20H233V72H220V37.5L208.5 43.5V31Z'));
    g.restore();
  };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(draw) : null;
  if (ro) ro.observe(container);
  draw();
  return {
    renderer: '2d',
    update(next) { state = normalizeState(next); container.dataset.labMode = state.mode; if (label) label(state); draw(); },
    destroy() { if (ro) ro.disconnect(); canvas.remove(); }
  };
}

// --- textures made in code -------------------------------------------------------

function glowTexture(THREE, size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.45)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.08)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function shieldShape(THREE) {
  // The PG1 shield (public/brand/pg1-mark.svg), centred, 1 unit tall, with
  // its numeral cut out.
  const s = 1 / 100;
  const P = (x, y) => [(x - 221.76) * s, (50 - y) * s];
  const shape = new THREE.Shape();
  shape.moveTo(...P(221.76, 0)); shape.lineTo(...P(262.5, 15.2)); shape.lineTo(...P(262.5, 47.3));
  shape.bezierCurveTo(...P(262.5, 73.9), ...P(245.1, 91.85), ...P(221.76, 100));
  shape.bezierCurveTo(...P(198.4, 91.85), ...P(181, 73.9), ...P(181, 47.3));
  shape.lineTo(...P(181, 15.2)); shape.closePath();
  const one = new THREE.Path();
  one.moveTo(...P(220, 20)); one.lineTo(...P(233, 20)); one.lineTo(...P(233, 72)); one.lineTo(...P(220, 72));
  one.lineTo(...P(220, 37.5)); one.lineTo(...P(208.5, 43.5)); one.lineTo(...P(208.5, 31)); one.closePath();
  shape.holes.push(one);
  return shape;
}

// --- the 3D scene -------------------------------------------------------------------

async function create3d(container, { coarse, label, threeUrl }) {
  const THREE = await import(threeUrl);
  const canvas = document.createElement('canvas');
  canvas.className = 'living-lab-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: !coarse, alpha: false, powerPreference: 'low-power' });
  } catch (e) {
    return null;
  }
  container.appendChild(canvas);
  container.dataset.renderer = 'webgl';
  const targetFps = coarse ? 30 : 60;
  const quality = { level: 0, dprCap: coarse ? 1.5 : 2 };
  renderer.setClearColor(0x0a0a0b, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0a0a0b, 0.045);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  const glow = glowTexture(THREE);
  const additive = (color, opacity = 1) => new THREE.SpriteMaterial({ map: glow, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });

  // The core: a shaded icosphere (fresnel rim, slow surface ripple), a
  // soft halo (the bloom), and the PG1 shield floating inside.
  const coreUniforms = { uTime: { value: 0 }, uCore: { value: new THREE.Color(MODE_STYLE.idle.core) }, uRim: { value: new THREE.Color(MODE_STYLE.idle.rim) }, uPulse: { value: 0 } };
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.85, coarse ? 3 : 5), new THREE.ShaderMaterial({
    uniforms: coreUniforms,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    vertexShader: `uniform float uTime; uniform float uPulse; varying vec3 vN; varying vec3 vV;
      void main(){ vec3 p = position; float w = sin(p.x*4.0+uTime*0.9)*sin(p.y*4.0+uTime*0.7)*sin(p.z*4.0+uTime*0.8);
        p += normal * (w*0.035 + uPulse); vec4 mv = modelViewMatrix*vec4(p,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `uniform vec3 uCore; uniform vec3 uRim; varying vec3 vN; varying vec3 vV;
      void main(){ float f = pow(1.0 - max(dot(vN, vV), 0.0), 2.0); vec3 c = mix(uCore*0.55, uRim*1.15, f); gl_FragColor = vec4(c, 0.22 + f*0.78); }`
  }));
  scene.add(core);
  // The glow is drawn over the core (no depth test), the brand mark over both.
  const halo = new THREE.Sprite(additive(MODE_STYLE.idle.core, 0.42));
  halo.material.depthTest = false;
  halo.renderOrder = 1;
  halo.scale.setScalar(6.5);
  scene.add(halo);
  const innerHalo = new THREE.Sprite(additive(0xffffff, 0.35));
  innerHalo.material.depthTest = false;
  innerHalo.renderOrder = 2;
  innerHalo.scale.setScalar(2.2);
  scene.add(innerHalo);
  const shield = new THREE.Mesh(new THREE.ShapeGeometry(shieldShape(THREE), 24), new THREE.MeshBasicMaterial({ color: 0xf3c623, transparent: true, opacity: 0.96, side: THREE.DoubleSide, depthWrite: false, depthTest: false, fog: false }));
  shield.renderOrder = 3;
  shield.scale.setScalar(0.8);
  scene.add(shield);

  // Dust: depth for the room, drifting very slowly (decor, not activity).
  const dustCount = coarse ? 500 : 1400;
  const dustPos = new Float32Array(dustCount * 3);
  for (let i = 0; i < dustCount; i++) {
    const r = 6 + Math.random() * 18; const th = Math.random() * Math.PI * 2; const ph = Math.acos(2 * Math.random() - 1);
    dustPos.set([r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph) * 0.6, r * Math.sin(ph) * Math.sin(th)], i * 3);
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ size: 0.16, map: glow, color: 0x8a8a96, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
  scene.add(dust);

  // Rings: one per experiment, each with a satellite.
  const rings = new Map(); // id8 -> { group, ring, sat, satHalo, speed, phase }
  const ringGroup = new THREE.Group();
  scene.add(ringGroup);
  const seeded = (id, k) => { let h = 2166136261; for (const ch of id + k) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return ((h >>> 0) % 10000) / 10000; };
  function syncRings(experiments) {
    const keep = new Set(experiments.map((e) => e.id8));
    for (const [id, r] of rings) if (!keep.has(id)) { ringGroup.remove(r.group); r.ring.geometry.dispose(); rings.delete(id); }
    experiments.forEach((e, i) => {
      let r = rings.get(e.id8);
      if (!r) {
        const group = new THREE.Group();
        const radius = 1.9 + i * 0.42;
        const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.012, 6, coarse ? 96 : 192), new THREE.MeshBasicMaterial({ color: RING_COLOR[e.status], transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false }));
        const sat = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 12), new THREE.MeshBasicMaterial({ color: RING_COLOR[e.status] }));
        const satHalo = new THREE.Sprite(additive(RING_COLOR[e.status], 0.8));
        satHalo.scale.setScalar(0.55);
        group.add(ring, sat, satHalo);
        group.rotation.set(seeded(e.id8, 'x') * Math.PI, seeded(e.id8, 'y') * Math.PI, 0);
        ringGroup.add(group);
        r = { group, ring, sat, satHalo, radius, phase: seeded(e.id8, 'p') * Math.PI * 2, color: new THREE.Color(RING_COLOR[e.status]) };
        rings.set(e.id8, r);
      }
      r.status = e.status;
      r.target = new THREE.Color(RING_COLOR[e.status]);
    });
  }

  // Particle streams: a pool; a real event sends a stream into the core.
  const poolSize = coarse ? 240 : 640;
  const pPos = new Float32Array(poolSize * 3);
  const pCol = new Float32Array(poolSize * 3);
  const parts = Array.from({ length: poolSize }, () => ({ alive: false }));
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
  const points = new THREE.Points(pGeo, new THREE.PointsMaterial({ size: coarse ? 0.09 : 0.07, map: glow, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  scene.add(points);
  const seen = new Set();
  let firstEvents = true;
  function spawn(kind, n) {
    const color = new THREE.Color(EVENT_COLOR[kind]);
    const th = Math.random() * Math.PI * 2; const ph = Math.acos(2 * Math.random() - 1);
    const origin = new THREE.Vector3(Math.sin(ph) * Math.cos(th), Math.cos(ph) * 0.7, Math.sin(ph) * Math.sin(th)).multiplyScalar(7.5);
    let made = 0;
    for (const p of parts) {
      if (made >= n) break;
      if (p.alive) continue;
      p.alive = true; p.t = -made * 0.03; p.dur = 1.6 + Math.random() * 1.2;
      p.a = origin.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.8));
      p.c = origin.clone().multiplyScalar(0.45).add(new THREE.Vector3((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3));
      p.color = color;
      made++;
    }
  }
  function syncEvents(events) {
    for (const e of events) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      // Events already there when the screen opens are history: one small
      // stream each, so the scene shows what recently arrived.
      spawn(e.kind, firstEvents ? 8 : quality.level ? 18 : 36);
    }
    firstEvents = false;
  }

  // Colour and motion follow the mode, eased (no flashes).
  let mode = 'idle';
  const style = { core: new THREE.Color(MODE_STYLE.idle.core), rim: new THREE.Color(MODE_STYLE.idle.rim), speed: MODE_STYLE.idle.speed, pulseHz: MODE_STYLE.idle.pulseHz, pulse: MODE_STYLE.idle.pulse };
  let waveT = -1;

  // View: slow drift; drag to orbit (touch or mouse), with easing.
  const view = { theta: 0.6, phi: 1.2, dist: coarse ? 10.5 : 9, vt: 0, vp: 0, dragging: false, lastX: 0, lastY: 0, idleFor: 0 };
  const onDown = (e) => { view.dragging = true; view.lastX = e.clientX; view.lastY = e.clientY; view.idleFor = 0; canvas.setPointerCapture?.(e.pointerId); };
  const onMove = (e) => {
    if (!view.dragging) return;
    view.vt = (e.clientX - view.lastX) * -0.005; view.vp = (e.clientY - view.lastY) * -0.004;
    view.lastX = e.clientX; view.lastY = e.clientY;
  };
  const onUp = () => { view.dragging = false; };
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);

  function resize() {
    const r = container.getBoundingClientRect();
    const dpr = Math.min(quality.dprCap / (1 + quality.level * 0.35), window.devicePixelRatio || 1);
    renderer.setPixelRatio(dpr);
    renderer.setSize(Math.max(1, r.width), Math.max(1, r.height), false);
    camera.aspect = Math.max(1, r.width) / Math.max(1, r.height);
    camera.updateProjectionMatrix();
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(container);
  resize();

  // Running only while visible.
  let visible = true;
  let raf = 0;
  let last = performance.now();
  let acc = 0;
  let frames = 0;
  let cost = 0;
  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => { visible = entries.some((x) => x.isIntersecting); schedule(); }) : null;
  if (io) io.observe(container);
  const onVis = () => schedule();
  document.addEventListener('visibilitychange', onVis);
  const running = () => visible && !document.hidden;
  let time = 0;

  function frame(now) {
    raf = 0;
    if (!running()) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    acc += dt;
    last = now;
    schedule();
    if (acc < 1 / targetFps - 0.002) return;
    const step = acc; acc = 0;
    const t0 = performance.now();
    time += step;
    const target = MODE_STYLE[mode];
    const k = 1 - Math.exp(-step * 2.2);
    style.core.lerp(new THREE.Color(target.core), k); style.rim.lerp(new THREE.Color(target.rim), k);
    style.speed += (target.speed - style.speed) * k; style.pulseHz += (target.pulseHz - style.pulseHz) * k; style.pulse += (target.pulse - style.pulse) * k;
    const breathe = Math.sin(time * Math.PI * 2 * style.pulseHz) * style.pulse;
    coreUniforms.uTime.value = time; coreUniforms.uCore.value.copy(style.core); coreUniforms.uRim.value.copy(style.rim); coreUniforms.uPulse.value = breathe;
    core.rotation.y += step * style.speed * 0.6; core.rotation.x += step * style.speed * 0.2;
    halo.material.color.copy(style.core); halo.scale.setScalar(6.5 + breathe * 8);
    shield.lookAt(camera.position);
    // A finished experiment: one slow wave out of the core (1.5 s, no flash).
    if (waveT >= 0) { waveT += step; innerHalo.scale.setScalar(2.2 + waveT * 3); innerHalo.material.opacity = Math.max(0, 0.35 - waveT * 0.23); if (waveT > 1.5) { waveT = -1; innerHalo.scale.setScalar(2.2); innerHalo.material.opacity = 0.35; } }
    for (const r of rings.values()) {
      r.color.lerp(r.target, k);
      r.ring.material.color.copy(r.color); r.sat.material.color.copy(r.color); r.satHalo.material.color.copy(r.color);
      const sp = r.status === 'running' ? 0.9 : r.status === 'queued' ? 0.25 : 0.12;
      r.phase += step * sp * (0.6 + style.speed);
      const x = Math.cos(r.phase) * r.radius; const y = Math.sin(r.phase) * r.radius;
      r.sat.position.set(x, y, 0); r.satHalo.position.set(x, y, 0);
      r.group.rotation.z += step * 0.03;
    }
    dust.rotation.y += step * 0.01;
    // Particles along their curves into the core.
    for (let i = 0; i < poolSize; i++) {
      const p = parts[i];
      if (!p.alive) { pPos[i * 3 + 1] = 9999; continue; }
      p.t += step / p.dur;
      if (p.t >= 1) { p.alive = false; pPos[i * 3 + 1] = 9999; continue; }
      const t = Math.max(0, p.t); const u = 1 - t;
      pPos[i * 3] = u * u * p.a.x + 2 * u * t * p.c.x;
      pPos[i * 3 + 1] = u * u * p.a.y + 2 * u * t * p.c.y;
      pPos[i * 3 + 2] = u * u * p.a.z + 2 * u * t * p.c.z;
      const fade = Math.min(1, t * 4) * Math.min(1, u * 3);
      pCol[i * 3] = p.color.r * fade; pCol[i * 3 + 1] = p.color.g * fade; pCol[i * 3 + 2] = p.color.b * fade;
    }
    pGeo.attributes.position.needsUpdate = true; pGeo.attributes.color.needsUpdate = true;
    // Camera: eased drag, then a slow drift once left alone.
    view.idleFor += step;
    if (!view.dragging) { view.vt *= Math.exp(-step * 3); view.vp *= Math.exp(-step * 3); if (view.idleFor > 2) view.theta += step * 0.04; }
    view.theta += view.vt; view.phi = Math.min(2.4, Math.max(0.6, view.phi + view.vp));
    const drift = Math.sin(time * 0.13) * 0.25;
    camera.position.set(view.dist * Math.sin(view.phi) * Math.cos(view.theta), view.dist * Math.cos(view.phi) + drift, view.dist * Math.sin(view.phi) * Math.sin(view.theta));
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
    // Adaptive quality: a slow device steps down (at most twice).
    cost += performance.now() - t0; frames++;
    if (frames >= 60) {
      const avg = cost / frames; frames = 0; cost = 0;
      if (avg > (1000 / targetFps) * 0.8 && quality.level < 2) { quality.level++; container.dataset.quality = String(quality.level); resize(); points.material.size *= 1.15; }
    }
    container.dataset.frames = String((Number(container.dataset.frames) || 0) + 1);
  }
  function schedule() {
    if (!raf && running()) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }
  schedule();

  return {
    renderer: 'webgl',
    update(next) {
      const s = normalizeState(next);
      if (s.mode === 'success' && mode !== 'success') waveT = 0;
      mode = s.mode;
      container.dataset.labMode = mode;
      syncRings(s.experiments);
      syncEvents(s.events);
      if (label) label(s);
      schedule();
    },
    destroy() {
      cancelAnimationFrame(raf); raf = 0;
      if (io) io.disconnect(); if (ro) ro.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointercancel', onUp);
      scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
      glow.dispose(); renderer.dispose(); canvas.remove();
    }
  };
}

function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch (e) { return false; }
}

// The scene for a container: 3D, or the calm 2D drawing under reduced
// motion or without WebGL.
export async function createLivingLab(container, { reducedMotion = false, coarse = false, label = null, threeUrl = '/vendor/three/three.module.min.js' } = {}) {
  if (!reducedMotion && hasWebGL()) {
    try {
      const scene = await create3d(container, { coarse, label, threeUrl });
      if (scene) return scene;
    } catch (e) { /* the 2D drawing below */ }
  }
  return create2d(container, label);
}
