"""Scenery for the Cycles reel only: the low-rise city between the towers, trees
along the streets and evening traffic on the far roads.

The live City draws the towers (each one stands for real activity) on open
ground; seen from height the gaps read as empty. A real city fills them with
three-to-seven-storey blocks, street trees and traffic. These are background:
low, plain and never taller than the towers, so they add life without adding
anything the data does not say. Coordinates are Blender's (z up); the live
view's roads run along x and y.
"""
import math
import random

import numpy as np

# Ground-level things a block may not stand on (anything higher than 0.5 m also blocks).
OPEN = ('ground',)
ROADISH = ('road', 'pavements', 'park', 'plaza', 'lane-markings', 'manhole-covers', 'puddles', 'kerbs',
           'pg1-river-water', 'embankment', 'pier', 'tram', 'bridge', 'roof-gardens')
CENTRE_KEEP = 70.0  # the PG1 tower's plaza


def _base(name):
    return name.split('.')[0]


def _free(scene, dg, x, y):
    """True where the spot is open ground (nothing built, no road, no water)."""
    from mathutils import Vector
    hit, loc, _n, _i, ob, _m = scene.ray_cast(dg, Vector((x, y, 400.0)), Vector((0, 0, -1)))
    if not hit:
        return False
    if loc.z > 0.5:
        return False
    return _base(ob.name) in OPEN


def _blocks_view(segs, cx, cy, w, d, h):
    """Does the box (centre cx, cy; w x d; 0..h) cut any protected sight line?"""
    if segs is None or not len(segs):
        return False
    P = segs[:, 0:3]; D = segs[:, 3:6] - P
    lo = np.array([cx - w / 2 - 1, cy - d / 2 - 1, 0.0]); hi = np.array([cx + w / 2 + 1, cy + d / 2 + 1, h + 1])
    with np.errstate(divide='ignore', invalid='ignore'):
        t1 = (lo - P) / D; t2 = (hi - P) / D
    tmin = np.nanmax(np.minimum(t1, t2), axis=1); tmax = np.nanmin(np.maximum(t1, t2), axis=1)
    return bool(((tmax >= tmin) & (tmax > 0) & (tmin < 0.98)).any())


def sight_lines(scene, dg, cam, set_camera, frames, nx=12, ny=20):
    """Sight lines from the camera to everything in shot that is not open ground
    (towers, river, bridge...): new blocks may not stand in front of them."""
    from mathutils import Vector
    out = []
    for fr in frames:
        set_camera(fr); bpy_ctx_update(scene)
        f = cam.data.view_frame(scene=scene); M = cam.matrix_world; o = M.translation
        tr, br, bl, tl = f[0], f[1], f[2], f[3]
        for i in range(nx):
            for j in range(ny):
                u = (i + 0.5) / nx; v = (j + 0.5) / ny
                local = tl + (tr - tl) * u + (bl - tl) * v
                dvec = (M.to_3x3() @ local).normalized()
                hit, loc, _n, _i, ob, _m = scene.ray_cast(dg, o, dvec)
                if hit and _base(ob.name) not in ('ground', 'road', 'lane-markings', 'pavements', 'puddles', 'kerbs', 'manhole-covers'):
                    out.append((o.x, o.y, o.z, loc.x, loc.y, loc.z))
    return np.array(out) if out else None


def bpy_ctx_update(scene):
    import bpy
    bpy.context.view_layer.update()


