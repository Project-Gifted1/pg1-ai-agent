// PG1 Sandbox viewer: what you see when something happens (the world's
// events, lib/sandbox/cosmos.mjs), played once, where it happened:
//
//   impact (a crater)      a meteor streaks down the sky, a white flash, a
//                          shockwave racing out along the ground, debris
//                          thrown up, and a column of dust that rises,
//                          spreads and drifts away; the crater stays
//   impact (in the water)  the streak, a flash, a column of spray and a ring
//   impact (a moon/planet) a flash and a puff of debris on its face
//   meteoroid (a craft)    a burst of sparks and a flash at the craft
//   flare                  the star swells and glows for a while
//   space_battle           flashes and streaks between ships high above
//
// Only events newer than the world as first seen are played (opening a
// world does not replay its past). Everything is drawn here, in code.
//
//   createEffects(THREE, scene, { where(id) -> { pos: Vector3, size } | null,
//                                 sky(), coarse })
//                                 hold(id, on): keep a thing out of sight (a crater until it is made)
//     -> { onWorld(world), tick(dt, camera), dispose(), active }

export function createEffects(THREE, scene, { where, sky = () => new THREE.Vector3(0, 3000, 0), coarse = false, hold = () => {} } = {}) {
  const live = [];
  const seen = new Set();
  let primed = false;
  const glowTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 32); r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.3, 'rgba(255,255,255,0.55)'); r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const smokeTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
    for (let i = 0; i < 14; i++) { const x = 16 + Math.random() * 32; const y = 16 + Math.random() * 32; const rr = 8 + Math.random() * 14; const r = g.createRadialGradient(x, y, 0, x, y, rr); r.addColorStop(0, 'rgba(255,255,255,0.35)'); r.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = r; g.fillRect(0, 0, 64, 64); }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const add = (obj, life, update) => { scene.add(obj); live.push({ obj, life, t: 0, update }); };
  const sprite = (color, size, additive = true, tex = glowTex) => { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color, transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, toneMapped: !additive })); s.scale.setScalar(size); return s; };

  // Particles: n points from p, each with its own velocity; gravity and drag.
  function burst(p, { n = 120, speed = 40, up = 30, color = 0xffb347, size = 2.5, life = 2.5, gravity = 9.8, drag = 0.6, spread = 1 } = {}) {
    n = coarse ? Math.ceil(n / 2) : n;
    const pos = new Float32Array(n * 3); const vel = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2; const e = Math.random() * spread; const v = speed * (0.3 + Math.random() * 0.7);
      vel[i * 3] = Math.cos(a) * v * (1 - e * 0.5); vel[i * 3 + 1] = up * (0.4 + Math.random()); vel[i * 3 + 2] = Math.sin(a) * v * (1 - e * 0.5);
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({ color, size, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, map: glowTex });
    const pts = new THREE.Points(g, m); pts.frustumCulled = false;
    add(pts, life, (dt, k) => {
      for (let i = 0; i < n; i++) {
        vel[i * 3 + 1] -= gravity * dt;
        for (let j = 0; j < 3; j++) { vel[i * 3 + j] *= 1 - drag * dt; pos[i * 3 + j] += vel[i * 3 + j] * dt; }
        if (pos[i * 3 + 1] < p.y - 0.5 && gravity > 0) { pos[i * 3 + 1] = p.y - 0.5; vel[i * 3] *= 0.5; vel[i * 3 + 2] *= 0.5; vel[i * 3 + 1] = 0; }
      }
      g.attributes.position.needsUpdate = true; m.opacity = 1 - k;
    });
  }
  function flash(p, size, color = 0xffffff, life = 0.8) { const s = sprite(color, size); s.position.copy(p); add(s, life, (dt, k) => { s.material.opacity = (1 - k) * (1 - k); s.scale.setScalar(size * (1 + k * 0.6)); }); }
  function ring(p, from, to, color, life) {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 64), new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
    m.rotation.x = -Math.PI / 2; m.position.copy(p).add(new THREE.Vector3(0, 0.4, 0));
    add(m, life, (dt, k) => { const r = from + (to - from) * (1 - Math.pow(1 - k, 2)); m.scale.set(r, r, r); m.material.opacity = 0.8 * (1 - k); });
  }
  function streak(to, done) {
    const from = to.clone().add(new THREE.Vector3(-900 + Math.random() * 300, 1600, -600 + Math.random() * 400));
    const head = sprite(0xfff1c4, 22); head.position.copy(from);
    const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 5, 1, 8, 1, true), new THREE.MeshBasicMaterial({ color: 0xffc37a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    const grp = new THREE.Group(); grp.add(head); grp.add(tail);
    const dir = to.clone().sub(from); const L = dir.length(); dir.normalize();
    tail.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().negate());
    let fired = false;
    add(grp, 1.4, (dt, k) => {
      const p = from.clone().addScaledVector(dir, L * Math.min(1, k * k * 1.05));
      head.position.copy(p);
      const len = Math.min(L * 0.35, 40 + k * 420); tail.scale.set(1, len, 1); tail.position.copy(p).addScaledVector(dir, -len / 2);
      if (!fired && k >= 0.95) { fired = true; done(); }
    });
  }
  function dust(p, radius) {
    const puffs = coarse ? 10 : 22;
    for (let i = 0; i < puffs; i++) {
      const s = sprite(0x9c8670, radius * (1.5 + Math.random()), false, smokeTex);
      const dx = (Math.random() - 0.5) * radius * 2; const dz = (Math.random() - 0.5) * radius * 2; const rise = 8 + Math.random() * 18;
      s.position.copy(p).add(new THREE.Vector3(dx, 2, dz));
      add(s, 18 + Math.random() * 8, (dt, k) => { s.position.y += rise * dt * (1 - k); s.position.x += 3 * dt; s.scale.setScalar(radius * (1.5 + k * 5)); s.material.opacity = 0.75 * (1 - k) * Math.min(1, k * 10); });
    }
  }
  function splash(p) {
    burst(p, { n: 160, speed: 14, up: 60, color: 0xe8f6ff, size: 3, life: 3.5, gravity: 30, drag: 0.2, spread: 0.2 });
    ring(p, 4, 120, 0xdff3ff, 5);
  }

  // What each event looks like.
  function play(ev) {
    const at = ev.ref ? where(ev.ref) : null;
    if (ev.kind === 'impact') {
      if (!at) return;
      if (at.crater) {
        const p = at.pos.clone();
        // The crater is there in the world already; it is shown when the meteorite lands.
        hold(ev.ref, true);
        streak(p, () => {
          hold(ev.ref, false);
          flash(p.clone().add(new THREE.Vector3(0, 8, 0)), 260, 0xfff6e0, 1.1);
          if (at.sea) { splash(p); return; }
          ring(p, 5, 260, 0xffe0b0, 2.4);
          burst(p, { n: 220, speed: 60, up: 55, color: 0xffa040, size: 3.2, life: 3, gravity: 25 });
          burst(p, { n: 120, speed: 30, up: 25, color: 0x8a7a66, size: 4, life: 6, gravity: 15 });
          dust(p, Math.max(12, at.size * 1.5));
        });
      } else {
        // On a moon or planet: a flash and debris on the face turned to us.
        const p = at.pos.clone().add(new THREE.Vector3(at.size * 0.6, at.size * 0.5, at.size * 0.6));
        flash(p, at.size * 0.6, 0xfff2c8, 1.4);
        burst(p, { n: 80, speed: at.size * 0.15, up: at.size * 0.1, color: 0xd9c4a0, size: Math.max(2, at.size * 0.03), life: 2.5, gravity: 0, drag: 0.9 });
      }
    } else if (ev.kind === 'meteoroid' && at) {
      flash(at.pos, Math.max(12, at.size * 1.2), 0xffffff, 0.5);
      burst(at.pos, { n: 90, speed: 35, up: 10, color: 0xffd27a, size: 1.6, life: 1.4, gravity: 0, drag: 1.2 });
    } else if (ev.kind === 'flare') {
      const star = where('@star');
      if (!star) return;
      const s = sprite(0xffc070, star.size * 10); s.position.copy(star.pos);
      add(s, 20, (dt, k) => { const pulse = Math.sin(k * Math.PI); s.scale.setScalar(star.size * (8 + pulse * 10)); s.material.opacity = 0.7 * pulse; });
    } else if (ev.kind === 'space_battle' || ev.kind === 'space_war') {
      const c = sky();
      for (let i = 0; i < (ev.kind === 'space_war' ? 4 : 10); i++) {
        const a = c.clone().add(new THREE.Vector3((Math.random() - 0.5) * 900, (Math.random() - 0.5) * 300, (Math.random() - 0.5) * 900));
        const b = a.clone().add(new THREE.Vector3((Math.random() - 0.5) * 500, (Math.random() - 0.5) * 120, (Math.random() - 0.5) * 500));
        const delay = Math.random() * 4;
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color: i % 2 ? 0x8fd3ff : 0xff8a65, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
        add(line, 4.5, (dt, k) => { const tt = k * 4.5 - delay; line.material.opacity = tt > 0 && tt < 0.35 ? 1 : 0; if (tt > 0.3 && !line.userData.hit) { line.userData.hit = true; flash(b, 40, 0xffe0c0, 0.6); } });
      }
    }
  }

  return {
    get active() { return live.length; },
    // A world (as the page gives it, with recent_events): play what is new.
    onWorld(world) {
      const evs = (world && world.recent_events) || [];
      const key = (e) => `${world.id}|${e.tick}|${e.kind}|${e.ref || ''}|${String(e.summary || '').slice(0, 40)}`;
      if (!primed) { for (const e of evs) seen.add(key(e)); primed = true; return; }
      for (const e of evs) { const k = key(e); if (seen.has(k)) continue; seen.add(k); play(e); }
      if (seen.size > 2000) { const keep = [...seen].slice(-1000); seen.clear(); for (const k of keep) seen.add(k); }
    },
    reset() { primed = false; seen.clear(); },
    tick(dt0) {
      // At most a fifteenth of a second a frame: on a slow device the
      // effect slows down rather than being skipped between two frames.
      const dt = Math.min(dt0, 1 / 15);
      for (let i = live.length - 1; i >= 0; i--) {
        const it = live[i]; it.t += dt; const k = Math.min(1, it.t / it.life);
        it.update(dt, k);
        if (k >= 1) { scene.remove(it.obj); it.obj.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); live.splice(i, 1); }
      }
    },
    play,
    dispose() { for (const it of live) { scene.remove(it.obj); it.obj.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); } live.length = 0; glowTex.dispose(); smokeTex.dispose(); }
  };
}
