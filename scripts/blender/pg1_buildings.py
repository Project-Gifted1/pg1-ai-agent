# PG1 City skyline in detail, for Cycles (used by city_cycles.py).
#
# The live City draws each building as one box, cylinder, tapered or twisted
# shape with its windows in a shader. Here each building record from
# city-export.mjs (kind, place, size, turn, seed, style) becomes real
# geometry: setbacks on tall towers, floor bands and cornices on stone and
# brick, spandrel bands on glass, parapets, plant rooms, water tanks, masts
# with aviation lights. Everything is seeded by the building's own seed, so a
# building looks the same in every shot.
#
# Material slots on the skyline mesh:
#   0 facade (windows in the shader, from the vertex colour: r = seed/997, g = style/8)
#   1 trim (bands, cornices, parapets)
#   2 roof plant (metal)
#   3 aviation light (red emission)
#   4 crown light (an LED band near the top; colour from the seed in the shader)

import math, random
import bmesh

GLASS, STONE, BRICK, METAL, GEORGIAN, PODIUM = range(6)
FACADE, TRIM, PLANT, LIGHT, CROWN = range(5)


def _box(bm, col, cx, cy, z0, w, d, h, mat, rot=0.0):
    """An axis box (w along x, d along y) from z0 up h, turned rot about its centre."""
    if w <= 0.01 or d <= 0.01 or h <= 0.01:
        return
    c, s = math.cos(rot), math.sin(rot)
    pts = []
    for z in (z0, z0 + h):
        for (x, y) in ((-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2)):
            pts.append(bm.verts.new((cx + x * c - y * s, cy + x * s + y * c, z)))
    faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    for f in faces:
        face = bm.faces.new([pts[i] for i in f]); face.material_index = mat
        for loop in face.loops:
            loop[col] = COLOUR[0]


def _prism(bm, col, ring_fn, n, z0, h, mat, segments=1, cap=True):
    """A prism from a ring of n points (ring_fn(t, i) -> (x, y), t = 0..1 up the height)."""
    rings = []
    for k in range(segments + 1):
        t = k / segments
        rings.append([bm.verts.new((*ring_fn(t, i), z0 + h * t)) for i in range(n)])
    for k in range(segments):
        a, b = rings[k], rings[k + 1]
        for i in range(n):
            j = (i + 1) % n
            face = bm.faces.new((a[i], a[j], b[j], b[i])); face.material_index = mat
            for loop in face.loops:
                loop[col] = COLOUR[0]
    if cap:
        for ring, rev in ((rings[0], True), (rings[-1], False)):
            face = bm.faces.new(list(reversed(ring)) if rev else ring); face.material_index = mat
            for loop in face.loops:
                loop[col] = COLOUR[0]


COLOUR = [(1, 1, 1, 1)]  # the current building's vertex colour (set per building)


