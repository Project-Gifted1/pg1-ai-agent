// PG1 City: vehicle and aircraft models, made in code (no third-party
// assets). Each model is ONE merged geometry with a per-vertex colour
// (glass dark, lights, trim), so every vehicle of a type is one instanced
// draw call and the paint comes from the instance colour.
//
// Real-world sizes in metres; the front faces +z, up is +y.

function part(THREE, geo, { at = [0, 0, 0], rot = null, colour = [1, 1, 1] } = {}) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  if (rot) { if (rot[0]) g.rotateX(rot[0]); if (rot[1]) g.rotateY(rot[1]); if (rot[2]) g.rotateZ(rot[2]); }
  g.translate(at[0], at[1], at[2]);
  const n = g.attributes.position.count; const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = colour[0]; c[i * 3 + 1] = colour[1]; c[i * 3 + 2] = colour[2]; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  return g;
}

function merge(THREE, parts) {
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'color', 'uv']) {
    const size = parts[0].attributes[name].itemSize;
    const arr = new Float32Array(parts.reduce((s, g) => s + g.attributes[name].count * size, 0));
    let o = 0; for (const g of parts) { arr.set(g.attributes[name].array, o); o += g.attributes[name].array.length; }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  for (const g of parts) g.dispose();
  out.computeBoundingSphere();
  return out;
}

const GLASS = [0.08, 0.1, 0.12]; const TRIM = [0.16, 0.17, 0.18]; const WHITE = [0.95, 0.95, 0.93]; const LIGHT = [1, 0.97, 0.88];
const BOX = (THREE, w, h, d) => new THREE.BoxGeometry(w, h, d);

// Road vehicles. Light heights per type for the head and tail lights.
export const LIGHT_Y = Object.freeze({ car: 0.68, taxi: 0.68, suv: 0.85, motorbike: 0.95, van: 1.0, lorry: 1.05, bus: 0.95 });
export const WHEELS = Object.freeze({ car: [[0.86, 1.4], [0.86, -1.4]], taxi: [[0.86, 1.4], [0.86, -1.4]], suv: [[0.92, 1.5], [0.92, -1.5]], motorbike: [[0, 0.75], [0, -0.75]], van: [[0.95, 1.9], [0.95, -1.9]], lorry: [[1.1, 3.5], [1.1, -1.4], [1.1, -3.3]], bus: [[1.1, 4.2], [1.1, -3.3], [1.1, -4.5]] });

export function vehicleGeometries(THREE) {
  const g = {};
  g.car = merge(THREE, [
    part(THREE, BOX(THREE, 1.84, 0.6, 4.5), { at: [0, 0.55, 0] }),
    part(THREE, BOX(THREE, 1.62, 0.5, 2.25), { at: [0, 1.08, -0.2], colour: GLASS }),
    part(THREE, BOX(THREE, 1.5, 0.07, 1.7), { at: [0, 1.36, -0.25] }),
    part(THREE, BOX(THREE, 1.9, 0.18, 0.12), { at: [0, 0.35, 2.26], colour: TRIM }),
    part(THREE, BOX(THREE, 1.9, 0.18, 0.12), { at: [0, 0.35, -2.26], colour: TRIM })
  ]);
  g.taxi = merge(THREE, [
    part(THREE, BOX(THREE, 1.84, 0.6, 4.6), { at: [0, 0.55, 0] }),
    part(THREE, BOX(THREE, 1.62, 0.5, 2.3), { at: [0, 1.08, -0.2], colour: GLASS }),
    part(THREE, BOX(THREE, 1.5, 0.07, 1.7), { at: [0, 1.36, -0.25] }),
    part(THREE, BOX(THREE, 0.62, 0.2, 0.28), { at: [0, 1.5, -0.1], colour: LIGHT })
  ]);
  g.suv = merge(THREE, [
    part(THREE, BOX(THREE, 1.96, 0.82, 4.8), { at: [0, 0.68, 0] }),
    part(THREE, BOX(THREE, 1.82, 0.62, 3.0), { at: [0, 1.4, -0.3], colour: GLASS }),
    part(THREE, BOX(THREE, 1.8, 0.08, 2.9), { at: [0, 1.74, -0.3] }),
    part(THREE, BOX(THREE, 2.0, 0.22, 0.14), { at: [0, 0.42, 2.38], colour: TRIM })
  ]);
  g.motorbike = merge(THREE, [
    part(THREE, BOX(THREE, 0.32, 0.45, 1.8), { at: [0, 0.62, 0] }),
    part(THREE, BOX(THREE, 0.44, 0.62, 0.34), { at: [0, 1.25, -0.15], colour: [0.2, 0.22, 0.26] }),
    part(THREE, new THREE.SphereGeometry(0.17, 8, 6), { at: [0, 1.72, -0.05], colour: WHITE })
  ]);
  g.van = merge(THREE, [
    part(THREE, BOX(THREE, 2.04, 2.15, 5.8), { at: [0, 1.25, 0] }),
    part(THREE, BOX(THREE, 1.9, 0.72, 0.06), { at: [0, 1.62, 2.91], colour: GLASS }),
    part(THREE, BOX(THREE, 2.06, 0.6, 1.0), { at: [0, 1.66, 2.2], colour: GLASS }),
    part(THREE, BOX(THREE, 2.1, 0.22, 0.14), { at: [0, 0.38, 2.93], colour: TRIM })
  ]);
  g.lorry = merge(THREE, [
    part(THREE, BOX(THREE, 2.4, 2.45, 2.1), { at: [0, 1.5, 3.65] }),
    part(THREE, BOX(THREE, 2.2, 0.85, 0.06), { at: [0, 2.15, 4.71], colour: GLASS }),
    part(THREE, BOX(THREE, 2.5, 3.0, 6.9), { at: [0, 2.0, -1.2], colour: WHITE }),
    part(THREE, BOX(THREE, 2.3, 0.3, 9.4), { at: [0, 0.55, 0], colour: TRIM })
  ]);
  // A double-deck city bus: two window bands, a dark lower skirt.
  g.bus = merge(THREE, [
    part(THREE, BOX(THREE, 2.55, 4.2, 12), { at: [0, 2.3, 0] }),
    part(THREE, BOX(THREE, 2.57, 0.95, 10.4), { at: [0, 1.75, 0.4], colour: GLASS }),
    part(THREE, BOX(THREE, 2.57, 0.95, 11.4), { at: [0, 3.45, 0], colour: GLASS }),
    part(THREE, BOX(THREE, 2.3, 1.6, 0.06), { at: [0, 2.2, 6.01], colour: GLASS }),
    part(THREE, BOX(THREE, 2.6, 0.4, 12.02), { at: [0, 0.45, 0], colour: TRIM })
  ]);
  return g;
}

