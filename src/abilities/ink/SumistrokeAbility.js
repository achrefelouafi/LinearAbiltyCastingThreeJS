import { Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { BrushStroke, BrushTip, brushStrokeParams } from '../../vfx/BrushStroke.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, Easing } from '../../utils/math.js';

/* ---------------------------------------------------------------------- */
/* Constants that are shapes, not dimensions                               */
/* ---------------------------------------------------------------------- */

/**
 * The three marks the brush makes, in the order the ferrule slots are laid out.
 *
 * They are slot indices rather than a loop because each one is authored
 * differently — a tuck is not a scaled stroke — and because the slot is where a
 * bristle's dice live. Compacting or reordering these would silently re-roll
 * which bristle runs out where, which is the one thing about this ability that
 * has to stay put between frames.
 */
const TUCK = 0;
const MAIN = 1;
const SHOULDER = 2;

/**
 * Bristles in the ferrule.
 *
 * This is the resolution of the fray and nothing else, and it wants to be high:
 * at twelve the tail came apart into twelve obviously-parallel ribbons and read
 * as a comb. At twenty-four the streaks are narrow enough that the eye stops
 * counting them and starts reading fibre. Above about thirty-two the extra
 * bristles are thinner than a pixel at any sensible camera distance and only
 * cost fill.
 */
const BRISTLES = 24;

/**
 * Samples down one spine. The stroke is up to twenty-odd metres long and bends
 * once, so this is set by how smooth the *swelling* has to be rather than by
 * the curvature — a coarse strip makes the pool at the tuck polygonal.
 */
const SAMPLES = 56;

/**
 * Steps in the CPU runout integral. `BrushStroke` uses a 13-point trapezoid in
 * the vertex shader; this is the same integral marched forward so it can be
 * *inverted* — the shader asks "how much ink is left here", this asks "where
 * did it run out" — and it needs a few more steps because a forward march that
 * overshoots reports the fray a whole segment late.
 */
const RUNOUT_STEPS = 28;

/* --- module-scope scratch. Nothing below allocates during a cast (I3) --- */
const _brush = brushStrokeParams();
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _from = new Vector3();
const _to = new Vector3();
const _c1 = new Vector3();
const _c2 = new Vector3();
const _deriv = new Vector3();
const _leg = new Vector3();
const _paperUp = new Vector3(0, 1, 0);

/**
 * SUMI STROKE — one enormous brushstroke dragged down the aimed line, which
 * runs out of ink before it gets to the end.
 *
 * **The trick is dry brush, and dry brush is a supply problem.** The ferrule is
 * twenty-four separately-modelled bristles (`vfx/BrushStroke.js`), each holding
 * its own load of pigment measured in *metre-pigment* — the length of nominal
 * full-pressure stroke it can lay before it is empty. Each spends its own load
 * against the pressure curve and against the brush's own speed, and once a
 * bristle is nearly out it starts making intermittent contact with the paper.
 * The tail therefore comes apart into separated fibre streaks that stop at
 * twenty-four different places, with clean floor between them.
 *
 * The first version of this slot did the obvious thing and multiplied an even
 * ribbon by a noise field. It is wrong in a way you can see from across the
 * room. A mask puts *holes in a stroke*; dry brush is several marks that used
 * to be one mark. The mask also breaks up uniformly across the width, because
 * noise does not know where the middle of the brush is, whereas a real brush
 * keeps ink in the core long after the outside bristles have given up — which
 * is `edgeStarve`, and it is the reason the fray opens from the edges inward.
 *
 * ### The causal chain, which is the point
 *
 * Nothing in this ability says "put the fray here". The fray is where the ink
 * ran out, and the ink runs out because of three things you can drag:
 *
 *  1. `mainLoad` × `inkLoad` — what is in the ferrule.
 *  2. `entryDwell` — how close the spine's second control point sits to its
 *     first. Small means the brush *dwells* at the tuck: `|B'(t)|` collapses
 *     there, `BrushStroke`'s dwell term blows up, ink pools into a heavy head —
 *     and that pool is paid for out of the same ferrule. A fat entry buys you a
 *     short stroke, exactly as it does on paper.
 *  3. `mainSwell` / `mainHold` — how hard the body presses.
 *
 * Reach for `dryBand` to move the fray and you are lying; `dryBand` is how
 * *softly* a bristle lets go, not where.
 *
 * ### Three marks, one brush
 *
 *  - **the tuck (起筆)** — the brush is set down and pushed *back* against the
 *    direction of travel before being dragged forward. That reversal is why a
 *    sumi stroke has a blunt, heavy head rather than a point, and because the
 *    tuck is drawn as its own short mark with its own ferrule slot it pools
 *    like one instead of being a bulge in a slider.
 *  - **the stroke** — the gesture, bowed, from the set-down point to a little
 *    past the target.
 *  - **the shoulder streak** — what the top edge of the ferrule left behind: a
 *    thin low-pressure mark offset laterally, carrying a third of the load, so
 *    it dies about a third of the way down. Individual ink loads running out at
 *    different points, at a scale you can see from the default camera.
 *
 * ### The CPU runout mirror
 *
 * `_measureRunout()` marches the same deposition integral the vertex shader
 * runs and inverts it, giving two numbers every frame: `_frayT`, where the
 * median bristle starts letting go, and `_dryT`, where it is bone dry. Those
 * place the two particle systems — pigment mist only on the wet part, torn
 * paper fibre (飛白, "flying white") only past the fray — so the particles are a
 * *consequence* of the dry brush rather than something that happens to be near
 * the end of the line. Change the integral in one place and it must change in
 * the other; that is the price of a mirror and it is worth paying, because the
 * alternative is an authored `frayStart` slider that goes out of sync with the
 * mark the moment anybody touches the pressure curve.
 *
 * ### Two things that cost an evening
 *
 * **`softFade`.** The mark lies three centimetres above the floor and
 * `BrushStroke`'s fragment feathers against the scene depth over
 * `softFade` metres. At the module's shipped 0.12 m the entire stroke came out
 * at about a quarter alpha and read as a grey smear; the default here is
 * 0.035 m, which is enough to stop it z-fighting the floor's own relief and not
 * enough to erase it. Anything lying *on* something wants this small.
 *
 * **No bloom, arithmetically.** Ink is the anti-glow school. `BrushStroke`
 * clamps its output linear luminance to `ceiling` (0.62) against
 * `post.bloomThreshold` (0.88), it is `toneMapped: true`, and it never
 * multiplies by `uGlobalGlow`. The three particle systems here are all
 * non-additive with `uGlow` held under 0.35 and dark gradients, because a
 * particle system is the one part of this slot that could still halo.
 *
 * ### The rule that makes the editor work
 *
 * A cast captures one number — `_seed`, so no two strokes fray the same way —
 * plus the timestamps the phase machine already keeps. Not one metre, radian or
 * second is recorded. The ferrule width, the bow, the tuck's angle, the ink in
 * the brush and the position of every control point re-resolve from
 * `settings.sumistroke` inside the update loop, on a zero-length frame
 * included. Pause with **P** half way down the stroke and drag `mainLoad`: the
 * fray walks along the mark, and the flying white walks with it because the
 * runout mirror re-ran too.
 */
export class SumistrokeAbility extends Ability {
  constructor(context) {
    super('sumistroke', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /**
     * One brush, three marks, one draw call.
     *
     * `FLAT` because a hake lays its bristles in a single rank across the
     * width, and a single rank is what gives a dry tail clean parallel
     * streaks. `ROUND` spreads them on a disc, which is right for seal script
     * and wrong here: the streaks separate through the paper normal as well and
     * on a mark lying flat on the floor that separation is invisible, so all it
     * does is make the fray muddier.
     */
    this.brush = new BrushStroke(this.group, {
      strokes: 3,
      bristles: BRISTLES,
      samples: SAMPLES,
      sides: 6,
      tip: BrushTip.FLAT,
      renderOrder: 6,
      name: 'SumiStroke'
    });
    this.brush.setPaper(_paperUp);

    /** The one thing a cast captures. Everything else resolves per frame. */
    this._seed = 0;

    /**
     * Where the median bristle starts letting go, and where it is spent, as
     * parameters along the main spine. Both are *outputs* of
     * `_measureRunout()`, recomputed every frame from live settings — they are
     * never authored and never survive a frame.
     */
    this._frayT = 1;
    this._dryT = 1;

    /** Fired once, on the frame the brush comes off the paper. */
    this._lifted = false;
  }

  createParticles() {
    const particles = this.ctx.particles;

    /*
     * Every system here is non-additive. That is not a preference: additive
     * blending cannot produce a pigment, only a light, and the whole argument
     * of this school is that ink sits *on* the world rather than shining out of
     * it. `uGlow` is driven from a slider that tops out at 1 and defaults to a
     * third, so a curious editor can prove the point rather than being told it.
     */

    // Pigment mist off the wet part of the mark: the fine spray a loaded brush
    // throws sideways when it is dragged fast. SOFT rather than SMOKE because
    // smoke's fbm erosion reads as combustion, and this is water.
    this.mist = particles.get('sumistroke.mist', {
      capacity: 900,
      shape: ParticleShape.SOFT,
      additive: false,
      curl: true,
      softFade: 0.5
    });
    this.mist.uniforms.uDrag.value = 2.4;
    this.mist.uniforms.uEndSize.value = 1.5;
    this.mist.uniforms.uSizeIn.value = 0.1;
    this.mist.uniforms.uFadeIn.value = 0.12;
    this.mist.uniforms.uFadeOut.value = 0.4;

    // Flying white: paper fibre lifted by a brush that has nothing left to lay
    // down. CHIP and lit, because these are flat flakes catching the key light
    // and they are the only *pale* thing in the school.
    this.flakes = particles.get('sumistroke.flakes', {
      capacity: 700,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.2
    });
    this.flakes.uniforms.uDrag.value = 1.1;
    this.flakes.uniforms.uEndSize.value = 0.7;
    this.flakes.uniforms.uSizeIn.value = 0.05;
    this.flakes.uniforms.uFadeIn.value = 0.04;
    this.flakes.uniforms.uFadeOut.value = 0.55;

    // Droplets flung at the set-down and at the lift. The only ballistic thing
    // in the slot, and the reason `spatterGravity` is allowed to be steep.
    this.spatter = particles.get('sumistroke.spatter', {
      capacity: 400,
      shape: ParticleShape.SOFT,
      additive: false,
      softFade: 0.15
    });
    this.spatter.uniforms.uDrag.value = 0.5;
    this.spatter.uniforms.uEndSize.value = 0.35;
    this.spatter.uniforms.uSizeIn.value = 0.03;
    this.spatter.uniforms.uFadeIn.value = 0.02;
    this.spatter.uniforms.uFadeOut.value = 0.6;

    this.mistEmitter = new RateEmitter();
    this.flakeEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this.brush.count;
  }

  /**
   * The lift, then the soak, then the stand.
   *
   * Scaled by `global.lifetime` at the *beat* level rather than at the phase
   * level, so turning the global knob up genuinely holds the wet mark longer
   * instead of leaving the ability staring at a finished one.
   */
  get impactDuration() {
    const c = settings.sumistroke;
    return Math.max(0.05, (c.liftTime + c.holdTime) * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.sumistroke.fadeTime);
  }

  /**
   * Ink does not gutter and it does not glint. The little lamp riding the wet
   * head only breathes, and slowly — a flicker here would read as fire, which
   * is the school this one is defined against.
   */
  lightShimmer() {
    return 0.92 + 0.08 * Math.sin(this.age * 2.1);
  }

  /* ------------------------------------------------------------------ */
  /* The gesture — every control point resolved from live settings        */
  /* ------------------------------------------------------------------ */

  /**
   * How much of the whole set of marks has been written, 0..1.
   *
   * Two regimes, and neither of them is a stored number. While the front is
   * travelling the head is pinned to it — `front` is metres downrange and the
   * spine spans `startInset` to `length + endOvershoot`, so the mapping is a
   * division, and the brush arrives where the aim indicator said it would. Once
   * the front has landed the remaining `endOvershoot` is paid out over
   * `liftTime` as the brush is dragged past the target and comes off.
   *
   * Snapping straight to 1 at impact was the first attempt and it draws the
   * last metre and a half of stroke in one frame — which, because that last
   * metre and a half is exactly the frayed part, means the ability's whole
   * point appears as a pop.
   */
  _progress() {
    const c = settings.sumistroke;
    const span = Math.max(0.1, this.length + c.endOvershoot - c.startInset);
    if (this.phase === AbilityPhase.TRAVEL) {
      return saturate((this.front - c.startInset) / span);
    }
    const landed = saturate((this.length - c.startInset) / span);
    const lift = Easing.outCubic(saturate(this.impactTime / Math.max(0.01, c.liftTime)));
    return lerp(landed, 1, lift);
  }

  /**
   * Lay out the three spines and their pressure curves.
   *
   * Called every frame from `_sync()`. Everything here is a metre or a radian
   * and every one of them comes off the block on this line, which is what makes
   * the paused editor reshape a standing mark.
   */
  _layout(c) {
    const lift = c.paperLift;

    /* --- the span the stroke covers, in world space --- */
    _from.copy(this.origin).addScaledVector(this.direction, c.startInset);
    _from.y = lift;
    _to.copy(this.origin).addScaledVector(this.direction, this.length + c.endOvershoot);
    _to.y = lift;

    /* ---------------- the stroke ---------------- */
    /*
     * Built with `curve()` rather than `line()`, because `line()` puts the two
     * inner control points at a fixed 1/3 and 2/3 and the *placement of those
     * points is the brush's speed profile*. At 1/3 and 2/3 the brush travels at
     * a constant rate, deposits evenly, and runs out with a horizontal cut. The
     * dwell at the entry and the rush at the exit are the whole reason the head
     * pools and the tail frays.
     */
    _leg.copy(_to).sub(_from);
    const skew = saturate(c.bowSkew);
    _c1.copy(_from).addScaledVector(_leg, c.entryDwell);
    _c2.copy(_to).addScaledVector(_leg, -c.exitRush);
    // The bow is applied to the two inner points only, weighted so the belly of
    // the arc sits where `bowSkew` puts it. Bowing the ends as well would move
    // the set-down point off the aim line, and the aim line is a promise.
    _c1.addScaledVector(this.side, c.bow * (1 - Math.abs(skew - 0.33) * 1.5));
    _c2.addScaledVector(this.side, c.bow * (1 - Math.abs(skew - 0.67) * 1.5));

    const main = this.brush.stroke(MAIN);
    main.curve(_from, _c1, _c2, _to);
    main.pressure(c.mainEntry, c.mainSwell, c.mainHold, c.mainExit);
    main.ink(c.mainLoad);
    main.timing(c.mainStart, c.mainSpan);

    /* ---------------- the tuck (起筆) ---------------- */
    /*
     * A short mark that starts *behind* the set-down point and travels forward
     * into it, at `pressAngle` off the heading. Two control points bunched at
     * its far end so the brush decelerates into the join: that deceleration is
     * where the ink pools, and the pool is what gives the stroke a blunt head.
     */
    const ta = c.pressAngle;
    _dir.copy(this.direction).multiplyScalar(Math.cos(ta)).addScaledVector(this.side, Math.sin(ta));
    _c1.copy(_from).addScaledVector(_dir, c.pressLength);
    _c1.y = lift;

    const tuck = this.brush.stroke(TUCK);
    _c2.copy(_c1).lerp(_from, 0.45);
    _pos.copy(_c1).lerp(_from, 0.88);
    tuck.curve(_c1, _c2, _pos, _from);
    tuck.pressure(c.pressEntry, c.pressSwell, c.pressHold, c.pressExit);
    tuck.ink(c.pressLoad);
    tuck.timing(c.pressStart, c.pressSpan);

    /* ---------------- the shoulder streak ---------------- */
    /*
     * The same gesture, offset laterally, at a third of the load and half the
     * pressure, covering `shoulderScale` of the span. It is not a copy of the
     * main stroke's curve: it is evaluated *along* it, so it stays parallel
     * through the bow instead of cutting the corner, which is what a real
     * shoulder mark does.
     */
    const shoulder = this.brush.stroke(SHOULDER);
    const end = saturate(c.shoulderScale);
    this.brush.pointAt(MAIN, 0, _from);
    this.brush.pointAt(MAIN, end * 0.34, _c1);
    this.brush.pointAt(MAIN, end * 0.67, _c2);
    this.brush.pointAt(MAIN, end, _to);
    _from.addScaledVector(this.side, c.shoulderOffset);
    _c1.addScaledVector(this.side, c.shoulderOffset);
    _c2.addScaledVector(this.side, c.shoulderOffset);
    _to.addScaledVector(this.side, c.shoulderOffset);
    shoulder.curve(_from, _c1, _c2, _to);
    shoulder.pressure(c.shoulderEntry, c.shoulderSwell, c.shoulderHold, c.shoulderExit);
    shoulder.ink(c.shoulderLoad);
    shoulder.timing(c.shoulderStart, c.shoulderSpan);
  }

  /**
   * Speed along the main spine at `t`, metres per unit parameter.
   *
   * The cubic's own derivative, evaluated exactly as `bezierD` does in the
   * vertex shader. It is the term that makes the dwell cost ink.
   */
  _speedAt(stroke, t) {
    const m = 1 - t;
    _deriv.set(0, 0, 0);
    _leg.copy(stroke.p1).sub(stroke.p0);
    _deriv.addScaledVector(_leg, 3 * m * m);
    _leg.copy(stroke.p2).sub(stroke.p1);
    _deriv.addScaledVector(_leg, 6 * m * t);
    _leg.copy(stroke.p3).sub(stroke.p2);
    _deriv.addScaledVector(_leg, 3 * t * t);
    return Math.max(_deriv.length(), 1e-3);
  }

  /**
   * March the deposition integral forward along the main stroke and record
   * where the median bristle frays and where it is spent.
   *
   * This is the CPU half of `BrushStroke`'s `inkSpent()`. The shader integrates
   * *to* a parameter; this inverts the same function, which cannot be done in
   * closed form because the pigment rate carries a `1/|B'(t)|` dwell term. The
   * median bristle is the one with no edge starvation and no load jitter, so
   * these two numbers sit in the middle of the fray rather than at either end
   * of it — which is what you want for placing particles, because the fray is a
   * *region*.
   */
  _measureRunout(c) {
    const stroke = this.brush.stroke(MAIN);
    const load = Math.max(0, stroke.load * c.inkLoad);
    const fraySpend = Math.max(0, load - Math.max(c.dryBand, 1e-3));

    const h = 1 / RUNOUT_STEPS;
    let acc = 0;
    let prev = this._depositionAt(stroke, 0, c);
    this._frayT = 1;
    this._dryT = 1;
    let foundFray = fraySpend <= 0;
    if (foundFray) this._frayT = 0;

    for (let i = 1; i <= RUNOUT_STEPS; i++) {
      const t = i * h;
      const rate = this._depositionAt(stroke, t, c);
      const before = acc;
      acc += 0.5 * (prev + rate) * h;
      prev = rate;
      const step = acc - before;
      if (!foundFray && acc >= fraySpend) {
        foundFray = true;
        // Linear inside the segment. A whole segment of slop here is a fifth of
        // a metre at a twenty-metre cast, which is enough to put the flying
        // white visibly ahead of the streaks it is supposed to be coming off.
        this._frayT = (t - h) + h * (step > 1e-9 ? (fraySpend - before) / step : 0);
      }
      if (acc >= load) {
        this._dryT = (t - h) + h * (step > 1e-9 ? (load - before) / step : 0);
        break;
      }
    }
    if (this._frayT > this._dryT) this._frayT = this._dryT;
  }

  /** Metre-pigment spent per unit of `t` at `t`. `pigmentAt(t) * |B'(t)|`. */
  _depositionAt(stroke, t, c) {
    const sp = this._speedAt(stroke, t);
    const pr = Math.max(this.brush.pressureOf(MAIN, t), 0);
    const pig = pr * (c.flowLength + c.flowDwell * (c.speedRef / sp)) * c.pigment;
    return pig * sp;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.mistEmitter.reset();
    this.flakeEmitter.reset();
    this._lifted = false;

    // The one thing a cast captures: which bristles started fuller than their
    // neighbours, and where each one's contact noise sits. Both unitless.
    this._seed = Math.random() * 100;
    this.brush.roll(this._seed);

    this._sync(1, 0);
    this._tuckFx();
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings into the brush and the three particle systems.
   *
   * @param {number} fade 1 while the mark stands, ramping to 0 as it goes
   * @param {number} soak 0..1 how far the ink has wicked into the paper
   */
  _sync(fade, soak) {
    const c = settings.sumistroke;
    const g = settings.global;

    this._layout(c);
    this._measureRunout(c);

    const b = _brush;
    b.paper = _paperUp;

    b.width = c.width;
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

    // The soak is the only thing on the mark that changes after the brush has
    // come off: the vehicle keeps travelling into the paper for a second or two
    // after the pigment has stopped, so the edge softens while the body does
    // not. Widening `bleed` is exactly that, and it is one lerp rather than a
    // second material.
    b.bleed = c.bleed + c.bleedSoak * saturate(soak);
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

    /* ---------------- the three particle systems ---------------- */
    this.mist.setGradient(
      getColor(c.colorMistA),
      getColor(c.colorMistB),
      getColor(c.colorMistC),
      getColor(c.colorMistD)
    );
    this.mist.uniforms.uGravity.value.set(0, c.mistRise, 0);
    this.mist.uniforms.uSizeScale.value = c.mistSize * g.particleSize * 7;
    this.mist.uniforms.uLifeScale.value = c.mistLifetime * 0.5 * g.particleLifetime;
    this.mist.uniforms.uSpeedScale.value = g.particleSpeed;
    this.mist.uniforms.uOpacity.value = c.mistOpacity * g.opacity;
    // Not `* g.glow`. The global glow knob exists to make the emissive schools
    // brighter, and ink is not one of them — see the note on `uGlobalGlow` in
    // BrushStroke's fragment doc, which this follows for the same reason.
    this.mist.uniforms.uGlow.value = c.mistGlow;
    this.mist.uniforms.uTurbulence.value = c.mistTurbulence * g.turbulence;

    this.flakes.setGradient(
      getColor(c.colorFlakeA),
      getColor(c.colorFlakeB),
      getColor(c.colorFlakeC),
      getColor(c.colorFlakeD)
    );
    this.flakes.uniforms.uGravity.value.set(0, c.flakeGravity, 0);
    this.flakes.uniforms.uSizeScale.value = c.flakeSize * g.particleSize * 7;
    this.flakes.uniforms.uLifeScale.value = c.flakeLifetime * 0.5 * g.particleLifetime;
    this.flakes.uniforms.uSpeedScale.value = g.particleSpeed;
    this.flakes.uniforms.uOpacity.value = c.flakeOpacity * g.opacity;
    this.flakes.uniforms.uGlow.value = 0.25;
    this.flakes.uniforms.uTurbulence.value = 0.2 * g.turbulence;

    this.spatter.setGradient(
      getColor(c.colorSpatterA),
      getColor(c.colorSpatterB),
      getColor(c.colorSpatterC),
      getColor(c.colorSpatterD)
    );
    this.spatter.uniforms.uGravity.value.set(0, c.spatterGravity, 0);
    this.spatter.uniforms.uSizeScale.value = c.spatterSize * g.particleSize * 7;
    this.spatter.uniforms.uLifeScale.value = c.spatterLifetime * 0.5 * g.particleLifetime;
    this.spatter.uniforms.uSpeedScale.value = g.particleSpeed;
    this.spatter.uniforms.uOpacity.value = c.spatterOpacity * g.opacity;
    this.spatter.uniforms.uGlow.value = 0.2;
  }

  /** Droplets thrown as the loaded brush is set down. */
  _tuckFx() {
    const c = settings.sumistroke;
    const g = settings.global;

    this.brush.pointAt(TUCK, 1, _pos);

    _emit.position = _pos;
    _emit.radius = Math.max(0.05, c.width * 0.8);
    // Backward and up: the tuck runs against the heading, and a droplet leaves
    // along the bristle, not along the gesture.
    _emit.direction = _dir.copy(this.direction).multiplyScalar(-0.5).setY(0.85).normalize();
    _emit.speed = c.spatterSpeed;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.14;
    _emit.sizeVariance = 0.85;
    _emit.life = c.spatterLifetime;
    _emit.lifeVariance = 0.55;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.spatter.emit(Math.round(c.spatterTuck * g.particleCount), _emit);

    this.lightBoost = c.lightIntensity * 0.3 * g.explosionIntensity;
  }

  /**
   * Everything the moving brush sheds, split at the runout point.
   *
   * @param {number} dt
   * @param {number} scale 0..1 — thinned once the brush has come off the paper
   */
  _brushFx(dt, scale) {
    const c = settings.sumistroke;
    const g = settings.global;
    const time = frame.uTime.value;
    const head = saturate(this.brush.headOf(MAIN));
    if (head <= 0.001) return;

    /* --- pigment mist, on the wet part only --- */
    const wet = Math.min(head, this._frayT);
    const mistCount = Math.round(
      this.mistEmitter.tick(dt, c.mistRate * scale * (wet > 0.01 ? 1 : 0)) * g.particleCount
    );
    if (mistCount > 0) {
      // Biased toward the head: a brush throws mist where it is moving, not
      // along the whole length of a mark it laid down a second ago.
      const t = wet * (1 - Math.random() * Math.random());
      this.brush.pointAt(MAIN, t, _pos);
      _pos.y += c.paperLift;
      this.brush.tangentAt(MAIN, t, _dir);
      // Sideways off the stroke, in the paper plane, with a little rise.
      _dir.cross(_paperUp).setY(0.5).normalize();
      _emit.position = _pos;
      _emit.radius = Math.max(0.04, this.brush.widthAt(MAIN, t) * 1.2);
      _emit.direction = _dir;
      _emit.speed = c.mistSpeed;
      _emit.speedVariance = 0.85;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.09;
      _emit.sizeVariance = 0.7;
      _emit.life = c.mistLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.mist.emit(mistCount, _emit);
    }

    /* --- flying white, past the runout only --- */
    const dryRun = Math.max(0, head - this._frayT);
    const flakeCount = Math.round(
      this.flakeEmitter.tick(dt, c.flakeRate * scale * (dryRun > 0.005 ? 1 : 0)) * g.particleCount
    );
    if (flakeCount > 0) {
      // Biased toward the far end of the dry run — `max` of two draws — because
      // a bristle that is merely thirsty still lays pigment and a bone-dry one
      // is scraping. A uniform draw put as much fibre in the first centimetre
      // of the fray as in the last, and the tail stopped reading as an ending.
      const t = this._frayT + Math.max(Math.random(), Math.random()) * dryRun;
      this.brush.pointAt(MAIN, t, _pos);
      _pos.y += c.paperLift;
      // Torn up along the direction of travel: a dry bristle catches the tooth
      // of the paper and drags fibre forward, which is why this reads as
      // scraping rather than as dust falling off.
      this.brush.tangentAt(MAIN, t, _dir);
      _dir.multiplyScalar(0.7).setY(0.7).normalize();
      _emit.position = _pos;
      _emit.radius = Math.max(0.04, this.brush.widthAt(MAIN, t) * 1.4);
      _emit.direction = _dir;
      _emit.speed = c.flakeSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.75;
      _emit.inherit = null;
      _emit.anchor = null;
      // Past `_dryT` the median bristle has nothing left at all and is dragging
      // its tip over the tooth of the paper, so the fibre it lifts is coarser.
      _emit.size = t > this._dryT ? 0.15 : 0.1;
      _emit.sizeVariance = 0.9;
      _emit.life = c.flakeLifetime;
      _emit.lifeVariance = 0.6;
      _emit.spin = c.flakeSpin;
      _emit.tint = null;
      _emit.time = time;
      this.flakes.emit(flakeCount, _emit);
    }
  }

  /** The brush comes off the paper. One shot, tested against the live beat. */
  _checkLift() {
    const c = settings.sumistroke;
    if (this._lifted) return;
    if (this.phase === AbilityPhase.TRAVEL) return;
    if (this.impactTime < c.liftTime) return;

    this._lifted = true;
    const g = settings.global;
    const time = frame.uTime.value;

    this.brush.pointAt(MAIN, 1, _pos);
    _pos.y += c.paperLift;

    _emit.position = _pos;
    _emit.radius = Math.max(0.05, c.width * 1.2);
    // Forward and up, along the gesture: the brush is still moving when it
    // leaves the paper and the droplets keep going.
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.7).setY(0.7).normalize();
    _emit.speed = c.spatterSpeed * 1.3;
    _emit.speedVariance = 0.85;
    _emit.spread = 0.7;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.11;
    _emit.sizeVariance = 0.9;
    _emit.life = c.spatterLifetime * 1.2;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.spatter.emit(Math.round(c.spatterLift * g.particleCount), _emit);

    this.ctx.shake.add(
      c.liftShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      14
    );
  }

  /** Put the lamp on the wet head, or on the last wet place once it has gone. */
  _placeLight(c) {
    const t = Math.min(saturate(this.brush.headOf(MAIN)), Math.max(this._frayT, 0.02));
    this.brush.pointAt(MAIN, t, this.position);
    this.position.y = c.paperLift + c.lightHeight;
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = settings.sumistroke;
    this._sync(1, 0);
    this._placeLight(c);
    this._brushFx(dt, 1);
    this.ctx.shake.rumble(c.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    // Nothing fires here. The brush has not left the paper yet — it is still
    // being dragged through `endOvershoot` — and firing the lift on arrival
    // put the droplets a metre and a half behind the brush that threw them.
    this._sync(1, 0);
  }

  onFade(dt, t) {
    const c = settings.sumistroke;
    this._checkLift();

    // `t` runs 0..1 while the mark stands, then 1..2 while it goes. The soak
    // runs on its own clock from the moment the brush lifted, because it is a
    // property of the paper rather than of the phase machine: a mark held for
    // ten seconds by `global.lifetime` is not ten times wetter.
    const soaked = saturate((this.impactTime - c.liftTime) / Math.max(0.05, c.soakTime));
    // Cubic on the way out so the mark hangs on and then goes, rather than
    // dimming evenly — evenly reads as a light being turned down, and there is
    // no light in this.
    const fade = t <= 1 ? 1 : 1 - Easing.inCubic(saturate(t - 1));
    this._sync(fade, soaked);

    this._placeLight(c);
    // The brush keeps shedding until it is off the paper, and then stops. A
    // standing mark that is still throwing mist is a mark somebody is still
    // painting.
    this._brushFx(dt, this._lifted ? 0 : 1);
    if (!this._lifted) this.ctx.shake.rumble(c.rumble * settings.global.cameraShake, dt);
  }

  onDestroy() {
    this._lifted = false;
    this._frayT = 1;
    this._dryT = 1;
    this.brush.reset();
  }

  dispose() {
    this.brush.dispose();
    super.dispose();
  }
}
