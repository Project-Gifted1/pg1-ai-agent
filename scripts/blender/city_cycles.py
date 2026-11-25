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
cams[0].data.clip_end = 20000
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
def facade_material():
    m = bpy.data.materials.new('pg1-facade'); m.use_nodes = True
    nt = m.node_tree; nt.nodes.clear()
    out = node(nt, 'ShaderNodeOutputMaterial', 1600, 0)
    geo = node(nt, 'ShaderNodeNewGeometry', -1400, 0)
    attr = node(nt, 'ShaderNodeVertexColor', -1400, -400); attr.layer_name = 'Color'
    sep_c = node(nt, 'ShaderNodeSeparateColor', -1200, -400)
    link(nt, attr.outputs['Color'], sep_c.inputs['Color'])
    sep_p = node(nt, 'ShaderNodeSeparateXYZ', -1200, 200); link(nt, geo.outputs['Position'], sep_p.inputs['Vector'])
    sep_n = node(nt, 'ShaderNodeSeparateXYZ', -1200, 0); link(nt, geo.outputs['Normal'], sep_n.inputs['Vector'])
    # Horizontal coordinate along the wall: y on walls facing x, x on walls facing y.
    ax = node(nt, 'ShaderNodeMath', -1000, 0, operation='ABSOLUTE'); link(nt, sep_n.outputs['X'], ax.inputs[0])
    ay = node(nt, 'ShaderNodeMath', -1000, -100, operation='ABSOLUTE'); link(nt, sep_n.outputs['Y'], ay.inputs[0])
    facing_x = node(nt, 'ShaderNodeMath', -850, -50, operation='GREATER_THAN'); link(nt, ax.outputs[0], facing_x.inputs[0]); link(nt, ay.outputs[0], facing_x.inputs[1])
    u = node(nt, 'ShaderNodeMix', -700, 150); u.data_type = 'FLOAT'
    link(nt, facing_x.outputs[0], u.inputs['Factor']); link(nt, sep_p.outputs['X'], u.inputs['A']); link(nt, sep_p.outputs['Y'], u.inputs['B'])
    wall = node(nt, 'ShaderNodeMath', -850, -250, operation='LESS_THAN'); az = node(nt, 'ShaderNodeMath', -1000, -250, operation='ABSOLUTE')
    link(nt, sep_n.outputs['Z'], az.inputs[0]); link(nt, az.outputs[0], wall.inputs[0]); wall.inputs[1].default_value = 0.5
    # Cells: 3.2 m wide, 3.6 m storeys.
    cu = node(nt, 'ShaderNodeMath', -550, 200, operation='DIVIDE'); link(nt, u.outputs['Result'], cu.inputs[0]); cu.inputs[1].default_value = 3.2
    cv = node(nt, 'ShaderNodeMath', -550, 50, operation='DIVIDE'); link(nt, sep_p.outputs['Z'], cv.inputs[0]); cv.inputs[1].default_value = 3.6
    fu = node(nt, 'ShaderNodeMath', -400, 250, operation='FRACT'); link(nt, cu.outputs[0], fu.inputs[0])
    fv = node(nt, 'ShaderNodeMath', -400, 100, operation='FRACT'); link(nt, cv.outputs[0], fv.inputs[0])
    flu = node(nt, 'ShaderNodeMath', -400, 400, operation='FLOOR'); link(nt, cu.outputs[0], flu.inputs[0])
    flv = node(nt, 'ShaderNodeMath', -400, -50, operation='FLOOR'); link(nt, cv.outputs[0], flv.inputs[0])
    def band(src, lo, hi, x, y):
        a = node(nt, 'ShaderNodeMath', x, y, operation='GREATER_THAN'); link(nt, src, a.inputs[0]); a.inputs[1].default_value = lo
        b = node(nt, 'ShaderNodeMath', x, y - 80, operation='LESS_THAN'); link(nt, src, b.inputs[0]); b.inputs[1].default_value = hi
        c = node(nt, 'ShaderNodeMath', x + 150, y - 40, operation='MULTIPLY'); link(nt, a.outputs[0], c.inputs[0]); link(nt, b.outputs[0], c.inputs[1])
        return c.outputs[0]
    wu = band(fu.outputs[0], 0.18, 0.82, -250, 300)
    wv = band(fv.outputs[0], 0.3, 0.78, -250, 100)
    win = node(nt, 'ShaderNodeMath', -50, 200, operation='MULTIPLY'); link(nt, wu, win.inputs[0]); link(nt, wv, win.inputs[1])
    win2 = node(nt, 'ShaderNodeMath', 100, 200, operation='MULTIPLY'); link(nt, win.outputs[0], win2.inputs[0]); link(nt, wall.outputs[0], win2.inputs[1])
    # Per window random: (cell u, cell v, seed) through white noise.
    cell = node(nt, 'ShaderNodeCombineXYZ', -250, -150); link(nt, flu.outputs[0], cell.inputs['X']); link(nt, flv.outputs[0], cell.inputs['Y'])
    sd = node(nt, 'ShaderNodeMath', -400, -200, operation='MULTIPLY'); link(nt, sep_c.outputs['Red'], sd.inputs[0]); sd.inputs[1].default_value = 997
    link(nt, sd.outputs[0], cell.inputs['Z'])
    wn = node(nt, 'ShaderNodeTexWhiteNoise', -100, -150); wn.noise_dimensions = '3D'; link(nt, cell.outputs['Vector'], wn.inputs['Vector'])
    lit = node(nt, 'ShaderNodeMath', 50, -100, operation='GREATER_THAN'); link(nt, wn.outputs['Value'], lit.inputs[0]); lit.inputs[1].default_value = 0.68 if night else 0.995
    litw = node(nt, 'ShaderNodeMath', 250, 0, operation='MULTIPLY'); link(nt, lit.outputs[0], litw.inputs[0]); link(nt, win2.outputs[0], litw.inputs[1])
    # Warm to cool office light, per window.
    ramp_l = node(nt, 'ShaderNodeValToRGB', 250, -250); link(nt, wn.outputs['Color'], ramp_l.inputs['Fac'])
    el = ramp_l.color_ramp.elements; el[0].color = (1.0, 0.62, 0.32, 1); el[1].color = (1.0, 0.88, 0.7, 1); el.new(0.8).color = (0.75, 0.86, 1.0, 1)
    # Wall colour by style (g = style / 8): glass, stone, brick, metal, georgian, podium.
    ramp_s = node(nt, 'ShaderNodeValToRGB', -100, -500); ramp_s.color_ramp.interpolation = 'CONSTANT'; link(nt, sep_c.outputs['Green'], ramp_s.inputs['Fac'])
    cols = [(0.05, 0.07, 0.10), (0.42, 0.38, 0.32), (0.32, 0.14, 0.09), (0.18, 0.19, 0.21), (0.30, 0.12, 0.08), (0.12, 0.12, 0.13)]
    es = ramp_s.color_ramp.elements
    es[0].position = 0.0; es[0].color = (*cols[0], 1)
    es[1].position = 0.5 / 8; es[1].color = (*cols[1], 1)
    for i, c in enumerate(cols[2:], start=2):
        es.new((i - 0.5) / 8).color = (*c, 1)
    glassy = node(nt, 'ShaderNodeMath', -100, -700, operation='LESS_THAN'); link(nt, sep_c.outputs['Green'], glassy.inputs[0]); glassy.inputs[1].default_value = 0.5 / 8
    rough = node(nt, 'ShaderNodeMix', 100, -650); rough.data_type = 'FLOAT'; link(nt, glassy.outputs[0], rough.inputs['Factor']); rough.inputs['A'].default_value = 0.7; rough.inputs['B'].default_value = 0.12
    # Windows (lit or not) are glass: dark and sharp; walls by style.
    bsdf = node(nt, 'ShaderNodeBsdfPrincipled', 1100, 0)
    basec = node(nt, 'ShaderNodeMix', 700, -300); basec.data_type = 'RGBA'
    link(nt, win2.outputs[0], basec.inputs['Factor']); link(nt, ramp_s.outputs['Color'], basec.inputs[6]); basec.inputs[7].default_value = (0.02, 0.025, 0.035, 1)
    link(nt, basec.outputs[2], bsdf.inputs['Base Color'])
    rgh = node(nt, 'ShaderNodeMix', 700, -500); rgh.data_type = 'FLOAT'; link(nt, win2.outputs[0], rgh.inputs['Factor']); link(nt, rough.outputs['Result'], rgh.inputs['A']); rgh.inputs['B'].default_value = 0.04
    link(nt, rgh.outputs['Result'], bsdf.inputs['Roughness'])
    met = node(nt, 'ShaderNodeMix', 700, -650); met.data_type = 'FLOAT'; link(nt, glassy.outputs[0], met.inputs['Factor']); met.inputs['A'].default_value = 0.0; met.inputs['B'].default_value = 0.35
    link(nt, met.outputs['Result'], bsdf.inputs['Metallic'])
    link(nt, ramp_l.outputs['Color'], bsdf.inputs['Emission Color'])
    # Brightness varies per window (blinds, lamps): 0.3 to 1 of the full strength.
    var = node(nt, 'ShaderNodeMapRange', 300, 250); link(nt, wn.outputs['Color'], var.inputs['Value']); var.inputs['To Min'].default_value = 0.3
    lv = node(nt, 'ShaderNodeMath', 400, 150, operation='MULTIPLY'); link(nt, litw.outputs[0], lv.inputs[0]); link(nt, var.outputs['Result'], lv.inputs[1])
    strength = node(nt, 'ShaderNodeMath', 550, 100, operation='MULTIPLY'); link(nt, lv.outputs[0], strength.inputs[0]); strength.inputs[1].default_value = 2.2 if night else 0.0
    link(nt, strength.outputs[0], bsdf.inputs['Emission Strength'])
    link(nt, bsdf.outputs['BSDF'], out.inputs['Surface'])
    return m

