// PG1 Sandbox viewer: the camera. It orbits a target point: drag to turn,
// pinch or scroll to zoom, two fingers (or right-drag, or shift-drag) to
// pan, a tap to pick something. Movement eases; nothing jumps.

export function createControls(THREE, canvas, camera, { onTap } = {}) {
  const c = {
    target: new THREE.Vector3(), goalTarget: new THREE.Vector3(),
    theta: 0.8, phi: 1.05, dist: 3000, goalDist: 3000, goalTheta: 0.8, goalPhi: 1.05,
    minDist: 4, maxDist: 60000, autoRotate: 0, userActive: 0, panScale: 1
  };
  const pointers = new Map();
  let down = null; let lastPinch = 0; let lastMid = null;
  const sph = new THREE.Vector3();
  const right = new THREE.Vector3(); const fwd = new THREE.Vector3();

  const onDown = (e) => {
    canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) down = { x: e.clientX, y: e.clientY, t: performance.now(), pan: e.button === 2 || e.shiftKey, moved: 0 };
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; lastPinch = Math.hypot(a.x - b.x, a.y - b.y); lastMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
    c.userActive = 3;
  };
  const pan = (dx, dy) => {
    const k = c.dist * 0.0016 * c.panScale;
    right.set(Math.sin(c.theta), 0, -Math.cos(c.theta));
    fwd.set(Math.cos(c.theta), 0, Math.sin(c.theta));
    c.goalTarget.addScaledVector(right, dx * k).addScaledVector(fwd, dy * k);
    if (c.onPan) c.onPan();
  };
  const onMove = (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x; const dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    c.userActive = 3;
    if (pointers.size === 1 && down) {
      down.moved += Math.abs(dx) + Math.abs(dy);
      if (down.pan) pan(-dx, -dy);
      else { c.goalTheta += dx * 0.006; c.goalPhi = Math.min(1.52, Math.max(0.08, c.goalPhi - dy * 0.005)); }
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (lastPinch > 0) c.goalDist = Math.min(c.maxDist, Math.max(c.minDist, c.goalDist * (lastPinch / Math.max(1, d))));
      if (lastMid) pan(-(mid.x - lastMid.x), -(mid.y - lastMid.y));
      lastPinch = d; lastMid = mid;
      if (down) down.moved += 100;
    }
  };
  const onUp = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) { lastPinch = 0; lastMid = null; }
    if (down && pointers.size === 0) {
      if (down.moved < 8 && performance.now() - down.t < 450 && onTap) {
        const r = canvas.getBoundingClientRect();
        onTap(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      }
      down = null;
    }
  };
  const onWheel = (e) => {
    e.preventDefault();
    c.goalDist = Math.min(c.maxDist, Math.max(c.minDist, c.goalDist * Math.exp(e.deltaY * 0.0012)));
    c.userActive = 3;
  };
  const onCtx = (e) => e.preventDefault();
  const keys = new Set();
  const onKey = (e) => { if (/^(?:w|a|s|d|q|e|arrow\w+)$/i.test(e.key) && document.activeElement === canvas) { e.type === 'keydown' ? keys.add(e.key.toLowerCase()) : keys.delete(e.key.toLowerCase()); e.preventDefault(); } };
  canvas.tabIndex = 0;
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onCtx);
  canvas.addEventListener('keydown', onKey);
  canvas.addEventListener('keyup', onKey);

  // Glide to a view: target point, distance and angles (any may be omitted).
  c.flyTo = ({ target, dist, theta, phi } = {}) => {
    if (target) c.goalTarget.copy(target);
    if (dist) c.goalDist = Math.min(c.maxDist, Math.max(c.minDist, dist));
    if (theta !== undefined) c.goalTheta = theta;
    if (phi !== undefined) c.goalPhi = phi;
  };
  c.jumpTo = (o) => { c.flyTo(o); c.target.copy(c.goalTarget); c.dist = c.goalDist; c.theta = c.goalTheta; c.phi = c.goalPhi; };

  c.update = (dt) => {
    if (keys.size) {
      const sp = 500 * dt;
      if (keys.has('w') || keys.has('arrowup')) pan(0, -sp);
      if (keys.has('s') || keys.has('arrowdown')) pan(0, sp);
      if (keys.has('a') || keys.has('arrowleft')) pan(-sp, 0);
      if (keys.has('d') || keys.has('arrowright')) pan(sp, 0);
      if (keys.has('q')) c.goalTheta -= dt; if (keys.has('e')) c.goalTheta += dt;
    }
    c.userActive = Math.max(0, c.userActive - dt);
    if (c.autoRotate && c.userActive <= 0) c.goalTheta += c.autoRotate * dt;
    const k = 1 - Math.exp(-dt * 5);
    c.target.lerp(c.goalTarget, k);
    c.dist += (c.goalDist - c.dist) * k;
    c.theta += (c.goalTheta - c.theta) * k;
    c.phi += (c.goalPhi - c.phi) * k;
    sph.set(Math.sin(c.phi) * Math.cos(c.theta), Math.cos(c.phi), Math.sin(c.phi) * Math.sin(c.theta)).multiplyScalar(c.dist);
    camera.position.copy(c.target).add(sph);
    if (camera.position.y < c.target.y + 1.5 && c.target.y < 50) camera.position.y = c.target.y + 1.5;
    camera.lookAt(c.target);
  };

  c.dispose = () => {
    canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp); canvas.removeEventListener('pointercancel', onUp);
    canvas.removeEventListener('wheel', onWheel); canvas.removeEventListener('contextmenu', onCtx);
    canvas.removeEventListener('keydown', onKey); canvas.removeEventListener('keyup', onKey);
  };
  return c;
}
