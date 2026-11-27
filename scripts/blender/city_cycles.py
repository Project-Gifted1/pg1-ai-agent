# PG1 City, path traced in Blender Cycles (a test of the offline look).
#
# Input: cycles-in/city.glb and city-shot.json from scripts/city-export.mjs.
# Output: cycles-out/<shot>.png (and the .blend for a closer look).
#
#   blender -b -P scripts/blender/city_cycles.py -- --in cycles-in --out cycles-out [--samples 128] [--device CPU|GPU] [--scale 100]
#
# What the browser City draws with its own shaders, this draws with Cycles
# materials: the skyline's windows (lit at random per window, from each
# building's seed, as on the live City), wet asphalt, the river, and the
# night sky; distance haze from the mist pass in the shot's fog colour, and a
# soft glow on bright lights. Everything else keeps the exported colours.

import re
import bpy, json, math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pg1_buildings, pg1_vehicles, pg1_filler

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
def arg(name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default
IN = os.path.abspath(arg('--in', 'cycles-in'))
OUT = os.path.abspath(arg('--out', 'cycles-out'))
SAMPLES = int(arg('--samples', '128'))
DEVICE = arg('--device', 'CPU')
SCALE = int(arg('--scale', '100'))
os.makedirs(OUT, exist_ok=True)
meta = json.load(open(os.path.join(IN, 'city-shot.json')))
night = meta.get('light') != 'day'
rain = bool(meta.get('weather') and 'rain' in str(meta.get('weather')))

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=os.path.join(IN, 'city.glb'))
scene = bpy.context.scene
import numpy as np
ANIM = bool(meta.get('frames'))
FLY_PTS = np.zeros((0, 3))
# three.js (y up) to Blender (z up): (x, y, z) -> (x, -z, y).
C = np.array([[1, 0, 0, 0], [0, 0, -1, 0], [0, 1, 0, 0], [0, 0, 0, 1]], dtype=np.float64); CI = np.linalg.inv(C)
cams = [o for o in scene.objects if o.type == 'CAMERA']
if ANIM:
    cd = bpy.data.cameras.new('shot-camera'); cam_ob = bpy.data.objects.new('shot-camera', cd); scene.collection.objects.link(cam_ob)
    cd.sensor_fit = 'VERTICAL'
    cams = [cam_ob]
if not cams:
    raise SystemExit('no camera in city.glb')
scene.camera = cams[0]
cams[0].data.clip_end = 90000
cams[0].data.clip_start = 0.5

def set_camera(fr):
    c = meta['frames'][fr]
    M = np.array(c['matrix'], dtype=np.float64).reshape(4, 4).T
    from mathutils import Matrix
    cams[0].matrix_world = Matrix((C @ M).tolist())
    cams[0].data.angle_y = math.radians(c['fov'])

# Moving things: one mesh per moving mesh of the City, its base geometry
# repeated per instance; each frame moves the vertices (numpy, from dyn.bin).
DYN = []
if ANIM:
    dyn_data = np.fromfile(os.path.join(IN, 'dyn.bin'), dtype=np.float32)
    fpf = meta['floats_per_frame']
    dyn_data = dyn_data.reshape(-1, fpf) if fpf else np.zeros((len(meta['frames']), 0), dtype=np.float32)
    # Clearance: nothing that flies may pass through a building. The live view
    # has no collision, so a drone's path can cut a corner of a tower; here it
    # rises over the roof instead, eased in and out over about two thirds of a
    # second so it reads as flying, not jumping.
    FLIERS = re.compile(r'crowd|drone|patrol|probe|courier|helicopter|seagull|warden|scanner')
    bl = meta.get('buildings') or []
    if bl and fpf:
        bx = np.array([b['x'] for b in bl]); bz = np.array([b['z'] for b in bl]); by0 = np.array([b['y'] for b in bl])
        btop = by0 + np.array([b['h'] * (1.13 if b['kind'] == 'taper' else 1.0) for b in bl])
        bw = np.array([(min(b['w'], b['d']) if b['kind'] == 'twist' else b['w']) / 2 for b in bl]) + 2.5
        bd = np.array([(min(b['w'], b['d']) if b['kind'] == 'twist' else b['d']) / 2 for b in bl]) + 2.5
        cr, sr = np.cos([b['ry'] for b in bl]), np.sin([b['ry'] for b in bl])
        K = 20; taper = 0.5 * (1 + np.cos(np.pi * np.arange(-K, K + 1) / K))
        nf = dyn_data.shape[0]; slots = []
        for d in meta['dynamic']:
            if not FLIERS.search(d['name']):
                continue
            for k in range(d['slots']):
                o0 = d['offset'] + k * 16
                if dyn_data[:, o0 + 13].max() < 6 or not np.abs(dyn_data[:, o0:o0 + 16]).any():
                    continue
                tx, ty, tz = dyn_data[:, o0 + 12], dyn_data[:, o0 + 13], dyn_data[:, o0 + 14]
                need = np.zeros(nf)
                for f in range(nf):
                    if ty[f] < 6:
                        continue
                    dx, dz = tx[f] - bx, tz[f] - bz
                    lx, lz = dx * cr - dz * sr, dx * sr + dz * cr
                    hit = (np.abs(lx) < bw) & (np.abs(lz) < bd) & (ty[f] > by0 - 2) & (ty[f] < btop + 2.5)
                    if hit.any():
                        need[f] = (btop[hit] + 2.5 - ty[f]).max()
                pad = np.pad(need, K)
                slots.append((o0, np.array([(pad[f:f + 2 * K + 1] * taper).max() for f in range(nf)])))
        moved = 0
        if slots:
            # A drone is several meshes (body, arms, lights): every part within 5 m
            # of another rises by the same amount, so nothing comes apart.
            L = np.array([l for _, l in slots]); O = [o for o, _ in slots]; Lh = L.copy()
            for f in range(nf):
                if not L[:, f].any():
                    continue
                P = np.array([[dyn_data[f, o + 12], dyn_data[f, o + 13], dyn_data[f, o + 14]] for o in O])
                near = np.linalg.norm(P[:, None, :] - P[None, :, :], axis=2) < 5.0
                Lh[:, f] = np.where(near, L[None, :, f], 0).max(axis=1)
            for i, o in enumerate(O):
                if Lh[i].any():
                    dyn_data[:, o + 13] += Lh[i].astype(np.float32); moved += 1
        print(f'[cycles] clearance: {moved} fliers lifted over roofs they would have crossed', flush=True)
        # Where fliers go (Blender axes), so the low-rise scenery keeps out of their way.
        _fp = []
        for d in meta['dynamic']:
            if FLIERS.search(d['name']):
                for k in range(d['slots']):
                    o0 = d['offset'] + k * 16
                    if dyn_data[:, o0 + 13].max() >= 3 and np.abs(dyn_data[:, o0:o0 + 16]).any():
                        _fp.append(np.stack([dyn_data[::3, o0 + 12], -dyn_data[::3, o0 + 14], dyn_data[::3, o0 + 13]], axis=1))
        FLY_PTS = np.concatenate(_fp) if _fp else np.zeros((0, 3))
    by_idx = {}
    for o in list(scene.objects):
        if o.type == 'MESH' and o.name.startswith('dyn~'):
            by_idx[int(o.name.split('~')[1])] = o
    for d in meta['dynamic']:
        src = by_idx.get(d['mesh'])
        if src is None or d.get('offset') is None:
            continue
        me = src.data; nv = len(me.vertices)
        base = np.empty(nv * 3, dtype=np.float64); me.vertices.foreach_get('co', base); base = base.reshape(nv, 3)
        # Back to three.js space for the instance matrices: v3 = CI . vb.
        base3 = (CI[:3, :3] @ base.T).T
        rep = pg1_vehicles.REPLACE.get(d['name'])
        part = None
        if d['name'] == 'crowd':
            ext = base3.max(axis=0) - base3.min(axis=0); cen3 = (base3.max(axis=0) + base3.min(axis=0)) / 2
            part = pg1_vehicles.classify_crowd_part(nv, ext)
            if part == 'body':
                rep = lambda cen3=cen3, ext=ext: pg1_vehicles.drone_body(tuple(cen3), tuple(ext))
            elif part == 'arm':
                rep = lambda cen3=cen3, ext=ext: pg1_vehicles.drone_arm(tuple(cen3), tuple(ext))
        if rep:
            # A detailed stand-in in the same local space (pg1_vehicles.py).
            rv, rf = rep()
            me = bpy.data.meshes.new(f'detail-{d["name"]}'); me.from_pydata([tuple(v) for v in rv], [], rf)
            for m in src.data.materials:
                me.materials.append(m)
            nv = len(me.vertices); base3 = np.array(rv, dtype=np.float64)
        n = d['slots']
        tris = np.array([v for poly in me.polygons for v in poly.vertices], dtype=np.int64)
        loops_per = [len(poly.vertices) for poly in me.polygons]
        big = bpy.data.meshes.new(f'moving-{d["name"]}')
        verts = np.zeros((n * nv, 3)); faces = []
        offs = np.cumsum([0] + loops_per[:-1])
        polys = [list(me.polygons[k].vertices) for k in range(len(me.polygons))]
        for i in range(n):
            faces.extend([[v + i * nv for v in poly] for poly in polys])
        big.from_pydata(verts.tolist(), [], faces)
        for m in me.materials:
            big.materials.append(m)
        # Colour per instance (cars, boats): the colour attribute, as the static meshes have.
        cols = d.get('colours')
        ca = big.color_attributes.new('Color', 'FLOAT_COLOR', 'POINT')
        if src.data.color_attributes and rep and d['name'] in pg1_vehicles.KEEP_COLOUR:
            sa = src.data.color_attributes[0]; raw = np.empty(len(sa.data) * 4, dtype=np.float32); sa.data.foreach_get('color', raw)
            sc_ = np.tile(raw.reshape(-1, 4).mean(axis=0), (nv, 1)).astype(np.float32)
        elif src.data.color_attributes and not rep:
            sa = src.data.color_attributes[0]; nd = len(sa.data)
            raw = np.empty(nd * 4, dtype=np.float32); sa.data.foreach_get('color', raw); raw = raw.reshape(nd, 4)
            if sa.domain == 'POINT':
                sc_ = raw
            else:
                # Per corner: one colour per vertex from its corners.
                sc_ = np.ones((nv, 4), dtype=np.float32); li = np.empty(len(me.loops), dtype=np.int64); me.loops.foreach_get('vertex_index', li); sc_[li] = raw
        else:
            sc_ = np.ones((nv, 4), dtype=np.float32)
        allc = np.tile(sc_, (n, 1))
        if cols:
            cc = np.array(cols, dtype=np.float32)
            allc[:, :3] = np.repeat(cc, nv, axis=0)
        ca.data.foreach_set('color', allc.ravel())
        ob = bpy.data.objects.new(f'moving-{d["name"]}', big); scene.collection.objects.link(ob)
        if part:
            ob['pg1_drone'] = part
        for poly in big.polygons:
            poly.use_smooth = me.polygons[0].use_smooth if len(me.polygons) else False
        src.hide_render = True; src.hide_viewport = True
        DYN.append((d, ob, base3, nv))
    print(f'[cycles] moving: {len(DYN)} meshes, {sum(d["slots"] for d, *_ in DYN)} instances, {dyn_data.shape[0]} frames', flush=True)