def simple(name, color, rough, metal=0.0, spec=0.5):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value = (*color, 1); b.inputs['Roughness'].default_value = rough; b.inputs['Metallic'].default_value = metal
    return m

FACADE = facade_material()
ASPHALT = simple('pg1-wet-asphalt', (0.025, 0.025, 0.028), 0.18 if rain else 0.45)
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
    elif base in ('lamp-pools', 'street-light-pools', 'boat-light-pools', 'wet-road-glare', 'wet-road-tail-glare', 'road-spray', 'boat-wakes', 'crowd'):
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
wn.links.new(grad.outputs['Fac'], ramp.inputs['Fac']); wn.links.new(ramp.outputs['Color'], bg.inputs['Color']); wn.links.new(bg.outputs['Background'], wo.inputs['Surface'])
# Haze as a real volume, 2 km deep over the city: lamps glow through it, the
# distance fades into it and the city's light lifts it (a sodium glow at night);
# above it the sky shows through.
HAZE = float(arg('--haze', '0.0004'))
if HAZE > 0:
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 1000))
    hz = bpy.context.active_object; hz.name = 'pg1-haze'; hz.scale = (30000, 30000, 2000)
    hm = bpy.data.materials.new('pg1-haze-volume'); hm.use_nodes = True
    hn = hm.node_tree; hn.nodes.clear()
    pv = hn.nodes.new('ShaderNodeVolumePrincipled'); ho = hn.nodes.new('ShaderNodeOutputMaterial')
    pv.inputs['Density'].default_value = HAZE; pv.inputs['Anisotropy'].default_value = 0.4
    pv.inputs['Color'].default_value = (0.8, 0.84, 0.95, 1) if night else (0.92, 0.94, 0.97, 1)
    if night:
        pv.inputs['Emission Color'].default_value = (0.9, 0.6, 0.4, 1); pv.inputs['Emission Strength'].default_value = HAZE * 0.012
    hn.links.new(pv.outputs['Volume'], ho.inputs['Volume'])
    hz.data.materials.append(hm)
sun = bpy.data.lights.new('pg1-moon' if night else 'pg1-sun', 'SUN')
sun.energy = 0.08 if night else 3.5; sun.color = (0.7, 0.8, 1.0) if night else (1.0, 0.95, 0.88); sun.angle = math.radians(0.6)
so = bpy.data.objects.new(sun.name, sun); scene.collection.objects.link(so)
d = (meta.get('lights') or [{}])[0].get('dir') if meta.get('lights') else None
if d:
    # three.js y-up to Blender z-up: (x, y, z) -> (x, -z, y); the sun points along -dir.
    v = (d[0], -d[2], d[1])
    so.rotation_euler = (math.acos(max(-1, min(1, v[2]))), 0, math.atan2(v[0], -v[1]))
else:
    so.rotation_euler = (math.radians(55), 0, math.radians(30))

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
