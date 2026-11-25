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

import bpy, json, math, os, sys

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
cams = [o for o in scene.objects if o.type == 'CAMERA']
if not cams:
    raise SystemExit('no camera in city.glb')
scene.camera = cams[0]
cams[0].data.clip_end = 90000
cams[0].data.clip_start = 0.5

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
    win = math_node(nt, 'MULTIPLY', math_node(nt, 'MULTIPLY', inside(fu, u_lo, u_hi), inside(fv, v_lo, v_hi)), wall)
    # Each window: white noise of (column, storey, building seed).
    cellv = node(nt, 'ShaderNodeCombineXYZ', -300, -150)
    # Offices light in runs along a floor (glass: about 6 panes), homes window by window.
    clus = lookup(nt, style, STYLE_CLUSTER, -700, -1500)
    link(nt, math_node(nt, 'FLOOR', math_node(nt, 'DIVIDE', math_node(nt, 'FLOOR', cu), clus)), cellv.inputs['X']); link(nt, math_node(nt, 'FLOOR', cv), cellv.inputs['Y']); link(nt, math_node(nt, 'MULTIPLY', seed, 997.0), cellv.inputs['Z'])
    wn = node(nt, 'ShaderNodeTexWhiteNoise', -100, -150); wn.noise_dimensions = '3D'; link(nt, cellv.outputs['Vector'], wn.inputs['Vector'])
    # Each building its own occupancy (0.2 to 0.6 of windows lit at night).
    bn = node(nt, 'ShaderNodeTexWhiteNoise', -300, -350); bn.noise_dimensions = '1D'; link(nt, math_node(nt, 'MULTIPLY', seed, 997.0), bn.inputs['W'])
    occ = math_node(nt, 'ADD', math_node(nt, 'MULTIPLY', bn.outputs['Value'], 0.35), 0.15)
    lit = math_node(nt, 'LESS_THAN', wn.outputs['Value'], occ if night else 0.004)
    litw = math_node(nt, 'MULTIPLY', lit, win)
    ramp_l = node(nt, 'ShaderNodeValToRGB', 300, -250); link(nt, wn.outputs['Color'], ramp_l.inputs['Fac'])
    el = ramp_l.color_ramp.elements; el[0].color = (1.0, 0.58, 0.28, 1); el[1].color = (1.0, 0.86, 0.66, 1); el.new(0.82).color = (0.72, 0.84, 1.0, 1)
    # Interior depth: brighter at the window top (ceiling lights), blinds part-way on some.
    grad = math_node(nt, 'ADD', math_node(nt, 'MULTIPLY', fv, 0.9), 0.4)
    cellw = node(nt, 'ShaderNodeCombineXYZ', -300, 400); link(nt, math_node(nt, 'FLOOR', cu), cellw.inputs['X']); link(nt, math_node(nt, 'FLOOR', cv), cellw.inputs['Y']); link(nt, math_node(nt, 'ADD', math_node(nt, 'MULTIPLY', seed, 997.0), 0.5), cellw.inputs['Z'])
    wn2 = node(nt, 'ShaderNodeTexWhiteNoise', -100, 400); wn2.noise_dimensions = '3D'; link(nt, cellw.outputs['Vector'], wn2.inputs['Vector'])
    var = node(nt, 'ShaderNodeMapRange', 300, 250); link(nt, wn2.outputs['Value'], var.inputs['Value']); var.inputs['To Min'].default_value = 0.35
    strength = math_node(nt, 'MULTIPLY', math_node(nt, 'MULTIPLY', math_node(nt, 'MULTIPLY', litw, var.outputs['Result']), grad), 1.5 if night else 0.0)
    wallc = lookup(nt, style, STYLE_WALL, 300, -700)
    # Slight weathering on walls: large noise darkens and lightens them.
    wnz = node(nt, 'ShaderNodeTexNoise', 300, -950); wnz.inputs['Scale'].default_value = 0.08; link(nt, geo.outputs['Position'], wnz.inputs['Vector'])
    weather = node(nt, 'ShaderNodeMix', 550, -800); weather.data_type = 'RGBA'; weather.blend_type = 'MULTIPLY'
    link(nt, wnz.outputs['Fac'], weather.inputs['Factor']); link(nt, wallc, weather.inputs[6]); weather.inputs[7].default_value = (0.75, 0.75, 0.75, 1)
    bsdf = node(nt, 'ShaderNodeBsdfPrincipled', 1300, 0)
    basec = node(nt, 'ShaderNodeMix', 900, -300); basec.data_type = 'RGBA'
    link(nt, win, basec.inputs['Factor']); link(nt, weather.outputs[2], basec.inputs[6]); basec.inputs[7].default_value = (0.004, 0.006, 0.01, 1)
    link(nt, basec.outputs[2], bsdf.inputs['Base Color'])
    glassy = math_node(nt, 'LESS_THAN', style, 0.5 / 8)
    rgh = node(nt, 'ShaderNodeMix', 900, -500); rgh.data_type = 'FLOAT'; link(nt, win, rgh.inputs['Factor'])
    link(nt, math_node(nt, 'ADD', math_node(nt, 'MULTIPLY', glassy, -0.55), 0.7), rgh.inputs['A']); rgh.inputs['B'].default_value = 0.03
    link(nt, rgh.outputs['Result'], bsdf.inputs['Roughness'])
    # Window glass reflects less than a mirror (tinted, with lights behind it).
    spec = node(nt, 'ShaderNodeMix', 900, -600); spec.data_type = 'FLOAT'; link(nt, win, spec.inputs['Factor']); spec.inputs['A'].default_value = 0.5; spec.inputs['B'].default_value = 0.18
    link(nt, spec.outputs['Result'], bsdf.inputs['Specular IOR Level'])
    link(nt, math_node(nt, 'MULTIPLY', glassy, 0.3), bsdf.inputs['Metallic'])
    link(nt, ramp_l.outputs['Color'], bsdf.inputs['Emission Color'])
    link(nt, strength, bsdf.inputs['Emission Strength'])
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
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pg1_buildings
if meta.get('buildings'):
    sky_ob = pg1_buildings.build_skyline(bpy, meta['buildings'], [FACADE, TRIM, PLANT, AVLIGHT])
    print(f"[cycles] skyline: {len(meta['buildings'])} buildings, {len(sky_ob.data.polygons)} faces", flush=True)