# The rooftop crane's mast: a solid box in the live view, a lattice here. It
# comes in merged, in world space, so the lattice is fitted to the box's
# bottom corners (centre, height and the turn about the vertical).
for o in list(scene.objects):
    if o.type != 'MESH' or not o.name.split('.')[0].startswith('construction-crane-mast'):
        continue
    me0 = o.data; nv0 = len(me0.vertices)
    co = np.empty(nv0 * 3); me0.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
    W = np.array(o.matrix_world); co = co @ W[:3, :3].T + W[:3, 3]
    if nv0 > 64:
        continue
    zmin, zmax = co[:, 2].min(), co[:, 2].max(); ctr = np.array([co[:, 0].mean(), co[:, 1].mean(), (zmin + zmax) / 2])
    bot = co[co[:, 2] < zmin + 0.01][:, :2] - ctr[:2]
    # A square's corners sit at turn + 45 deg + k * 90 deg from its centre.
    c0 = bot[0]; th = (math.atan2(c0[1], c0[0]) - math.pi / 4) % (math.pi / 2)
    side = float(np.hypot(*bot.T).mean()) * math.sqrt(2)
    rv, rf = pg1_vehicles.crane_mast(w=side, h=float(zmax - zmin))
    rv = np.array(rv)  # three.js local: along y
    b = (C[:3, :3] @ rv.T).T  # Blender: along z
    R3 = np.array([[math.cos(th), -math.sin(th), 0], [math.sin(th), math.cos(th), 0], [0, 0, 1]])
    b = b @ R3.T + ctr
    me = bpy.data.meshes.new('crane-mast-lattice'); me.from_pydata(b.tolist(), [], rf)
    for m in me0.materials:
        me.materials.append(m)
    if me0.color_attributes:
        sa = me0.color_attributes[0]; raw = np.empty(len(sa.data) * 4, dtype=np.float32); sa.data.foreach_get('color', raw)
        ca = me.color_attributes.new(sa.name, 'FLOAT_COLOR', 'POINT')
        ca.data.foreach_set('color', np.tile(raw.reshape(-1, 4).mean(axis=0), (len(me.vertices), 1)).ravel())
    o.data = me; o.matrix_world = __import__('mathutils').Matrix.Identity(4)
    print(f'[cycles] crane mast as a lattice: {side:.2f} m x {zmax - zmin:.1f} m, turned {math.degrees(th):.1f} deg', flush=True)
    # A camera path through the crane's reach (the jib swings 48 m round the
    # mast): the crane is left out of that shot rather than flown through.
    campos = np.array([(C @ np.array(c['matrix'], dtype=np.float64).reshape(4, 4).T)[:3, 3] for c in meta.get('frames') or []]).reshape(-1, 3)
    hd = np.hypot(campos[:, 0] - ctr[0], campos[:, 1] - ctr[1])
    if len(hd) and ((hd < 50) & (campos[:, 2] < zmax + 10)).any():
        for o2 in list(scene.objects):
            if 'construction-crane' in o2.name:
                o2.hide_render = True
        print(f'[cycles] crane left out: the camera passes {hd.min():.0f} m from it', flush=True)

def set_dynamic(fr):
    for d, ob, base3, nv in DYN:
        n = d['slots']
        M = dyn_data[fr, d['offset']:d['offset'] + n * 16].astype(np.float64).reshape(n, 4, 4).transpose(0, 2, 1)
        T = np.einsum('ij,njk,kl->nil', C, M, CI)
        b = (C[:3, :3] @ base3.T).T  # base in Blender space
        v = np.einsum('nij,vj->nvi', T[:, :3, :3], b) + T[:, None, :3, 3]
        ob.data.vertices.foreach_set('co', v.reshape(-1).astype(np.float32))
        ob.data.update()

def node(nt, kind, x=0, y=0, **inputs):
    n = nt.nodes.new(kind); n.location = (x, y)
    for k, v in inputs.items():
        if k in n.inputs:
            n.inputs[k].default_value = v
        else:
            setattr(n, k, v)
    return n

def link(nt, a, b):
    nt.links.new(a, b)

# --- the skyline facade: windows from world position, lit per window ---
# Per style (glass, stone, brick, metal, georgian, podium): window cell width,
# window share of the cell across and up, and the wall colour.
STYLE_CELL = [1.5, 2.8, 2.4, 2.0, 2.2, 5.0]
STYLE_WIN_U = [(0.04, 0.96), (0.22, 0.78), (0.2, 0.8), (0.08, 0.92), (0.25, 0.75), (0.05, 0.95)]
STYLE_WIN_V = [(0.12, 0.9), (0.28, 0.8), (0.25, 0.78), (0.15, 0.88), (0.22, 0.82), (0.1, 0.85)]
STYLE_CLUSTER = [6.0, 1.0, 1.0, 4.0, 1.0, 3.0]
STYLE_WALL = [(0.035, 0.045, 0.06), (0.36, 0.33, 0.28), (0.26, 0.11, 0.07), (0.14, 0.15, 0.17), (0.24, 0.1, 0.06), (0.1, 0.1, 0.11)]

def lookup(nt, src, values, x, y):
    """A constant colour ramp on style/8: returns the socket with values[style] (floats or colours)."""
    r = node(nt, 'ShaderNodeValToRGB', x, y); r.color_ramp.interpolation = 'CONSTANT'
    link(nt, src, r.inputs['Fac'])
    el = r.color_ramp.elements
    def col(v):
        return (*v, 1) if isinstance(v, tuple) else (v, v, v, 1)
    el[0].position = 0.0; el[0].color = col(values[0])
    el[1].position = 0.5 / 8; el[1].color = col(values[1])
    for k, v in enumerate(values[2:], start=2):
        el.new((k - 0.5) / 8).color = col(v)
    if isinstance(values[0], tuple):
        return r.outputs['Color']
    sep = node(nt, 'ShaderNodeSeparateColor', x + 250, y); link(nt, r.outputs['Color'], sep.inputs['Color'])
    return sep.outputs['Red']

def math_node(nt, op, a, b=None, x=0, y=0):
    n = node(nt, 'ShaderNodeMath', x, y, operation=op)
    for k, v in enumerate((a, b)):
        if v is None:
            continue
        if isinstance(v, (int, float)):
            n.inputs[k].default_value = v
        else:
            link(nt, v, n.inputs[k])
    return n.outputs[0]

