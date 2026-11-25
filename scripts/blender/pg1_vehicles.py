# Detailed stand-ins for the City's simple movers, in the City's own local
# space (three.js: x right, y up, z forward), so the per-frame instance
# matrices from cycles-dump.mjs move them exactly as the City moves its own.
# Each returns (verts Nx3, faces [[i, ...], ...]).

import math


def _merge(parts):
    verts, faces = [], []
    for v, f in parts:
        o = len(verts); verts.extend(v); faces.extend([[i + o for i in face] for face in f])
    return verts, faces


def _loft(rings):
    """Faces between consecutive rings (each a list of points, same count), caps at the ends."""
    verts = [p for r in rings for p in r]; n = len(rings[0]); faces = []
    for k in range(len(rings) - 1):
        for i in range(n):
            j = (i + 1) % n
            faces.append([k * n + i, k * n + j, (k + 1) * n + j, (k + 1) * n + i])
    faces.append(list(range(n))[::-1]); faces.append([(len(rings) - 1) * n + i for i in range(n)])
    return verts, faces


def _box(cx, cy, cz, sx, sy, sz):
    v = [(cx + x * sx / 2, cy + y * sy / 2, cz + z * sz / 2) for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)]
    f = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]]
    return v, f


def _wing(root_z, span, root_chord, tip_chord, sweep, y, thick, x_sign_both=True, dihedral=0.0):
    """A tapered, swept wing pair (or tailplane) as two thin slabs."""
    parts = []
    for s in (-1, 1):
        tip_x = s * span; tip_z = root_z - sweep; ty = y + dihedral
        v = [(0, y - thick / 2, root_z + root_chord / 2), (0, y - thick / 2, root_z - root_chord / 2),
             (tip_x, ty - thick / 4, tip_z - tip_chord / 2), (tip_x, ty - thick / 4, tip_z + tip_chord / 2),
             (0, y + thick / 2, root_z + root_chord / 2), (0, y + thick / 2, root_z - root_chord / 2),
             (tip_x, ty + thick / 4, tip_z - tip_chord / 2), (tip_x, ty + thick / 4, tip_z + tip_chord / 2)]
        f = [[0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]]
        if s < 0:
            f = [list(reversed(x)) for x in f]
        parts.append((v, f))
    return _merge(parts)


def airliner():
    """A twin-engine airliner, about 38 m long (nose to +z), as the City's."""
    seg = 16; rings = []
    # Fuselage stations (z, radius, y offset): nose cone, cabin, tail cone rising.
    st = [(19.0, 0.05, -0.2), (18.2, 0.9, -0.3), (16.8, 1.6, -0.15), (14.5, 1.95, 0), (-10, 1.95, 0), (-14, 1.6, 0.35), (-17.5, 0.8, 0.9), (-19, 0.15, 1.2)]
    for z, r, yo in st:
        rings.append([(r * math.cos(a), yo + r * 1.05 * math.sin(a), z) for a in (2 * math.pi * i / seg for i in range(seg))])
    parts = [_loft(rings)]
    parts.append(_wing(1.5, 17.5, 6.5, 1.8, 6.5, -0.9, 0.5, dihedral=1.2))      # wings
    parts.append(_wing(-16.0, 6.5, 3.4, 1.2, 2.8, 0.9, 0.25))                  # tailplane
    # Fin: a swept slab up from the tail.
    fv = [(-0.15, 1.2, -13.0), (-0.15, 1.2, -18.6), (-0.15, 7.2, -20.0), (-0.15, 7.2, -17.6),
          (0.15, 1.2, -13.0), (0.15, 1.2, -18.6), (0.15, 7.2, -20.0), (0.15, 7.2, -17.6)]
    ff = [[0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]]
    parts.append((fv, ff))
    # Engines under the wings: short nacelles.
    for x in (-6.5, 6.5):
        er = []
        for z, r in ((5.6, 0.9), (5.2, 1.15), (2.2, 1.15), (1.2, 0.7)):
            er.append([(x + r * math.cos(a), -1.9 + r * math.sin(a), z) for a in (2 * math.pi * i / 12 for i in range(12))])
        parts.append(_loft(er))
    return _merge(parts)


REPLACE = {'aircraft': airliner}
