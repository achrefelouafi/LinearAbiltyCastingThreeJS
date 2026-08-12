import { MeshStandardMaterial, Color, DoubleSide } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { patchGrowthMaterial } from '../vfx/GrowthField.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * Brine ice — the frozen splash of `BrinelockAbility`.
 *
 * This is the *third* ice material in the project and it exists because the
 * other two are both wrong for a splash that has stopped.
 * `materials/IceMaterial.js` shades a crystal: a grown solid, opaque toward its
 * axis, with facets. `materials/SheetIceMaterial.js` shades a plate: thin,
 * clearest face-on, deepest at a grazing angle. A frozen splash finger is
 * neither. It is a **thin column of water caught mid-flight**, which means:
 *
 *  - **it is clearest at the tip and cloudy at the foot.** Water that is still
 *    attached to the pool when it freezes is full of entrained air and traps a
 *    skin of foam; the bead that had already torn free is glass. That gradient
 *    runs base-to-tip, so it is keyed off `vGrowLocal.y` — the one thing that
 *    genuinely belongs in local space, because it must follow each finger's own
 *    axis however the instance is scaled and leaned.
 *  - **the light goes *down* it.** A narrow clear column piped end-on is bright
 *    along its own axis and dull across it, which is the opposite of the plate
 *    and the same sign as the crystal — but the falloff is much sharper,
 *    because the column is two centimetres wide and half a metre long.
 *  - **it fractured while it froze.** Water expands about nine per cent when it
 *    goes to ice, and a finger frozen from the outside in splits along its
 *    length. The seams are the zero crossing of a signed fbm evaluated in
 *    **world** space and squashed along +Y, so a whole crown of fingers looks
 *    cracked out of one body of brine rather than each carrying its own
 *    private pattern. A first version sampled the seam field in local space and
 *    every finger in the lane wore the identical stripe down its front — the
 *    unmistakable tell of an instanced field, and visible from across the
 *    stage.
 *
 * **The freeze flash is `aBirth` read forwards, not backwards.** `GrowthField`
 * publishes one per-instance stopwatch, a birth term running 1 → 0 over
 * `birthFade` seconds from the moment that instance was triggered.
 * `SheetIceMaterial` reads it backwards, as "how long since this plate locked",
 * because a plate spends a second curling. This ability wants the opposite: the
 * glaze front sweeps the lane in a couple of tenths and each finger needs a
 * hard white crack of light **as it locks**, then nothing. So it is used
 * directly, raised to `uFlashPower`, and the sweeping front is drawn by the
 * stagger rather than by anything in here.
 *
 * ## The one number that is not resolved per frame
 *
 * None. Every metre, radian and second is a uniform rewritten from
 * `settings.brinelock` by `userData.sync()` on every frame, zero-length ones
 * included — and the uniforms are parked on `material.userData.uniforms`,
 * because that is the second place the harness's pause probe looks and the only
 * place a patched `MeshStandardMaterial` has to put them (**I8**).
 */