def plan_lots(scene, dg, campos, radius=2800.0, seed=11, segs=None, fliers=None):
    """Lots on open ground, kept off roads, water, parks and every camera path:
    a pass of ordinary blocks, then small ones (corner shops, mews houses) in
    the gaps left near the centre. Returns building records in the live view's
    own form (three.js axes)."""
    rnd = random.Random(seed)
    styles = [2] * 7 + [1] * 5 + [4] * 3 + [5] * 3 + [0] * 2  # brick, stone, georgian, podium, glass
    recs = []
    grid = {}

    def clashes(cx, cy, w, d):
        gx, gy = int(cx // 50), int(cy // 50)
        for i in (gx - 1, gx, gx + 1):
            for j in (gy - 1, gy, gy + 1):
                for (x, y, ww, dd) in grid.get((i, j), ()):
                    if abs(x - cx) < (w + ww) / 2 + 2 and abs(y - cy) < (d + dd) / 2 + 2:
                        return True
        return False

    passes = [(24.0, (12, 21), (11, 19), radius, 3.0), (13.0, (7, 11), (7, 11), 1600.0, 2.0)]
    for step, wr, dr, rad, margin in passes:
        n = int(rad // step)
        for i in range(-n, n + 1):
            for j in range(-n, n + 1):
                cx = i * step + rnd.uniform(-2, 2)
                cy = j * step + rnd.uniform(-2, 2)
                r = math.hypot(cx, cy)
                if r > rad or r < CENTRE_KEEP:
                    continue
                w = rnd.uniform(*wr); d = rnd.uniform(*dr)
                storeys = rnd.choice([3, 3, 4, 4, 4, 5, 5, 6, 7]) + (1 if r < 1200 and rnd.random() < 0.4 else 0)
                if w < 12:
                    storeys = min(storeys, 4)
                h = storeys * 3.2 + 0.8
                if clashes(cx, cy, w, d):
                    continue
                if _blocks_view(segs, cx, cy, w, d, h):
                    continue
                if fliers is not None and len(fliers):
                    near = (np.abs(fliers[:, 0] - cx) < w / 2 + 4) & (np.abs(fliers[:, 1] - cy) < d / 2 + 4) & (fliers[:, 2] < h + 4)
                    if near.any():
                        continue
                # Kept off the cameras' paths with room to spare.
                if len(campos):
                    hd = np.hypot(campos[:, 0] - cx, campos[:, 1] - cy)
                    if ((hd < math.hypot(w, d) / 2 + 30) & (campos[:, 2] < h + 20)).any():
                        continue
                # Every corner (with a pavement margin) and the centre on open ground.
                ok = True
                for (u, v) in ((0, 0), (-1, -1), (1, -1), (1, 1), (-1, 1), (0, -1), (0, 1), (-1, 0), (1, 0)):
                    if not _free(scene, dg, cx + u * (w / 2 + margin), cy + v * (d / 2 + margin)):
                        ok = False
                        break
                if not ok:
                    continue
                grid.setdefault((int(cx // 50), int(cy // 50)), []).append((cx, cy, w, d))
                recs.append({'x': cx, 'z': -cy, 'y': 0.0, 'w': w, 'd': d, 'h': h, 'ry': 0.0,
                             'style': rnd.choice(styles), 'seed': rnd.randrange(1, 997), 'kind': 'filler'})
    return recs


def _cyl(verts, faces, cx, cy, z0, r, h, seg=6):
    base = len(verts)
    for k in range(seg):
        a = 2 * math.pi * k / seg
        verts.append((cx + r * math.cos(a), cy + r * math.sin(a), z0))
        verts.append((cx + r * math.cos(a), cy + r * math.sin(a), z0 + h))
    for k in range(seg):
        a0, a1 = base + 2 * k, base + 2 * ((k + 1) % seg)
        faces.append((a0, a1, a1 + 1, a0 + 1))


def tree_mesh(bpy, bark, leaves):
    """One street tree: a trunk and a crown of three overlapping lobes."""
    import bmesh
    me = bpy.data.meshes.new('pg1-street-tree')
    bm = bmesh.new()
    verts, faces = [], []
    _cyl(verts, faces, 0, 0, 0, 0.18, 3.2)
    vs = [bm.verts.new(v) for v in verts]
    for f in faces:
        bm.faces.new([vs[i] for i in f]).material_index = 0
    for (ox, oy, oz, r) in ((0, 0, 4.6, 2.2), (0.9, 0.4, 5.4, 1.6), (-0.8, -0.5, 5.2, 1.7)):
        res = bmesh.ops.create_icosphere(bm, subdivisions=2, radius=r)
        for v in res['verts']:
            v.co.x += ox; v.co.y += oy; v.co.z = v.co.z * 0.9 + oz
        for f in {f for v in res['verts'] for f in v.link_faces}:
            f.material_index = 1
            f.smooth = True
    bm.to_mesh(me); bm.free()
    me.materials.append(bark); me.materials.append(leaves)
    return me


def street_trees(bpy, scene, dg, campos, roads, bark, leaves, radius=2200.0, spacing=13.0, seed=5):
    """Trees on the pavements either side of every road, as instances (cheap to render)."""
    rnd = random.Random(seed)
    pts = []
    for (x0, x1, y0, y1) in roads:
        along_x = (x1 - x0) > (y1 - y0)
        half = ((y1 - y0) if along_x else (x1 - x0)) / 2
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        lo, hi = (x0, x1) if along_x else (y0, y1)
        lo, hi = max(lo, -radius), min(hi, radius)
        t = lo + rnd.uniform(0, spacing)
        while t < hi:
            for side in (-1, 1):
                off = half + 2.6
                px, py = (t, cy + side * off) if along_x else (cx + side * off, t)
                if math.hypot(px, py) > radius or math.hypot(px, py) < CENTRE_KEEP:
                    continue
                if len(campos):
                    hd = np.hypot(campos[:, 0] - px, campos[:, 1] - py)
                    if ((hd < 12) & (campos[:, 2] < 14)).any():
                        continue
                from mathutils import Vector
                hit, loc, _n, _i, ob, _m = scene.ray_cast(dg, Vector((px, py, 400.0)), Vector((0, 0, -1)))
                if hit and loc.z < 0.5 and _base(ob.name) in ('pavements', 'ground', 'kerbs', 'puddles', 'manhole-covers'):
                    pts.append((px, py, rnd.uniform(0.75, 1.3), rnd.uniform(0, 6.283)))
            t += spacing * rnd.uniform(0.8, 1.25)
    if not pts:
        return None, 0
    tree = bpy.data.objects.new('pg1-street-tree-src', tree_mesh(bpy, bark, leaves))
    scene.collection.objects.link(tree); tree.hide_render = True; tree.hide_viewport = True
    # The points, with a scale and a turn each, instanced by geometry nodes.
    me = bpy.data.meshes.new('pg1-street-tree-points')
    me.from_pydata([(p[0], p[1], 0.0) for p in pts], [], [])
    sa = me.attributes.new('tscale', 'FLOAT', 'POINT'); sa.data.foreach_set('value', [p[2] for p in pts])
    ra = me.attributes.new('tturn', 'FLOAT', 'POINT'); ra.data.foreach_set('value', [p[3] for p in pts])
    ob = bpy.data.objects.new('pg1-street-trees', me); scene.collection.objects.link(ob)
    ng = bpy.data.node_groups.new('pg1-trees', 'GeometryNodeTree')
    ng.interface.new_socket('Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
    ng.interface.new_socket('Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
    N = ng.nodes; L = ng.links
    gi = N.new('NodeGroupInput'); go = N.new('NodeGroupOutput')
    inst = N.new('GeometryNodeInstanceOnPoints')
    oi = N.new('GeometryNodeObjectInfo'); oi.inputs['Object'].default_value = tree
    sc = N.new('GeometryNodeInputNamedAttribute'); sc.data_type = 'FLOAT'; sc.inputs['Name'].default_value = 'tscale'
    tu = N.new('GeometryNodeInputNamedAttribute'); tu.data_type = 'FLOAT'; tu.inputs['Name'].default_value = 'tturn'
    cv = N.new('ShaderNodeCombineXYZ')
    L.new(tu.outputs['Attribute'], cv.inputs['Z'])
    L.new(gi.outputs[0], inst.inputs['Points']); L.new(oi.outputs['Geometry'], inst.inputs['Instance'])
    L.new(sc.outputs['Attribute'], inst.inputs['Scale']); L.new(cv.outputs['Vector'], inst.inputs['Rotation'])
    L.new(inst.outputs['Instances'], go.inputs[0])
    mod = ob.modifiers.new('trees', 'NODES'); mod.node_group = ng
    return ob, len(pts)


class Traffic:
    """Cars on the far roads: left-hand traffic (as in Ireland), headlights white,
    tail lights red, each at its own steady speed, wrapping along its road.
    Kept away from every camera so nothing pops in close up."""

    def __init__(self, bpy, scene, campos, roads, paint, head, tail, fps=30.0, seed=23, near=600.0, cam_clear=300.0):
        rnd = random.Random(seed)
        self.fps = fps
        self.campos = campos
        self.cam_clear = cam_clear
        cars = []  # (x0, y0, dx, dy, length, s0, speed, lane_offset_vec)
        for (x0, x1, y0, y1) in roads:
            along_x = (x1 - x0) > (y1 - y0)
            width = (y1 - y0) if along_x else (x1 - x0)
            if width < 8:
                continue
            cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
            length = (x1 - x0) if along_x else (y1 - y0)
            for direction in (1, -1):
                # Left-hand traffic: the lane on the driver's left of the centre line.
                lane = width * 0.22
                if along_x:
                    ox, oy = 0.0, lane * direction
                    start = (x0 if direction > 0 else x1, cy + oy)
                    dvec = (direction, 0.0)
                else:
                    ox, oy = -lane * direction, 0.0
                    start = (cx + ox, y0 if direction > 0 else y1)
                    dvec = (0.0, direction)
                s = rnd.uniform(0, 60)
                while s < length:
                    cars.append((start[0], start[1], dvec[0], dvec[1], length, s, rnd.uniform(9, 15)))
                    s += rnd.uniform(35, 110)
        self.cars = np.array(cars, dtype=np.float64) if cars else np.zeros((0, 7))
        self.near = near
        # One car: body, cabin, two headlights, two tail lights (along +x, centred).
        body = _box_verts(0, 0, 0.35, 4.4, 1.8, 0.75) + _box_verts(-0.2, 0, 1.05, 2.4, 1.6, 0.55)
        hl = _box_verts(2.22, 0.6, 0.6, 0.08, 0.35, 0.18) + _box_verts(2.22, -0.6, 0.6, 0.08, 0.35, 0.18)
        tl = _box_verts(-2.22, 0.62, 0.7, 0.08, 0.32, 0.14) + _box_verts(-2.22, -0.62, 0.7, 0.08, 0.32, 0.14)
        parts = [(body, 0), (hl, 1), (tl, 2)]
        local = []; faces = []; mats = []
        for vs, mi in parts:
            for k in range(0, len(vs), 8):
                b = len(local)
                local.extend(vs[k:k + 8])
                for f in ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
                    faces.append(tuple(b + i for i in f)); mats.append(mi)
        self.local = np.array(local, dtype=np.float64)
        nc = len(self.cars); nv = len(self.local)
        self.nv = nv
        allv = np.zeros((max(nc, 1) * nv, 3)); allf = []
        for c in range(nc):
            allf.extend(tuple(i + c * nv for i in f) for f in faces)
        me = bpy.data.meshes.new('pg1-traffic')
        me.from_pydata(allv.tolist(), [], allf if nc else [])
        me.materials.append(paint); me.materials.append(head); me.materials.append(tail)
        if nc:
            me.polygons.foreach_set('material_index', mats * nc)
            # A paint colour per car.
            palette = np.array([(0.02, 0.02, 0.022), (0.6, 0.6, 0.62), (0.75, 0.75, 0.78), (0.12, 0.13, 0.16), (0.35, 0.03, 0.03),
                                (0.03, 0.08, 0.25), (0.25, 0.25, 0.27), (0.5, 0.45, 0.38), (0.9, 0.9, 0.9)])
            pick = palette[[rnd.randrange(len(palette)) for _ in range(nc)]]
            ca = me.color_attributes.new('Color', 'FLOAT_COLOR', 'POINT')
            cols = np.concatenate([np.repeat(pick, nv, axis=0), np.ones((nc * nv, 1))], axis=1)
            ca.data.foreach_set('color', cols.ravel())
        me.update()
        self.mesh = me
        self.ob = bpy.data.objects.new('pg1-traffic', me); scene.collection.objects.link(self.ob)
        self.update(0)

    def update(self, fr):
        if not len(self.cars):
            return
        t = fr / self.fps
        c = self.cars
        s = np.mod(c[:, 5] + c[:, 6] * t, c[:, 4])
        px = c[:, 0] + c[:, 2] * s; py = c[:, 1] + c[:, 3] * s
        hide = np.hypot(px, py) < self.near
        if len(self.campos):
            cp = self.campos[min(fr, len(self.campos) - 1)]
            hide |= np.hypot(px - cp[0], py - cp[1]) < self.cam_clear
        ang = np.arctan2(c[:, 3], c[:, 2])
        ca, sa = np.cos(ang), np.sin(ang)
        L = self.local
        X = L[None, :, 0] * ca[:, None] - L[None, :, 1] * sa[:, None] + px[:, None]
        Y = L[None, :, 0] * sa[:, None] + L[None, :, 1] * ca[:, None] + py[:, None]
        Z = np.broadcast_to(L[None, :, 2], X.shape) - np.where(hide, 500.0, 0.0)[:, None]
        co = np.stack([X, Y, Z], axis=2).reshape(-1)
        self.mesh.vertices.foreach_set('co', co.astype(np.float32))
        self.mesh.update()


def _box_verts(cx, cy, cz, w, d, h):
    """8 corners of a box centred (cx, cy) with its base at cz - h/2... centre cz."""
    out = []
    for z in (cz - h / 2, cz + h / 2):
        for (u, v) in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            out.append((cx + u * w / 2, cy + v * d / 2, z))
    return out


def road_rects(bpy):
    """The live view's straight roads as rectangles (x0, x1, y0, y1) at street level."""
    ob = bpy.data.objects.get('road')
    if not ob:
        return []
    W = ob.matrix_world; me = ob.data; out = set()
    for p in me.polygons:
        vs = [W @ me.vertices[i].co for i in p.vertices]
        if max(abs(v.z) for v in vs) > 0.5:
            continue
        xs = [v.x for v in vs]; ys = [v.y for v in vs]
        out.add((round(min(xs), 1), round(max(xs), 1), round(min(ys), 1), round(max(ys), 1)))
    return sorted(out)