def facade_material():
    m = bpy.data.materials.new('pg1-facade'); m.use_nodes = True
    nt = m.node_tree; nt.nodes.clear()
    out = node(nt, 'ShaderNodeOutputMaterial', 1800, 0)
    geo = node(nt, 'ShaderNodeNewGeometry', -1600, 0)
    attr = node(nt, 'ShaderNodeVertexColor', -1600, -400); attr.layer_name = 'Color'
    sc = node(nt, 'ShaderNodeSeparateColor', -1400, -400); link(nt, attr.outputs['Color'], sc.inputs['Color'])
    seed, style = sc.outputs['Red'], sc.outputs['Green']
    P = node(nt, 'ShaderNodeSeparateXYZ', -1400, 200); link(nt, geo.outputs['Position'], P.inputs['Vector'])
    N = node(nt, 'ShaderNodeSeparateXYZ', -1400, 0); link(nt, geo.outputs['Normal'], N.inputs['Vector'])
    # Along the wall: the horizontal direction perpendicular to the normal (any wall angle).
    along = math_node(nt, 'SUBTRACT', math_node(nt, 'MULTIPLY', P.outputs['X'], N.outputs['Y']), math_node(nt, 'MULTIPLY', P.outputs['Y'], N.outputs['X']))
    wall = math_node(nt, 'LESS_THAN', math_node(nt, 'ABSOLUTE', N.outputs['Z']), 0.5)
    cell = lookup(nt, style, STYLE_CELL, -1100, -700)
    u_lo = lookup(nt, style, [a for a, b in STYLE_WIN_U], -1100, -900); u_hi = lookup(nt, style, [b for a, b in STYLE_WIN_U], -1100, -1050)
    v_lo = lookup(nt, style, [a for a, b in STYLE_WIN_V], -1100, -1200); v_hi = lookup(nt, style, [b for a, b in STYLE_WIN_V], -1100, -1350)
    cu = math_node(nt, 'DIVIDE', along, cell); cv = math_node(nt, 'DIVIDE', P.outputs['Z'], 3.6)
    fu, fv = math_node(nt, 'FRACT', cu), math_node(nt, 'FRACT', cv)
    inside = lambda f, lo, hi: math_node(nt, 'MULTIPLY', math_node(nt, 'GREATER_THAN', f, lo), math_node(nt, 'LESS_THAN', f, hi))
    win_up = math_node(nt, 'MULTIPLY', math_node(nt, 'MULTIPLY', inside(fu, u_lo, u_hi), inside(fv, v_lo, v_hi)), wall)
    # The ground floor: shop fronts (wide glass, lit late), from the base height in the vertex colour.
    rel = math_node(nt, 'SUBTRACT', P.outputs['Z'], math_node(nt, 'MULTIPLY', sc.outputs['Blue'], 400.0))
    shop = math_node(nt, 'MULTIPLY', math_node(nt, 'LESS_THAN', rel, 4.4), math_node(nt, 'GREATER_THAN', rel, -0.5))
    shopwin = math_node(nt, 'MULTIPLY', math_node(nt, 'MULTIPLY', inside(math_node(nt, 'FRACT', math_node(nt, 'DIVIDE', along, 6.0)), 0.06, 0.94), inside(rel, 0.35, 3.5)), wall)
    win = math_node(nt, 'ADD', math_node(nt, 'MULTIPLY', win_up, math_node(nt, 'SUBTRACT', 1.0, shop)), math_node(nt, 'MULTIPLY', shopwin, shop))
    # Each window: white noise of (column, storey, building seed).
    cellv = node(nt, 'ShaderNodeCombineXYZ', -300, -150)
    # Offices light in runs along a floor (glass: about 6 panes), homes window by window.
    clus = lookup(nt, style, STYLE_CLUSTER, -700, -1500)
    link(nt, math_node(nt, 'FLOOR', math_node(nt, 'DIVIDE', math_node(nt, 'FLOOR', cu), clus)), cellv.inputs['X']); link(nt, math_node(nt, 'FLOOR', cv), cellv.inputs['Y']); link(nt, math_node(nt, 'MULTIPLY', seed, 997.0), cellv.inputs['Z'])
    wn = node(nt, 'ShaderNodeTexWhiteNoise', -100, -150); wn.noise_dimensions = '3D'; link(nt, cellv.outputs['Vector'], wn.inputs['Vector'])
    # Each building its own occupancy (0.2 to 0.6 of windows lit at night).
    bn = node(nt, 'ShaderNodeTexWhiteNoise', -300, -350); bn.noise_dimensions = '1D'; link(nt, math_node(nt, 'MULTIPLY', seed, 997.0), bn.inputs['W'])
    occ = math_node(nt, 'ADD', math_node(nt, 'MULTIPLY', bn.outputs['Value'], 0.4), 0.3)
    lit = math_node(nt, 'LESS_THAN', wn.outputs['Value'], math_node(nt, 'ADD', occ, math_node(nt, 'MULTIPLY', shop, 0.45)) if night else 0.004)
    litw = math_node(nt, 'MULTIPLY', lit, win)
    ramp_l = node(nt, 'ShaderNodeValToRGB', 300, -250); link(nt, wn.outputs['Color'], ramp_l.inputs['Fac'])
    el = ramp_l.color_ramp.elements; el[0].color = (1.0, 0.42, 0.14, 1); el[1].color = (0.45, 0.68, 1.0, 1); el.new(0.3).color = (1.0, 0.62, 0.3, 1); el.new(0.5).color = (1.0, 0.84, 0.6, 1); el.new(0.66).color = (0.92, 0.95, 1.0, 1); el.new(0.86).color = (0.6, 0.78, 1.0, 1); el.new(0.96).color = (0.3, 0.5, 1.0, 1)
    # Interior mapping: each lit window shows a room behind the glass (back
    # wall, side walls, a bright ceiling, a darker floor, a piece of furniture),
    # traced from the view ray, so windows have depth and parallax as the
    # camera moves instead of reading as flat lit tiles.
    I = node(nt, 'ShaderNodeSeparateXYZ', -1400, 600); link(nt, geo.outputs['Incoming'], I.inputs['Vector'])
    M = lambda a, b: math_node(nt, 'MULTIPLY', a, b)
    A = lambda a, b: math_node(nt, 'ADD', a, b)
    S = lambda a, b: math_node(nt, 'SUBTRACT', a, b)
    rx = S(M(I.outputs['Y'], N.outputs['X']), M(I.outputs['X'], N.outputs['Y']))   # -I . T, T = (Ny, -Nx, 0)
    ry = M(I.outputs['Z'], -1.0)
    rz = A(M(I.outputs['X'], N.outputs['X']), M(I.outputs['Y'], N.outputs['Y']))     # -I . -N
    rz = math_node(nt, 'MAXIMUM', rz, 0.02)
    Wc = cell; Hc = 3.6; Dd = 4.5
    lx = M(S(fu, 0.5), Wc); ly = M(S(fv, 0.5), Hc)
    sgn = lambda v: S(M(math_node(nt, 'GREATER_THAN', v, 0.0), 2.0), 1.0)
    safe = lambda v: A(v, M(sgn(v), 1e-4))
    tx = math_node(nt, 'DIVIDE', S(M(sgn(rx), M(Wc, 0.5)), lx), safe(rx))
    ty = math_node(nt, 'DIVIDE', S(M(sgn(ry), Hc / 2), ly), safe(ry))
    tz = math_node(nt, 'DIVIDE', Dd, rz)
    back = M(math_node(nt, 'LESS_THAN', tz, tx), math_node(nt, 'LESS_THAN', tz, ty))
    side = M(math_node(nt, 'LESS_THAN', tx, ty), math_node(nt, 'SUBTRACT', 1.0, back))
    flat = S(S(1.0, back), side)
    ceil_ = M(flat, math_node(nt, 'GREATER_THAN', ry, 0.0)); floor_ = S(flat, ceil_)
    tmin = math_node(nt, 'MINIMUM', math_node(nt, 'MINIMUM', tx, ty), tz)
    depth = math_node(nt, 'MINIMUM', math_node(nt, 'DIVIDE', M(tmin, rz), Dd), 1.0)
    hy = A(ly, M(ry, tmin))                    # height of the hit point in the room
    hx = A(lx, M(rx, tmin))
    # Furniture: a dark block across part of the back wall, low down (a desk, a sofa, shelves).
    room = A(A(A(M(back, 0.85), M(side, S(0.62, M(depth, 0.25)))), M(ceil_, 1.55)), M(floor_, 0.38))
    furn = M(M(back, math_node(nt, 'LESS_THAN', hy, -0.75)), math_node(nt, 'LESS_THAN', math_node(nt, 'ABSOLUTE', hx), M(Wc, 0.3)))
    room = S(room, M(furn, 0.55))
    # Blinds on some windows: the top part a flat, softly lit blind.
    blind_n = node(nt, 'ShaderNodeTexWhiteNoise', -100, 700); blind_n.noise_dimensions = '3D'
    bcell = node(nt, 'ShaderNodeCombineXYZ', -300, 700); link(nt, math_node(nt, 'FLOOR', cu), bcell.inputs['X']); link(nt, math_node(nt, 'FLOOR', cv), bcell.inputs['Y']); link(nt, A(M(seed, 997.0), 7.3), bcell.inputs['Z'])
    link(nt, bcell.outputs['Vector'], blind_n.inputs['Vector'])
    blind_h = M(math_node(nt, 'GREATER_THAN', blind_n.outputs['Value'], 0.55), M(S(blind_n.outputs['Value'], 0.55), 2.0))
    in_blind = math_node(nt, 'GREATER_THAN', fv, S(v_hi, M(blind_h, S(v_hi, v_lo))))
    grad = A(M(room, S(1.0, in_blind)), M(in_blind, 0.7))
    cellw = node(nt, 'ShaderNodeCombineXYZ', -300, 400); link(nt, math_node(nt, 'FLOOR', cu), cellw.inputs['X']); link(nt, math_node(nt, 'FLOOR', cv), cellw.inputs['Y']); link(nt, math_node(nt, 'ADD', math_node(nt, 'MULTIPLY', seed, 997.0), 0.5), cellw.inputs['Z'])
    wn2 = node(nt, 'ShaderNodeTexWhiteNoise', -100, 400); wn2.noise_dimensions = '3D'; link(nt, cellw.outputs['Vector'], wn2.inputs['Vector'])
    var = node(nt, 'ShaderNodeMapRange', 300, 250); link(nt, wn2.outputs['Value'], var.inputs['Value']); var.inputs['To Min'].default_value = 0.35
    strength = math_node(nt, 'MULTIPLY', math_node(nt, 'MULTIPLY', math_node(nt, 'MULTIPLY', litw, var.outputs['Result']), math_node(nt, 'ADD', grad, math_node(nt, 'MULTIPLY', shop, 1.6))), 1.9 if night else 0.0)
    wallc = lookup(nt, style, STYLE_WALL, 300, -700)
    # Slight weathering on walls: large noise darkens and lightens them.
    wnz = node(nt, 'ShaderNodeTexNoise', 300, -950); wnz.inputs['Scale'].default_value = 0.08; link(nt, geo.outputs['Position'], wnz.inputs['Vector'])
    weather = node(nt, 'ShaderNodeMix', 550, -800); weather.data_type = 'RGBA'; weather.blend_type = 'MULTIPLY'
    link(nt, wnz.outputs['Fac'], weather.inputs['Factor']); link(nt, wallc, weather.inputs[6]); weather.inputs[7].default_value = (0.75, 0.75, 0.75, 1)
    bsdf = node(nt, 'ShaderNodeBsdfPrincipled', 1300, 0)
    basec = node(nt, 'ShaderNodeMix', 900, -300); basec.data_type = 'RGBA'
    link(nt, win, basec.inputs['Factor']); link(nt, weather.outputs[2], basec.inputs[6]); basec.inputs[7].default_value = (0.004, 0.006, 0.01, 1)
    # Roofs: a light membrane and gravel, weathered, with skylights and roof
    # lights glowing here and there (seen from above, bare dark roofs read as empty).
    roof = math_node(nt, 'GREATER_THAN', N.outputs['Z'], 0.5)
    rnz = node(nt, 'ShaderNodeTexNoise', 300, -1250); rnz.inputs['Scale'].default_value = 0.18; rnz.inputs['Detail'].default_value = 8; link(nt, geo.outputs['Position'], rnz.inputs['Vector'])
    rr = node(nt, 'ShaderNodeValToRGB', 550, -1250); link(nt, rnz.outputs['Fac'], rr.inputs['Fac'])
    rr.color_ramp.elements[0].color = (0.07, 0.07, 0.075, 1); rr.color_ramp.elements[1].color = (0.24, 0.23, 0.22, 1)
    rmix = node(nt, 'ShaderNodeMix', 1100, -300); rmix.data_type = 'RGBA'; link(nt, roof, rmix.inputs['Factor'])
    link(nt, basec.outputs[2], rmix.inputs[6]); link(nt, rr.outputs['Color'], rmix.inputs[7])
    link(nt, rmix.outputs[2], bsdf.inputs['Base Color'])
    svs = node(nt, 'ShaderNodeVectorMath', 300, -1450, operation='SCALE'); svs.inputs['Scale'].default_value = 1 / 7.0; link(nt, geo.outputs['Position'], svs.inputs[0])
    svr = node(nt, 'ShaderNodeTexVoronoi', 550, -1450); link(nt, svs.outputs['Vector'], svr.inputs['Vector'])
    swn = node(nt, 'ShaderNodeTexWhiteNoise', 750, -1450); swn.noise_dimensions = '3D'; link(nt, svr.outputs['Position'], swn.inputs['Vector'])
    skyl = math_node(nt, 'MULTIPLY', math_node(nt, 'MULTIPLY', math_node(nt, 'LESS_THAN', svr.outputs['Distance'], 0.11), math_node(nt, 'LESS_THAN', swn.outputs['Value'], 0.3)), roof)
    glassy = math_node(nt, 'LESS_THAN', style, 0.5 / 8)
    rgh = node(nt, 'ShaderNodeMix', 900, -500); rgh.data_type = 'FLOAT'; link(nt, win, rgh.inputs['Factor'])
    link(nt, math_node(nt, 'ADD', math_node(nt, 'MULTIPLY', glassy, -0.55), 0.7), rgh.inputs['A']); rgh.inputs['B'].default_value = 0.03
    link(nt, rgh.outputs['Result'], bsdf.inputs['Roughness'])
    # Window glass reflects less than a mirror (tinted, with lights behind it).
    spec = node(nt, 'ShaderNodeMix', 900, -600); spec.data_type = 'FLOAT'; link(nt, win, spec.inputs['Factor']); spec.inputs['A'].default_value = 0.5; spec.inputs['B'].default_value = 0.18
    link(nt, spec.outputs['Result'], bsdf.inputs['Specular IOR Level'])
    link(nt, math_node(nt, 'MULTIPLY', glassy, 0.3), bsdf.inputs['Metallic'])
    link(nt, ramp_l.outputs['Color'], bsdf.inputs['Emission Color'])
    link(nt, math_node(nt, 'ADD', strength, math_node(nt, 'MULTIPLY', skyl, 2.2 if night else 0.0)), bsdf.inputs['Emission Strength'])
    link(nt, bsdf.outputs['BSDF'], out.inputs['Surface'])
    return m