def _roof(bm, col, rnd, cx, cy, top, w, d, rot, style, h_total, round_=False):
    # Parapet (trim), then plant: boxes, a water tank on brick and stone, a mast on the tallest.
    t = 0.35
    if round_:
        r = min(w, d) / 2
        _prism(bm, col, lambda tt, i: (cx + (r + 0.05) * math.cos(i / 32 * 2 * math.pi), cy + (r + 0.05) * math.sin(i / 32 * 2 * math.pi)), 32, top, 1.0, TRIM, cap=False)
    else:
        c, s = math.cos(rot), math.sin(rot)
        for (ox, oy, ww, dd) in ((0, d / 2 - t / 2, w, t), (0, -d / 2 + t / 2, w, t), (w / 2 - t / 2, 0, t, d), (-w / 2 + t / 2, 0, t, d)):
            _box(bm, col, cx + ox * c - oy * s, cy + ox * s + oy * c, top, ww, dd, 1.1, TRIM, rot)
    n = 1 + int(rnd.random() * 3)
    for _ in range(n):
        pw, pd = w * (0.15 + rnd.random() * 0.2), d * (0.15 + rnd.random() * 0.2)
        ox, oy = (rnd.random() - 0.5) * (w - pw) * 0.6, (rnd.random() - 0.5) * (d - pd) * 0.6
        c, s = math.cos(rot), math.sin(rot)
        _box(bm, col, cx + ox * c - oy * s, cy + ox * s + oy * c, top, pw, pd, 2.5 + rnd.random() * 3.0, PLANT, rot)
    if style in (BRICK, STONE, GEORGIAN) and rnd.random() < 0.45 and not round_:
        r = 1.6 + rnd.random() * 0.8; ox, oy = (rnd.random() - 0.5) * w * 0.4, (rnd.random() - 0.5) * d * 0.4
        _prism(bm, col, lambda tt, i: (cx + ox + r * math.cos(i / 12 * 2 * math.pi), cy + oy + r * math.sin(i / 12 * 2 * math.pi)), 12, top + 2.5, 3.2, PLANT)
        for (lx, ly) in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            _box(bm, col, cx + ox + lx * r * 0.6, cy + oy + ly * r * 0.6, top, 0.2, 0.2, 2.5, PLANT)
    if h_total > 90 and rnd.random() < 0.7:
        mh = 8 + rnd.random() * 16
        _box(bm, col, cx, cy, top, 0.5, 0.5, mh, PLANT)
        _box(bm, col, cx, cy, top + mh, 0.7, 0.7, 0.7, LIGHT)


def _bands(bm, col, rnd, cx, cy, z0, h, w, d, rot, style, round_=False):
    # Floor bands every few storeys (stone, brick, georgian), spandrels on glass at each tier top.
    if style in (STONE, BRICK, GEORGIAN):
        every = 3.6 * (3 if style == GEORGIAN else 4)
        z = z0 + every
        while z < z0 + h - 2:
            if round_:
                r = min(w, d) / 2 + 0.25
                _prism(bm, col, lambda tt, i, r=r: (cx + r * math.cos(i / 32 * 2 * math.pi), cy + r * math.sin(i / 32 * 2 * math.pi)), 32, z, 0.35, TRIM)
            else:
                _box(bm, col, cx, cy, z, w + 0.5, d + 0.5, 0.35, TRIM, rot)
            z += every
        # Cornice.
        if round_:
            r = min(w, d) / 2 + 0.5
            _prism(bm, col, lambda tt, i: (cx + r * math.cos(i / 32 * 2 * math.pi), cy + r * math.sin(i / 32 * 2 * math.pi)), 32, z0 + h - 0.8, 0.8, TRIM)
        else:
            _box(bm, col, cx, cy, z0 + h - 0.8, w + 1.0, d + 1.0, 0.8, TRIM, rot)
    elif not round_:
        _box(bm, col, cx, cy, z0 + h - 0.6, w + 0.12, d + 0.12, 0.6, TRIM, rot)


