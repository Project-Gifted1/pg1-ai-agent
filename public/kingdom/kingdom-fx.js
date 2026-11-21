// PG1 City: the effects of an interception, pooled and instanced so a wave
// of hundreds stays smooth (a handful of draw calls, none while idle).
//
//   lockOn(agent)            a gold lock-on reticle that follows a threat
//   scanBeam(from, to, s)    a cyan scan beam from a PG1 sentinel to it
//   tag(agent, text)         a holographic tag over it ("Scanning", then
//                            "Caught · <reason code>")
//   sparks(pos, colour, n)   a burst of sparks at a contact point
//   shockwave(pos, colour, r, { up }) an expanding ring (flat on the
//                            ground or water, or facing outward on the dome)
//   aftermath(kind, pos)     a trace that stays for the Dublin day: a marker
//                            buoy where a threat sank, a scorch ring where a
//                            flood hit the gate, a fresh patch where a repair
//                            crew worked; cleared at Dublin midnight
//
// PG1's colours only (gold, white, cyan); the threat's own red stays on the
// threat. Decoration of real events only: nothing here is ever counted.

const GOLD = 0xf3c623; const CYAN = 0x6fd8ff; const WHITE = 0xf5f7fa;
const CAP = { reticles: 16, beams: 16, sparks: 900, rings: 32, tags: 6, aftermath: 40 };

function tagSprite(THREE, text, colour) {
  const cv = document.createElement('canvas'); const g = cv.getContext('2d');
  let fs = 40; g.font = `700 ${fs}px Inter, system-ui, sans-serif`;
  const wide = g.measureText(text).width + 64; if (wide > 1024) fs = Math.floor(fs * 1024 / wide);
  g.font = `700 ${fs}px Inter, system-ui, sans-serif`;
  const w = Math.min(1024, Math.ceil(g.measureText(text).width) + 64); cv.width = w; cv.height = 76;
  g.font = `700 ${fs}px Inter, system-ui, sans-serif`;
  // A holographic panel: dark glass, a bright frame and corner ticks.
  g.fillStyle = 'rgba(8,14,20,0.62)'; g.fillRect(4, 4, w - 8, 68);
  g.strokeStyle = colour; g.lineWidth = 3; g.strokeRect(4, 4, w - 8, 68);
  g.fillStyle = colour; for (const [x, y] of [[0, 0], [w - 14, 0], [0, 62], [w - 14, 62]]) g.fillRect(x, y, 14, 14);
  g.textBaseline = 'middle'; g.fillText(text, 32, 40);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
  sp.name = 'intercept-tag'; sp.renderOrder = 21; sp.scale.set(w / 76 * 2.6, 2.6, 1);
  return sp;
}