def simple(name, color, rough, metal=0.0, spec=0.5):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value = (*color, 1); b.inputs['Roughness'].default_value = rough; b.inputs['Metallic'].default_value = metal
    return m

FACADE = facade_material()
TRIM = simple('pg1-trim', (0.16, 0.155, 0.15), 0.75)
PLANT = simple('pg1-plant', (0.09, 0.095, 0.1), 0.45, metal=0.6)
AVLIGHT = simple('pg1-aviation-light', (0.3, 0.02, 0.02), 0.4)
_b = AVLIGHT.node_tree.nodes.get('Principled BSDF'); _b.inputs['Emission Color'].default_value = (1.0, 0.05, 0.03, 1); _b.inputs['Emission Strength'].default_value = 40.0 if night else 0.0
AVLIGHT['pg1_boosted'] = 1

def crown_material():
    """Tower-top LED bands: one colour per building (from its seed), as real skylines are lit."""
    m = bpy.data.materials.new('pg1-crown'); m.use_nodes = True; nt = m.node_tree; nt.nodes.clear()
    out = node(nt, 'ShaderNodeOutputMaterial', 600, 0)
    attr = node(nt, 'ShaderNodeVertexColor', -600, 0); attr.layer_name = 'Color'
    sc = node(nt, 'ShaderNodeSeparateColor', -400, 0); link(nt, attr.outputs['Color'], sc.inputs['Color'])
    wn = node(nt, 'ShaderNodeTexWhiteNoise', -200, 0); wn.noise_dimensions = '1D'; link(nt, math_node(nt, 'MULTIPLY', sc.outputs['Red'], 613.0), wn.inputs['W'])
    r = node(nt, 'ShaderNodeValToRGB', 0, 0); r.color_ramp.interpolation = 'CONSTANT'; link(nt, wn.outputs['Value'], r.inputs['Fac'])
    el = r.color_ramp.elements
    pal = [(0.85, 0.92, 1.0), (1.0, 0.55, 0.16), (0.1, 0.85, 0.8), (0.95, 0.25, 0.65), (1.0, 0.82, 0.55), (0.25, 0.5, 1.0), (0.85, 0.92, 1.0)]
    el[0].position = 0.0; el[0].color = (*pal[0], 1); el[1].position = 1 / 7; el[1].color = (*pal[1], 1)
    for k, c in enumerate(pal[2:], start=2):
        el.new(k / 7).color = (*c, 1)
    em = node(nt, 'ShaderNodeEmission', 300, 0); link(nt, r.outputs['Color'], em.inputs['Color']); em.inputs['Strength'].default_value = 9.0 if night else 0.6
    link(nt, em.outputs['Emission'], out.inputs['Surface'])
    m['pg1_boosted'] = 1
    return m

def pool_material(color, strength):
    """The live view's lamp pools as light on the ground: a soft disc of emission over the street."""
    m = bpy.data.materials.new('pg1-light-pool'); m.use_nodes = True; nt = m.node_tree; nt.nodes.clear()
    out = node(nt, 'ShaderNodeOutputMaterial', 800, 0)
    uv = node(nt, 'ShaderNodeUVMap', -800, 0)
    sub = node(nt, 'ShaderNodeVectorMath', -600, 0, operation='SUBTRACT'); link(nt, uv.outputs['UV'], sub.inputs[0]); sub.inputs[1].default_value = (0.5, 0.5, 0)
    ln = node(nt, 'ShaderNodeVectorMath', -400, 0, operation='LENGTH'); link(nt, sub.outputs['Vector'], ln.inputs[0])
    fall = math_node(nt, 'POWER', math_node(nt, 'MAXIMUM', math_node(nt, 'SUBTRACT', 1.0, math_node(nt, 'MULTIPLY', ln.outputs['Value'], 2.0)), 0.0), 2.2)
    em = node(nt, 'ShaderNodeEmission', 200, 100); em.inputs['Color'].default_value = (*color, 1)
    link(nt, math_node(nt, 'MULTIPLY', fall, strength), em.inputs['Strength'])
    tr = node(nt, 'ShaderNodeBsdfTransparent', 200, -100)
    add = node(nt, 'ShaderNodeAddShader', 500, 0); link(nt, em.outputs['Emission'], add.inputs[0]); link(nt, tr.outputs['BSDF'], add.inputs[1])
    link(nt, add.outputs['Shader'], out.inputs['Surface'])
    m['pg1_boosted'] = 1
    return m

CROWN = crown_material()
POOL = pool_material((1.0, 0.62, 0.32), 2.6 if night else 0.0)
if meta.get('buildings'):
    sky_ob = pg1_buildings.build_skyline(bpy, meta['buildings'], [FACADE, TRIM, PLANT, AVLIGHT, CROWN])
    print(f"[cycles] skyline: {len(meta['buildings'])} buildings, {len(sky_ob.data.polygons)} faces", flush=True)
ASPHALT = simple('pg1-wet-asphalt', (0.075, 0.068, 0.06), 0.7)