def build(bm, col, b):
    """One building from its record (three.js units: x east, y up, z south)."""
    rnd = random.Random(int(b['seed'] * 1000) + int(b['x'] * 7) + int(b['z'] * 13))
    cx, cy, z0 = b['x'], -b['z'], b['y']
    w, d, h, rot, style, kind = b['w'], b['d'], b['h'], b['ry'], int(round(b['style'])), b['kind']
    # b = the building's base height / 400: the shader finds the ground floor (shops).
    COLOUR[0] = (b['seed'] / 997.0, style / 8.0, max(0.0, z0) / 400.0, 1.0)
    if kind == 'box':
        if h > 55 and style in (GLASS, METAL):
            # Setbacks: two or three tiers.
            tiers = [(0.0, 0.62), (0.1, 0.26), (0.2, 0.12)] if rnd.random() < 0.6 else [(0.0, 0.72), (0.14, 0.28)]
            z = z0
            for inset, frac in tiers:
                th = h * frac; tw, td = w * (1 - inset * 2), d * (1 - inset * 2)
                _box(bm, col, cx, cy, z, tw, td, th, FACADE, rot)
                _bands(bm, col, rnd, cx, cy, z, th, tw, td, rot, style)
                z += th
            _roof(bm, col, rnd, cx, cy, z, tw, td, rot, style, h)
        else:
            _box(bm, col, cx, cy, z0, w, d, h, FACADE, rot)
            if style != PODIUM:
                _bands(bm, col, rnd, cx, cy, z0, h, w, d, rot, style)
            _roof(bm, col, rnd, cx, cy, z0 + h, w, d, rot, style, h)
    elif kind == 'round':
        r = min(w, d) / 2
        _prism(bm, col, lambda t, i: (cx + r * math.cos(i / 32 * 2 * math.pi), cy + r * math.sin(i / 32 * 2 * math.pi)), 32, z0, h, FACADE)
        _bands(bm, col, rnd, cx, cy, z0, h, w, d, rot, style, round_=True)
        _roof(bm, col, rnd, cx, cy, z0 + h, w, d, rot, style, h, round_=True)
    elif kind == 'taper':
        # Four sides, 0.62 -> 0.4 of the width (as the live City), turned 45 degrees, with a spire.
        def ring(t, i, w=w, d=d):
            k = 0.62 + (0.4 - 0.62) * t
            a = rot + math.pi / 4 + i * math.pi / 2
            return (cx + math.cos(a) * w * k, cy + math.sin(a) * d * k)
        _prism(bm, col, ring, 4, z0, h, FACADE)
        _box(bm, col, cx, cy, z0 + h, 0.6, 0.6, h * 0.12, PLANT)
        _box(bm, col, cx, cy, z0 + h * 1.12, 0.8, 0.8, 0.8, LIGHT)
    elif kind == 'twist':
        side = min(w, d)
        def ring(t, i, side=side):
            a = rot + t * 0.35 * math.pi + math.pi / 4 + i * math.pi / 2
            return (cx + math.cos(a) * side / math.sqrt(2), cy + math.sin(a) * side / math.sqrt(2))
        _prism(bm, col, ring, 4, z0, h, FACADE, segments=24)
        top_rot = rot + 0.35 * math.pi
        _roof(bm, col, rnd, cx, cy, z0 + h, side * 0.8, side * 0.8, top_rot, style, h)


def _crown(bm, col, b):
    """About 40% of towers over 45 m: an LED band (sometimes two) just under the top."""
    cr = random.Random(int(b['seed'] * 7919) + int(b['x'] * 3) + int(b['z'] * 5) + 17)
    if b['h'] < 45 or cr.random() > 0.42 or b['kind'] == 'twist':
        return
    cx, cy, z0 = b['x'], -b['z'], b['y']
    w, d, h, rot, kind = b['w'], b['d'], b['h'], b['ry'], b['kind']
    zs = [z0 + h - 1.6] + ([z0 + h - 6.0] if cr.random() < 0.45 else [])
    if kind == 'box' and h > 55 and int(round(b['style'])) in (GLASS, METAL):
        return  # setback towers: the tiers already read; keep their tops plain
    for z in zs:
        if kind == 'round':
            r = min(w, d) / 2 + 0.12
            _prism(bm, col, lambda tt, i, r=r: (cx + r * math.cos(i / 32 * 2 * math.pi), cy + r * math.sin(i / 32 * 2 * math.pi)), 32, z, 0.45, CROWN, cap=False)
        elif kind == 'taper':
            def ring(t, i, z=z):
                k = (0.62 + (0.4 - 0.62) * ((z - z0) / h)) + 0.01
                a = rot + math.pi / 4 + i * math.pi / 2
                return (cx + math.cos(a) * w * k, cy + math.sin(a) * d * k)
            _prism(bm, col, ring, 4, z, 0.45, CROWN, cap=False)
        else:
            _box(bm, col, cx, cy, z, w + 0.25, d + 0.25, 0.45, CROWN, rot)


def build_skyline(bpy, buildings, materials, name='pg1-skyline'):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    col = bm.loops.layers.float_color.new('Color')
    for b in buildings:
        build(bm, col, b)
        if len(materials) > CROWN:
            _crown(bm, col, b)
    bm.normal_update()
    bm.to_mesh(me); bm.free()
    for m in materials:
        me.materials.append(m)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob
