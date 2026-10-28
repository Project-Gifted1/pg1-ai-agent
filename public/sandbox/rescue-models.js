// PG1 Sandbox viewer: emergency services and the beach (the engine's
// lib/sandbox/emergency.mjs). Drawn in code, like every model here.
//
//   fire_station     red engine-bay doors, a drill tower, a flagpole
//   fire_truck       red, a ladder on the roof, lockers, a light bar
//   ambulance        white box body with stripes and a light bar
//   lifeguard_tower  a hut on stilts with a ramp, a flag and a rescue board
//   kayak, sailboat, jet_ski, yacht
//   props (worn by people at the beach, see sandbox-scene.js):
//     prop_sunbathe   a towel under a striped umbrella
//     prop_surf       a surfboard
//     prop_sandcastle a sandcastle with a bucket
//     prop_volleyball a net between two poles, and a ball
//
// Light bars are two parts, 'beaconA' and 'beaconB', which the scene
// flashes in turn while the vehicle is on a call (its `siren`).
//
//   rescueModel(T, Kit, kind, p, seed, { partOf, wheelPair }) -> model | null

export const RESCUE_CLASS = Object.freeze({
  fire_station: 'building', lifeguard_tower: 'structure',
  fire_truck: 'vehicle', ambulance: 'vehicle', kayak: 'vehicle', sailboat: 'vehicle', jet_ski: 'vehicle', yacht: 'vehicle'
});
export const RESCUE_FIXED = Object.freeze(['fire_station', 'lifeguard_tower']);
export const PROP_KINDS = Object.freeze({ sunbathe: 'prop_sunbathe', surf: 'prop_surf', sandcastle: 'prop_sandcastle', volleyball: 'prop_volleyball' });

const out = (k, extra = {}) => ({ ...k.build(), parts: [], ...extra });
const col = (c, d) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : d);