def puddles(m, wet_share, wet_rough=0.08, dry_rough=0.72):
    """Wet ground in patches (puddles, damp lanes), the rest dry and matt: a
    uniformly glossy ground reads as standing water, as if the city were flooded."""
    nt = m.node_tree; b = nt.nodes.get('Principled BSDF')
    g = nt.nodes.new('ShaderNodeNewGeometry')
    nz = nt.nodes.new('ShaderNodeTexNoise'); nz.inputs['Scale'].default_value = 0.035; nz.inputs['Detail'].default_value = 6; nz.inputs['Roughness'].default_value = 0.55
    nt.links.new(g.outputs['Position'], nz.inputs['Vector'])
    mr = nt.nodes.new('ShaderNodeMapRange')
    # Noise below lo is wet: lo sits where about wet_share of the noise lies under it.
    lo = 0.5 - (0.5 - wet_share) * 0.35
    mr.inputs['From Min'].default_value = lo - 0.03; mr.inputs['From Max'].default_value = lo + 0.03
    mr.inputs['To Min'].default_value = wet_rough; mr.inputs['To Max'].default_value = dry_rough
    nt.links.new(nz.outputs['Fac'], mr.inputs['Value']); nt.links.new(mr.outputs['Result'], b.inputs['Roughness'])
    # Wet patches are darker (water fills the texture).
    dk = nt.nodes.new('ShaderNodeMapRange'); dk.inputs['From Min'].default_value = wet_rough; dk.inputs['From Max'].default_value = dry_rough
    dk.inputs['To Min'].default_value = 0.55; dk.inputs['To Max'].default_value = 1.0
    nt.links.new(mr.outputs['Result'], dk.inputs['Value'])
    mul = nt.nodes.new('ShaderNodeMix'); mul.data_type = 'RGBA'; mul.blend_type = 'MULTIPLY'; mul.inputs['Factor'].default_value = 1.0
    mul.inputs[6].default_value = b.inputs['Base Color'].default_value[:]
    nt.links.new(dk.outputs['Result'], mul.inputs[7]); nt.links.new(mul.outputs[2], b.inputs['Base Color'])

puddles(ASPHALT, 0.09 if rain else 0.03, wet_rough=0.22)
ASPHALT.node_tree.nodes.get('Principled BSDF').inputs['Specular IOR Level'].default_value = 0.25
if night:
    # Past the modelled city (about 3 km out) the suburbs go on to the horizon:
    # street lights and windows as small warm points on the ground.
    an = ASPHALT.node_tree; ab = an.nodes.get('Principled BSDF')
    ag = an.nodes.new('ShaderNodeNewGeometry'); al = an.nodes.new('ShaderNodeVectorMath'); al.operation = 'LENGTH'
    an.links.new(ag.outputs['Position'], al.inputs[0])
    far = an.nodes.new('ShaderNodeMapRange'); far.inputs['From Min'].default_value = 700; far.inputs['From Max'].default_value = 1500
    an.links.new(al.outputs['Value'], far.inputs['Value'])
    vs_ = an.nodes.new('ShaderNodeVectorMath'); vs_.operation = 'SCALE'; vs_.inputs['Scale'].default_value = 1 / 18.0
    an.links.new(ag.outputs['Position'], vs_.inputs[0])
    vr = an.nodes.new('ShaderNodeTexVoronoi'); vr.inputs['Scale'].default_value = 1.0; vr.inputs['Randomness'].default_value = 1.0
    an.links.new(vs_.outputs['Vector'], vr.inputs['Vector'])
    pt = an.nodes.new('ShaderNodeMath'); pt.operation = 'LESS_THAN'; pt.inputs[1].default_value = 0.07
    an.links.new(vr.outputs['Distance'], pt.inputs[0])
    blk = an.nodes.new('ShaderNodeTexNoise'); blk.inputs['Scale'].default_value = 0.0012
    an.links.new(ag.outputs['Position'], blk.inputs['Vector'])
    bm_ = an.nodes.new('ShaderNodeMath'); bm_.operation = 'GREATER_THAN'; bm_.inputs[1].default_value = 0.42
    an.links.new(blk.outputs['Fac'], bm_.inputs[0])
    m1 = an.nodes.new('ShaderNodeMath'); m1.operation = 'MULTIPLY'; an.links.new(pt.outputs[0], m1.inputs[0]); an.links.new(far.outputs['Result'], m1.inputs[1])
    m2 = an.nodes.new('ShaderNodeMath'); m2.operation = 'MULTIPLY'; an.links.new(m1.outputs[0], m2.inputs[0]); an.links.new(bm_.outputs[0], m2.inputs[1])
    m3 = an.nodes.new('ShaderNodeMath'); m3.operation = 'MULTIPLY'; m3.inputs[1].default_value = 30.0; an.links.new(m2.outputs[0], m3.inputs[0])
    vcol = an.nodes.new('ShaderNodeValToRGB'); an.links.new(vr.outputs['Color'], vcol.inputs['Fac'])
    vcol.color_ramp.elements[0].color = (1.0, 0.55, 0.22, 1); vcol.color_ramp.elements[1].color = (1.0, 0.85, 0.65, 1)
    # Streets out there too: a grid every 90 m, a lamp every 24 m along each.
    sx = an.nodes.new('ShaderNodeSeparateXYZ'); an.links.new(ag.outputs['Position'], sx.inputs['Vector'])
    def near_line(v, period, half):
        return math_node(an, 'LESS_THAN', math_node(an, 'MULTIPLY', math_node(an, 'ABSOLUTE', math_node(an, 'SUBTRACT', math_node(an, 'FRACT', math_node(an, 'DIVIDE', v, period)), 0.5)), period), half)
    X, Y = sx.outputs['X'], sx.outputs['Y']
    lamps = math_node(an, 'MAXIMUM', math_node(an, 'MULTIPLY', near_line(X, 90.0, 0.9), near_line(Y, 24.0, 0.9)), math_node(an, 'MULTIPLY', near_line(Y, 90.0, 0.9), near_line(X, 24.0, 0.9)))
    street = math_node(an, 'MULTIPLY', math_node(an, 'MULTIPLY', lamps, far.outputs['Result']), 12.0)
    em_all = math_node(an, 'MAXIMUM', m3.outputs[0], street)
    an.links.new(vcol.outputs['Color'], ab.inputs['Emission Color']); an.links.new(em_all, ab.inputs['Emission Strength'])
WATER = simple('pg1-river', (0.003, 0.006, 0.01), 0.05)
# Ripples: two scales of noise as a bump, so the river breaks up reflections as real water does.
_wn = WATER.node_tree; _wb = _wn.nodes.get('Principled BSDF')
_wt = _wn.nodes.new('ShaderNodeTexCoord'); _wz = _wn.nodes.new('ShaderNodeTexNoise'); _wz.noise_dimensions = '3D'
_wz.inputs['Scale'].default_value = 0.35; _wz.inputs['Detail'].default_value = 8; _wz.inputs['Roughness'].default_value = 0.6
_wmap = _wn.nodes.new('ShaderNodeMapping'); _wmap.inputs['Scale'].default_value = (1.0, 3.0, 1.0)
_wn.links.new(_wt.outputs['Object'], _wmap.inputs['Vector']); _wn.links.new(_wmap.outputs['Vector'], _wz.inputs['Vector'])
_wbump = _wn.nodes.new('ShaderNodeBump'); _wbump.inputs['Strength'].default_value = 0.35; _wbump.inputs['Distance'].default_value = 0.4
_wn.links.new(_wz.outputs['Fac'], _wbump.inputs['Height']); _wn.links.new(_wbump.outputs['Normal'], _wb.inputs['Normal'])
_wb.inputs['Specular IOR Level'].default_value = 0.5
GLASS = simple('pg1-glass', (0.8, 0.85, 0.9), 0.05)
_gb = GLASS.node_tree.nodes.get('Principled BSDF'); _gb.inputs['Transmission Weight'].default_value = 0.9
GRASS = simple('pg1-grass', (0.025, 0.06, 0.018), 0.9)
_gt = GRASS.node_tree; _gb = _gt.nodes.get('Principled BSDF'); _gg = _gt.nodes.new('ShaderNodeNewGeometry')
_gn = _gt.nodes.new('ShaderNodeTexNoise'); _gn.inputs['Scale'].default_value = 0.6; _gn.inputs['Detail'].default_value = 10; _gt.links.new(_gg.outputs['Position'], _gn.inputs['Vector'])
_gr = _gt.nodes.new('ShaderNodeValToRGB'); _gt.links.new(_gn.outputs['Fac'], _gr.inputs['Fac'])
_gr.color_ramp.elements[0].color = (0.015, 0.035, 0.01, 1); _gr.color_ramp.elements[1].color = (0.05, 0.09, 0.025, 1); _gt.links.new(_gr.outputs['Color'], _gb.inputs['Base Color'])
_gb.inputs['Sheen Weight'].default_value = 0.6; _gb.inputs['Sheen Tint'].default_value = (0.4, 0.7, 0.3, 1)
_gbump = _gt.nodes.new('ShaderNodeBump'); _gbump.inputs['Strength'].default_value = 0.4; _gt.links.new(_gn.outputs['Fac'], _gbump.inputs['Height']); _gt.links.new(_gbump.outputs['Normal'], _gb.inputs['Normal'])
LEAVES = simple('pg1-leaves', (0.03, 0.07, 0.02), 0.75)
_lt = LEAVES.node_tree; _lb = _lt.nodes.get('Principled BSDF'); _lg = _lt.nodes.new('ShaderNodeNewGeometry')
_ln = _lt.nodes.new('ShaderNodeTexNoise'); _ln.inputs['Scale'].default_value = 2.5; _ln.inputs['Detail'].default_value = 6; _lt.links.new(_lg.outputs['Position'], _ln.inputs['Vector'])
_lr = _lt.nodes.new('ShaderNodeValToRGB'); _lt.links.new(_ln.outputs['Fac'], _lr.inputs['Fac'])
_lr.color_ramp.elements[0].color = (0.012, 0.03, 0.008, 1); _lr.color_ramp.elements[1].color = (0.06, 0.11, 0.03, 1); _lt.links.new(_lr.outputs['Color'], _lb.inputs['Base Color'])
_lb.inputs['Subsurface Weight'].default_value = 0.15
_lbump = _lt.nodes.new('ShaderNodeBump'); _lbump.inputs['Strength'].default_value = 0.8; _lt.links.new(_ln.outputs['Fac'], _lbump.inputs['Height']); _lt.links.new(_lbump.outputs['Normal'], _lb.inputs['Normal'])
PAVING = simple('pg1-paving', (0.11, 0.105, 0.1), 0.7)
puddles(PAVING, 0.08 if rain else 0.02, wet_rough=0.25, dry_rough=0.78)

