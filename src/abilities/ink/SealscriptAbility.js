import { Vector3 } from 'three';
import { Ability } from '../Ability.js';
import { BrushStroke, BrushTip, brushStrokeParams } from '../../vfx/BrushStroke.js';
import { InkDiffusion, InkMode, inkDiffusionParams } from '../../vfx/InkDiffusion.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, Easing, hash11 } from '../../utils/math.js';

/* ====================================================================== */
/*  The alphabet — authored once, in em space, with no units in it         */
/* ====================================================================== */

/**
 * Ten seal-script skeletons.
 *
 * A character is an array of strokes; a stroke is nine numbers —
 * `[x0,y0, x1,y1, x2,y2, x3,y3, weight]` — where the eight coordinates are the
 * control points of a cubic in an **em box** running −0.5..0.5 on both axes,
 * and `weight` is a unitless multiplier on the pressure curve. Not one of these
 * numbers is a metre. `emSize` turns them into metres, every frame, which is
 * why dragging it while paused re-sizes the writing rather than scaling a
 * finished object.
 *
 * They are cubics rather than polylines because seal script (篆書) is defined by
 * its turns: the corners of 日 are not corners, they are quarter-circles, and
 * a polyline corner immediately reads as a stencil font. Every "straight"
 * vertical here is very slightly bowed outward for the same reason — a truly
 * straight stroke is the tell that a machine drew it.
 *
 * The forms are real characters (日 月 山 川 王 中 木 水 石 田) rather than
 * invented marks. Inventing them was the first attempt and it does not work:
 * made-up glyphs come out with even spacing and a consistent number of strokes,
 * because that is what a person generating them reaches for, and the column
 * then reads as ornament. Real characters have three strokes next to six, and
 * that unevenness is most of what makes a column read as *writing*.
 *
 * Authored root-first, top-to-bottom, left-to-right within a character —
 * because that is the order they are written in, and the drawing sequence walks
 * this array directly.
 */