ASPHALT = simple('pg1-wet-asphalt', (0.025, 0.025, 0.028), 0.18 if rain else 0.45)
if night:
    # Past the modelled city (about 3 km out) the suburbs go on to the horizon:
    # street lights and windows as small warm points on the ground.
    an = ASPHALT.node_tree; ab = an.nodes.get('Principled BSDF')
    ag = an.nodes.new('ShaderNodeNewGeometry'); al = an.nodes.new('ShaderNodeVectorMath'); al.operation = 'LENGTH'
    an.links.new(ag.outputs['Position'], al.inputs[0])
    far = an.nodes.new('ShaderNodeMapRange'); far.inputs['From Min'].default_value = 3000; far.inputs['From Max'].default_value = 4200
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
    an.links.new(vcol.outputs['Color'], ab.inputs['Emission Color']); an.links.new(m3.outputs[0], ab.inputs['Emission Strength'])
WATER = simple('pg1-river', (0.004, 0.008, 0.014), 0.02)
PAVING = simple('pg1-paving', (0.07, 0.07, 0.075), 0.3 if rain else 0.6)

def assign(o, m):
    o.data.materials.clear(); o.data.materials.append(m)

counts = {}
for o in list(scene.objects):
    if o.type != 'MESH':
        continue
    n = o.name.split('.')[0]
    base = n.rsplit('-', 1)[0] if n.rsplit('-', 1)[-1].isdigit() else n
    if base.startswith('facade~') or base.startswith('skyline-'):
        assign(o, FACADE); counts['facade'] = counts.get('facade', 0) + 1
    elif base in ('ground', 'road', 'puddles'):
        assign(o, ASPHALT)
    elif base in ('river',):
        assign(o, WATER)
    elif base in ('pavements', 'plaza', 'kerbs'):
        assign(o, PAVING)
    elif base in ('lamp-pools', 'street-light-pools', 'boat-light-pools', 'wet-road-glare', 'wet-road-tail-glare', 'road-spray', 'boat-wakes', 'crowd', 'tower-beacon-halo'):
        # Fake light pools and glows from the live view: Cycles lights the ground itself.
        o.hide_render = True; counts['hidden'] = counts.get('hidden', 0) + 1
    # Glows and lamps (exported as emission): brighter, as real lamps are.
    for m in o.data.materials:
        if not m or not m.use_nodes or m.name.startswith('pg1-'):
            continue
        b = m.node_tree.nodes.get('Principled BSDF')
        if b and 'Emission Strength' in b.inputs:
            col = b.inputs['Emission Color'].default_value; st = b.inputs['Emission Strength'].default_value
            em_linked = b.inputs['Emission Color'].is_linked
            if st > 0 and (em_linked or max(col[0], col[1], col[2]) > 0.05) and not m.get('pg1_boosted'):
                b.inputs['Emission Strength'].default_value = st * (6.0 if night else 1.5); m['pg1_boosted'] = 1

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
    ramp.color_ramp.elements[0].color = (fc[0] * 0.35, fc[1] * 0.35, fc[2] * 0.42, 1)
    ramp.color_ramp.elements[0].position = 0.5
    ramp.color_ramp.elements[1].color = (0.002, 0.004, 0.012, 1)
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
HAZE = float(arg('--haze', '0.00028'))
if HAZE > 0:
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 450))
    hz = bpy.context.active_object; hz.name = 'pg1-haze'; hz.scale = (30000, 30000, 900)
    hm = bpy.data.materials.new('pg1-haze-volume'); hm.use_nodes = True
    hn = hm.node_tree; hn.nodes.clear()
    pv = hn.nodes.new('ShaderNodeVolumePrincipled'); ho = hn.nodes.new('ShaderNodeOutputMaterial')
    pv.inputs['Density'].default_value = HAZE; pv.inputs['Anisotropy'].default_value = 0.4
    pv.inputs['Color'].default_value = (0.8, 0.84, 0.95, 1) if night else (0.92, 0.94, 0.97, 1)
    if night:
        pv.inputs['Emission Color'].default_value = (0.9, 0.6, 0.4, 1); pv.inputs['Emission Strength'].default_value = HAZE * 0.005
    hn.links.new(pv.outputs['Volume'], ho.inputs['Volume'])
    hz.data.materials.append(hm)