# The river: the live view draws it with its own mirror shader (left out of
# the export), so Cycles gets real water here: three.js RIVER z 120, half 45,
# 3.3 m below the street, the length of the ground.
bpy.ops.mesh.primitive_plane_add(size=1, location=(0, -120, -3.3))
_rv = bpy.context.active_object; _rv.name = 'pg1-river-water'; _rv.scale = (30000, 90, 1)
_rv.data.materials.append(WATER)

def assign(o, m):
    o.data.materials.clear(); o.data.materials.append(m)

CARBON = simple('pg1-carbon', (0.02, 0.02, 0.022), 0.35, metal=0.2)
def rotor_material():
    """A spinning prop: a faint dark disc (the blades a blur), slightly glossy."""
    m = bpy.data.materials.new('pg1-rotor'); m.use_nodes = True; nt = m.node_tree; nt.nodes.clear()
    out = node(nt, 'ShaderNodeOutputMaterial', 800, 0)
    b = node(nt, 'ShaderNodeBsdfPrincipled', 200, 100); b.inputs['Base Color'].default_value = (0.03, 0.03, 0.035, 1); b.inputs['Roughness'].default_value = 0.35
    tr = node(nt, 'ShaderNodeBsdfTransparent', 200, -150)
    mx = node(nt, 'ShaderNodeMixShader', 500, 0); mx.inputs[0].default_value = 0.28; link(nt, tr.outputs['BSDF'], mx.inputs[1]); link(nt, b.outputs['BSDF'], mx.inputs[2])
    link(nt, mx.outputs['Shader'], out.inputs['Surface'])
    m['pg1_boosted'] = 1
    return m
ROTOR = rotor_material()

counts = {}
HIDDEN_FAKE = set()
for o in list(scene.objects):
    if o.type != 'MESH':
        continue
    n = o.name.split('.')[0]
    if n.startswith('moving-'):
        n = n[len('moving-'):]
    dp = o.get('pg1_drone')
    if dp == 'rotor':
        assign(o, ROTOR); o.visible_shadow = False; counts['rotors'] = counts.get('rotors', 0) + 1; continue
    if dp == 'arm':
        assign(o, CARBON); continue
    if dp == 'body':
        for m in o.data.materials:
            b = m.node_tree.nodes.get('Principled BSDF') if m and m.use_nodes else None
            if b:
                b.inputs['Roughness'].default_value = 0.28; b.inputs['Coat Weight'].default_value = 0.8; b.inputs['Coat Roughness'].default_value = 0.08
        continue
    base = n.rsplit('-', 1)[0] if n.rsplit('-', 1)[-1].isdigit() else n
    if base.startswith('facade~') or base.startswith('skyline-'):
        assign(o, FACADE); counts['facade'] = counts.get('facade', 0) + 1
    elif base in ('ground', 'road', 'puddles'):
        assign(o, ASPHALT)
    elif base in ('tower-beacon', 'rooftop-beacon'):
        # The live view's 4.4 m beacon reads as a white ball close up: a smaller lamp.
        co = np.empty(len(o.data.vertices) * 3); o.data.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
        cen = co.mean(axis=0); o.data.vertices.foreach_set('co', (cen + (co - cen) * 0.45).ravel()); o.data.update()
    elif base == 'construction-crane-light':
        # The live view's 1.8 m white ball on the crane top: a small red aviation light.
        co = np.empty(len(o.data.vertices) * 3); o.data.vertices.foreach_get('co', co); co = co.reshape(-1, 3)
        cen = co.mean(axis=0); o.data.vertices.foreach_set('co', (cen + (co - cen) * 0.3).ravel()); o.data.update()
        assign(o, AVLIGHT); continue
    elif base in ('river',):
        assign(o, WATER)
    elif base in ('park', 'roof-gardens', 'grass', 'verges'):
        assign(o, GRASS)
    elif base in ('tree-crowns', 'shop-planters') or base.startswith('shop-planters'):
        assign(o, LEAVES)
    elif base in ('pavements', 'plaza', 'kerbs'):
        assign(o, PAVING)
    elif base in ('lamp-pools', 'street-light-pools') and night:
        # Street lighting: the pools as warm light on the street (the wet asphalt reflects the lamp heads too).
        assign(o, POOL); o.visible_shadow = False; counts['pools'] = counts.get('pools', 0) + 1; continue
    elif base in ('lamp-pools', 'street-light-pools', 'boat-light-pools', 'wet-road-glare', 'wet-road-tail-glare', 'road-spray', 'boat-wakes', 'tower-beacon-halo'):
        # Fake light pools and glows from the live view: Cycles lights the ground itself.
        o.hide_render = True; counts['hidden'] = counts.get('hidden', 0) + 1
    # The live view's fake glows (see-through, glowing cards and cones): Cycles makes real glow.
    # Everything the live view draws see-through (glows, trails, beams, rotor
    # blur, light pools) comes in from glTF as solid: left out, except real
    # glass (shop fronts, shelters, rails: made glass) and PG1's own marks.
    fake = False
    for m in o.data.materials:
        if m and m.use_nodes and not m.name.startswith('pg1-'):
            b = m.node_tree.nodes.get('Principled BSDF')
            see_through = getattr(m, 'surface_render_method', '') == 'BLENDED' or (not b.inputs['Alpha'].is_linked and b.inputs['Alpha'].default_value < 0.95) if b else False
            if b and see_through:
                fake = True
    if fake and base in ('shop-glass', 'bus-shelters', 'roof-terrace-rails'):
        fake = False; assign(o, GLASS)
    if fake and (base.startswith('pg1-emblem') or base == 'command-deck'):
        fake = False  # PG1's own marks and the deck stay (drawn as lit glass)
    if fake:
        o.hide_render = True; counts['hidden'] = counts.get('hidden', 0) + 1; HIDDEN_FAKE.add(base)
        continue
    if base == 'aircraft':
        # Airliners at night: painted, lit by the city, their lights do the glowing.
        for m in o.data.materials:
            b = m.node_tree.nodes.get('Principled BSDF') if m and m.use_nodes else None
            if b:
                b.inputs['Emission Strength'].default_value = 0.0; b.inputs['Roughness'].default_value = 0.3; m['pg1_boosted'] = 1
    # Glows and lamps (exported as emission): brighter, as real lamps are.
    for m in o.data.materials:
        if not m or not m.use_nodes or m.name.startswith('pg1-'):
            continue
        b = m.node_tree.nodes.get('Principled BSDF')
        if b and 'Emission Strength' in b.inputs:
            col = b.inputs['Emission Color'].default_value; st = b.inputs['Emission Strength'].default_value
            em_linked = b.inputs['Emission Color'].is_linked
            # Only the live view's unlit lamps (MeshBasic): painted parts keep their own small glow.
            if st > 0 and m.name.startswith('MeshBasicMaterial') and (em_linked or max(col[0], col[1], col[2]) > 0.05) and not m.get('pg1_boosted'):
                b.inputs['Emission Strength'].default_value = st * ((14.0 if base in ('car-lights', 'buses', 'taxi-roof-signs', 'tram') else 6.0) if night else 1.5); m['pg1_boosted'] = 1

# Real lights at the street lamps would be thousands; the lamp heads glow
# and light the wet street by reflection. A dim moon and the sky do the rest.
world = bpy.data.worlds.new('pg1-sky'); scene.world = world; world.use_nodes = True
wn = world.node_tree; wn.nodes.clear()
wo = wn.nodes.new('ShaderNodeOutputWorld')
bg = wn.nodes.new('ShaderNodeBackground')
grad = wn.nodes.new('ShaderNodeTexGradient'); grad.gradient_type = 'LINEAR'
tc = wn.nodes.new('ShaderNodeTexCoord')
mp = wn.nodes.new('ShaderNodeMapping'); mp.inputs['Rotation'].default_value = (0, -math.pi / 2, 0)
ramp = wn.nodes.new('ShaderNodeValToRGB')
fog = meta.get('fog') or {'color': [0.2, 0.24, 0.36], 'density': 0.0009}
fc = fog['color']
if night:
    # Night: the horizon in the fog colour, deep blue overhead.
    ramp.color_ramp.elements[0].color = (0.035, 0.045, 0.085, 1)
    ramp.color_ramp.elements[0].position = 0.5
    ramp.color_ramp.elements[1].color = (0.004, 0.01, 0.04, 1)
    ramp.color_ramp.elements[1].position = 0.75
    bg.inputs['Strength'].default_value = 1.0
else:
    ramp.color_ramp.elements[0].color = (0.75, 0.8, 0.88, 1)
    ramp.color_ramp.elements[1].color = (0.25, 0.42, 0.72, 1)
    bg.inputs['Strength'].default_value = 1.5