const GLYPHS = Object.freeze([
  /* 日 — sun. Five strokes; the two verticals bow outward at the waist. */
  [
    [-0.26, 0.44, -0.29, 0.26, -0.29, -0.26, -0.26, -0.44, 1.0],
    [-0.26, 0.44, -0.09, 0.475, 0.09, 0.475, 0.26, 0.44, 0.92],
    [0.26, 0.44, 0.29, 0.26, 0.29, -0.26, 0.26, -0.44, 1.0],
    [-0.27, 0.01, -0.09, 0.035, 0.09, 0.035, 0.27, 0.01, 0.84],
    [-0.26, -0.44, -0.09, -0.475, 0.09, -0.475, 0.26, -0.44, 0.92]
  ],

  /* 月 — moon. Tall, and deliberately asymmetric: the left wall falls further. */
  [
    [-0.2, 0.46, -0.25, 0.2, -0.25, -0.2, -0.19, -0.5, 1.0],
    [-0.2, 0.46, -0.06, 0.49, 0.08, 0.49, 0.22, 0.45, 0.9],
    [0.22, 0.45, 0.27, 0.2, 0.27, -0.16, 0.22, -0.44, 1.0],
    [-0.23, 0.12, -0.08, 0.15, 0.09, 0.15, 0.25, 0.12, 0.8],
    [-0.24, -0.18, -0.08, -0.15, 0.09, -0.15, 0.25, -0.18, 0.8]
  ],

  /* 山 — mountain. Four strokes, and the only glyph whose base is the last. */
  [
    [0.0, 0.46, 0.005, 0.2, -0.005, -0.1, 0.0, -0.4, 1.0],
    [-0.3, 0.18, -0.325, 0.03, -0.325, -0.2, -0.3, -0.4, 0.9],
    [0.3, 0.18, 0.325, 0.03, 0.325, -0.2, 0.3, -0.4, 0.9],
    [-0.36, -0.4, -0.12, -0.445, 0.12, -0.445, 0.36, -0.4, 1.0]
  ],

  /* 川 — river. Three strokes and nothing else. The column needs the rest. */
  [
    [-0.28, 0.44, -0.33, 0.18, -0.31, -0.18, -0.26, -0.44, 0.95],
    [0.0, 0.42, -0.025, 0.14, 0.005, -0.16, 0.025, -0.44, 0.95],
    [0.28, 0.44, 0.33, 0.18, 0.31, -0.18, 0.26, -0.44, 0.95]
  ],

  /* 王 — king. Three bars through one stem; the bars are all different widths. */
  [
    [-0.3, 0.44, -0.1, 0.465, 0.1, 0.465, 0.3, 0.44, 0.9],
    [-0.22, 0.02, -0.07, 0.04, 0.07, 0.04, 0.22, 0.02, 0.8],
    [0.0, 0.46, 0.008, 0.16, -0.008, -0.14, 0.0, -0.44, 1.0],
    [-0.35, -0.44, -0.11, -0.468, 0.11, -0.468, 0.35, -0.44, 0.95]
  ],

  /* 中 — centre. The through-stroke overruns the box at both ends, which is
     the whole character and the reason it is drawn last. */
  [
    [-0.24, 0.3, -0.27, 0.18, -0.27, -0.04, -0.24, -0.17, 0.9],
    [-0.24, 0.3, -0.08, 0.335, 0.08, 0.335, 0.24, 0.3, 0.85],
    [0.24, 0.3, 0.27, 0.18, 0.27, -0.04, 0.24, -0.17, 0.9],
    [-0.24, -0.17, -0.08, -0.2, 0.08, -0.2, 0.24, -0.17, 0.85],
    [0.0, 0.5, 0.008, 0.18, -0.008, -0.16, 0.0, -0.5, 1.05]
  ],

  /* 木 — tree. Two splayed legs that leave the stem, not the bar. */
  [
    [-0.34, 0.2, -0.11, 0.235, 0.11, 0.235, 0.34, 0.2, 0.9],
    [0.0, 0.46, 0.006, 0.18, -0.006, -0.12, 0.0, -0.46, 1.0],
    [-0.02, 0.13, -0.11, 0.02, -0.21, -0.18, -0.32, -0.42, 0.78],
    [0.02, 0.13, 0.11, 0.02, 0.21, -0.18, 0.32, -0.42, 0.78]
  ],

  /* 水 — water. Five strokes, all curved; nothing in it is straight. */
  [
    [0.0, 0.46, 0.01, 0.16, -0.01, -0.14, 0.0, -0.46, 1.0],
    [-0.03, 0.22, -0.16, 0.1, -0.25, -0.08, -0.28, -0.34, 0.78],
    [0.03, 0.22, 0.16, 0.1, 0.25, -0.08, 0.28, -0.34, 0.78],
    [-0.29, 0.3, -0.37, 0.16, -0.39, 0.0, -0.33, -0.13, 0.68],
    [0.29, 0.3, 0.37, 0.16, 0.39, 0.0, 0.33, -0.13, 0.68]
  ],

  /* 石 — stone. Six strokes, and the widest silhouette in the set. */
  [
    [-0.38, 0.32, -0.2, 0.42, 0.06, 0.46, 0.36, 0.45, 0.9],
    [-0.08, 0.44, -0.2, 0.24, -0.32, 0.02, -0.4, -0.34, 0.9],
    [-0.06, 0.0, -0.075, -0.14, -0.075, -0.3, -0.06, -0.44, 0.88],
    [-0.06, 0.0, 0.06, 0.03, 0.19, 0.03, 0.31, 0.0, 0.84],
    [0.31, 0.0, 0.325, -0.14, 0.325, -0.3, 0.31, -0.44, 0.88],
    [-0.06, -0.44, 0.06, -0.472, 0.19, -0.472, 0.31, -0.44, 0.84]
  ],

  /* 田 — field. Six strokes: the box, then the cross inside it. */
  [
    [-0.28, 0.42, -0.31, 0.2, -0.31, -0.2, -0.28, -0.42, 1.0],
    [-0.28, 0.42, -0.09, 0.455, 0.09, 0.455, 0.28, 0.42, 0.9],
    [0.28, 0.42, 0.31, 0.2, 0.31, -0.2, 0.28, -0.42, 1.0],
    [0.0, 0.42, 0.008, 0.14, -0.008, -0.14, 0.0, -0.42, 0.85],
    [-0.3, 0.0, -0.1, 0.025, 0.1, 0.025, 0.3, 0.0, 0.85],
    [-0.28, -0.42, -0.09, -0.455, 0.09, -0.455, 0.28, -0.42, 0.9]
  ]
]);

/** Characters the column can hold. `chars` clamps here. */
const MAX_CHARS = 6;