export function createBrineIceMaterial(environment) {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.08,
    metalness: 0.0,
    // Flat shading, as the crystals use: the finger is a low-facet lathe and
    // the facets are the read. A smoothed normal turns it into a wax candle.
    flatShading: true,
    transparent: true,
    // A frozen splash is hollow-looking from every angle and you see the far
    // wall of every finger through the near one.
    side: DoubleSide,
    depthWrite: true
  });

  const uniforms = {
    uTime: frame.uTime,

    /* --- the body --- */
    uColorIce: { value: new Color() }, //    the clear glass
    uColorAerated: { value: new Color() }, //the milky foot
    uColorSeam: { value: new Color() }, //   the expansion cracks
    uColorFlash: { value: new Color() }, //  the crack of light as it locks
    uAerate: { value: 0.75 }, //             0..1 how milky the foot gets
    uAeratePower: { value: 2.1 }, //         how fast that clears going up
    uDepthTint: { value: 0.9 }, //           how much the body deepens across the axis
    uPipe: { value: 1.6 }, //                brightness looking down the finger's axis
    uPipePower: { value: 3.4 }, //           how sharply that falls off
    uTranslucency: { value: 0.85 }, //       how much light comes through it

    /* --- the fracture --- */
    uSeamScale: { value: 3.2 }, //           cycles per metre across the crack field
    uSeamStretch: { value: 3.6 }, //         how many times longer a seam is vertically
    uSeamWidth: { value: 0.16 }, //          0..1 of the field — the seam's width
    uSeamGlow: { value: 1.5 },

    /* --- the surface --- */
    uFresnel: { value: 1.5 },
    uFresnelPower: { value: 2.6 },
    uGlint: { value: 1.1 },
    uGlintScale: { value: 22 }, //           cycles per metre of the pinpoints
    uGlintSpeed: { value: 0.35 }, //         metres/second they crawl at
    uGlow: { value: 1.2 },
    uFlashGlow: { value: 3.4 },
    uFlashPower: { value: 2.2 }
  };

  patchGrowthMaterial(material, {
    environment,
    uniforms,
    common: /* glsl */ `
      uniform float uTime;
      uniform vec3  uColorIce;
      uniform vec3  uColorAerated;
      uniform vec3  uColorSeam;
      uniform vec3  uColorFlash;
      uniform float uAerate;
      uniform float uAeratePower;
      uniform float uDepthTint;
      uniform float uPipe;
      uniform float uPipePower;
      uniform float uTranslucency;
      uniform float uSeamScale;
      uniform float uSeamStretch;
      uniform float uSeamWidth;
      uniform float uSeamGlow;
      uniform float uFresnel;
      uniform float uFresnelPower;
      uniform float uGlint;
      uniform float uGlintScale;
      uniform float uGlintSpeed;
      uniform float uGlow;
      uniform float uFlashGlow;
      uniform float uFlashPower;
      ${noiseGLSL}
    `,
    fragment: /* glsl */ `
      vec3  N   = normalize(normal);
      vec3  V   = normalize(vViewPosition);
      float ndv = clamp(dot(N, V), 0.0, 1.0);

      // Down the barrel. A clear column two centimetres across is bright where
      // the view ray runs along it and almost invisible across it, and the
      // exponent is high because the column is thin: at uPipePower near 1 the
      // whole finger lights up and it reads as a plastic tube.
      float pipe = pow(ndv, uPipePower) * uPipe;
      float fres = pow(1.0 - ndv, uFresnelPower) * uFresnel;

      // Base to tip. Entrained air at the foot, glass at the bead.
      float clear = pow(clamp(vGrowLocal.y, 0.0, 1.0), uAeratePower);
      float milk  = (1.0 - clear) * uAerate;

      // The expansion seams, in WORLD space and squashed vertically, so the
      // whole lane looks cracked out of one body of brine. Local space put the
      // same stripe down the front of every finger — see the module header.
      vec3 q = vec3(vGrowWorld.x * uSeamScale,
                    vGrowWorld.y * uSeamScale / max(uSeamStretch, 0.05),
                    vGrowWorld.z * uSeamScale);
      float field = fbm3(q + vGrowSeed * 0.31);
      float seam = 1.0 - smoothstep(0.0, max(uSeamWidth, 1e-3), abs(field));
      // Seams that reach the milky foot are already opaque there, so they only
      // read in the clear part of the body.
      seam *= clear;

      // Pinpoints, crawling slowly in world space so a standing crown twinkles
      // without anything about it actually moving.
      float glint = snoise(vGrowWorld * uGlintScale
                           + vec3(0.0, uTime * uGlintSpeed, 0.0) + vGrowSeed * 13.0);
      glint = pow(clamp(glint, 0.0, 1.0), 12.0);

      vec3 body = mix(uColorIce, uColorAerated, clamp(milk, 0.0, 1.0));
      body = mix(body, uColorSeam, clamp(seam * 0.55, 0.0, 1.0));

      vec3 glow = uColorIce * pipe * uTranslucency;
      glow += uColorSeam * seam * uSeamGlow;
      glow += uColorIce * fres * 0.4;
      glow += uColorSeam * glint * uGlint;
      // The lock. aBirth is 1 on the frame this finger was triggered and gone a
      // fraction of a second later, so this is the crack of light running down
      // the lane with the glaze front.
      glow += uColorFlash * pow(clamp(vGrowBirth, 0.0, 1.0), uFlashPower) * uFlashGlow;
      glow *= uGlow;

      // The same Reinhard ceiling the other two ice materials carry. Every term
      // above peaks somewhere on the silhouette and without it a crown of forty
      // fingers sums past white and the bloom pass smears the whole lane.
      glow /= 1.0 + glow * 0.22;

      diffuseColor.rgb *= body;
      totalEmissiveRadiance += glow;

      // Clear glass hides nothing face-on; the milky foot and the seams are the
      // only parts with any opacity of their own.
      float solid = clamp(milk + seam * 0.5 + pow(1.0 - ndv, 1.6) * uDepthTint, 0.0, 1.0);
      diffuseColor.a = clamp(diffuseColor.a * (0.22 + 0.78 * solid), 0.0, 1.0);
    `
  });

  material.userData.uniforms = uniforms;

  /** Pull the palette and every shading control from the live settings. */
  material.userData.sync = () => {
    const c = settings.brinelock;
    const g = settings.global;

    uniforms.uColorIce.value.copy(getColor(c.colorIce));
    uniforms.uColorAerated.value.copy(getColor(c.colorAerated));
    uniforms.uColorSeam.value.copy(getColor(c.colorSeam));
    uniforms.uColorFlash.value.copy(getColor(c.colorIceFlash));

    uniforms.uAerate.value = c.aerate;
    uniforms.uAeratePower.value = Math.max(0.05, c.aeratePower);
    uniforms.uDepthTint.value = c.iceDepthTint;
    uniforms.uPipe.value = c.icePipe;
    uniforms.uPipePower.value = Math.max(0.2, c.icePipePower);
    uniforms.uTranslucency.value = c.iceTranslucency;

    uniforms.uSeamScale.value = c.seamScale * g.noiseFrequency;
    uniforms.uSeamStretch.value = c.seamStretch;
    uniforms.uSeamWidth.value = c.seamWidth;
    uniforms.uSeamGlow.value = c.seamGlow * g.shaderIntensity;

    uniforms.uFresnel.value = c.iceFresnel * g.fresnel;
    uniforms.uFresnelPower.value = c.iceFresnelPower;
    uniforms.uGlint.value = c.iceGlint * g.shaderIntensity;
    uniforms.uGlintScale.value = c.iceGlintScale;
    uniforms.uGlintSpeed.value = c.iceGlintSpeed * g.noiseSpeed;
    uniforms.uGlow.value = c.iceGlow * g.glow;
    uniforms.uFlashGlow.value = c.lockGlow;
    uniforms.uFlashPower.value = Math.max(0.5, c.lockGlowPower);

    material.opacity = c.iceOpacity * g.opacity;
    material.roughness = c.iceRoughness;
    material.envMapIntensity = c.iceEnvIntensity;
  };

  material.userData.sync();
  return material;
}