wn.links.new(tc.outputs['Generated'], mp.inputs['Vector']); wn.links.new(mp.outputs['Vector'], grad.inputs['Vector'])
wn.links.new(grad.outputs['Fac'], ramp.inputs['Fac'])
if night:
    # A few stars: thresholded noise on the view direction, through the haze only faintly.
    st = wn.nodes.new('ShaderNodeTexWhiteNoise'); st.noise_dimensions = '3D'
    sm = wn.nodes.new('ShaderNodeVectorMath'); sm.operation = 'SCALE'; sm.inputs['Scale'].default_value = 900.0
    wn.links.new(tc.outputs['Generated'], sm.inputs[0]); wn.links.new(sm.outputs['Vector'], st.inputs['Vector'])
    sth = wn.nodes.new('ShaderNodeMath'); sth.operation = 'GREATER_THAN'; sth.inputs[1].default_value = 0.9985
    wn.links.new(st.outputs['Value'], sth.inputs[0])
    sadd = wn.nodes.new('ShaderNodeMix'); sadd.data_type = 'RGBA'; sadd.blend_type = 'ADD'
    sstr = wn.nodes.new('ShaderNodeMath'); sstr.operation = 'MULTIPLY'; sstr.inputs[1].default_value = 0.6
    wn.links.new(sth.outputs[0], sstr.inputs[0]); wn.links.new(sstr.outputs[0], sadd.inputs['Factor'])
    wn.links.new(ramp.outputs['Color'], sadd.inputs[6]); sadd.inputs[7].default_value = (0.8, 0.85, 1.0, 1)
    wn.links.new(sadd.outputs[2], bg.inputs['Color'])
else:
    wn.links.new(ramp.outputs['Color'], bg.inputs['Color'])
wn.links.new(bg.outputs['Background'], wo.inputs['Surface'])
# Haze as a real volume, 900 m deep over the city: lamps glow through it, the
# distance fades into it and the city's light lifts it (a sodium glow at night);
# above it the sky shows through.
# Night: no haze volume. Lit by moon and sky it laid a navy veil over the
# streets, which read as standing water; distance fades in the mist pass instead.
HAZE = float(arg('--haze', '0' if night else '0.00016'))
if HAZE > 0:
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 450))
    hz = bpy.context.active_object; hz.name = 'pg1-haze'; hz.scale = (30000, 30000, 900)
    hm = bpy.data.materials.new('pg1-haze-volume'); hm.use_nodes = True
    hn = hm.node_tree; hn.nodes.clear()
    pv = hn.nodes.new('ShaderNodeVolumePrincipled'); ho = hn.nodes.new('ShaderNodeOutputMaterial')
    pv.inputs['Density'].default_value = HAZE; pv.inputs['Anisotropy'].default_value = 0.4
    pv.inputs['Color'].default_value = (0.95, 0.82, 0.68, 1) if night else (0.92, 0.94, 0.97, 1)
    if night:
        pv.inputs['Emission Color'].default_value = (0.8, 0.62, 0.5, 1); pv.inputs['Emission Strength'].default_value = HAZE * 0.003
    hn.links.new(pv.outputs['Volume'], ho.inputs['Volume'])
    hz.data.materials.append(hm)
sun = bpy.data.lights.new('pg1-moon' if night else 'pg1-sun', 'SUN')
sun.energy = 0.15 if night else 3.5; sun.color = (0.7, 0.8, 1.0) if night else (1.0, 0.95, 0.88); sun.angle = math.radians(0.6)
so = bpy.data.objects.new(sun.name, sun); scene.collection.objects.link(so)
if night:
    # The moon lamp's glint on the rippled river drew a bright column there: lights the scene, no reflection.
    so.visible_glossy = False
d = (meta.get('lights') or [{}])[0].get('dir') if meta.get('lights') else None
if d:
    # three.js y-up to Blender z-up: (x, y, z) -> (x, -z, y); the sun points along -dir.
    v = (d[0], -d[2], d[1])
    so.rotation_euler = (math.acos(max(-1, min(1, v[2]))), 0, math.atan2(v[0], -v[1]))
else:
    so.rotation_euler = (math.radians(55), 0, math.radians(30))

# --- night sky: moonlit clouds over the city's glow, the moon, a few stars ---
CLOUDS = arg('--clouds', 'on') != 'off'
moon_dir = None
if d:
    moon_dir = (d[0], -d[2], d[1]); n_ = math.sqrt(sum(c * c for c in moon_dir)) or 1; moon_dir = tuple(c / n_ for c in moon_dir)
if CLOUDS:
    bpy.ops.mesh.primitive_plane_add(size=1, location=(0, 0, 2600))
    cl = bpy.context.active_object; cl.name = 'pg1-clouds'; cl.scale = (60000, 60000, 1)
    cm = bpy.data.materials.new('pg1-clouds'); cm.use_nodes = True; cn = cm.node_tree; cn.nodes.clear()
    co = cn.nodes.new('ShaderNodeOutputMaterial')
    tc2 = cn.nodes.new('ShaderNodeTexCoord')
    nz = cn.nodes.new('ShaderNodeTexNoise'); nz.noise_dimensions = '3D'; nz.inputs['Scale'].default_value = 45.0
    nz.inputs['Detail'].default_value = 12; nz.inputs['Roughness'].default_value = 0.62; nz.inputs['Distortion'].default_value = 0.4
    cn.links.new(tc2.outputs['Generated'], nz.inputs['Vector'])
    cr = cn.nodes.new('ShaderNodeValToRGB'); cn.links.new(nz.outputs['Fac'], cr.inputs['Fac'])
    cr.color_ramp.elements[0].position = 0.42; cr.color_ramp.elements[0].color = (0, 0, 0, 1)
    cr.color_ramp.elements[1].position = 0.62; cr.color_ramp.elements[1].color = (1, 1, 1, 1)
    tr = cn.nodes.new('ShaderNodeBsdfTransparent'); df = cn.nodes.new('ShaderNodeBsdfPrincipled')
    df.inputs['Base Color'].default_value = (0.5, 0.52, 0.58, 1) if night else (0.95, 0.95, 0.97, 1); df.inputs['Roughness'].default_value = 1.0
    if night:
        # Lit from below by the city: a warm glow on the cloud base.
        df.inputs['Emission Color'].default_value = (0.75, 0.55, 0.45, 1); df.inputs['Emission Strength'].default_value = 0.07
    mx = cn.nodes.new('ShaderNodeMixShader')
    cn.links.new(cr.outputs['Color'], mx.inputs['Fac']); cn.links.new(tr.outputs['BSDF'], mx.inputs[1]); cn.links.new(df.outputs['BSDF'], mx.inputs[2])
    cn.links.new(mx.outputs['Shader'], co.inputs['Surface'])
    cl.data.materials.append(cm)
    cl.visible_shadow = False
if night and moon_dir and moon_dir[2] > 0.05:
    # The moon itself, far out along the light's direction (the sun lamp lights the scene).
    md = 40000
    bpy.ops.mesh.primitive_uv_sphere_add(radius=md * 0.0045, location=tuple(c * md for c in moon_dir))
    mo = bpy.context.active_object; mo.name = 'pg1-moon'
    mm = bpy.data.materials.new('pg1-moon'); mm.use_nodes = True; mb = mm.node_tree.nodes.get('Principled BSDF')
    mb.inputs['Base Color'].default_value = (0, 0, 0, 1); mb.inputs['Emission Color'].default_value = (0.92, 0.94, 1.0, 1); mb.inputs['Emission Strength'].default_value = 6.0
    mo.data.materials.append(mm); mo.visible_shadow = False; mo.visible_diffuse = False
    # Not in reflections: on the rippled river it drew a bright column that read as a light beam.
    mo.visible_glossy = False; mo.visible_transmission = False
    for f in mo.data.polygons:
        f.use_smooth = True
camera_far = 80000

# --- render ---
scene.render.engine = 'CYCLES'
cy = scene.cycles
cy.device = DEVICE
if DEVICE == 'GPU':
    prefs = bpy.context.preferences.addons['cycles'].preferences
    for t in ('OPTIX', 'CUDA', 'HIP', 'METAL', 'ONEAPI'):
        try:
            prefs.compute_device_type = t; prefs.get_devices(); break
        except Exception:
            pass
    for dev in prefs.devices:
        dev.use = True
cy.samples = SAMPLES; cy.use_adaptive_sampling = True; cy.adaptive_threshold = 0.02
cy.use_denoising = True; cy.denoiser = 'OPENIMAGEDENOISE'
cy.max_bounces = 6; cy.diffuse_bounces = 3; cy.glossy_bounces = 4; cy.transmission_bounces = 4
cy.caustics_reflective = False; cy.caustics_refractive = False
cy.light_sampling_threshold = 0.01
RES = arg('--res')
scene.render.resolution_x, scene.render.resolution_y = (int(v) for v in RES.split('x')) if RES else meta['size']
scene.render.resolution_percentage = SCALE
scene.render.film_transparent = False
scene.view_settings.view_transform = arg('--view', 'Khronos PBR Neutral' if night else 'AgX')
if scene.view_settings.view_transform == 'AgX':
    scene.view_settings.look = arg('--look-grade', 'AgX - Punchy')
scene.view_settings.exposure = float(arg('--exposure', '0.3' if night else '0.0'))
scene.render.image_settings.file_format = 'PNG'
# The compositor on the CPU: a runner has no display for a GPU context.
if hasattr(scene.render, 'compositor_device'):
    scene.render.compositor_device = 'CPU'

