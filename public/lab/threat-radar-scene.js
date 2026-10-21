// PG1 threat radar, full screen: the radar card's data as a 3D scene in the
// Living Lab's style (public/lab/living-lab.js), built in code with
// three.js (no stock assets, no video). Loaded only when the radar screen
// opens; three.js is served from this app (/vendor/three/), never a CDN.
//
//   createThreatRadarScene(container, { reducedMotion, coarse, label }) -> { update(view), destroy() }
//
// view: the radar card's data (lib/threatRadar.mjs buildThreatRadar, via
// /threat-radar; nothing is invented): findings [{ value, status, kev,
// ring, angle }], counts, feeds, as_of. Each finding is a glowing blip on a
// tilted radar disc, its distance from the core its age (2, 5 and 7 day
// rings), its colour its status (flagged red, unknown amber, no flags
// green); an actively exploited one breathes slowly. A sweep turns around
// the disc and each blip brightens softly as it passes. The core takes the
// radar's state: red with a flagged finding, amber with unknowns, green
// when nothing was flagged. Never the word "safe": no flags means no flags
// found in the sources read.
//
// Same rules as the Living Lab: nothing flashes (no brightness change
// faster than 1 Hz); 30 fps on phones, 60 on desktop; paused when off
// screen or the tab is hidden; prefers-reduced-motion, or no WebGL: a calm,
// still 2D drawing instead, redrawn only when the data changes.

export const RADAR_STATES = Object.freeze({
  alert: { core: 0xff5c5c, rim: 0xff9b7a, label: 'Flagged findings' },
  watch: { core: 0xffb300, rim: 0xf3c623, label: 'Unknowns to check' },
  clear: { core: 0x3ddc84, rim: 0xf3c623, label: 'No flags found' },
  empty: { core: 0xf3c623, rim: 0xffd84d, label: 'Nothing new' }
});
export const BLIP_COLOR = Object.freeze({ flagged: 0xff5c5c, unknown: 0xffb300, no_flags: 0x3ddc84 });
const MAX_BLIPS = 60;
const DISC_R = 3.4;

export function normalizeRadarView(v) {
  const view = v && typeof v === 'object' ? v : {};
  const findings = (Array.isArray(view.findings) ? view.findings : []).filter((f) => f && typeof f === 'object').slice(0, MAX_BLIPS).map((f) => ({
    value: String(f.value || '').slice(0, 80),
    status: Object.hasOwn(BLIP_COLOR, f.status) ? f.status : 'unknown',
    kev: f.kev === true,
    ring: Math.min(0.96, Math.max(0.08, Number(f.ring) || 0.5)),
    angle: ((Number(f.angle) || 0) % 360 + 360) % 360
  }));
  const c = view.counts && typeof view.counts === 'object' ? view.counts : {};
  const counts = { flagged: Math.max(0, Number(c.flagged) || 0), unknown: Math.max(0, Number(c.unknown) || 0), no_flags: Math.max(0, Number(c.no_flags) || 0) };
  const state = !findings.length ? 'empty' : counts.flagged > 0 ? 'alert' : counts.unknown > 0 ? 'watch' : 'clear';
  return { state, findings, counts, kev: findings.filter((f) => f.kev).length, as_of: String(view.as_of || '').slice(0, 40) };
}

const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;
const SHIELD = 'M221.76 0L262.5 15.2V47.3C262.5 73.9 245.1 91.85 221.76 100C198.4 91.85 181 73.9 181 47.3V15.2Z';
const ONE = 'M220 20H233V72H220V37.5L208.5 43.5V31Z';

// --- the 2D drawing (reduced motion, no WebGL) ----------------------------------------

