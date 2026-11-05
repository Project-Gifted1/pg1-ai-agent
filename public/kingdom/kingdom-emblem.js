// PG1 City: PG1's emblem, from the brand asset itself.
//
// The shield and its "1" are read from /brand/pg1-shield.svg (the same file
// the app's header uses): its two paths and their fills. Nothing here
// redraws or approximates the logo; a change to the brand file changes the
// emblem everywhere (tests/kingdom-view.test.mjs checks they match).
//
//   parseBrandSvg(text)               -> { viewBox, paths: [{ d, fill }] }
//   pathCommands(d)                    the path as absolute commands
//   shapeFromPath(THREE, d, opts)      a THREE.Shape in emblem units
//   brandCanvas(brand, size, opts)     the logo drawn on a canvas (decals,
//                                      billboards, drone hulls)
//   buildEmblem(THREE, brand, opts)    the large 3D emblem for the tower's
//                                      crown: the extruded, bevelled shield in
//                                      brushed gold, the "1" in black enamel,
//                                      a thin glowing gold edge
//   buildHologram(THREE, brand, opts)  the slowly turning holographic
//                                      emblem above the beacon (night only)

export const BRAND_SVG_URL = '/brand/pg1-shield.svg';

export function parseBrandSvg(text) {
  const vb = /viewBox="([^"]+)"/.exec(text);
  const paths = [...String(text).matchAll(/<path\b[^>]*\bd="([^"]+)"[^>]*\bfill="(#[0-9a-fA-F]{6})"/g)].map((m) => ({ d: m[1], fill: m[2].toLowerCase() }));
  return { viewBox: vb ? vb[1].split(/[\s,]+/).map(Number) : null, paths };
}

// M, L, H, V, C and Z (absolute), the commands the brand file uses.
export function pathCommands(d) {
  const tokens = String(d).match(/[MLHVCZmlhvcz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
  const out = []; let i = 0; let cmd = null; let x = 0; let y = 0; let sx = 0; let sy = 0;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) cmd = tokens[i++];
    switch (cmd) {
      case 'M': x = num(); y = num(); sx = x; sy = y; out.push(['M', x, y]); cmd = 'L'; break;
      case 'L': x = num(); y = num(); out.push(['L', x, y]); break;
      case 'H': x = num(); out.push(['L', x, y]); break;
      case 'V': y = num(); out.push(['L', x, y]); break;
      case 'C': { const a = [num(), num(), num(), num(), num(), num()]; out.push(['C', ...a]); x = a[4]; y = a[5]; break; }
      case 'Z': case 'z': out.push(['Z']); x = sx; y = sy; i += 0; cmd = null; break;
      default: throw new Error(`unsupported path command ${cmd}`);
    }
    if (cmd === null && i < tokens.length && !/[A-Za-z]/.test(tokens[i])) break;
  }
  return out;
}

// Emblem units: the shield's own centre at the origin, y up, 1 unit = 1/100
// of the shield's height (the brand file's 100-unit shield).
const CX = 221.76; const CY = 50;
export function shapeFromPath(THREE, d, { asPath = false } = {}) {
  const s = asPath ? new THREE.Path() : new THREE.Shape();
  const P = (x, y) => [(x - CX) / 100, (CY - y) / 100];
  for (const c of pathCommands(d)) {
    if (c[0] === 'M') s.moveTo(...P(c[1], c[2]));
    else if (c[0] === 'L') s.lineTo(...P(c[1], c[2]));
    else if (c[0] === 'C') s.bezierCurveTo(...P(c[1], c[2]), ...P(c[3], c[4]), ...P(c[5], c[6]));
    else if (c[0] === 'Z') s.closePath();
  }
  return s;
}

// The logo on a canvas, from the same paths and fills.
export function brandCanvas(brand, size = 256, { glow = false, background = null } = {}) {
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const g = cv.getContext('2d');
  if (background) { g.fillStyle = background; g.fillRect(0, 0, size, size); }
  const [vx, vy, vw, vh] = brand.viewBox || [169.76, -2, 104, 104];
  g.save(); g.scale(size / vw, size / vh); g.translate(-vx, -vy);
  if (glow) { g.shadowColor = brand.paths[0].fill; g.shadowBlur = 6; }
  for (const p of brand.paths) { g.fillStyle = p.fill; g.fill(new Path2D(p.d)); }
  g.restore();
  return cv;
}