export function rescueModel(T, Kit, kind, p = {}, seed = 0, { partOf, wheelPair } = {}) {
  const k = new Kit(T);
  // A light bar: red and blue halves that flash in turn.
  const beacons = (x, y, w) => [
    partOf(T, (q) => q.box(0.35, 0.18, w / 2 - 0.05, '#ff1744', 0, 0, 0, { layer: 'glow' }), [x, y, w / 4], 'beaconA'),
    partOf(T, (q) => q.box(0.35, 0.18, w / 2 - 0.05, '#2979ff', 0, 0, 0, { layer: 'glow' }), [x, y, -w / 4], 'beaconB')
  ];
  switch (kind) {
    case 'fire_station': {
      k.box(24, 8, 16, '#b0413e', 0, 4, 0);                              // brick hall
      k.box(24.4, 0.6, 16.4, '#5d4037', 0, 8.3, 0);                        // parapet
      for (const z of [-4.5, 0, 4.5]) { k.box(0.1, 5.4, 3.8, '#c62828', 12.05, 2.7, z); for (let y = 0.6; y < 5.4; y += 0.9) k.box(0.12, 0.05, 3.8, '#8e1b1b', 12.1, y, z); k.box(0.12, 1, 3.6, '#22313f', 12.1, 4.6, z, { layer: 'glass' }); }
      k.box(0.12, 0.8, 9, '#fafafa', 12.12, 6.6, 0); k.box(0.14, 0.4, 8.2, '#c62828', 12.14, 6.6, 0);   // sign board
      k.box(4, 16, 4, '#9e3b37', -9, 8, -5); for (let y = 2; y < 16; y += 3) k.box(0.1, 1.2, 1.2, '#22313f', -6.95, y, -5, { layer: 'glass' });   // drill tower
      k.cyl(0.08, 0.08, 10, 6, '#bdbdbd', 11, 5, 7.5); k.box(0.02, 1.1, 1.8, '#c62828', 11, 9.3, 8.4);   // flagpole
      k.box(14, 0.08, 16, '#9e9e9e', 19, 0.04, 0);                          // apron
      return out(k, { size: 24 });
    }
    case 'lifeguard_tower': {
      for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.cyl(0.08, 0.1, 2.6, 6, '#e0e0e0', x, 1.3, z);
      k.box(2.6, 0.12, 2.6, '#d7ccc8', 0, 2.65, 0);
      k.box(2.4, 1.8, 2.4, '#f9a825', 0, 3.6, 0);
      k.box(0.06, 0.8, 2, '#22313f', 1.23, 3.8, 0, { layer: 'glass' });
      k.prism([[-1.6, 0], [1.6, 0], [0, 0.7]], 2.8, '#c62828', 0, 4.5, 0);
      k.box(3.4, 0.1, 0.9, '#bcaaa4', 2.6, 1.3, 0, { rz: -0.75 });       // ramp
      k.cyl(0.04, 0.04, 2.4, 6, '#bdbdbd', -1.2, 5.6, 1.2); k.box(0.02, 0.6, 1, '#d50000', -1.2, 6.5, 1.7);   // red flag
      k.capsule(0.12, 1.8, '#d50000', 1.5, 0.3, -1.6, { rz: Math.PI / 2 });                                   // rescue tube
      return out(k, { size: 6 });
    }
    case 'fire_truck': {
      k.box(2.4, 1.9, 2.4, '#c62828', 3.3, 1.75, 0);                         // cab
      k.box(0.1, 0.9, 2.1, '#22313f', 4.52, 2.15, 0, { layer: 'glass' });
      k.box(1.9, 0.7, 2.42, '#22313f', 3.2, 2.2, 0, { layer: 'glass' });
      k.box(6.6, 2.1, 2.5, '#c62828', -1.3, 1.85, 0);                        // body
      for (const z of [1.26, -1.26]) for (let i = 0; i < 4; i++) k.box(1.4, 1.5, 0.04, '#b71c1c', -3.8 + i * 1.65, 1.85, z);   // lockers
      k.box(9, 0.3, 2.3, '#263238', 0.3, 0.55, 0);
      k.box(9.2, 0.12, 2.52, '#fafafa', 0.3, 1.1, 0);                         // white stripe
      // The ladder on top, and its turntable.
      k.cyl(0.5, 0.6, 0.4, 12, '#9e9e9e', -3.6, 3.1, 0);
      for (const z of [0.45, -0.45]) k.box(7.5, 0.1, 0.08, '#e0e0e0', 0, 3.3, z);
      for (let x = -3.5; x <= 3.5; x += 0.5) k.box(0.05, 0.08, 0.9, '#e0e0e0', x, 3.3, 0);
      k.box(0.08, 0.2, 0.4, '#fff8e1', 4.53, 1.1, 0.9, { layer: 'glow' }); k.box(0.08, 0.2, 0.4, '#fff8e1', 4.53, 1.1, -0.9, { layer: 'glow' });
      return { ...k.build(), parts: [wheelPair(T, 3.2, 0.5, 1.1, 0.5, 0.35), wheelPair(T, -2.6, 0.5, 1.1, 0.5, 0.35), ...beacons(3.4, 2.82, 1.8)], size: 10 };
    }
    case 'ambulance': {
      k.box(1.8, 1.5, 2.1, '#fafafa', 2.4, 1.4, 0);                          // cab
      k.box(0.1, 0.8, 1.9, '#22313f', 3.32, 1.75, 0, { layer: 'glass' });
      k.box(4.2, 2.3, 2.3, '#fafafa', -0.7, 1.75, 0);                         // box body
      for (const z of [1.16, -1.16]) { k.box(5.9, 0.25, 0.04, '#c62828', 0.15, 1.3, z); k.box(5.9, 0.12, 0.04, '#2e7d32', 0.15, 1.55, z); k.box(0.7, 0.18, 0.05, '#c62828', -0.7, 2.2, z); k.box(0.18, 0.7, 0.05, '#c62828', -0.7, 2.2, z); }
      k.box(0.05, 1.6, 2, '#eceff1', -2.82, 1.75, 0);                         // rear doors
      k.box(6.2, 0.3, 2.2, '#263238', 0.2, 0.5, 0);
      k.box(0.08, 0.18, 0.4, '#fff8e1', 3.33, 1, 0.8, { layer: 'glow' }); k.box(0.08, 0.18, 0.4, '#fff8e1', 3.33, 1, -0.8, { layer: 'glow' });
      return { ...k.build(), parts: [wheelPair(T, 2.2, 0.42, 0.98, 0.42, 0.3), wheelPair(T, -1.9, 0.42, 0.98, 0.42, 0.3), ...beacons(2.4, 2.25, 1.7)], size: 7 };
    }
    case 'kayak': {
      const c = col(p.color, '#e74c3c');
      k.lathe([[0, -2.4], [0.18, -1.8], [0.3, -0.6], [0.32, 0], [0.3, 0.6], [0.18, 1.8], [0, 2.4]], 12, c, 0, 0.12, 0, { rz: Math.PI / 2, sz: 0.55 });
      k.box(0.7, 0.05, 0.4, '#212121', 0, 0.3, 0);                            // cockpit
      k.cyl(0.02, 0.02, 2.2, 5, '#9e9e9e', 0, 0.45, 0, { rx: Math.PI / 2 }); for (const z of [1.1, -1.1]) k.box(0.25, 0.03, 0.12, '#fbc02d', 0, 0.45, z);   // paddle
      return out(k, { size: 5 });
    }
    case 'sailboat': {
      const c = col(p.color, '#ffffff');
      k.prism([[-3.5, 0.9], [4.2, 0.9], [3.5, 0], [-3.2, 0]], 2.2, c, 0, -0.2, 0);
      k.box(7, 0.1, 2.1, '#a1887f', 0, 0.72, 0);
      k.cyl(0.07, 0.08, 9, 6, '#eceff1', 0.6, 5.2, 0);                        // mast
      k.prism([[0, 0], [0, 7.6], [-3.4, 0]], 0.04, '#fafafa', 0.55, 1.1, 0);  // mainsail
      k.prism([[0, 0], [0, 6.4], [2.6, 0]], 0.04, '#e3f2fd', 0.65, 1.1, 0);   // jib
      k.box(3.6, 0.06, 0.06, '#9e9e9e', -1.2, 1.1, 0);                         // boom
      return out(k, { size: 8, wake: true });
    }
    case 'jet_ski': {
      const c = col(p.color, '#1565c0');
      k.prism([[-1.4, 0.55], [1.6, 0.55], [1.2, 0], [-1.3, 0]], 1.1, c, 0, 0, 0);
      k.box(1.3, 0.28, 0.55, '#212121', -0.3, 0.68, 0);                        // seat
      k.box(0.25, 0.4, 0.8, '#eceff1', 0.8, 0.8, 0); k.box(0.06, 0.06, 0.9, '#212121', 0.85, 1.0, 0);   // bars
      return out(k, { size: 3.5, wake: true });
    }
    case 'yacht': {
      const c = col(p.color, '#ffffff');
      k.prism([[-11, 2.4], [12.5, 2.4], [10.5, 0], [-10, 0]], 5.2, c, 0, -0.8, 0);
      k.box(22, 0.15, 4.9, '#8d6e63', 0, 1.65, 0);                             // teak deck
      k.box(11, 2.2, 4.2, '#fafafa', -1.5, 2.8, 0);
      k.box(10.6, 0.9, 4.25, '#22313f', -1.5, 3.1, 0, { layer: 'glass' });
      k.box(6, 1.8, 3.6, '#fafafa', -1, 4.8, 0); k.box(5.6, 0.7, 3.65, '#22313f', -1, 5.0, 0, { layer: 'glass' });
      k.cyl(0.08, 0.08, 3, 6, '#bdbdbd', -2, 7.2, 0);                          // radar mast
      k.box(0.2, 0.3, 1.6, '#212121', -2, 8.6, 0);
      return out(k, { size: 24, wake: true });
    }
    case 'prop_sunbathe': {
      k.box(1.9, 0.02, 0.8, col(p.color, '#29b6f6'), 0, 0.02, 0);              // towel
      k.cyl(0.03, 0.03, 2.2, 6, '#eceff1', -0.9, 1.1, 0.5);
      for (let i = 0; i < 8; i++) k.cone(1.25, 0.5, 3, i % 2 ? '#fafafa' : '#e53935', -0.9, 2.3, 0.5, { ry: (i * Math.PI) / 4 });   // umbrella
      return out(k, { size: 3 });
    }
    case 'prop_surf': {
      const c = col(p.color, '#ffca28');
      k.box(1.7, 0.07, 0.56, c, 0, 0.05, 0);
      for (const x of [0.85, -0.85]) k.cyl(0.28, 0.28, 0.07, 14, c, x, 0.05, 0);   // rounded nose and tail
      k.box(1.9, 0.075, 0.04, '#e53935', 0, 0.06, 0);                            // stringer
      return out(k, { size: 2.5 });
    }
    case 'prop_sandcastle': {
      k.cyl(0.45, 0.55, 0.4, 10, '#e6c98f', 0.8, 0.2, 0);
      for (const [x, z] of [[0.45, 0.35], [1.15, 0.35], [0.45, -0.35], [1.15, -0.35]]) k.cyl(0.14, 0.16, 0.65, 8, '#e0c084', x, 0.32, z);
      k.cyl(0.13, 0.1, 0.22, 10, '#ef5350', 1.4, 0.11, -0.7);                   // bucket
      return out(k, { size: 2 });
    }
    case 'prop_volleyball': {
      for (const z of [-4, 4]) k.cyl(0.05, 0.05, 2.4, 6, '#eceff1', 1.5, 1.2, z);
      k.box(0.02, 0.9, 8, '#fafafa', 1.5, 2.0, 0);
      k.sphere(0.11, '#fff59d', 1.5, 3.2, 1);
      return out(k, { size: 9 });
    }
    default: return null;
  }
}