function create2d(container, label) {
  const canvas = document.createElement('canvas');
  canvas.className = 'living-lab-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  container.appendChild(canvas);
  container.dataset.renderer = '2d';
  let data = normalizeRadarView(null);
  const draw = () => {
    const r = container.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    const g = canvas.getContext('2d');
    if (!g) return;
    const w = canvas.width; const h = canvas.height; const cx = w / 2; const cy = h / 2;
    const R = Math.min(w, h) * 0.42;
    const style = RADAR_STATES[data.state];
    g.clearRect(0, 0, w, h);
    const bg = g.createRadialGradient(cx, cy, R * 0.1, cx, cy, R * 1.6);
    bg.addColorStop(0, 'rgba(20,20,24,1)'); bg.addColorStop(1, 'rgba(10,10,11,1)');
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(160,160,170,0.28)'; g.lineWidth = Math.max(1, dpr);
    for (const k of [2 / 7, 5 / 7, 1]) { g.beginPath(); g.arc(cx, cy, R * k, 0, Math.PI * 2); g.stroke(); }
    g.beginPath(); g.moveTo(cx - R, cy); g.lineTo(cx + R, cy); g.moveTo(cx, cy - R); g.lineTo(cx, cy + R); g.stroke();
    g.fillStyle = 'rgba(184,184,192,0.8)'; g.font = `${Math.round(11 * dpr)}px Inter, system-ui, sans-serif`;
    [['2d', 2 / 7], ['5d', 5 / 7], ['7d', 1]].forEach(([t, k]) => g.fillText(t, cx + 4 * dpr, cy - R * k + 12 * dpr));
    const glow = g.createRadialGradient(cx, cy, 0, cx, cy, R * 0.45);
    glow.addColorStop(0, `${hex(style.core)}cc`); glow.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = glow; g.beginPath(); g.arc(cx, cy, R * 0.45, 0, Math.PI * 2); g.fill();
    for (const f of data.findings) {
      const a = (f.angle * Math.PI) / 180;
      const x = cx + Math.sin(a) * f.ring * R; const y = cy - Math.cos(a) * f.ring * R;
      const s = (f.kev ? 7 : 5) * dpr;
      const halo = g.createRadialGradient(x, y, 0, x, y, s * 3);
      halo.addColorStop(0, `${hex(BLIP_COLOR[f.status])}aa`); halo.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = halo; g.beginPath(); g.arc(x, y, s * 3, 0, Math.PI * 2); g.fill();
      g.fillStyle = hex(BLIP_COLOR[f.status]); g.beginPath(); g.arc(x, y, s, 0, Math.PI * 2); g.fill();
    }
    g.save(); g.translate(cx, cy); const k = R / 300; g.scale(k, k); g.translate(-221.76, -50);
    g.fillStyle = '#f3c623'; g.fill(new Path2D(SHIELD)); g.fillStyle = '#0a0a0b'; g.fill(new Path2D(ONE));
    g.restore();
  };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(draw) : null;
  if (ro) ro.observe(container);
  draw();
  return {
    renderer: '2d',
    update(next) { data = normalizeRadarView(next); container.dataset.radarState = data.state; container.dataset.blips = String(data.findings.length); if (label) label(data); draw(); },
    destroy() { if (ro) ro.disconnect(); canvas.remove(); }
  };
}