export async function loadBrand(fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(BRAND_SVG_URL);
  if (!res.ok) throw new Error('brand asset missing');
  const brand = parseBrandSvg(await res.text());
  if (brand.paths.length < 2) throw new Error('brand asset has no shield');
  return brand;
}

// The 3D emblem, `height` metres tall, facing +z.
export function buildEmblem(THREE, brand, { height = 30, phone = false } = {}) {
  const [shieldP, oneP] = brand.paths;
  const k = height; // shape units are 1 per shield height
  const g = new THREE.Group(); g.name = 'pg1-emblem';
  const shield = shapeFromPath(THREE, shieldP.d);
  shield.holes.push(shapeFromPath(THREE, oneP.d, { asPath: true }));
  const bevel = { depth: 0.06, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.015, bevelSegments: phone ? 2 : 4, curveSegments: phone ? 10 : 24 };
  const goldMat = new THREE.MeshPhysicalMaterial({ color: shieldP.fill, metalness: 1, roughness: 0.28, anisotropy: 0.7, clearcoat: 0.3, emissive: shieldP.fill, emissiveIntensity: 0.12 });
  goldMat.userData.brandFill = shieldP.fill;
  const body = new THREE.Mesh(new THREE.ExtrudeGeometry(shield, bevel), goldMat); body.name = 'pg1-emblem-shield';
  body.scale.setScalar(k); g.add(body);
  // The "1": black enamel, set slightly back into the shield.
  const one = shapeFromPath(THREE, oneP.d);
  const enamel = new THREE.MeshPhysicalMaterial({ color: oneP.fill, metalness: 0, roughness: 0.15, clearcoat: 1, clearcoatRoughness: 0.08 });
  enamel.userData.brandFill = oneP.fill;
  const numeral = new THREE.Mesh(new THREE.ExtrudeGeometry(one, { depth: 0.05, bevelEnabled: false, curveSegments: phone ? 6 : 12 }), enamel); numeral.name = 'pg1-emblem-one';
  numeral.scale.setScalar(k); numeral.position.z = 0.012 * k; g.add(numeral);
  // The glowing gold edge: a thin rim, the shield's own outline inset by 3 %.
  const rim = shapeFromPath(THREE, shieldP.d);
  const inner = new THREE.Path(shapeFromPath(THREE, shieldP.d).getPoints(phone ? 40 : 90).slice(0, -1).map((p) => p.clone().multiplyScalar(0.965)).reverse());
  rim.holes.push(inner);
  const edgeMat = new THREE.MeshBasicMaterial({ color: 0xffd34d, transparent: true, opacity: 0.9 });
  const edge = new THREE.Mesh(new THREE.ExtrudeGeometry(rim, { depth: 0.012, bevelEnabled: false, curveSegments: phone ? 10 : 24 }), edgeMat); edge.name = 'pg1-emblem-edge';
  edge.scale.setScalar(k); edge.position.z = 0.085 * k; g.add(edge);
  return { group: g, gold: goldMat, edge: edgeMat, enamel };
}

// The hologram: the shield as light, with scan lines, turning slowly.
export function buildHologram(THREE, brand, { height = 22 } = {}) {
  const shape = shapeFromPath(THREE, brand.paths[0].d);
  shape.holes.push(shapeFromPath(THREE, brand.paths[1].d, { asPath: true }));
  const u = { uTime: { value: 0 }, uAlpha: { value: 0 }, uColor: { value: new THREE.Color(brand.paths[0].fill) } };
  const m = new THREE.Mesh(new THREE.ShapeGeometry(shape, 24), new THREE.ShaderMaterial({
    uniforms: u, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    vertexShader: 'varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: 'uniform float uTime; uniform float uAlpha; uniform vec3 uColor; varying vec2 vP; void main(){ float scan = 0.55 + 0.45 * step(0.5, fract(vP.y * 40.0 - uTime * 0.8)); float shimmer = 0.85 + 0.15 * sin(uTime * 3.0 + vP.y * 12.0); gl_FragColor = vec4(uColor, uAlpha * scan * shimmer * 0.55); }'
  }));
  m.name = 'pg1-emblem-hologram';
  m.scale.setScalar(height);
  return { mesh: m, uniforms: u };
}
