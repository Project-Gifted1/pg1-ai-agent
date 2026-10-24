// PG1 Sandbox viewer: a small kit for building models out of primitives.
// Every part is baked into one geometry per layer (with its colour as a
// vertex colour), so a whole house or car is one draw call, not thirty.
//
//   const k = new Kit(THREE);
//   k.box(4, 1.2, 1.8, '#c0392b', 0, 0.6, 0);            // w, h, d, colour, x, y, z
//   k.cyl(0.35, 0.35, 0.25, 16, '#111', 1.3, 0.35, 0.9, { rx: Math.PI / 2 });
//   const { body, glow, glass } = k.build();             // BufferGeometry or null
//
// Layers: body (lit, opaque), glow (unlit: windows, lamps, flames; the
// scene dims it by day and brightens it at night), glass (shiny, darker).

export class Kit {
  constructor(THREE) {
    this.T = THREE;
    this.layers = { body: [], glow: [], glass: [] };
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();
  }

  // Adds a geometry with a colour, a position and optional rotation/scale.
  add(geo, color, x = 0, y = 0, z = 0, o = {}) {
    const T = this.T;
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    if (geo.index || g !== geo) geo.dispose();
    this._e.set(o.rx || 0, o.ry || 0, o.rz || 0, o.order || 'XYZ');
    this._q.setFromEuler(this._e);
    this._p.set(x, y, z);
    this._s.set(o.sx ?? 1, o.sy ?? 1, o.sz ?? 1);
    this._m.compose(this._p, this._q, this._s);
    if (o.pre) g.applyMatrix4(o.pre);
    g.applyMatrix4(this._m);
    if (o.post) g.applyMatrix4(o.post);
    if (!g.attributes.normal) g.computeVertexNormals();
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    this._c.set(color);
    const jitter = o.jitter || 0;
    for (let i = 0; i < n; i++) {
      const j = jitter ? 1 + (((i * 2654435761) >>> 0) % 1000 / 1000 - 0.5) * jitter : 1;
      col[i * 3] = this._c.r * j; col[i * 3 + 1] = this._c.g * j; col[i * 3 + 2] = this._c.b * j;
    }
    g.setAttribute('color', new T.BufferAttribute(col, 3));
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color'].includes(k)) g.deleteAttribute(k);
    this.layers[o.layer || 'body'].push(g);
    return this;
  }

  box(w, h, d, color, x, y, z, o) { return this.add(new this.T.BoxGeometry(w, h, d), color, x, y, z, o); }
  cyl(rt, rb, h, seg, color, x, y, z, o) { return this.add(new this.T.CylinderGeometry(rt, rb, h, seg || 12, 1, !!(o && o.open)), color, x, y, z, o); }
  cone(r, h, seg, color, x, y, z, o) { return this.add(new this.T.ConeGeometry(r, h, seg || 12), color, x, y, z, o); }
  sphere(r, color, x, y, z, o = {}) { return this.add(new this.T.SphereGeometry(r, o.seg || 14, o.rings || 10), color, x, y, z, o); }
  ico(r, detail, color, x, y, z, o) { return this.add(new this.T.IcosahedronGeometry(r, detail || 0), color, x, y, z, o); }
  torus(r, tube, color, x, y, z, o = {}) { return this.add(new this.T.TorusGeometry(r, tube, o.rseg || 8, o.tseg || 20), color, x, y, z, o); }
  capsule(r, len, color, x, y, z, o = {}) { return this.add(new this.T.CapsuleGeometry(r, len, o.cseg || 6, o.rseg || 12), color, x, y, z, o); }

  // A prism from a 2D outline (x, y points), extruded `depth` along z and centred on it.
  prism(points, depth, color, x, y, z, o = {}) {
    const T = this.T;
    const shape = new T.Shape(points.map(([a, b]) => new T.Vector2(a, b)));
    const g = new T.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
    g.translate(0, 0, -depth / 2);
    return this.add(g, color, x, y, z, o);
  }

  // A shape turned around the y axis (points: [radius, height]).
  lathe(points, seg, color, x, y, z, o) {
    const T = this.T;
    return this.add(new T.LatheGeometry(points.map(([a, b]) => new T.Vector2(a, b)), seg || 16), color, x, y, z, o);
  }

  // Merges each layer into one BufferGeometry (null when empty).
  build() {
    const out = {};
    for (const [name, list] of Object.entries(this.layers)) out[name] = list.length ? mergeGeometries(this.T, list) : null;
    return out;
  }

  get empty() { return !this.layers.body.length && !this.layers.glow.length && !this.layers.glass.length; }
}

// Non-indexed geometries with position, normal and color -> one geometry.
export function mergeGeometries(THREE, list) {
  let n = 0;
  for (const g of list) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3); const nor = new Float32Array(n * 3); const col = new Float32Array(n * 3);
  let o = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    col.set(g.attributes.color.array, o * 3);
    o += g.attributes.position.count;
    g.dispose();
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  m.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  m.setAttribute('color', new THREE.BufferAttribute(col, 3));
  m.computeBoundingSphere();
  m.computeBoundingBox();
  return m;
}

// Copies a built geometry with a transform applied (for batching fixed things).
export function placed(THREE, geo, matrix) {
  const g = geo.clone();
  g.applyMatrix4(matrix);
  return g;
}