/**
 * Stroke slots the brush is built with.
 *
 * `MAX_CHARS × 6` because 石 and 田 are the longest characters in the alphabet.
 * Sizing this to the *average* was the first attempt and it silently truncated
 * the two six-stroke glyphs, which is a category of bug that looks like a
 * badly-drawn character rather than like a missing one.
 */
const MAX_STROKES = MAX_CHARS * 6;

/** Bristles per stroke. Ten is plenty at this scale — a stroke is 25 cm long. */
const BRISTLES = 10;

/** Samples down one spine. A character stroke turns once; twenty is smooth. */
const SAMPLES = 20;

/* --- module-scope scratch. Nothing below allocates during a cast (I3) --- */
const _brush = brushStrokeParams();
const _wash = inkDiffusionParams();
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _centre = new Vector3();
const _anchor = new Vector3();
const _right = new Vector3();
const _normal = new Vector3();
const _charRight = new Vector3();
const _charNormal = new Vector3();
const _charCentre = new Vector3();
const _p0 = new Vector3();
const _p1 = new Vector3();
const _p2 = new Vector3();
const _p3 = new Vector3();

/**
 * SEAL SCRIPT — a column of characters written top-to-bottom in the air over a
 * wash of ink.
 *
 * **The trick is legible brush weight in three dimensions.** Ten seal-script
 * skeletons live at the top of this file as unitless cubics in an em box; every
 * control point becomes metres inside the update loop, and every stroke is
 * drawn in sequence with a real entry, body and exit.
 *
 * The failure this ability is defined against is the flat one. Write a column
 * of characters as camera-facing billboards and it looks perfect until somebody
 * orbits, at which point the entire cast is a line of nothing — a plane seen
 * edge-on is thinner than a pixel. Turning the billboard to follow the camera
 * fixes the disappearance and breaks everything else: the writing is supposed
 * to be an object hanging in the world, and an object that rotates to face you
 * is a sprite.
 *
 * So the strokes are solid. `vfx/BrushStroke.js` sweeps an ellipse of
 * half-width `strokeWidth` and half-depth `depth` along each spine, and at the
 * defaults here (0.030 m × 0.024 m) that cross-section is very nearly round.
 * Edge-on you get a column of ink bars; face-on the depth is invisible and it
 * reads flat, which is what writing wants. Three further things make the column
 * an object rather than a pane of glass with marks on it:
 *
 *  - **`columnBow`** barrels each character toward the reader — the middle of
 *    the em box comes forward by nine centimetres and the edges recede, so the
 *    strokes at the sides of a character are genuinely further away.
 *  - **`charTwist`** yaws each character a little further round than the one
 *    above it, so the column fans instead of lying in one plane. It is the
 *    difference between a scroll and a mobile, and it is small on purpose.
 *  - **`BrushTip.ROUND`** lays the bristles on a golden-angle disc rather than
 *    in one rank, which is the only layout where `ferruleDepth` does anything.
 *    That puts grain *through* the stroke as well as across it, so the depth
 *    axis has structure in it and the bar you see edge-on is a brush mark
 *    rather than an extrusion.
 *
 * ### The sequence
 *
 * `uProgress` is one clock for the whole column and every stroke owns a window
 * of it, built each frame from a timeline in *stroke units*: one unit per
 * stroke, `charPause` units between characters, `strokeOverlap` of overrun so
 * the brush never comes to a complete stop inside a character. The windows are
 * therefore recomputed when you drag `chars` or `charPause` with the clock
 * stopped, and the half-written column re-paces itself.
 *
 * Character order is top-first because that is the reading order, but the
 * *height* of a character is measured up from `baseHeight` — the lowest
 * character always stands the same distance off the floor, whatever `chars`
 * says. Anchoring the top instead put a two-character column at head height and
 * a six-character column through the floor.
 *
 * ### Two settings that are not what they look like
 *
 * **`speedRef` is 1.6, not 12.** `BrushStroke` measures the brush's dwell
 * against this in metres per unit of curve parameter, and a seal-script stroke
 * is a fifth of the length of a sumi gesture. Left at the module's default the
 * dwell term is enormous everywhere, every stroke pools along its whole length,
 * and the writing turns into a row of blobs. This is the one number that has to
 * be re-scaled when the marks get small.
 *
 * **`poolCurve` is 0.05, not 0.35.** These strokes are *made* of turns —
 * curvature is high by construction — so the module's default swells every
 * corner of every character and the counters fill in. Pooling on curvature is
 * right for a hairpin in a long gesture and wrong for a letterform.
 *
 * ### The rule that makes the editor work
 *
 * A cast captures one number, `_seed`, from which the character choices, the
 * per-character lateral drift and the bristle dice are all derived — all
 * unitless, all re-derived every frame. Not a metre, radian or second is
 * recorded. Pause with **P** half way down the column and drag `emSize`: the
 * characters resize about their own slots, the slot pitch follows because it is
 * measured in em boxes, and the strokes still being written keep their place in
 * the sequence.
 */