export function wheelGeometry(THREE) {
  const g = new THREE.CylinderGeometry(0.34, 0.34, 0.26, 10); g.rotateZ(Math.PI / 2); g.translate(0, 0.34, 0);
  return g;
}

// Aircraft. Fuselage along +z.
export function aircraftGeometries(THREE) {
  const g = {};
  const fus = (r, len) => { const c = new THREE.CylinderGeometry(r * 0.75, r, len, 12); c.rotateX(Math.PI / 2); return c; };
  g.airliner = merge(THREE, [
    part(THREE, fus(2, 36), {}),
    part(THREE, new THREE.SphereGeometry(2, 12, 8), { at: [0, 0, 18], colour: WHITE }),
    part(THREE, BOX(THREE, 34, 0.45, 5.5), { at: [0, -0.6, 1] }),
    part(THREE, BOX(THREE, 0.4, 6.5, 4.2), { at: [0, 3.6, -15.5], colour: [0.2, 0.35, 0.62] }),
    part(THREE, BOX(THREE, 12, 0.35, 3), { at: [0, 0.6, -16] }),
    part(THREE, new THREE.CylinderGeometry(1, 1, 4, 10), { at: [-6.5, -1.6, 2.5], rot: [Math.PI / 2, 0, 0], colour: TRIM }),
    part(THREE, new THREE.CylinderGeometry(1, 1, 4, 10), { at: [6.5, -1.6, 2.5], rot: [Math.PI / 2, 0, 0], colour: TRIM }),
    part(THREE, BOX(THREE, 3.2, 0.6, 1.2), { at: [0, 0.9, 16.3], colour: GLASS })
  ]);
  g.light = merge(THREE, [
    part(THREE, fus(0.7, 8), {}),
    part(THREE, BOX(THREE, 11, 0.18, 1.5), { at: [0, 0.55, 0.8] }),
    part(THREE, BOX(THREE, 0.18, 1.6, 1.2), { at: [0, 0.9, -3.6], colour: [0.2, 0.35, 0.62] }),
    part(THREE, BOX(THREE, 3.4, 0.14, 0.9), { at: [0, 0.2, -3.7] }),
    part(THREE, BOX(THREE, 1.0, 0.5, 1.4), { at: [0, 0.6, 1.4], colour: GLASS })
  ]);
  g.helicopter = merge(THREE, [
    part(THREE, (() => { const s = new THREE.SphereGeometry(1, 14, 10); s.scale(1.25, 1.15, 2.2); return s; })(), { at: [0, 1.6, 0.6] }),
    part(THREE, (() => { const s = new THREE.SphereGeometry(1, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2); s.scale(1.05, 0.9, 1.3); s.rotateX(Math.PI / 2.4); return s; })(), { at: [0, 1.75, 1.9], colour: GLASS }),
    part(THREE, new THREE.CylinderGeometry(0.22, 0.4, 6.5, 8), { at: [0, 2.0, -4.2], rot: [Math.PI / 2, 0, 0] }),
    part(THREE, BOX(THREE, 0.14, 1.6, 0.9), { at: [0, 2.6, -7.3] }),
    part(THREE, BOX(THREE, 0.1, 0.1, 3.6), { at: [-0.9, 0.12, 0.5], colour: TRIM }),
    part(THREE, BOX(THREE, 0.1, 0.1, 3.6), { at: [0.9, 0.12, 0.5], colour: TRIM }),
    part(THREE, BOX(THREE, 0.3, 0.5, 0.3), { at: [0, 3.0, 0.6], colour: TRIM })
  ]);
  // The main rotor: a thin translucent disc that spins (drawn separately).
  g.rotor = new THREE.CylinderGeometry(5.6, 5.6, 0.05, 24, 1); g.rotor.translate(0, 3.3, 0.6);
  g.contrail = (() => { const p = new THREE.PlaneGeometry(1.2, 260); p.rotateX(-Math.PI / 2); p.translate(0, 0, -150); return p; })();
  return g;
}
