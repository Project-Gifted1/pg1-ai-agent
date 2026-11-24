// PG1 Sandbox viewer: post-processing, by quality tier (quality.js).
//
//   scene render -> ambient occlusion (GTAO, High and Ultra) -> subtle bloom
//   (glows, lamps, the sun; Medium and up) -> anti-aliasing (SMAA; Ultra
//   adds temporal accumulation while the camera is still) -> depth of
//   field on what the camera follows (Cinematic) -> ACES tone mapping and
//   sRGB output (OutputPass). The offline Showcase profile (quality.js
//   SHOWCASE_SETTINGS) settles TAA on every frame instead.
//
// The sky stays crisp (setSky): looking at space, or with nothing nearby
// followed, depth of field is off (nothing is out of focus at infinity),
// TAA takes one unjittered sample (its sub-pixel jitter would smear the
// stars, which are single points), and bloom is held under the stars'
// brightness (environment.js draws them at least 2 px and just below the
// bloom threshold), so stars, planets and moons stay sharp.
//
// Low draws straight to the screen with the renderer's own tone mapping.
// The add-ons are three.js r180's own (public/vendor/three/addons/, MIT).

const ADDONS = '/vendor/three/addons/postprocessing/';
// Bloom never picks up what is dimmer than this: the stars (environment.js
// STAR_PEAK is below it), so they never smear into glows.
export const STAR_BLOOM_FLOOR = 0.9;
// A glow, not a surface: sprites, and see-through things that write no depth.
const isFlat = (o) => o.isSprite || o.isPoints || (o.material && !Array.isArray(o.material) && o.material.transparent && o.material.depthWrite === false);

