// PG1 City: the weather and the sky's small lights. Decoration only: it
// follows the real weather in Dublin (kingdom-data.js weatherLook of the
// feed's `weather`), never an event, never counted or captioned, and it
// never uses the enemy palette.
//
//   rain      instanced streaks round the camera's target (one draw call),
//             longer and faster in heavy rain, slanting with the wind
//   snow      slow white flakes (points)
//   ripples   expanding rings on the river and on puddles in the streets
//   puddles   dark, glossy patches on the roads while it is wet
//   stars     at night under a clear sky
//   moon      its real phase (lib/cityWeather.mjs moonPhase), at night
//   sun disc  on clear days
//
// The Legacy phone tier keeps the same effects with far fewer streaks and
// ripples (settings.weatherScale).

const RIPPLE_COLOUR = 0xcfe0ee;

function ringTexture(THREE) {
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 3; g.beginPath(); g.arc(32, 32, 26, 0, Math.PI * 2); g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 2; g.beginPath(); g.arc(32, 32, 17, 0, Math.PI * 2); g.stroke();
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// The moon's disc lit for its phase (0 new, 0.5 full).
export function drawMoon(g, size, phase) {
  const r = size / 2 - 2; const c = size / 2;
  g.clearRect(0, 0, size, size);
  g.fillStyle = 'rgba(40,46,60,0.35)'; g.beginPath(); g.arc(c, c, r, 0, Math.PI * 2); g.fill();
  const lit = 1 - Math.abs(phase - 0.5) * 2; // 0 new .. 1 full
  if (lit < 0.02) return 0;
  const waxing = phase < 0.5;
  g.save(); g.beginPath(); g.arc(c, c, r, 0, Math.PI * 2); g.clip();
  g.fillStyle = '#eef1f6';
  // The lit half, then the terminator ellipse added or cut.
  g.beginPath(); g.arc(c, c, r, -Math.PI / 2, Math.PI / 2, !waxing); g.fill();
  const k = Math.cos(lit * Math.PI) * r; // r (new) .. -r (full)
  g.fillStyle = lit < 0.5 ? 'rgba(40,46,60,1)' : '#eef1f6';
  g.beginPath(); g.ellipse(c, c, Math.abs(k), r, 0, 0, Math.PI * 2); g.fill();
  g.restore();
  return lit;
}

export function createWeatherFx(THREE, scene, world, settings) {
  const scale = settings.weatherScale || 1;
  const root = new THREE.Group(); root.name = 'weather'; scene.add(root);
  const named = (o, n) => { o.name = n; return o; };

  // --- rain: line segments (two vertices a streak) in a box round the target ---
  // Line segments are cheap (one draw call): even Legacy phone keeps enough to read as rain.
  const nRain = Math.max(1500, Math.round((settings.tier === 'cinematic' ? 9000 : settings.tier === 'balanced' ? 5000 : 2200) * scale));
  const BOX = 520; const TOP = 260;
  const rainPos = new Float32Array(nRain * 6); const rainSeed = new Float32Array(nRain * 3);
  for (let i = 0; i < nRain; i++) { rainSeed[i * 3] = (Math.random() - 0.5) * BOX; rainSeed[i * 3 + 1] = Math.random() * TOP; rainSeed[i * 3 + 2] = (Math.random() - 0.5) * BOX; }
  const rainGeo = new THREE.BufferGeometry(); rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
  const rainMat = new THREE.LineBasicMaterial({ color: 0xcad6e2, transparent: true, opacity: 0, depthWrite: false, fog: true });
  const rain = named(new THREE.LineSegments(rainGeo, rainMat), 'rain-streaks');
  rain.frustumCulled = false; rain.visible = false; root.add(rain);

  // --- snow ---
  const nSnow = Math.round(2500 * scale);
  const snowPos = new Float32Array(nSnow * 3);
  for (let i = 0; i < nSnow; i++) { snowPos[i * 3] = (Math.random() - 0.5) * BOX; snowPos[i * 3 + 1] = Math.random() * TOP; snowPos[i * 3 + 2] = (Math.random() - 0.5) * BOX; }
  const snowGeo = new THREE.BufferGeometry(); snowGeo.setAttribute('position', new THREE.BufferAttribute(snowPos, 3));
  const snow = named(new THREE.Points(snowGeo, new THREE.PointsMaterial({ color: 0xf3f6fa, size: 1.1, transparent: true, opacity: 0, depthWrite: false })), 'snow');
  snow.frustumCulled = false; snow.visible = false; root.add(snow);

  // --- ripples on the river and in puddles; the puddles themselves ---
  const ringTex = ringTexture(THREE);
  const nRip = Math.round(160 * scale);
  const ripGeo = new THREE.PlaneGeometry(1, 1); ripGeo.rotateX(-Math.PI / 2);
  const ripMat = new THREE.MeshBasicMaterial({ map: ringTex, color: RIPPLE_COLOUR, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  const ripples = named(new THREE.InstancedMesh(ripGeo, ripMat, nRip), 'rain-ripples');
  ripples.visible = false; root.add(ripples);
  const puddleSpots = [];
  const nPud = Math.round(90 * scale);
  for (let i = 0; i < nPud; i++) {
    const alongX = Math.random() < 0.5; const k = Math.floor(Math.random() * 9) - 4;
    const along = (Math.random() - 0.5) * 1200; const across = (Math.random() < 0.5 ? -1 : 1) * (4 + Math.random() * 3);
    const x = alongX ? along : k * 160 + across; const z = alongX ? k * 160 - 40 + across : along;
    if (Math.abs(z - 120) < 70) { i--; continue; }
    puddleSpots.push({ x, z, r: 1.2 + Math.random() * 2.4 });
  }
  const pudGeo = new THREE.CircleGeometry(1, 16); pudGeo.rotateX(-Math.PI / 2);
  const pudMat = new THREE.MeshStandardMaterial({ color: 0x0e1014, roughness: 0.05, metalness: 0.6, transparent: true, opacity: 0, depthWrite: false });
  const puddles = named(new THREE.InstancedMesh(pudGeo, pudMat, puddleSpots.length), 'puddles');
  const dummy = new THREE.Object3D();
  puddleSpots.forEach((p, i) => { dummy.position.set(p.x, 0.08, p.z); dummy.scale.set(p.r, 1, p.r * (0.6 + Math.random() * 0.6)); dummy.rotation.set(0, Math.random() * 3, 0); dummy.updateMatrix(); puddles.setMatrixAt(i, dummy.matrix); });
  puddles.visible = false; root.add(puddles);
  const rip = [];
  for (let i = 0; i < nRip; i++) rip.push({ x: 0, z: 0, y: 0, age: Math.random(), life: 0.9 + Math.random() * 0.6 });
  const respawnRipple = (p) => {
    p.age = 0; p.life = 0.8 + Math.random() * 0.7;
    if (Math.random() < 0.6) { p.x = (Math.random() - 0.5) * 1600; p.z = 120 + (Math.random() - 0.5) * 84; p.y = -3.0; } else { const s = puddleSpots[Math.floor(Math.random() * puddleSpots.length)]; p.x = s.x + (Math.random() - 0.5) * s.r; p.z = s.z + (Math.random() - 0.5) * s.r; p.y = 0.1; }
  };
  rip.forEach(respawnRipple);

  // --- stars, the moon, the sun disc ---
  const nStars = Math.round(1400 * Math.max(0.4, scale));
  const starPos = new Float32Array(nStars * 3);
  for (let i = 0; i < nStars; i++) { const u = Math.random() * Math.PI * 2; const v = 0.08 + Math.random() * 0.92; const rr = Math.sqrt(1 - v * v); starPos[i * 3] = Math.cos(u) * rr * 6000; starPos[i * 3 + 1] = v * 6000; starPos[i * 3 + 2] = Math.sin(u) * rr * 6000; }
  const starGeo = new THREE.BufferGeometry(); starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const stars = named(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false })), 'stars');
  stars.frustumCulled = false; root.add(stars);
  const moonCv = document.createElement('canvas'); moonCv.width = moonCv.height = 128;
  const moonTex = new THREE.CanvasTexture(moonCv); moonTex.colorSpace = THREE.SRGBColorSpace;
  const moon = named(new THREE.Sprite(new THREE.SpriteMaterial({ map: moonTex, transparent: true, depthWrite: false, fog: false, opacity: 0 })), 'moon');
  moon.scale.setScalar(240); root.add(moon);
  let moonDrawn = -1;
  const sunCv = document.createElement('canvas'); sunCv.width = sunCv.height = 128;
  { const g = sunCv.getContext('2d'); const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64); gr.addColorStop(0, 'rgba(255,252,244,1)'); gr.addColorStop(0.16, 'rgba(255,248,232,1)'); gr.addColorStop(0.28, 'rgba(255,240,215,0.35)'); gr.addColorStop(1, 'rgba(255,236,210,0)'); g.fillStyle = gr; g.fillRect(0, 0, 128, 128); }
  const sunTex = new THREE.CanvasTexture(sunCv); sunTex.colorSpace = THREE.SRGBColorSpace;
  const sunDisc = named(new THREE.Sprite(new THREE.SpriteMaterial({ map: sunTex, transparent: true, depthWrite: false, fog: false, opacity: 0, blending: THREE.AdditiveBlending })), 'sun-disc');
  sunDisc.scale.setScalar(700); root.add(sunDisc);

  const ease = (cur, goal, dt, k = 0.5) => cur + (goal - cur) * Math.min(1, dt * k);
  const state = { rain: 0, snow: 0, wet: 0, stars: 0, sun: 0, wind: 0 };
  let phaseNow = 0.5;

  return {
    root,
    state,
    // look: kingdom-data.js weatherLook(); light: 0 night .. 1 day.
    update(dt, t, look, { target, sunDir, light = 1, dusk = 0 }) {
      state.rain = ease(state.rain, look.rain, dt, 0.4);
      state.snow = ease(state.snow, look.snow, dt, 0.4);
      state.wet = ease(state.wet, Math.max(look.wet, look.rain), dt, 0.15);
      state.wind = ease(state.wind, look.wind, dt, 0.3);
      const night = Math.max(0, 1 - light * 1.4 - dusk * 0.6);
      state.stars = ease(state.stars, night * look.stars, dt, 0.4);
      // The disc only once the sun is a few degrees up: low down, the sky's own glow is the sun.
      const up = Math.max(0, Math.min(1, (sunDir.y - 0.05) / 0.1));
      state.sun = ease(state.sun, look.sun * Math.min(1, light * 1.5) * up, dt, 0.4);
      const cx = target ? target.x : 0; const cz = target ? target.z : 0;
      // Rain.
      rain.visible = state.rain > 0.01;
      if (rain.visible) {
        const heavy = look.heavy;
        const n = Math.max(1, Math.floor(nRain * Math.min(1, 0.25 + state.rain)));
        rainGeo.setDrawRange(0, n * 2);
        const fall = (55 + 25 * heavy) * dt; const len = 2.4 + 3.5 * heavy; const sx = state.wind * 0.35 * len; const sz = state.wind * 0.12 * len;
        for (let i = 0; i < n; i++) {
          let y = rainSeed[i * 3 + 1] - fall; if (y < 0) y += TOP; rainSeed[i * 3 + 1] = y;
          const x = cx + rainSeed[i * 3]; const z = cz + rainSeed[i * 3 + 2];
          const o = i * 6; rainPos[o] = x; rainPos[o + 1] = y; rainPos[o + 2] = z; rainPos[o + 3] = x - sx; rainPos[o + 4] = y + len; rainPos[o + 5] = z - sz;
        }
        rainGeo.attributes.position.needsUpdate = true;
        rainMat.opacity = Math.min(0.55, 0.15 + state.rain * 0.45);
      }
      // Snow.
      snow.visible = state.snow > 0.01;
      if (snow.visible) {
        for (let i = 0; i < nSnow; i++) { let y = snowPos[i * 3 + 1] - dt * 2.2; if (y < 0) y += TOP; snowPos[i * 3 + 1] = y; snowPos[i * 3] += Math.sin(t * 0.7 + i) * dt * (0.3 + state.wind * 3); }
        snowGeo.attributes.position.needsUpdate = true; snow.position.set(cx, 0, cz); snow.material.opacity = 0.8 * state.snow;
      }
      // Puddles and ripples.
      puddles.visible = state.wet > 0.02; pudMat.opacity = 0.75 * state.wet;
      ripples.visible = state.rain > 0.05;
      if (ripples.visible) {
        const live = Math.floor(nRip * Math.min(1, state.rain));
        ripples.count = live;
        for (let i = 0; i < live; i++) {
          const p = rip[i]; p.age += dt / p.life; if (p.age >= 1) respawnRipple(p);
          const s = 0.4 + p.age * (p.y < 0 ? 3.2 : 1.6);
          dummy.position.set(p.x, p.y, p.z); dummy.rotation.set(0, 0, 0); dummy.scale.set(s, 1, s); dummy.updateMatrix(); ripples.setMatrixAt(i, dummy.matrix);
        }
        ripples.instanceMatrix.needsUpdate = true; ripMat.opacity = 0.35 * state.rain;
      }
      // Stars, the moon, the sun disc.
      stars.material.opacity = 0.9 * state.stars; stars.visible = state.stars > 0.01;
      phaseNow = look.moonPhase;
      if (Math.abs(moonDrawn - phaseNow) > 0.01) { drawMoon(moonCv.getContext('2d'), 128, phaseNow); moonTex.needsUpdate = true; moonDrawn = phaseNow; }
      const moonUp = Math.max(0, 1 - light * 1.6) * (1 - look.cover * 0.85);
      moon.material.opacity = moonUp; moon.visible = moonUp > 0.01;
      // Roughly opposite the sun, well up in the sky.
      moon.position.set(-sunDir.x * 5200, 2600, -sunDir.z * 5200 - 800);
      sunDisc.material.opacity = state.sun; sunDisc.visible = state.sun > 0.01;
      sunDisc.position.copy(sunDir).multiplyScalar(6200);
    },
    // Jump straight to the weather's goal (tests and stills).
    settle(look) { state.rain = look.rain; state.snow = look.snow; state.wet = Math.max(look.wet, look.rain); state.wind = look.wind; },
    counts: () => ({ rain: nRain, snow: nSnow, ripples: nRip, puddles: puddleSpots.length, stars: nStars }),
    dispose() { scene.remove(root); root.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } }); }
  };
}
