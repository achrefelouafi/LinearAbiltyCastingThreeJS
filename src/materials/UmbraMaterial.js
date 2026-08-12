import { Color, NormalBlending, ShaderMaterial, Vector3 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';

/**
 * UMBRA — the black disc, and the one thing in Eclipse that is not additive.
 *
 * ## Why this is not a `Shell`
 *
 * Eclipse's corona *is* a `Shell` in `SUNDISC` mode, and that mode already
 * draws a disc with filaments licking off its rim. What it cannot draw is the
 * middle, because a `Shell` is additive and **the darkest mark an additive
 * material can make is nothing at all**. An eclipse is not a bright thing that
 * has been dimmed; it is a hole with a ring of fire round it, and the hole has
 * to be able to take light *away* from the floor underneath it.
 *
 * So the shell paints the corona with `fill`, `granule` and `rim` at zero, and
 * this material — `NormalBlending`, black, nearly opaque — paints the umbra
 * inside it. Two draw calls, each doing the one thing its blend mode can.
 *
 * ## Why it is a ground disc rather than a billboard in the sky
 *
 * The first version hung the disc in the air, camera-facing, at the far end of
 * the cast. It reads as a sticker: the stage is a lit floor with a flat dark
 * backdrop, so a black circle in front of that backdrop is invisible, and a
 * black circle in front of the *floor* is a shape with no relationship to
 * anything the player can walk on. On the floor it is unambiguous — the umbra
 * has *landed* somewhere, the aim circle measured out where, and everything
 * inside it is gone. It is also the only reading under which the corona ring
 * and the black middle are coplanar and therefore obviously one object.
 *
 * ## What it draws
 *
 * No model matrix: the quad is placed around `uCentre` in the vertex shader
 * from `vfx/quads.js`'s unit ground quad, and `vPlane` comes out in **disc
 * radii** rather than metres, so every feature below is scale-invariant and a
 * dragged `discRadiusEnd` never changes the look of the limb, only its size.
 *
 *  - **the disc** — `uColorUmbra` at `uShade`, cut off with a soft limb;
 *  - **the limb ring** — a thin bright band exactly at `r = 1`, which is what
 *    stops the black disc reading as a hole in the render rather than as an
 *    object;
 *  - **Baily's beads** — hashed bright spots pinned to the limb.
 *
 * ### The beads are allowed to be sampled on the angle
 *
 * `vfx/Shell.js` warns at length that sampling a corona on `atan(y, x)` gives
 * every radius along a bearing the same value and draws dead-straight spokes.
 * That is exactly right for a corona, and exactly wrong to apply here: a bead
 * genuinely *is* an angular feature pinned to one radius — it is a piece of
 * sunlight coming through a valley on the limb — so the angle is the correct
 * domain and the radial Gaussian is what keeps it from becoming a spoke. Beads
 * hashed in the plane instead were tried and drift off the limb the moment the
 * disc grows, which is the wrong physics and looks like dirt on the lens.
 */

const UMBRA_VERTEX = /* glsl */ `
  uniform vec3  uCentre;
  uniform float uRadius;
  uniform float uReach;

  varying vec2 vPlane;

  void main() {
    // The shared ground quad is 1 x 1 in XZ. Measured in DISC RADII, so r = 1.0
    // is the limb wherever the radius slider puts it.
    vec2 q = vec2(position.x, position.z) * 2.0 * uReach;
    vPlane = q;

    vec3 here = uCentre + vec3(q.x, 0.0, q.y) * uRadius;
    gl_Position = projectionMatrix * viewMatrix * vec4(here, 1.0);
  }
`;

const UMBRA_FRAGMENT = /* glsl */ `
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform float uGlobalGlow;
  uniform float uShaderIntensity;

  uniform float uSeed;
  uniform float uFade;
  uniform float uEdge;
  uniform float uShade;
  uniform float uOpacity;

  uniform float uRim;
  uniform float uRimWidth;

  uniform float uBead;
  uniform float uBeadCount;
  uniform float uBeadSize;
  uniform float uBeadWidth;
  uniform float uBeadSpin;

  uniform vec3 uColorUmbra;
  uniform vec3 uColorLimb;
  uniform vec3 uColorBead;

  varying vec2 vPlane;

  ${noiseGLSL}

  void main() {
    float r = length(vPlane);

    /* --- the disc --- */
    float soft = clamp(uEdge, 0.002, 0.9);
    float body = 1.0 - smoothstep(1.0 - soft, 1.0, r);

    /* --- the limb ring, a band centred exactly on r = 1 --- */
    float band = max(uRimWidth, 1e-3);
    float ring = exp(-pow((r - 1.0) / band, 2.0));

    /* --- Baily's beads --- */
    float turn = atan(vPlane.y, vPlane.x) / TAU + 0.5 + uTime * uBeadSpin;
    float count = max(floor(uBeadCount + 0.5), 1.0);
    float cell = turn * count;
    float index = floor(cell);
    float within = cell - index;
    // Two hashes off the cell index: where in its cell the bead sits, and how
    // bright it is. Evenly spaced beads of equal brightness read as a dial.
    float place = 0.5 + (hash11(index + uSeed) - 0.5) * 0.6;
    float bright = mix(0.3, 1.0, hash11(index + 31.7 + uSeed));
    float da = abs(within - place);
    float bead = exp(-pow(da / max(uBeadSize, 1e-3), 2.0)) * bright;
    bead *= exp(-pow((r - 1.0) / max(uBeadWidth, 1e-3), 2.0));

    float lit = ring * uRim + bead * uBead;

    // uShade is how much of the picker survives: 1 keeps colorUmbra's faint
    // violet, 0 crushes the disc to absolute black. The bright marks are gained
    // by the global glow; the body deliberately is not, because a black that
    // brightens with the bloom slider is not a black.
    vec3 color = uColorUmbra * clamp(uShade, 0.0, 1.0) * body;
    float gain = uGlobalGlow * mix(0.7, 1.0, uShaderIntensity);
    color += (uColorLimb * ring * uRim + uColorBead * bead * uBead) * gain;

    // Normal blending, so alpha is coverage: the middle is opaque black and
    // genuinely removes the floor, and the bright marks sit on top of it.
    float alpha = clamp(body * uOpacity + lit * 0.85, 0.0, 1.0) * uFade;
    if (alpha < 0.003) discard;

    gl_FragColor = vec4(clamp(color, 0.0, 64.0), alpha);
  }
`;

/** One umbra. Uniforms are pushed by the ability every frame. */
export function createUmbraMaterial() {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: NormalBlending,
    toneMapped: false,
    uniforms: sharedUniforms({
      uCentre: { value: new Vector3() },
      uRadius: { value: 1 },
      uReach: { value: 1.4 },
      uSeed: { value: 0 },
      uFade: { value: 0 },

      uEdge: { value: 0.05 },
      uShade: { value: 1 },
      uOpacity: { value: 0.96 },

      uRim: { value: 1.5 },
      uRimWidth: { value: 0.09 },

      uBead: { value: 0 },
      uBeadCount: { value: 9 },
      uBeadSize: { value: 0.13 },
      uBeadWidth: { value: 0.07 },
      uBeadSpin: { value: 0.1 },

      uColorUmbra: { value: new Color(0.02, 0.015, 0.04) },
      uColorLimb: { value: new Color(0.85, 0.78, 1) },
      uColorBead: { value: new Color(1, 0.96, 0.88) }
    }),
    vertexShader: UMBRA_VERTEX,
    fragmentShader: UMBRA_FRAGMENT
  });
}
