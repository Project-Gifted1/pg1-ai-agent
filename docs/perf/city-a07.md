# PG1 City on a Galaxy A07 profile

Measured with `scripts/city-measure.mjs` (raw numbers: `city-a07-before.json`, `city-a07-after.json`; screenshots: `docs/screenshots/city-a07/before|after`).

**Profile:** 360 × 800 CSS px at device pixel ratio 2 (a 720 × 1600 screen), touch, `navigator.deviceMemory` 4, Android Chrome user agent, `?debug=1`, Dublin night (23:30) or day (12:30), rain or clear from the fixture feed. Each tier chosen by hand.

**What the numbers mean:** draw calls and triangles are exact (the same on any GPU). The milliseconds come from SwiftShader, which draws 3D on the CPU: there, cost grows with pixels, so a tier that draws more pixels looks slower. On the real A07 you measured that halving the pixels did not raise the frame rate, so these milliseconds are not A07 frame times. Single-effect milliseconds were too noisy to report (about ±150 ms on ~600 ms frames).

## Tiers, before → after
| Condition | Tier | Draw calls (before → after) | Triangles | Render scale | Drawn pixels (of a 2x screen) | ms/frame in SwiftShader |
|---|---|---|---|---|---|---|
| night, rain | Low | 135 → **133** | 155k → **129k** | 1 → 1 | 0.50 → 0.50 | 63 → 59 |
| night, rain | Medium | 229 → **142** | 300k → **210k** | 1 → 1 | 0.63 → 0.80 | 110 → 242 |
| night, rain | High | 588 → **589** | 1940k → **1941k** | 1 → 1 | 0.75 → 0.80 | 648 → 747 |
| night, rain | Cinematic | 360 → **282** | 820k → **621k** | 0.5 → 1 | 0.38 → 0.80 | 272 → 647 |
| night, clear | Low | 130 → **128** | 144k → **123k** | 1 → 1 | 0.50 → 0.50 | 63 → 59 |
| night, clear | Medium | 224 → **135** | 287k → **202k** | 1 → 1 | 0.63 → 0.80 | 112 → 206 |
| night, clear | High | 582 → **581** | 1860k → **1861k** | 1 → 1 | 0.75 → 0.80 | 666 → 681 |
| night, clear | Cinematic | 355 → **275** | 793k → **593k** | 0.5 → 1 | 0.38 → 0.80 | 253 → 592 |
| day, clear | Low | 127 → **126** | 144k → **128k** | 1 → 1 | 0.50 → 0.50 | 54 → 61 |
| day, clear | Medium | 221 → **132** | 287k → **201k** | 1 → 1 | 0.63 → 0.80 | 107 → 162 |
| day, clear | High | 578 → **577** | 1860k → **1860k** | 1 → 1 | 0.75 → 0.80 | 630 → 664 |
| day, clear | Cinematic | 351 → **272** | 793k → **593k** | 0.5 → 1 | 0.38 → 0.80 | 280 → 527 |


## Each effect on its own

| Effect switched off (Cinematic, night, rain) | Draw calls saved | Triangles saved |
|---|---|---|
| Ambient occlusion (already off on a 4 GB phone) | 0 | -0.1k |
| Shadows | 1 | 106.8k |
| Bloom | 13 | 0k |
| Water shader | 0 | -0.1k |
| Fog | 0 | -0.1k |
| Crowds | 23 | 14.6k |
| Full drones (vs the lean ones) | 44 | 9.6k |
| Colour grade | 0 | -0.1k |
| Sharpen | 0 | -0.1k |
| Night HDRI | 0 | -0.1k |
| Wet streets | 2 | 0.7k |
| Facade detail | 0 | -0.1k |

Effects that save no draw calls or triangles cost only per-pixel work (the grade and sharpen pass, the HDRI lookup, fog, the facade normal map). They need timing on the device itself: open the City with `?debug=1&fx=-grade` (or `-sharpen`, `-hdri`, `-wet`, `-facade`, `-gtao`, `-shadows`, `-bloom`, `-water`, `-fog`, `-crowds`, `-drones`) and compare the overlay's fps.