export function createInterceptFx(THREE, root, settings, { dayKey = () => '' } = {}) {
  const legacy = !!settings.legacy;
  const grp = new THREE.Group(); grp.name = 'intercepts'; root.add(grp);
  const named = (o, n) => { o.name = n; return o; };
  const add = (m) => { m.frustumCulled = false; m.visible = false; grp.add(m); return m; };
  const dummy = new THREE.Object3D(); const tmpA = new THREE.Vector3(); const tmpB = new THREE.Vector3(); const up = new THREE.Vector3(0, 1, 0);
  const basic = (color, o = {}) => new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, ...o });

  // Lock-on reticles: a ring and four brackets, rotating.
  const ringGeo = new THREE.RingGeometry(0.9, 1, 40);
  const bracketGeo = (() => { const parts = []; for (let k = 0; k < 4; k++) { const b = new THREE.PlaneGeometry(0.42, 0.08); b.translate(1.25, 0, 0); b.rotateZ(k * Math.PI / 2 + Math.PI / 4); parts.push(b); } const g = new THREE.BufferGeometry(); const pos = []; for (const p of parts) { const a = p.toNonIndexed().attributes.position.array; pos.push(...a); } g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); return g; })();
  const reticleRing = add(named(new THREE.InstancedMesh(ringGeo, basic(GOLD, { side: THREE.DoubleSide, opacity: 0.9 }), CAP.reticles), 'lock-on-reticle'));
  const reticleBrk = add(named(new THREE.InstancedMesh(bracketGeo, basic(WHITE, { side: THREE.DoubleSide, opacity: 0.95 }), CAP.reticles), 'lock-on-brackets'));
  const reticles = [];
  // Scan beams: thin cylinders from a sentinel to the threat.
  const beamGeo = new THREE.CylinderGeometry(0.12, 0.5, 1, 8, 1, true); beamGeo.translate(0, 0.5, 0);
  const beams = add(named(new THREE.InstancedMesh(beamGeo, basic(CYAN, { opacity: 0.55, side: THREE.DoubleSide }), CAP.beams), 'scan-beams'));
  const beamList = [];
  // Sparks: one Points cloud, a ring buffer.
  const nSparks = legacy ? 240 : CAP.sparks;
  const sp = new Float32Array(nSparks * 3); const sv = new Float32Array(nSparks * 3); const sl = new Float32Array(nSparks); const sc = new Float32Array(nSparks * 3);
  const sparkGeo = new THREE.BufferGeometry(); sparkGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3)); sparkGeo.setAttribute('color', new THREE.BufferAttribute(sc, 3));
  const sparkPts = add(named(new THREE.Points(sparkGeo, new THREE.PointsMaterial({ size: legacy ? 1.6 : 1.1, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })), 'intercept-sparks'));
  let sparkHead = 0; let sparksLive = 0;
  // Shockwave rings.
  const swGeo = new THREE.RingGeometry(0.8, 1, 48);
  const rings = add(named(new THREE.InstancedMesh(swGeo, basic(WHITE, { side: THREE.DoubleSide, opacity: 0.8 }), CAP.rings), 'shockwaves'));
  const ringList = [];
  // Holographic tags.
  const tags = [];
  // Aftermath: buoys (a hull and a blinking amber light), scorch rings, repair patches.
  const buoyGeo = new THREE.ConeGeometry(0.9, 2.4, 8); buoyGeo.translate(0, 1.2, 0);
  const buoys = add(named(new THREE.InstancedMesh(buoyGeo, new THREE.MeshStandardMaterial({ color: 0xffc94d, roughness: 0.5 }), CAP.aftermath), 'aftermath-buoys'));
  const buoyLightMat = new THREE.MeshBasicMaterial({ color: 0xffb300 });
  const buoyLights = add(named(new THREE.InstancedMesh(new THREE.SphereGeometry(0.35, 6, 4), buoyLightMat, CAP.aftermath), 'aftermath-buoy-lights'));
  const scorchGeo = new THREE.RingGeometry(2, 7, 32); scorchGeo.rotateX(-Math.PI / 2);
  const scorches = add(named(new THREE.InstancedMesh(scorchGeo, new THREE.MeshBasicMaterial({ color: 0x15171b, transparent: true, opacity: 0.55, depthWrite: false }), CAP.aftermath), 'aftermath-scorch'));
  const patchGeo = new THREE.PlaneGeometry(6, 6); patchGeo.rotateX(-Math.PI / 2);
  const patches = add(named(new THREE.InstancedMesh(patchGeo, basic(0xffd27a, { opacity: 0.35 }), CAP.aftermath), 'aftermath-patches'));
  const traces = { buoy: [], scorch: [], patch: [] };
  let traceDay = dayKey();

  function writeTraces() {
    traces.buoy.forEach((p, i) => { dummy.position.set(p.x, -3.2, p.z); dummy.rotation.set(0, 0, 0); dummy.scale.setScalar(1); dummy.updateMatrix(); buoys.setMatrixAt(i, dummy.matrix); dummy.position.y = -0.4; dummy.updateMatrix(); buoyLights.setMatrixAt(i, dummy.matrix); });
    buoys.count = buoyLights.count = traces.buoy.length; buoys.visible = buoyLights.visible = traces.buoy.length > 0;
    traces.scorch.forEach((p, i) => { dummy.position.set(p.x, 0.11, p.z); dummy.rotation.set(0, p.r || 0, 0); dummy.scale.setScalar(p.s || 1); dummy.updateMatrix(); scorches.setMatrixAt(i, dummy.matrix); });
    scorches.count = traces.scorch.length; scorches.visible = traces.scorch.length > 0;
    traces.patch.forEach((p, i) => { dummy.position.set(p.x, p.y + 0.3, p.z); dummy.rotation.set(0, 0, 0); dummy.scale.setScalar(1); dummy.updateMatrix(); patches.setMatrixAt(i, dummy.matrix); });
    patches.count = traces.patch.length; patches.visible = traces.patch.length > 0;
    for (const m of [buoys, buoyLights, scorches, patches]) m.instanceMatrix.needsUpdate = true;
  }

  const api = {
    root: grp,
    lockOn(agent) {
      if (!agent) return null;
      if (reticles.length >= CAP.reticles) reticles.shift();
      const r = { agent, age: 0, size: Math.max(3, (agent.scale || 1) * (agent.isBoat ? 9 : 2.2)), live: true };
      reticles.push(r); return r;
    },
    release(r) { if (r) r.live = false; },
    scanBeam(from, to, seconds = 1.6) {
      if (!from || !to) return;
      if (beamList.length >= CAP.beams) beamList.shift();
      beamList.push({ from, to, ttl: seconds, dur: seconds });
    },
    tag(agent, text) {
      if (!agent) return null;
      if (tags.length >= CAP.tags) { const old = tags.shift(); grp.remove(old.sprite); old.sprite.material.map.dispose(); old.sprite.material.dispose(); }
      const t = { agent, sprite: tagSprite(THREE, text, '#f3c623'), ttl: 9, text };
      grp.add(t.sprite); tags.push(t); return t;
    },
    retag(t, text, colour = '#f3c623') {
      if (!t || t.text === text) return;
      grp.remove(t.sprite); t.sprite.material.map.dispose(); t.sprite.material.dispose();
      t.sprite = tagSprite(THREE, text, colour); t.text = text; t.ttl = 6; grp.add(t.sprite);
    },
    sparks(pos, colour = GOLD, n = 40) {
      const c = new THREE.Color(colour); const k = legacy ? Math.ceil(n / 3) : n;
      for (let i = 0; i < k; i++) {
        const j = sparkHead; sparkHead = (sparkHead + 1) % nSparks;
        sp[j * 3] = pos.x; sp[j * 3 + 1] = pos.y; sp[j * 3 + 2] = pos.z;
        const a = Math.random() * Math.PI * 2; const e = (Math.random() - 0.2) * Math.PI / 2; const v = 6 + Math.random() * 14;
        sv[j * 3] = Math.cos(a) * Math.cos(e) * v; sv[j * 3 + 1] = Math.sin(e) * v + 4; sv[j * 3 + 2] = Math.sin(a) * Math.cos(e) * v;
        sl[j] = 0.6 + Math.random() * 0.7; sc[j * 3] = c.r; sc[j * 3 + 1] = c.g; sc[j * 3 + 2] = c.b;
      }
      sparksLive = Math.min(nSparks, sparksLive + k);
    },
    shockwave(pos, colour = WHITE, radius = 12, { normal = null } = {}) {
      if (ringList.length >= CAP.rings) ringList.shift();
      ringList.push({ x: pos.x, y: pos.y, z: pos.z, radius, colour: new THREE.Color(colour), normal: normal ? normal.clone().normalize() : null, age: 0, dur: 0.9 });
    },
    aftermath(kind, pos) {
      if (!traces[kind]) return false;
      const day = dayKey(); if (day !== traceDay) { traceDay = day; for (const k of Object.keys(traces)) traces[k].length = 0; }
      if (traces[kind].length >= CAP.aftermath) traces[kind].shift();
      traces[kind].push({ x: pos.x, y: pos.y || 0, z: pos.z, r: Math.random() * 6, s: 0.8 + Math.random() * 0.5 });
      writeTraces(); return true;
    },
    counts: () => ({ reticles: reticles.filter((r) => r.live).length, beams: beamList.length, tags: tags.length, rings: ringList.length, sparks: sparksLive, buoys: traces.buoy.length, scorches: traces.scorch.length, patches: traces.patch.length, day: traceDay }),
    update(dt, t, camera) {
      // A new Dublin day clears yesterday's traces.
      const day = dayKey(); if (day !== traceDay) { traceDay = day; for (const k of Object.keys(traces)) traces[k].length = 0; writeTraces(); }
      buoyLightMat.color.setHex((t % 1.8) < 0.25 ? 0xffb300 : 0x3a2a08);
      // Reticles follow their threat and face the camera.
      let n = 0;
      for (let i = reticles.length - 1; i >= 0; i--) { const r = reticles[i]; r.age += dt; if (!r.live || r.agent.fade <= 0.05 || r.age > 14) reticles.splice(i, 1); }
      for (const r of reticles) {
        const a = r.agent; const s = r.size * (1 + Math.max(0, 0.6 - r.age) * 1.6);
        dummy.position.set(a.x, a.y + (a.isBoat ? 2 : 0), a.z); dummy.quaternion.copy(camera.quaternion); dummy.rotateZ(t * 1.4); dummy.scale.setScalar(s); dummy.updateMatrix();
        reticleRing.setMatrixAt(n, dummy.matrix); dummy.rotateZ(-t * 2.8); dummy.updateMatrix(); reticleBrk.setMatrixAt(n, dummy.matrix); n++;
      }
      reticleRing.count = reticleBrk.count = n; reticleRing.visible = reticleBrk.visible = n > 0;
      reticleRing.instanceMatrix.needsUpdate = true; reticleBrk.instanceMatrix.needsUpdate = true;
      // Beams stretch from the sentinel to the threat.
      let b = 0;
      for (let i = beamList.length - 1; i >= 0; i--) { beamList[i].ttl -= dt; if (beamList[i].ttl <= 0) beamList.splice(i, 1); }
      for (const bm of beamList) {
        tmpA.set(bm.from.x, bm.from.y, bm.from.z); tmpB.set(bm.to.x, bm.to.y + (bm.to.isBoat ? 2 : 0), bm.to.z);
        const len = tmpA.distanceTo(tmpB); if (len < 0.5) continue;
        dummy.position.copy(tmpA); dummy.quaternion.setFromUnitVectors(up, tmpB.sub(tmpA).normalize()); dummy.scale.set(1, len, 1); dummy.updateMatrix(); beams.setMatrixAt(b++, dummy.matrix);
      }
      beams.count = b; beams.visible = b > 0; beams.instanceMatrix.needsUpdate = true;
      beams.material.opacity = 0.35 + 0.25 * Math.sin(t * 30);
      // Sparks fall and fade.
      if (sparksLive > 0) {
        let alive = 0;
        for (let j = 0; j < nSparks; j++) {
          if (sl[j] <= 0) continue;
          sl[j] -= dt; sv[j * 3 + 1] -= 18 * dt;
          sp[j * 3] += sv[j * 3] * dt; sp[j * 3 + 1] += sv[j * 3 + 1] * dt; sp[j * 3 + 2] += sv[j * 3 + 2] * dt;
          if (sl[j] <= 0) sp[j * 3 + 1] = -999; else alive++;
        }
        sparksLive = alive; sparkGeo.attributes.position.needsUpdate = true;
      }
      sparkPts.visible = sparksLive > 0;
      // Shockwave rings expand and fade.
      let k = 0;
      for (let i = ringList.length - 1; i >= 0; i--) { ringList[i].age += dt; if (ringList[i].age > ringList[i].dur) ringList.splice(i, 1); }
      for (const r of ringList) {
        const f = r.age / r.dur; dummy.position.set(r.x, r.y, r.z);
        if (r.normal) dummy.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), r.normal); else { dummy.quaternion.identity(); dummy.rotation.set(-Math.PI / 2, 0, 0); }
        dummy.scale.setScalar(0.5 + f * r.radius); dummy.updateMatrix(); rings.setMatrixAt(k, dummy.matrix); rings.setColorAt(k, r.colour.clone().multiplyScalar(1 - f)); k++;
      }
      rings.count = k; rings.visible = k > 0; rings.instanceMatrix.needsUpdate = true; if (rings.instanceColor) rings.instanceColor.needsUpdate = true;
      // Tags ride above their threat.
      for (let i = tags.length - 1; i >= 0; i--) {
        const tg = tags[i]; tg.ttl -= dt; const a = tg.agent;
        tg.sprite.position.set(a.x, a.y + (a.isBoat ? 9 : 5 + (a.scale || 1) * 0.6), a.z); tg.sprite.material.opacity = Math.min(1, tg.ttl, a.fade);
        if (tg.ttl <= 0 || a.fade <= 0.02) { grp.remove(tg.sprite); tg.sprite.material.map.dispose(); tg.sprite.material.dispose(); tags.splice(i, 1); }
      }
    },
    dispose() { root.remove(grp); grp.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } }); }
  };
  return api;
}
