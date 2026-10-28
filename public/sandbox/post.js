// PG1 Sandbox viewer: post-processing, by quality tier (quality.js).
//
//   scene render -> ambient occlusion (GTAO, High and Ultra) -> subtle bloom
//   (glows, lamps, the sun; Medium and up) -> anti-aliasing (SMAA; Ultra
//   adds temporal accumulation while the camera is still) -> depth of
//   field on what the camera looks at (Cinematic) -> ACES tone mapping and
//   sRGB output (OutputPass).
//
// Low draws straight to the screen with the renderer's own tone mapping.
// The add-ons are three.js r180's own (public/vendor/three/addons/, MIT).

const ADDONS = '/vendor/three/addons/postprocessing/';
// A glow, not a surface: sprites, and see-through things that write no depth.
const isFlat = (o) => o.isSprite || o.isPoints || (o.material && !Array.isArray(o.material) && o.material.transparent && o.material.depthWrite === false);

const isFlat = (o) => o.isSprite || o.isPoints || (o.material && !Array.isArray(o.material) && o.material.transparent && o.material.depthWrite === false);

export async function createPost(THREE, renderer, scene, camera, settings) {
  if (!settings || (settings.aa === 'none' && !settings.gtao && !settings.bloom && !settings.dof)) return null;
  const [{ EffectComposer }, { RenderPass }, { OutputPass }, { SMAAPass }, { UnrealBloomPass }, gtaoMod, taaMod, bokehMod] = await Promise.all([
    import(`${ADDONS}EffectComposer.js`), import(`${ADDONS}RenderPass.js`), import(`${ADDONS}OutputPass.js`), import(`${ADDONS}SMAAPass.js`), import(`${ADDONS}UnrealBloomPass.js`),
    settings.gtao ? import(`${ADDONS}GTAOPass.js`) : null,
    settings.aa === 'taa' ? import(`${ADDONS}TAARenderPass.js`) : null,
    settings.dof ? import(`${ADDONS}BokehPass.js`) : null
  ]);
  const size = renderer.getSize(new THREE.Vector2());
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(size.x, size.y);
  let taa = null;
  if (taaMod) {
    taa = new taaMod.TAARenderPass(scene, camera, 0x000000, 0);
    taa.sampleLevel = 2;
    taa.unbiased = false;
    composer.addPass(taa);
  } else {
    composer.addPass(new RenderPass(scene, camera));
  }
  let gtao = null;
  if (gtaoMod) {
    gtao = new gtaoMod.GTAOPass(scene, camera, size.x, size.y);
    gtao.updateGtaoMaterial({ radius: 1.0, distanceExponent: 1.6, thickness: 0.8, scale: 1, samples: 12, distanceFallOff: 0.6, screenSpaceRadius: false });
    gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
    gtao.blendIntensity = 0.6;
    // Glow sprites and see-through shells (halos, atmospheres, nebulae, lamp
    // pools) are not surfaces: kept out of its depth and normals, or each
    // would cast a square of shadow.
    const hideFlat = gtao._overrideVisibility.bind(gtao);
    gtao._overrideVisibility = function () { hideFlat(); scene.traverse((o) => { if (o.visible && isFlat(o)) { o.visible = false; this._visibilityCache.push(o); } }); };
    composer.addPass(gtao);
  }
  let bloom = null;
  if (settings.bloom) {
    bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.28, 0.45, 0.92);
    composer.addPass(bloom);
  }
  // Depth of field: sharp where the camera looks, soft before and beyond.
  let bokeh = null;
  if (bokehMod) {
    bokeh = new bokehMod.BokehPass(scene, camera, { focus: 300, aperture: 0.00012, maxblur: 0.008 });
    // Its depth render leaves out the same glows (they are not where things are).
    const bokehRender = bokeh.render.bind(bokeh);
    bokeh.render = (...a) => { const hidden = []; scene.traverse((o) => { if (o.visible && isFlat(o)) { o.visible = false; hidden.push(o); } }); try { bokehRender(...a); } finally { for (const o of hidden) o.visible = true; } };
    composer.addPass(bokeh);
  }
  let smaa = null;
  if (settings.aa === 'smaa' || settings.aa === 'taa') {
    smaa = new SMAAPass(size.x * renderer.getPixelRatio(), size.y * renderer.getPixelRatio());
    composer.addPass(smaa);
  }
  composer.addPass(new OutputPass());
  return {
    composer, passes: { taa, gtao, bloom, bokeh, smaa },
    // TAA accumulates only while nothing moves on screen; otherwise it is plain rendering.
    render(still) { if (taa) { taa.accumulate = !!still; } composer.render(); },
    // The distance in metres to keep sharp (the camera's target), eased.
    setFocus(d) { if (bokeh) { const u = bokeh.uniforms; u.focus.value += (Math.max(1, d) - u.focus.value) * 0.15; u.aperture.value = 0.004 / Math.max(10, d); } },
    // Draw another scene (a world's surface) through the same passes.
    setScene(sc) { for (const p of composer.passes) if ('scene' in p) p.scene = sc; },
    setSize(w, h, pr) { composer.setPixelRatio(pr); composer.setSize(w, h); if (gtao) gtao.setSize(w * pr, h * pr); },
    // Night makes the windows and lamps the brightest things on screen: a little more bloom.
    setNight(n) { if (bloom) { bloom.strength = 0.22 + n * 0.35; bloom.threshold = 0.95 - n * 0.2; } },
    dispose() { for (const p of composer.passes) if (p.dispose) p.dispose(); composer.dispose(); }
  };
}
