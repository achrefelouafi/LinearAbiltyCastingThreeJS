/**
 * Applies the screen-space refraction buffer written by `LAYER.DISTORTION`.
 *
 * The buffer is a half-resolution HalfFloat target cleared to `(0.5, 0.5, 0, 0)`
 * — "no offset, no coverage" — and every visible mesh on the distortion layer is
 * drawn into it with normal blending before the composer runs. See
 * `vfx/Distortion.js` for the emitters and `core/Layers.js` for the counter that
 * lets this whole pass be skipped when nothing is writing.
 *
 * ```
 *   R,G  unit screen-space direction, encoded as d * 0.5 + 0.5
 *   B    magnitude, in screen widths at uScale = 1
 *   A    coverage — the blend weight between overlapping emitters
 * ```
 *
 * ## Why the decode does not multiply by alpha
 *
 * It used to. The buffer is normal-blended, which means an emitter covering a
 * fragment at coverage `a` writes `rg = 0.5 + dir·a·0.5` and `b = mag·a`. Both
 * channels therefore already carry the coverage, and multiplying by `a` a third
 * time made every emitter's soft edge fall off as `a³` — a heat plume that was
 * authored to feather over 20% of its width feathered over most of it, and the
 * effect read as weaker than its slider said it was. Dropping the term leaves
 * `a²`, which is still one more than is strictly correct and is exactly the
 * price of expressing "who wins where two distorters overlap" in a single blend
 * mode. Alpha is kept as the early-out.
 *
 * `uScale` is `settings.post.distortion × settings.global.distortion`, applied
 * here and only here. Emitters never fold the global gains into their own
 * strength — one place to apply them means a writer that forgets still obeys the
 * master sliders, and no writer can apply them twice.
 */
export const DistortionShader = {
  name: 'DistortionShader',

  uniforms: {
    tDiffuse: { value: null },
    tDistortion: { value: null },
    uScale: { value: 0.045 }
  },

  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tDistortion;
    uniform float uScale;
    varying vec2 vUv;

    void main() {
      vec4 d = texture2D(tDistortion, vUv);

      // The overwhelming majority of the frame is untouched buffer. Bailing out
      // here costs one compare and saves the second texture fetch's dependent
      // address computation on the tiles that need nothing.
      if (d.a < 0.002 || d.b < 0.0005) {
        gl_FragColor = texture2D(tDiffuse, vUv);
        return;
      }

      vec2 offset = (d.rg - 0.5) * 2.0 * d.b * uScale;

      // Fade the offset out against the frame border rather than clamping into
      // it. A clamp smears the edge row of pixels across whatever asked for a
      // sample from outside, which reads as a streak pinned to the screen edge —
      // and a screen-pinned artefact is the one thing that gives a
      // world-anchored effect away.
      vec2 border = min(vUv, 1.0 - vUv);
      float inset = smoothstep(0.0, 0.03, min(border.x, border.y));
      offset *= inset;

      vec2 uv = clamp(vUv + offset, vec2(0.0), vec2(1.0));
      gl_FragColor = texture2D(tDiffuse, uv);
    }
  `
};