export class SealscriptAbility extends Ability {
  constructor(context) {
    super('sealscript', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /**
     * Thirty-six stroke slots and one draw call.
     *
     * `samples: 20` rather than the module default of 40 because a character
     * stroke is a quarter of a metre long and turns once — forty samples down
     * it is forty samples describing a shape that eight would carry. The
     * module's own doc recommends exactly this for seal script.
     */
    this.brush = new BrushStroke(this.group, {
      strokes: MAX_STROKES,
      bristles: BRISTLES,
      samples: SAMPLES,
      sides: 6,
      tip: BrushTip.ROUND,
      renderOrder: 8,
      name: 'SealScript'
    });

    /**
     * The wash the column is written over.
     *
     * `WASH` and not `BLOOM`: the fingering instability is `inkbloom`'s trick
     * and it would be the loudest thing on screen here. A wash is a flat pool
     * with a deposition line at its rim, which is what a stone slab of ink
     * actually leaves, and it exists to give the column something to stand on —
     * writing floating over bare floor reads as a hologram.
     */
    this.wash = new InkDiffusion(this.group, {
      mode: InkMode.WASH,
      sources: 4,
      satellites: 1, //  SPLATTER-only; one slot so the uniform array is legal
      renderOrder: 5,
      name: 'SealWash'
    });

    /** The one thing a cast captures. Everything else resolves per frame. */
    this._seed = 0;

    /** Strokes written this frame. Recomputed in `_layout`; HUD readout too. */
    this._strokeTotal = 0;

    /** Fired once, when the last stroke lands. */
    this._finished = false;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Pigment lifting off the wet strokes. Non-additive, like everything in
    // this school: additive blending makes a light, and ink is not one.
    this.motes = particles.get('sealscript.motes', {
      capacity: 800,
      shape: ParticleShape.SOFT,
      additive: false,
      curl: true,
      softFade: 0.4
    });
    this.motes.uniforms.uDrag.value = 2.1;
    this.motes.uniforms.uEndSize.value = 1.4;
    this.motes.uniforms.uSizeIn.value = 0.1;
    this.motes.uniforms.uFadeIn.value = 0.14;
    this.motes.uniforms.uFadeOut.value = 0.42;

    // Ink that ran off the bottom of a stroke and fell into the wash. The one
    // thing in the slot with real gravity on it, and the only reason the
    // column and the pool read as the same substance.
    this.drips = particles.get('sealscript.drips', {
      capacity: 400,
      shape: ParticleShape.SOFT,
      additive: false,
      softFade: 0.2
    });
    this.drips.uniforms.uDrag.value = 0.35;
    this.drips.uniforms.uEndSize.value = 0.5;
    this.drips.uniforms.uSizeIn.value = 0.04;
    this.drips.uniforms.uFadeIn.value = 0.03;
    this.drips.uniforms.uFadeOut.value = 0.65;

    this.moteEmitter = new RateEmitter();
    this.dripEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this.brush.count;
  }

  /** A beat's length in seconds under the global lifetime knob. */
  _span(seconds) {
    return Math.max(0.01, seconds * settings.global.lifetime);
  }

  /** The impact phase holds all three beats. Re-derived, never stored. */
  get impactDuration() {
    const c = settings.sealscript;
    return this._span(c.leadTime) + this._span(c.writeTime) + this._span(c.holdTime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.sealscript.fadeTime);
  }

  /** Ink does not gutter. A slow breath, and nothing else. */
  lightShimmer() {
    return 0.93 + 0.07 * Math.sin(this.age * 1.9);
  }

  /* ------------------------------------------------------------------ */
  /* The column — every metre resolved from live settings                 */
  /* ------------------------------------------------------------------ */

  /** How many characters the column is carrying. Clamped to the alphabet slots. */
  _charCount() {
    return Math.max(1, Math.min(MAX_CHARS, Math.round(settings.sealscript.chars)));
  }

  /** Which glyph sits in slot `k`. Derived from the seed, so a preset repeats. */
  _glyphOf(k) {
    return GLYPHS[Math.floor(hash11(this._seed * 3.7 + k * 17.31) * GLYPHS.length) % GLYPHS.length];
  }

  /** Where the writing stands: the far end of the aimed line, on the floor. */
  _anchorPoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /** 0..1 — how much of the whole column has been written. */
  _progress() {
    const c = settings.sealscript;
    return saturate((this.age - this._span(c.leadTime)) / this._span(c.writeTime));
  }

  /**
   * Lay every stroke of every character out in world space, in drawing order.
   *
   * This is the whole ability. It runs every frame — including a zero-length
   * one — because every number it touches is a live dimension, and it walks the
   * alphabet directly rather than caching a resolved column, because a cached
   * column is a column that stops answering the sliders.
   */
  _layout(c) {
    const chars = this._charCount();
    const em = Math.max(0.02, c.emSize);
    const pitch = em * c.charPitch;

    /* --- the writing plane ---------------------------------------------
     * The paper normal faces *back at the caster*: the column is written to be
     * read from where it was cast. It is fixed in world space and it does not
     * follow the camera — the moment it follows the camera it stops being an
     * object, which is the failure this ability exists to avoid.
     */
    this._anchorPoint(_anchor);
    _normal.copy(this.direction).multiplyScalar(-1);
    // `side` is the caster's right when looking downrange, so it is the
    // character's +x and the writing does not come out mirrored.
    _right.copy(this.side);

    let slot = 0;
    let units = 0;

    /* --- pass one: the timeline, in stroke units ----------------------- */
    let total = 0;
    for (let k = 0; k < chars; k++) total += this._glyphOf(k).length;
    total += Math.max(0, chars - 1) * Math.max(0, c.charPause);
    const invTotal = 1 / Math.max(total, 1e-4);
    const span = (1 + Math.max(0, c.strokeOverlap)) * invTotal;

    /* --- pass two: the strokes ----------------------------------------- */
    for (let k = 0; k < chars; k++) {
      const glyph = this._glyphOf(k);

      /* the character's own frame */
      // Twisted about world up, symmetrically about the middle of the column,
      // so the fan opens both ways rather than winding off to one side.
      const twist = c.charTwist * (k - (chars - 1) * 0.5);
      const ct = Math.cos(twist);
      const st = Math.sin(twist);
      _charRight.set(
        _right.x * ct + _right.z * st,
        0,
        -_right.x * st + _right.z * ct
      );
      _charNormal.set(
        _normal.x * ct + _normal.z * st,
        0,
        -_normal.x * st + _normal.z * ct
      );

      // Character 0 is written first and sits at the top; heights are measured
      // up from `baseHeight` so the bottom of the column is where it was put.
      const drift = (hash11(this._seed * 1.13 + k * 5.77) - 0.5) * 2 * c.columnDrift;
      _charCentre
        .copy(_anchor)
        .addScaledVector(_charRight, drift)
        .setY(c.baseHeight + (chars - 1 - k) * pitch);

      // A calligrapher's brush is drier at the bottom of a column than at the
      // top, because nothing has been added to it since the first character.
      const load =
        c.strokeInk * (1 - saturate(c.inkFalloff) * (chars > 1 ? k / (chars - 1) : 0));

      for (let s = 0; s < glyph.length && slot < MAX_STROKES; s++) {
        const g = glyph[s];
        const stroke = this.brush.stroke(slot);

        this._place(g, 0, 1, _charCentre, _charRight, _charNormal, em, c, _p0);
        this._place(g, 2, 3, _charCentre, _charRight, _charNormal, em, c, _p1);
        this._place(g, 4, 5, _charCentre, _charRight, _charNormal, em, c, _p2);
        this._place(g, 6, 7, _charCentre, _charRight, _charNormal, em, c, _p3);
        stroke.curve(_p0, _p1, _p2, _p3);

        // Even weight is the legibility of seal script, so the four pressure
        // control points come off four sliders and the alphabet only scales
        // them. A per-stroke pressure *curve* in the table was the first
        // attempt and it made every character a different hand.
        const w = g[8];
        stroke.pressure(
          c.pressEntry * w,
          c.pressSwell * w,
          c.pressHold * w,
          c.pressExit * w
        );
        stroke.ink(load);
        stroke.timing(units * invTotal, span);
        stroke.active = true;

        units += 1;
        slot += 1;
      }
      units += Math.max(0, c.charPause);
    }

    this._strokeTotal = slot;
    this.brush.setStrokeCount(slot);
  }

  /**
   * One em-space control point into world space.
   *
   * `columnBow` is applied here rather than to the character as a whole because
   * it is a function of the point's own `x`: the middle of the em box comes
   * toward the reader and the edges fall away, which is a barrel. Bowing the
   * character as a rigid body just moves it, and moving it is not depth.
   */
  _place(g, ix, iy, centre, right, normal, em, c, out) {
    const x = g[ix];
    const y = g[iy];
    const bow = c.columnBow * (1 - 4 * x * x);
    out.copy(centre);
    out.addScaledVector(right, x * em);
    out.y += y * em;
    out.addScaledVector(normal, bow);
    return out;
  }

  /**
   * The stroke the brush is on right now, or −1 before it starts.
   *
   * Walks the same timeline `_layout` built, so the emitters hang off the tip
   * of the brush rather than off "somewhere in the column".
   */
  _activeStroke() {
    const u = this._progress();
    if (u <= 0 || this._strokeTotal <= 0) return -1;
    let best = -1;
    for (let i = 0; i < this._strokeTotal; i++) {
      if (this.brush.headOf(i) > 0.001) best = i;
    }
    return best;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.moteEmitter.reset();
    this.dripEmitter.reset();
    this._finished = false;

    // The one thing a cast captures. Every character choice, every drift and
    // every bristle's load dice comes out of it, and all of them are unitless.
    this._seed = Math.random() * 100;
    this.brush.roll(this._seed);
    this.wash.reset();
    this.wash.roll(this._seed);
    this.wash.setVisible(true);

    this._sync(1);
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings into the brush, the wash and the two particle
   * systems.
   *
   * @param {number} fade 1 while the column stands, ramping to 0 as it goes
   */
  _sync(fade) {
    const c = settings.sealscript;
    const g = settings.global;

    this._layout(c);

    /* ---------------- the writing ---------------- */
    const b = _brush;
    // Recomputed here rather than cached in `_layout`, because `setPaper`
    // normalises into the module's own vector and the module is the only thing
    // allowed to hold it.
    _dir.copy(this.direction).multiplyScalar(-1);
    b.paper = _dir;

    b.width = c.strokeWidth;
    b.depth = c.depth;
    b.ferruleDepth = c.ferruleDepth;
    b.bristleWidth = c.bristleWidth;
    b.splay = c.splay;
    b.wobble = c.wobble;
    b.fibreScale = c.fibreScale;

    b.inkLoad = c.inkLoad;
    b.flowLength = c.flowLength;
    b.flowDwell = c.flowDwell;
    b.speedRef = c.speedRef;
    b.edgeStarve = c.edgeStarve;
    b.loadJitter = c.loadJitter;
    b.dryBand = c.dryBand;
    b.dryThin = c.dryThin;
    b.skipScale = c.skipScale;
    b.skipSoft = c.skipSoft;
    b.skipContrast = c.skipContrast;

    b.poolSwell = c.poolSwell;
    b.poolCurve = c.poolCurve;
    b.pigment = c.pigment;

    b.progress = this._progress();
    b.headTaper = c.headTaper;
    b.wetLength = c.wetLength;

    b.bleed = c.bleed;
    b.fibreEdge = c.fibreEdge;
    b.dryPigment = c.dryPigment;
    b.wetGain = c.wetGain;
    b.opacity = c.opacity * g.opacity;
    b.fade = fade;
    b.lit = c.lit;
    b.backLit = c.backLit;
    b.ceiling = c.ceiling;
    b.softFade = c.softFade;
    b.tint = c.tint;
    b.tintDensity = c.tintDensity;
    b.tintJitter = c.tintJitter;

    b.colorWash = c.colorWash;
    b.colorBody = c.colorBody;
    b.colorInk = c.colorInk;
    b.colorPool = c.colorPool;

    this.brush.update(0, b);

    /* ---------------- the wash ---------------- */
    this._anchorPoint(_centre);
    this.wash.setPlacement(_centre, this.direction);

    const w = _wash;
    w.radius = Math.max(0.2, c.zoneRadius);
    w.height = c.washHeight;
    w.spread = c.washSpread;
    w.spreadPower = c.washPower;
    w.edge = c.washEdge;
    w.clipSoft = c.washClip;
    w.sources = c.washSources;
    w.sourceScatter = c.washScatter;
    w.sourceDelay = c.washDelay;
    w.core = c.washCore;
    w.falloff = c.washFalloff;
    w.film = c.washFilm;
    w.granulation = c.washGranulation;
    w.granScale = c.washGranScale;
    w.ring = c.washRing;
    w.ringWidth = c.washRingWidth;
    w.dryTime = c.washDryTime;
    w.wetDarken = c.washWetDarken;
    w.gloss = c.washGloss;
    w.glossPower = c.washGlossPower;
    w.meniscus = c.washMeniscus;
    w.opacity = c.washOpacity * g.opacity;
    w.fade = fade;
    w.ceiling = c.washCeiling;
    w.softFade = c.washSoftFade;
    w.tint = c.washTint;
    w.tintDensity = c.washTintDensity;
    w.colorWash = c.colorFilmA;
    w.colorBody = c.colorFilmB;
    w.colorDeep = c.colorFilmC;
    w.colorPool = c.colorFilmD;
    w.colorRing = c.colorFilmRing;
    w.colorWet = c.colorFilmWet;
    w.colorGloss = c.colorFilmGloss;
    this.wash.update(this.age, w);

    /* ---------------- the two particle systems ---------------- */
    this.motes.setGradient(
      getColor(c.colorMoteA),
      getColor(c.colorMoteB),
      getColor(c.colorMoteC),
      getColor(c.colorMoteD)
    );
    this.motes.uniforms.uGravity.value.set(0, c.moteRise, 0);
    this.motes.uniforms.uSizeScale.value = c.moteSize * g.particleSize * 7;
    this.motes.uniforms.uLifeScale.value = c.moteLifetime * 0.5 * g.particleLifetime;
    this.motes.uniforms.uSpeedScale.value = g.particleSpeed;
    this.motes.uniforms.uOpacity.value = c.moteOpacity * g.opacity;
    // Not `* g.glow`. The global glow knob brightens the emissive schools, and
    // ink is the one that must not answer it.
    this.motes.uniforms.uGlow.value = c.moteGlow;
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;

    this.drips.setGradient(
      getColor(c.colorDripA),
      getColor(c.colorDripB),
      getColor(c.colorDripC),
      getColor(c.colorDripD)
    );
    this.drips.uniforms.uGravity.value.set(0, c.dripGravity, 0);
    this.drips.uniforms.uSizeScale.value = c.dripSize * g.particleSize * 7;
    this.drips.uniforms.uLifeScale.value = c.dripLifetime * 0.5 * g.particleLifetime;
    this.drips.uniforms.uSpeedScale.value = g.particleSpeed;
    this.drips.uniforms.uOpacity.value = c.dripOpacity * g.opacity;
    this.drips.uniforms.uGlow.value = 0.2;
  }

  /**
   * Motes off the brush and drips off the strokes it has already written.
   *
   * @param {number} dt
   * @param {number} scale 0..1 — thinned once the brush has stopped
   */
  _writeFx(dt, scale) {
    const c = settings.sealscript;
    const g = settings.global;
    const time = frame.uTime.value;
    const active = this._activeStroke();

    /* --- motes off the tip of the brush --- */
    if (active >= 0) {
      const moteCount = Math.round(
        this.moteEmitter.tick(dt, c.moteRate * scale) * g.particleCount
      );
      if (moteCount > 0) {
        this.brush.tipPoint(active, _pos);
        _emit.position = _pos;
        _emit.radius = Math.max(0.02, c.strokeWidth * 2.5);
        _emit.direction = _dir.set(0, 1, 0);
        _emit.speed = c.moteSpeed;
        _emit.speedVariance = 0.8;
        _emit.spread = 1.0;
        _emit.inherit = null;
        _emit.anchor = null;
        _emit.size = 0.07;
        _emit.sizeVariance = 0.7;
        _emit.life = c.moteLifetime;
        _emit.lifeVariance = 0.55;
        _emit.spin = 0;
        _emit.tint = null;
        _emit.time = time;
        this.motes.emit(moteCount, _emit);
      }
    }

    /* --- drips off a stroke that has already been laid down --- */
    const written = active >= 0 ? active + 1 : this._strokeTotal;
    if (written > 0) {
      const dripCount = Math.round(
        this.dripEmitter.tick(dt, c.dripRate * scale) * g.particleCount
      );
      if (dripCount > 0) {
        // Off the *bottom* of a random written stroke, because that is where
        // ink goes. Picking a uniform point along the stroke put droplets
        // leaving the top of a horizontal bar and falling through it.
        const i = Math.floor(Math.random() * written) % Math.max(1, this._strokeTotal);
        const t = 0.35 + Math.random() * 0.6;
        this.brush.pointAt(i, Math.min(t, this.brush.headOf(i)), _pos);
        _emit.position = _pos;
        _emit.radius = Math.max(0.015, c.strokeWidth * 1.5);
        _emit.direction = _dir.set(0, -1, 0);
        _emit.speed = c.dripSpeed;
        _emit.speedVariance = 0.6;
        _emit.spread = 0.25;
        _emit.inherit = null;
        _emit.anchor = null;
        _emit.size = 0.09;
        _emit.sizeVariance = 0.7;
        _emit.life = c.dripLifetime;
        _emit.lifeVariance = 0.4;
        _emit.spin = 0;
        _emit.tint = null;
        _emit.time = time;
        this.drips.emit(dripCount, _emit);
      }
    }
  }

  /**
   * The last stroke lands. One shot, tested against the live beats every frame.
   *
   * One-way, like `runeseal`'s: dragging `writeTime` upward after the column
   * has finished would otherwise push the threshold back past the clock and let
   * the flourish fire again, which is a burst of droplets out of nowhere.
   */
  _checkFinish() {
    if (this._finished) return;
    if (this._progress() < 0.999) return;

    this._finished = true;
    const c = settings.sealscript;
    const g = settings.global;

    this._anchorPoint(_pos);
    _pos.y = c.baseHeight;

    _emit.position = _pos;
    _emit.radius = Math.max(0.05, c.emSize * 0.5);
    _emit.direction = _dir.set(0, -1, 0);
    _emit.speed = c.dripSpeed * 1.4;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.6;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.11;
    _emit.sizeVariance = 0.85;
    _emit.life = c.dripLifetime * 1.2;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.drips.emit(Math.round(c.dripBurst * g.particleCount), _emit);

    this.ctx.shake.add(
      c.finishShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      13
    );
    this.lightBoost = c.lightIntensity * 0.4 * g.explosionIntensity;
  }

  /** The lamp rides the brush, and settles at the foot of the column after. */
  _placeLight(c) {
    const active = this._activeStroke();
    if (active >= 0) {
      this.brush.tipPoint(active, this.position);
      return;
    }
    this._anchorPoint(this.position);
    this.position.y = c.baseHeight;
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = settings.sealscript;
    this._sync(1);
    // The beats run off the cast's own age, not off the phase machine, so a
    // column planted at four metres writes at the same rate as one at sixteen.
    this._checkFinish();
    this._placeLight(c);
    this._writeFx(dt, 1);
  }

  onImpact() {
    // Nothing fires here. The brush arriving is not one of the column's beats —
    // `leadTime` is, and it is measured from the muzzle.
    this._sync(1);
  }

  onFade(dt, t) {
    const c = settings.sealscript;
    this._checkFinish();

    // `t` runs 0..1 while the column stands, then 1..2 while it goes. Cubic on
    // the way out so it hangs on and then lets go: dimming evenly reads as a
    // light being turned down, and there is no light in this.
    const fade = t <= 1 ? 1 : 1 - Easing.inCubic(saturate(t - 1));
    this._sync(fade);

    this._placeLight(c);
    // The brush keeps shedding until the writing is done, and then only drips.
    this._writeFx(dt, this._finished ? lerp(0.25, 0, saturate(t - 1)) : 1);
    if (!this._finished) this.ctx.shake.rumble(c.rumble * settings.global.cameraShake, dt);
  }

  onDestroy() {
    this._finished = false;
    this._strokeTotal = 0;
    this.brush.reset();
    this.wash.reset();
  }

  dispose() {
    this.brush.dispose();
    this.wash.dispose();
    super.dispose();
  }
}