// --- the 3D scene --------------------------------------------------------------------

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
  renderer.setClearColor(0x0a0a0b, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0a0a0b, 0.04);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  const glow = glowTexture(THREE);
  const additive = (color, opacity = 1) => new THREE.SpriteMaterial({ map: glow, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });

  // The disc: a tilted group holding the face, the 2/5/7-day rings, the
  // axes, the sweep and the blips.
  const disc = new THREE.Group();
  disc.rotation.x = -Math.PI / 2.6;
  scene.add(disc);
  const face = new THREE.Mesh(new THREE.CircleGeometry(DISC_R * 1.02, 96), new THREE.MeshBasicMaterial({ color: 0x141418, transparent: true, opacity: 0.85, depthWrite: false }));
  disc.add(face);
  for (const k of [2 / 7, 5 / 7, 1]) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(DISC_R * k - 0.012, DISC_R * k + 0.012, coarse ? 96 : 192), new THREE.MeshBasicMaterial({ color: 0x8a8a96, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide }));
    ring.position.z = 0.002;
    disc.add(ring);
  }
  const axisMat = new THREE.LineBasicMaterial({ color: 0x5a5a64, transparent: true, opacity: 0.5 });
  disc.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-DISC_R, 0, 0.003), new THREE.Vector3(DISC_R, 0, 0.003), new THREE.Vector3(0, -DISC_R, 0.003), new THREE.Vector3(0, DISC_R, 0.003)]), axisMat));
  // The sweep: a soft wedge that fades behind its leading edge.
  const sweepUniforms = { uColor: { value: new THREE.Color(0xf3c623) } };
  const sweep = new THREE.Mesh(new THREE.CircleGeometry(DISC_R, 64, 0, Math.PI / 3), new THREE.ShaderMaterial({
    uniforms: sweepUniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    vertexShader: 'varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: 'uniform vec3 uColor; varying vec2 vP; void main(){ float a = atan(vP.y, vP.x); float t = clamp(a / 1.0472, 0.0, 1.0); float r = length(vP) / 3.4; gl_FragColor = vec4(uColor, pow(t, 3.0) * 0.32 * (0.35 + r)); }'
  }));
  sweep.position.z = 0.004;
  disc.add(sweep);

  // The core: the Living Lab's shaded orb, halo and shield, in the radar's state colour.
  const coreUniforms = { uTime: { value: 0 }, uCore: { value: new THREE.Color(RADAR_STATES.empty.core) }, uRim: { value: new THREE.Color(RADAR_STATES.empty.rim) } };
  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, coarse ? 3 : 5), new THREE.ShaderMaterial({
    uniforms: coreUniforms, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    vertexShader: `uniform float uTime; varying vec3 vN; varying vec3 vV;
      void main(){ vec3 p = position; float w = sin(p.x*5.0+uTime*0.9)*sin(p.y*5.0+uTime*0.7)*sin(p.z*5.0+uTime*0.8);
        p += normal * w*0.03; vec4 mv = modelViewMatrix*vec4(p,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `uniform vec3 uCore; uniform vec3 uRim; varying vec3 vN; varying vec3 vV;
      void main(){ float f = pow(1.0 - max(dot(vN, vV), 0.0), 2.0); vec3 c = mix(uCore*0.55, uRim*1.15, f); gl_FragColor = vec4(c, 0.25 + f*0.75); }`
  }));
  core.position.y = 0.35;
  scene.add(core);
  const halo = new THREE.Sprite(additive(RADAR_STATES.empty.core, 0.4));
  halo.material.depthTest = false; halo.renderOrder = 1; halo.scale.setScalar(3.6); halo.position.copy(core.position);
  scene.add(halo);
  const shield = new THREE.Mesh(new THREE.ShapeGeometry(shieldShape(THREE), 24), new THREE.MeshBasicMaterial({ color: 0xf3c623, transparent: true, opacity: 0.96, side: THREE.DoubleSide, depthWrite: false, depthTest: false, fog: false }));
  shield.renderOrder = 3; shield.scale.setScalar(0.46); shield.position.copy(core.position);
  scene.add(shield);

  // Dust, as in the lab.
  const dustCount = coarse ? 450 : 1200;
  const dustPos = new Float32Array(dustCount * 3);
  for (let i = 0; i < dustCount; i++) {
    const r = 6 + Math.random() * 18; const th = Math.random() * Math.PI * 2; const ph = Math.acos(2 * Math.random() - 1);
    dustPos.set([r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph) * 0.6, r * Math.sin(ph) * Math.sin(th)], i * 3);
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ size: 0.16, map: glow, color: 0x8a8a96, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
  scene.add(dust);

  // Blips: a dot and a halo each, on the disc.
  const blipGroup = new THREE.Group();
  disc.add(blipGroup);
  let blips = [];
  function syncBlips(findings) {
    for (const b of blips) { blipGroup.remove(b.dot, b.halo); b.dot.geometry.dispose(); b.dot.material.dispose(); b.halo.material.dispose(); }
    blips = findings.map((f) => {
      const a = (f.angle * Math.PI) / 180;
      const x = Math.sin(a) * f.ring * DISC_R; const y = Math.cos(a) * f.ring * DISC_R;
      const color = BLIP_COLOR[f.status];
      const dot = new THREE.Mesh(new THREE.SphereGeometry(f.kev ? 0.075 : 0.055, 12, 12), new THREE.MeshBasicMaterial({ color }));
      dot.position.set(x, y, 0.05);
      const halo = new THREE.Sprite(additive(color, 0.75));
      halo.position.set(x, y, 0.06);
      const base = f.kev ? 0.7 : 0.5;
      halo.scale.setScalar(base);
      blipGroup.add(dot, halo);
      // The sweep's angle on the disc where it meets this blip (radians).
      return { dot, halo, base, kev: f.kev, at: Math.atan2(y, x), lit: 0 };
    });
  }

  let state = 'empty';
  const coreColor = new THREE.Color(RADAR_STATES.empty.core);
  const rimColor = new THREE.Color(RADAR_STATES.empty.rim);

  const view = { theta: 0.5, phi: 1.05, dist: coarse ? 13.5 : 10, vt: 0, vp: 0, dragging: false, lastX: 0, lastY: 0, idleFor: 0 };
  const onDown = (e) => { view.dragging = true; view.lastX = e.clientX; view.lastY = e.clientY; view.idleFor = 0; canvas.setPointerCapture?.(e.pointerId); };
  const onMove = (e) => { if (!view.dragging) return; view.vt = (e.clientX - view.lastX) * -0.005; view.vp = (e.clientY - view.lastY) * -0.004; view.lastX = e.clientX; view.lastY = e.clientY; };
  const onUp = () => { view.dragging = false; };
  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp); canvas.addEventListener('pointercancel', onUp);

  function resize() {
    const r = container.getBoundingClientRect();
    renderer.setPixelRatio(Math.min(coarse ? 1.5 : 2, window.devicePixelRatio || 1));
    renderer.setSize(Math.max(1, r.width), Math.max(1, r.height), false);
    camera.aspect = Math.max(1, r.width) / Math.max(1, r.height);
    camera.updateProjectionMatrix();
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(container);
  resize();

  let visible = true;
  let raf = 0;
  let last = performance.now();
  let acc = 0;
  let time = 0;
  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => { visible = entries.some((x) => x.isIntersecting); schedule(); }) : null;
  if (io) io.observe(container);
  const onVis = () => schedule();
  document.addEventListener('visibilitychange', onVis);
  const running = () => visible && !document.hidden;

  function frame(now) {
    raf = 0;
    if (!running()) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    acc += dt; last = now;
    schedule();
    if (acc < 1 / targetFps - 0.002) return;
    const step = acc; acc = 0;
    time += step;
    const target = RADAR_STATES[state];
    const k = 1 - Math.exp(-step * 2.2);
    coreColor.lerp(new THREE.Color(target.core), k); rimColor.lerp(new THREE.Color(target.rim), k);
    coreUniforms.uTime.value = time; coreUniforms.uCore.value.copy(coreColor); coreUniforms.uRim.value.copy(rimColor);
    core.rotation.y += step * 0.3;
    halo.material.color.copy(coreColor);
    halo.scale.setScalar(3.6 + Math.sin(time * Math.PI * 2 * 0.25) * 0.15);
    sweepUniforms.uColor.value.copy(rimColor);
    // One turn every 6 s; the wedge's leading edge is at its start angle + 60°.
    sweep.rotation.z = -(time * (Math.PI * 2 / 6)) % (Math.PI * 2);
    const edge = sweep.rotation.z + Math.PI / 3;
    for (const b of blips) {
      const d = Math.abs(Math.atan2(Math.sin(edge - b.at), Math.cos(edge - b.at)));
      if (d < 0.08) b.lit = 1;
      b.lit = Math.max(0, b.lit - step * 0.7); // fades over 1.4 s: no flash
      const breathe = b.kev ? Math.sin(time * Math.PI * 2 * 0.5) * 0.12 : 0;
      b.halo.scale.setScalar(b.base * (1 + b.lit * 0.6 + breathe));
      b.halo.material.opacity = 0.55 + b.lit * 0.35;
    }
    shield.lookAt(camera.position);
    dust.rotation.y += step * 0.01;
    view.idleFor += step;
    if (!view.dragging) { view.vt *= Math.exp(-step * 3); view.vp *= Math.exp(-step * 3); if (view.idleFor > 2) view.theta += step * 0.03; }
    view.theta += view.vt; view.phi = Math.min(1.45, Math.max(0.55, view.phi + view.vp));
    camera.position.set(view.dist * Math.sin(view.phi) * Math.cos(view.theta), view.dist * Math.cos(view.phi) + Math.sin(time * 0.13) * 0.2, view.dist * Math.sin(view.phi) * Math.sin(view.theta));
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
    container.dataset.frames = String((Number(container.dataset.frames) || 0) + 1);
  }
  function schedule() { if (!raf && running()) { last = performance.now(); raf = requestAnimationFrame(frame); } }
  schedule();

  return {
    renderer: 'webgl',
    update(next) {
      const data = normalizeRadarView(next);
      state = data.state;
      container.dataset.radarState = state;
      container.dataset.blips = String(data.findings.length);
      syncBlips(data.findings);
      if (label) label(data);
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

export async function createThreatRadarScene(container, { reducedMotion = false, coarse = false, label = null, threeUrl = '/vendor/three/three.module.min.js' } = {}) {
  if (!reducedMotion && hasWebGL()) {
    try {
      const scene = await create3d(container, { coarse, label, threeUrl });
      if (scene) return scene;
    } catch (e) { /* the 2D drawing below */ }
  }
  return create2d(container, label);
}