# --- scenery between the towers (reel only): low-rise blocks, street trees, far traffic ---
CAMPOS = np.array([(C @ np.array(c['matrix'], dtype=np.float64).reshape(4, 4).T)[:3, 3] for c in meta.get('frames') or []]).reshape(-1, 3)
TRAFFIC = None
if arg('--scenery', '1') == '1':
    bpy.context.view_layer.update(); _dg = bpy.context.evaluated_depsgraph_get()
    _segs = None
    if ANIM:
        _nfr = len(meta['frames']); _frs = sorted(set([0, _nfr - 1] + list(range(0, _nfr, 15))))
        _segs = pg1_filler.sight_lines(scene, _dg, cams[0], set_camera, _frs)
        print(f'[cycles] scenery: {0 if _segs is None else len(_segs)} sight lines kept clear', flush=True)
    _lots = pg1_filler.plan_lots(scene, _dg, CAMPOS, segs=_segs, fliers=FLY_PTS)
    if _lots:
        pg1_buildings.build_skyline(bpy, _lots, [FACADE, TRIM, PLANT, AVLIGHT], name='pg1-lowrise', fn=pg1_buildings.build_filler)
    _roads = pg1_filler.road_rects(bpy)
    BARK = simple('pg1-bark', (0.05, 0.035, 0.025), 0.85)
    _trees, _nt = pg1_filler.street_trees(bpy, scene, _dg, CAMPOS, _roads, BARK, LEAVES)
    PAINT = simple('pg1-car-paint', (0.3, 0.3, 0.3), 0.3)
    _pt = PAINT.node_tree; _pv = _pt.nodes.new('ShaderNodeVertexColor'); _pv.layer_name = 'Color'
    _pt.links.new(_pv.outputs['Color'], _pt.nodes.get('Principled BSDF').inputs['Base Color'])
    _pt.nodes.get('Principled BSDF').inputs['Coat Weight'].default_value = 0.6
    HEAD = simple('pg1-headlight', (1, 1, 1), 0.3); _hb = HEAD.node_tree.nodes.get('Principled BSDF')
    _hb.inputs['Emission Color'].default_value = (1.0, 0.92, 0.8, 1); _hb.inputs['Emission Strength'].default_value = 40.0 if night else 0.0
    TAIL = simple('pg1-taillight', (0.4, 0.02, 0.02), 0.3); _tb = TAIL.node_tree.nodes.get('Principled BSDF')
    _tb.inputs['Emission Color'].default_value = (1.0, 0.05, 0.02, 1); _tb.inputs['Emission Strength'].default_value = 25.0 if night else 0.0
    TRAFFIC = pg1_filler.Traffic(bpy, scene, CAMPOS, _roads, PAINT, HEAD, TAIL)
    print(f'[cycles] scenery: {len(_lots)} low-rise blocks, {_nt} street trees, {len(TRAFFIC.cars)} cars on {len(_roads)} roads', flush=True)

# Distance haze: the mist pass, in the shot's fog colour.
vl = scene.view_layers[0]; vl.use_pass_mist = True
world.mist_settings.start = 400 if night else 150; world.mist_settings.depth = 4300 if night else 5000; world.mist_settings.falloff = 'QUADRATIC'
# Blender 5 compositor: a node group as the scene's compositor.
ct = bpy.data.node_groups.new('pg1-grade', 'CompositorNodeTree')
ct.interface.new_socket('Image', in_out='OUTPUT', socket_type='NodeSocketColor')
scene.compositing_node_group = ct
rl = ct.nodes.new('CompositorNodeRLayers')
mist_curve = ct.nodes.new('ShaderNodeMath'); mist_curve.operation = 'MULTIPLY'; mist_curve.inputs[1].default_value = float(arg('--mist', '0.95' if night else '0'))
ct.links.new(rl.outputs['Mist'], mist_curve.inputs[0])
mix = ct.nodes.new('ShaderNodeMix'); mix.data_type = 'RGBA'; mix.blend_type = 'MIX'
mix.inputs[7].default_value = (0.035, 0.045, 0.085, 1) if night else (0.7, 0.75, 0.82, 1)
ct.links.new(mist_curve.outputs[0], mix.inputs['Factor']); ct.links.new(rl.outputs['Image'], mix.inputs[6])
glare = ct.nodes.new('CompositorNodeGlare')
glare.inputs['Type'].default_value = 'Fog Glow'; glare.inputs['Quality'].default_value = 'High'
glare.inputs['Threshold'].default_value = 1.0; glare.inputs['Strength'].default_value = 0.6
ct.links.new(mix.outputs[2], glare.inputs['Image'])
gout = ct.nodes.new('NodeGroupOutput'); ct.links.new(glare.outputs['Image'], gout.inputs[0])

shot = meta.get('shot', 'shot')
print(f'[cycles] see-through glows left out: {sorted(HIDDEN_FAKE)}', flush=True)
print(f'[cycles] {shot}: {len(scene.objects)} objects, facade on {counts.get("facade", 0)}, hidden glows {counts.get("hidden", 0)}, {SAMPLES} samples on {DEVICE}, {scene.render.resolution_x}x{scene.render.resolution_y} at {SCALE}%', flush=True)
if ANIM:
    # --frames A:B renders frames A..B-1 (0-based) as frame_00001.png ... (1-based, as the shot's MP4 frames).
    total = len(meta['frames'])
    rng = arg('--frames', f'0:{total}'); a_, b_ = (int(x) for x in rng.split(':')); b_ = min(b_, total)
    still = arg('--still')
    import time
    MBLUR = arg('--motion-blur', '1') == '1' and not arg('--look')
    # Camera steps between frames: a step far above the shot's usual one is a jump.
    _P = np.array([np.array(c['matrix'], dtype=np.float64).reshape(4, 4).T[:3, 3] for c in meta['frames']])
    _R = [np.array(c['matrix'], dtype=np.float64).reshape(4, 4).T[:3, :3] for c in meta['frames']]
    _step = np.linalg.norm(np.diff(_P, axis=0), axis=1)
    _turn = np.array([math.degrees(math.acos(max(-1.0, min(1.0, (np.trace(_R[i].T @ _R[i + 1]) - 1) / 2)))) for i in range(len(_R) - 1)])
    _ms, _mt = float(np.median(_step)) + 1e-6, float(np.median(_turn)) + 1e-6
    CAM_JUMP = list((_step > 2.5 * _ms + 0.5) | (_turn > 2.5 * _mt + 0.4)) + [False]
    FIRST_OK = int(arg('--first-frame', '9'))
    print(f'[cycles] camera jumps (no blur across): {[i for i, j in enumerate(CAM_JUMP) if j]}', flush=True)
    if MBLUR:
        # Camera motion blur, as a real camera at 1/60 s: the camera keyed a
        # frame either side, the shutter open for 40% of a frame round each.
        scene.render.use_motion_blur = True; scene.render.motion_blur_shutter = 0.25
        scene.render.motion_blur_position = 'CENTER'
        cams[0].rotation_mode = 'QUATERNION'
    for fr in ([int(round((total - 1) * meta.get('still_t', 0.66)))] if still else range(a_, b_)):
        t0 = time.time()
        if MBLUR:
            # A neighbour frame across a jump in the recorded camera (a cut, the
            # first frames settling) would smear the whole frame: that side
            # keeps this frame's pose (no blur from it).
            cam = cams[0]; cam.animation_data_clear(); q_prev = None
            for f_ in (fr - 1, fr, fr + 1):
                g_ = min(max(f_, 0), total - 1)
                if g_ != fr and (not (FIRST_OK <= g_) or CAM_JUMP[min(fr, g_)]):
                    g_ = fr
                set_camera(g_)
                q = cam.matrix_world.to_quaternion()
                if q_prev is not None and q.dot(q_prev) < 0:
                    q.negate()
                q_prev = q
                cam.rotation_quaternion = q; cam.location = cam.matrix_world.translation.copy()
                cam.keyframe_insert('location', frame=f_ + 1); cam.keyframe_insert('rotation_quaternion', frame=f_ + 1)
            scene.frame_set(fr + 1)
        set_camera(fr); set_dynamic(fr)
        if TRAFFIC:
            TRAFFIC.update(fr)
        if arg('--look'):
            # Test view: from --look-from (x,y,z, Blender) at the named object's centre.
            from mathutils import Vector
            tgt = [o for o in scene.objects if o.name.startswith(arg('--look'))][0]
            cen = sum((tgt.matrix_world @ Vector(c) for c in tgt.bound_box), Vector()) / 8
            frm = Vector([float(x) for x in arg('--look-from').split(',')]) + cen
            cams[0].location = frm; cams[0].rotation_euler = (cen - frm).to_track_quat('-Z', 'Y').to_euler()
        if arg('--pick'):
            # Debug: what lies under these image points (u,v in 0..1 from top-left; ';' between points).
            from mathutils import Vector
            from bpy_extras.view3d_utils import region_2d_to_vector_3d
            bpy.context.view_layer.update(); dg = bpy.context.evaluated_depsgraph_get(); cam = cams[0]
            fr_ = cam.data.view_frame(scene=scene)
            for pt in arg('--pick').split(';'):
                u, v = [float(x) for x in pt.split(',')]
                tl, tr, br, bl_ = fr_[3], fr_[0], fr_[1], fr_[2]
                local = tl + (tr - tl) * u + (bl_ - tl) * v
                d = (cam.matrix_world.to_3x3() @ local).normalized()
                hit, loc, nrm, idx, ob, mx = scene.ray_cast(dg, cam.matrix_world.translation, d)
                print('[pick]', pt, ob.name if ob else None, [m.name for m in ob.data.materials][:2] if ob else None, tuple(round(c, 1) for c in loc), flush=True)
        scene.render.filepath = os.path.join(OUT, f'{shot}-still.png' if still else f'frame_{fr + 1:05d}.png')
        bpy.ops.render.render(write_still=True)
        print(f'[cycles] {shot} frame {fr + 1}/{total} in {time.time() - t0:.0f} s', flush=True)
else:
    scene.render.filepath = os.path.join(OUT, f'{shot}-cycles.png')
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, f'{shot}.blend'), compress=True)
    bpy.ops.render.render(write_still=True)
    print(f'[cycles] wrote {scene.render.filepath}', flush=True)