// settings.aa 'msaa' (PG1 City on a phone, 1.23): the scene is drawn into a
// multisampled target (4 samples; resolved on the chip of a tile-based phone
// GPU), so edges stay smooth through the passes without SMAA.
// settings.finish (PG1 City): one last pass after tone mapping
// (kingdom/kingdom-look.js finishShader): the live colour grade and
// contrast-adaptive sharpening. It reads the frame at the render resolution
// and writes the canvas at the output resolution (the renderer's own pixel
// ratio, setSize's outPr), so the sharpening happens after the upscale.
export async function createPost(THREE, renderer, scene, camera, settings) {
  if (!settings || (settings.aa === 'none' && !settings.gtao && !settings.bloom && !settings.dof && !settings.finish)) return null;
  const [{ EffectComposer }, { RenderPass }, { OutputPass }, { SMAAPass }, { UnrealBloomPass }, gtaoMod, taaMod, bokehMod] = await Promise.all([
    import(`${ADDONS}EffectComposer.js`), import(`${ADDONS}RenderPass.js`), import(`${ADDONS}OutputPass.js`), import(`${ADDONS}SMAAPass.js`), import(`${ADDONS}UnrealBloomPass.js`),
    settings.gtao ? import(`${ADDONS}GTAOPass.js`) : null,
    settings.aa === 'taa' ? import(`${ADDONS}TAARenderPass.js`) : null,
    settings.dof ? import(`${ADDONS}BokehPass.js`) : null
  ]);
  const size = renderer.getSize(new THREE.Vector2());
  // Depth of field on a phone (settings.shareDepth, no ambient occlusion or
  // temporal pass in between): the scene's own depth, kept with its colour,
  // is read by the blur, instead of the whole scene drawn a second time.
  const shareDepth = !!(settings.shareDepth && settings.dof && !settings.gtao && settings.aa !== 'taa');
  let rt = null;
  if (shareDepth) { rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType }); rt.depthTexture = new THREE.DepthTexture(1, 1); rt.depthTexture.type = THREE.UnsignedIntType; }
  else if (settings.aa === 'msaa') rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  const composer = rt ? new EffectComposer(renderer, rt) : new EffectComposer(renderer);
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
  const aoScale = settings.gtaoScale > 0 && settings.gtaoScale <= 1 ? settings.gtaoScale : 1;
  const aoSamples = settings.gtaoSamples || 12;
  if (gtaoMod) {
    // On a phone (settings.gtaoScale 0.5) it is worked out at half the
    // resolution with fewer samples, then blended over the full frame: soft
    // contact shadows at a quarter of the cost.
    gtao = new gtaoMod.GTAOPass(scene, camera, size.x * aoScale, size.y * aoScale);
    gtao.updateGtaoMaterial({ radius: 1.0, distanceExponent: 1.6, thickness: 0.8, scale: 1, samples: aoSamples, distanceFallOff: 0.6, screenSpaceRadius: false });
    gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: aoSamples });
    gtao.blendIntensity = 0.6;
    // Glow sprites and see-through shells (halos, atmospheres, nebulae, lamp
    // pools) are not surfaces: kept out of its depth and normals, or each
    // would cast a square of shadow.
    const hideFlat = gtao._overrideVisibility.bind(gtao);
    gtao._overrideVisibility = function () { hideFlat(); scene.traverse((o) => { if (o.visible && isFlat(o)) { o.visible = false; this._visibilityCache.push(o); } }); };
    composer.addPass(gtao);
  }
  let bloom = null; let bloomScale = 1;
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
    if (shareDepth) {
      bokeh.materialBokeh.defines.DEPTH_PACKING = 0; bokeh.materialBokeh.needsUpdate = true;
      bokeh.render = (r, writeBuffer, readBuffer) => {
        const u = bokeh.uniforms; u.tDepth.value = readBuffer.depthTexture; u.tColor.value = readBuffer.texture; u.nearClip.value = camera.near; u.farClip.value = camera.far;
        const oldAuto = r.autoClear; r.autoClear = false;
        r.setRenderTarget(bokeh.renderToScreen ? null : writeBuffer); if (!bokeh.renderToScreen) r.clear();
        bokeh._fsQuad.render(r); r.autoClear = oldAuto;
      };
    } else bokeh.render = (...a) => { const hidden = []; scene.traverse((o) => { if (o.visible && isFlat(o)) { o.visible = false; hidden.push(o); } }); try { bokehRender(...a); } finally { for (const o of hidden) o.visible = true; } };
    composer.addPass(bokeh);
  }
  let smaa = null;
  if (settings.aa === 'smaa' || settings.aa === 'taa') {
    smaa = new SMAAPass(size.x * renderer.getPixelRatio(), size.y * renderer.getPixelRatio());
    composer.addPass(smaa);
  }
  composer.addPass(new OutputPass());
  // Showcase only (settings.grade): the colour grade, vignette and film grain
  // after tone mapping (showcase-look.js).
  let grade = null;
  if (settings.grade) {
    const [{ ShaderPass }, look] = await Promise.all([import(`${ADDONS}ShaderPass.js`), import('./showcase-look.js')]);
    grade = new ShaderPass(look.gradeShader(settings.grade));
    grade.uniforms.uAspect.value = size.x / Math.max(1, size.y);
    composer.addPass(grade);
  }
  // PG1 City: the live grade and sharpening, last (kingdom-look.js).
  let finish = null;
  if (settings.finish) {
    const [{ ShaderPass }, look] = await Promise.all([import(`${ADDONS}ShaderPass.js`), import('../kingdom/kingdom-look.js')]);
    finish = new ShaderPass(look.finishShader());
    finish.uniforms.uGrade.value = settings.finish.grade ? 1 : 0;
    finish.userData = { sharpen: !!settings.finish.sharpen, look };
    composer.addPass(finish);
  }
  let skyView = false;
  return {
    composer, passes: { taa, gtao, bloom, bokeh, smaa, grade, finish },
    // PG1 City: the live grade's mood (kingdom-look.js LIVE_GRADES).
    setMood(mood) { if (!finish) return; const g = finish.userData.look.LIVE_GRADES[mood]; if (!g) return; const u = finish.uniforms; u.uLift.value = g.shadows.slice(); u.uGain.value = g.highlights.slice(); u.uContrast.value = g.contrast; u.uSaturation.value = g.saturation; u.uVignette.value = g.vignette; },
    setGradeOn(on) { if (finish) finish.uniforms.uGrade.value = on ? 1 : 0; },
    // Showcase: the grade's mood (GRADES) and the grain's frame.
    setGrade(mood, look) { if (!grade || !look) return; const g = look.GRADES[mood]; if (!g) return; const u = grade.uniforms; u.uLift.value = g.shadows.slice(); u.uGain.value = g.highlights.slice(); u.uContrast.value = g.contrast; u.uSaturation.value = g.saturation; u.uVignette.value = g.vignette; u.uGrain.value = g.grain; },
    setTime(t) { if (grade) grade.uniforms.uTime.value = t; },
    // TAA accumulates only while nothing moves on screen; otherwise it is plain rendering.
    // Looking at the sky, it takes one sample, unjittered: points stay points.
    // Showcase (settings.settle, offline): every frame is settled on its own,
    // 2^taaSamples jittered samples, never accumulated across frames.
    render(still) {
      if (taa && settings.settle) { taa.sampleLevel = skyView ? 0 : (settings.taaSamples || 4); taa.accumulate = false; }
      else if (taa) { taa.sampleLevel = skyView ? 0 : 2; taa.accumulate = !!still && !skyView; }
      composer.render();
    },
    // The distance in metres to keep sharp (the followed thing), eased; with
    // focus null (nothing nearby followed) depth of field is off.
    setFocus(d) {
      if (!bokeh) return;
      bokeh.enabled = d != null && !skyView;
      if (!bokeh.enabled) return;
      const u = bokeh.uniforms; u.focus.value += (Math.max(1, d) - u.focus.value) * 0.15; u.aperture.value = 0.004 / Math.max(10, d);
    },
    // In space, or looking at the night sky: the crisp-sky settings above.
    setSky(on) { skyView = !!on; if (bokeh && skyView) bokeh.enabled = false; },
    get skyView() { return skyView; },
    // Draw another scene (a world's surface) through the same passes.
    setScene(sc) { for (const p of composer.passes) if ('scene' in p) p.scene = sc; },
    // outPr: the canvas's pixel ratio (the renderer's), when the finish pass
    // upscales; the sharpening is on only when it is above pr.
    setSize(w, h, pr, outPr = pr) {
      composer.setPixelRatio(pr); composer.setSize(w, h);
      if (grade) grade.uniforms.uAspect.value = w / Math.max(1, h);
      if (gtao) gtao.setSize(Math.max(1, Math.round(w * pr * aoScale)), Math.max(1, Math.round(h * pr * aoScale)));
      if (finish) {
        const u = finish.uniforms; u.uAspect.value = w / Math.max(1, h);
        u.uTexel.value = [1 / Math.max(1, Math.round(w * pr)), 1 / Math.max(1, Math.round(h * pr))];
        u.uSharp.value = finish.userData.sharpen && outPr > pr * 1.01 ? Math.min(1, 0.35 + 0.65 * (outPr / pr - 1)) : 0;
      }
    },
    get sharpening() { return finish ? finish.uniforms.uSharp.value : 0; },
    // Night makes the windows and lamps the brightest things on screen: a little more bloom.
    // (Never down to the stars' brightness: STAR_PEAK in environment.js.)
    // Showcase: bloom on the brightest lights only (HDR above 1), weak and
    // tight, so nothing turns to a glowing blob and nothing washes out; a
    // still can lower it further (bloomScale).
    setBloomScale(k) { bloomScale = Math.max(0, Number(k) || 0); },
    setNight(n) { if (bloom) { bloom.strength = (0.22 + n * 0.35) * (skyView ? 0.5 : 1); bloom.threshold = Math.max(STAR_BLOOM_FLOOR, 0.95 - n * 0.2); if (settings.grade) { bloom.strength = (0.12 + n * 0.16) * (skyView ? 0.5 : 1) * bloomScale; bloom.threshold = 1.0; bloom.radius = 0.32; } } },
    dispose() { for (const p of composer.passes) if (p.dispose) p.dispose(); composer.dispose(); }
  };
}