sun = bpy.data.lights.new('pg1-moon' if night else 'pg1-sun', 'SUN')
sun.energy = 0.15 if night else 3.5; sun.color = (0.7, 0.8, 1.0) if night else (1.0, 0.95, 0.88); sun.angle = math.radians(0.6)
so = bpy.data.objects.new(sun.name, sun); scene.collection.objects.link(so)
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
        df.inputs['Emission Color'].default_value = (0.9, 0.55, 0.32, 1); df.inputs['Emission Strength'].default_value = 0.16
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
    mo.data.materials.append(mm); mo.visible_shadow = False; mo.visible_diffuse = False; mo.visible_glossy = True
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
scene.render.resolution_x, scene.render.resolution_y = meta['size']
scene.render.resolution_percentage = SCALE
scene.render.film_transparent = False
scene.view_settings.view_transform = 'AgX'
scene.view_settings.look = 'AgX - Medium High Contrast'
scene.view_settings.exposure = 0.3 if night else 0.0
scene.render.image_settings.file_format = 'PNG'
# The compositor on the CPU: a runner has no display for a GPU context.
if hasattr(scene.render, 'compositor_device'):
    scene.render.compositor_device = 'CPU'

# Distance haze: the mist pass, in the shot's fog colour.
vl = scene.view_layers[0]; vl.use_pass_mist = True
world.mist_settings.start = 150; world.mist_settings.depth = 5000; world.mist_settings.falloff = 'QUADRATIC'
# Blender 5 compositor: a node group as the scene's compositor.
ct = bpy.data.node_groups.new('pg1-grade', 'CompositorNodeTree')
ct.interface.new_socket('Image', in_out='OUTPUT', socket_type='NodeSocketColor')
scene.compositing_node_group = ct
rl = ct.nodes.new('CompositorNodeRLayers')
mist_curve = ct.nodes.new('ShaderNodeMath'); mist_curve.operation = 'MULTIPLY'; mist_curve.inputs[1].default_value = float(arg('--mist', '0'))
ct.links.new(rl.outputs['Mist'], mist_curve.inputs[0])
mix = ct.nodes.new('ShaderNodeMix'); mix.data_type = 'RGBA'; mix.blend_type = 'MIX'
mix.inputs[7].default_value = (fc[0] * 0.6, fc[1] * 0.6, fc[2] * 0.7, 1) if night else (0.7, 0.75, 0.82, 1)
ct.links.new(mist_curve.outputs[0], mix.inputs['Factor']); ct.links.new(rl.outputs['Image'], mix.inputs[6])
glare = ct.nodes.new('CompositorNodeGlare')
glare.inputs['Type'].default_value = 'Fog Glow'; glare.inputs['Quality'].default_value = 'High'
glare.inputs['Threshold'].default_value = 1.0; glare.inputs['Strength'].default_value = 0.6
ct.links.new(mix.outputs[2], glare.inputs['Image'])
gout = ct.nodes.new('NodeGroupOutput'); ct.links.new(glare.outputs['Image'], gout.inputs[0])

shot = meta.get('shot', 'shot')
scene.render.filepath = os.path.join(OUT, f'{shot}-cycles.png')
print(f'[cycles] {shot}: {len(scene.objects)} objects, facade on {counts.get("facade", 0)}, hidden glows {counts.get("hidden", 0)}, {SAMPLES} samples on {DEVICE}, {scene.render.resolution_x}x{scene.render.resolution_y} at {SCALE}%', flush=True)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, f'{shot}.blend'), compress=True)
bpy.ops.render.render(write_still=True)
print(f'[cycles] wrote {scene.render.filepath}', flush=True)
