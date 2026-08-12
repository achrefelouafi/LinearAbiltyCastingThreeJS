import { Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { FoldMesh, FoldPattern, FoldLayout, foldMeshParams } from '../../vfx/FoldMesh.js';
import { Swarm, Silhouette, LeadPath, swarmParams } from '../../vfx/Swarm.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, Easing } from '../../utils/math.js';

/**
 * Hard ceiling on cranes. The editor's `sheets` slider clamps here.
 *
 * The vertex cost of a folded sheet is `segments² × MAX_CREASES` rotations, and
 * the crane table is seven creases at 26×26 — about 4.7k rotations a bird. At
 * twenty-eight that is 130k a frame, which is nothing, and the
 * real ceiling is legibility: past about twenty birds the flock stops reading
 * as individual objects opening and starts reading as confetti.
 */
const MAX_SHEETS = 28;
/** Hard ceiling on the scrap cloud. `Swarm` capacity; the slider clamps here. */
const MAX_SCRAPS = 192;
/**
 * Grid resolution across one sheet.
 *
 * The crease is only as sharp as the grid can resolve: a hinge narrower than a
 * cell quantises into a visible kink along the fold. At 26 a cell is 13.8 mm on
 * the shipped 36 cm sheet, just inside the 16 mm hinge — drop this to 12 and
 * the wing breaks turn into a staircase.
 *
 * The one crease that is still under-resolved is the head, which carries
 * `hinge: 0.6` in the crane table and so folds over 9.6 mm. It is knowingly
 * left there: the head is a centimetre of paper at the end of a neck, the kink
 * is a single cell wide, and paying 40 % more vertices on every sheet in the
 * flock to round off a fold nobody can see at flock distance is the wrong
 * trade.
 */
const SEGMENTS = 26;

/* Module-scope scratch. Nothing in the frame path allocates — invariant I3. */
const _paper = foldMeshParams();
const _flock = swarmParams();
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
/** The mirrored side vector — see `_syncPaper`. Never `this.side` itself. */
const _basis = new Vector3();

/**
 * ORIGAMI — Paper Storm. A flight of cranes that comes apart in the air.
 *
 * A flock of folded paper is thrown down the aimed line. It flies, folded, for
 * the length of the cast; on arrival the birds **unfold** — every crease runs
 * backwards through the order it was folded in, the wings drop, the necks and
 * tails straighten, and eighteen cranes become eighteen flat sheets of written
 * paper hanging in the air. Then they sink and go.
 *
 * ## THE TRICK — real folding, and therefore no stretching
 *
 * The flock opens on **one number**. `FoldMesh` takes `progress`, walks the
 * crane's seven-crease table backwards from the deepest fold, and applies each
 * crease as a **rigid motion of the material point**. This ability drives that
 * number from `1 + foldStagger` down to `0` across the impact phase and does
 * nothing else to the geometry: no per-bird animation, no keyframes, no second
 * copy of the crane in its open state.
 *
 * The reason that matters is the thing you notice before you notice anything
 * else. The obvious implementation — model the crane, model the sheet, `mix()`
 * between them on a slider — is four lines, and it is wrong in a way that
 * cannot be unseen: a vertex travelling in a straight line between two
 * positions that are *rotated* apart cuts the chord rather than walking the
 * arc, so every span across a fold shortens on the way over. A half-open crane
 * has lost thirty per cent of its width. It deflates as it opens and inflates
 * as it closes, and it reads as rubber. Paper does not do that, and neither
 * does this: a product of rigid motions preserves every distance on the sheet
 * by construction, at *every* intermediate value and not just at the two ends.
 *
 * The stagger is the second half of the trick. One shared parameter minus a
 * per-bird die means the flock opens as a **ripple** — the near birds first,
 * the far ones a beat later — from a single slider, with no per-instance state
 * on the CPU at all. Drag `foldStagger` to 0 while paused and eighteen cranes
 * snap open in lockstep, which is worth doing once to see how much of the
 * ability the stagger is carrying.
 *
 * ## What is not here
 *
 * **Nothing glows.** Ink is the matte school. There is no `ctx.flash`, no
 * additive pass, no burst shell; the paper is the one tone-mapped material in
 * `src/vfx/`, the scrap cloud is lit rather than emissive, and the dust is
 * non-additive so it genuinely occludes. The only light is one warm lamp riding
 * the flock so the birds catch an edge against the floor. The first pass had a
 * bloom-threshold cream on the crease highlight, and it turned a paper crane
 * into a neon one — the school exists precisely because everything else in this
 * project is lit from inside.
 *
 * ## Two things the shared clock will not let you do
 *
 * `tumble` and `scrapChurn` are both multiplied by `frame.uTime` — seconds
 * since the app booted — inside their shaders. Ramping either of them from zero
 * as the flock opens, which is the obvious way to say "it starts spinning as it
 * comes apart", slews every sheet by `t · Δω` on the frame it changes: hundreds
 * of radians, in one frame, as a snap. Both are therefore **constant across a
 * cast**, and the turning-over read is bought by `openRoll` and `openPitch`,
 * which are closed-form *angles* in the beat and can be re-evaluated at any
 * time — including on a zero-length frame.
 *
 * ## The rule that makes the editor work
 *
 * A cast captures exactly one thing: `_seed`, so two flocks do not lay out
 * identically. It is an event and it carries no unit. Every metre, radian and
 * second — the sheet size, the altitude, the crease radius, the coast past the
 * end of the line, the fall — is resolved from `settings.origami` inside the
 * update loop, on a zero-length frame included. Pause with **P** mid-unfold and drag `sheetWidth`: the paper
 * gets bigger and the fold stays exactly as far through as it was, because the
 * crease table is in fractions of the sheet and the metres are a uniform.
 */
export class OrigamiAbility extends Ability {
  constructor(context) {
    super('origami', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /* --- the flock. One draw call, every bird folded by the vertex stage. --- */
    this.paper = new FoldMesh(this.group, {
      pattern: FoldPattern.CRANE,
      layout: FoldLayout.LINE,
      capacity: MAX_SHEETS,
      segments: SEGMENTS,
      renderOrder: 4,
      name: 'Origami:cranes'
    });

    /* --- the offcuts flying with it. One more. --- */
    this.scraps = new Swarm(this.group, {
      capacity: MAX_SCRAPS,
      silhouette: Silhouette.LEAF,
      // Not additive: a scrap of paper in front of a dark floor is *darker*
      // than the floor, and an additive one can only ever be brighter.
      additive: false,
      renderOrder: 5
    });

    /** Re-rolled per cast so no two flocks lay out the same way. */
    this._seed = 0;

    /**
     * The cast's beats, all unitless, refilled every frame. One object, reused.
     *
     *   fly    0..1  how far down the lane the flock has flown
     *   open   0..1  how far through the unfold it is
     *   coast  0..1  how far through the drift past the end it is
     *   fall   0..1  how far through the sink it is
     *   appear 0..1  the wave that brings the birds into existence
     *   fade   1..0  master opacity
     */
    this._b = { fly: 0, open: 0, coast: 0, fall: 0, appear: 0, fade: 1 };
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Paper dust: the fine stuff that comes off a sheet being handled. Not
    // additive, because it has to sit *in front of* the paper and dim it.
    this.dust = particles.get('origami.dust', {
      capacity: 1200,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 0.6
    });
    this.dust.uniforms.uDrag.value = 2.4;
    this.dust.uniforms.uEndSize.value = 2.2;
    this.dust.uniforms.uSizeIn.value = 0.14;
    this.dust.uniforms.uFadeIn.value = 0.18;
    this.dust.uniforms.uFadeOut.value = 0.45;

    // Chaff: torn corners. `LEAF` rather than `CHIP` — a chip is a rock and
    // tumbles like one; a leaf has a chord, catches air and flutters, and the
    // difference is obvious at any distance you can see the flock from.
    this.chaff = particles.get('origami.chaff', {
      capacity: 1400,
      shape: ParticleShape.LEAF,
      additive: false,
      lit: true,
      softFade: 0.3
    });
    this.chaff.uniforms.uDrag.value = 1.9;
    this.chaff.uniforms.uEndSize.value = 1.0;
    this.chaff.uniforms.uSizeIn.value = 0.06;
    this.chaff.uniforms.uFadeIn.value = 0.05;
    this.chaff.uniforms.uFadeOut.value = 0.55;

    this.dustEmitter = new RateEmitter();
    this.chaffEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this.paper.count + this.scraps.count;
  }

  /** The unfold and the hold share the impact phase. */
  get impactDuration() {
    const c = settings.origami;
    return Math.max(0.05, (c.openTime + c.holdTime) * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.origami.sinkTime);
  }

  /**
   * Paper does not gutter and does not glint. The lamp riding the flock
   * breathes on the same clock the birds bob on, which is the only thing that
   * keeps it from reading as a spotlight bolted to the camera.
   */
  lightShimmer() {
    return 1 + 0.06 * Math.sin(this.age * settings.origami.bobRate);
  }

  /* ------------------------------------------------------------------ */
  /* The beats — fractions only. Metres are resolved in the sync methods. */
  /* ------------------------------------------------------------------ */

  /**
   * @param {number} t 0..1 through the impact phase, then 1..2 through the fade
   */
  _resolveBeats(t) {
    const c = settings.origami;
    const b = this._b;

    if (this.phase === AbilityPhase.TRAVEL) {
      b.fly = this.u;
      b.open = 0;
      b.coast = 0;
      b.fall = 0;
      // The birds arrive as the front does, each on its own die.
      b.appear = Easing.outQuad(this.u);
      b.fade = 1;
      return;
    }

    b.fly = 1;
    b.appear = 1;
    // The coast runs across *both* remaining phases, so `overrun` is the total
    // distance the flock drifts past the end of the line rather than a per-
    // phase quantity that jumps when the phase changes.
    b.coast = saturate(t * 0.5);

    if (t <= 1) {
      const openFrac = saturate(c.openTime / Math.max(c.openTime + c.holdTime, 1e-3));
      b.open = saturate(t / Math.max(openFrac, 1e-3));
      b.fall = 0;
      b.fade = 1;
      return;
    }

    b.open = 1;
    const s = saturate(t - 1);
    b.fall = s;
    // Cubic, so the sheets hang and *then* go, rather than dimming from the
    // first frame of the fade. Paper does not dissolve; it leaves the shot.
    b.fade = 1 - Easing.inCubic(s);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.dustEmitter.reset();
    this.chaffEmitter.reset();

    // The one thing a cast captures. Everything else is resolved per frame.
    this._seed = Math.random() * 100;
    this.paper.roll(this._seed);
    this.scraps.roll(this._seed);
    this.paper.visible = true;

    this._resolveBeats(0);
    this._sync();
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /** Everything that draws, re-resolved from the live block. */
  _sync() {
    this._syncPaper();
    this._syncScraps();
    this._syncParticles();

    // The lamp rides the flock at altitude, not the floor line the base class
    // walks along. Resolved after the paper so both agree about the altitude.
    this.pointAt(this._travelFraction(), this.position);
    this.position.y = this._altitude();
  }

  /**
   * How far along the cast the flock is, as a fraction — including the coast
   * past the end.
   *
   * `overrun` is in metres and `travel` is a fraction, so the conversion has to
   * happen against the *live* `this.length`. Doing it here rather than in the
   * beats is what keeps `_b` free of dimensions.
   */
  _travelFraction() {
    const c = settings.origami;
    return this._b.fly + (c.overrun * this._b.coast) / Math.max(this.length, 1e-3);
  }

  /**
   * The flock's altitude in metres: cruise, plus the pop of air as the wings
   * come apart, minus the fall.
   *
   * The fall is `speed × duration × ease`, not an integration. Integrating it
   * would put a metre on the CPU and freeze the sheets where they were the
   * moment you paused; this way, dragging `sink` while paused moves a sheet
   * that is already falling to where it *would* have been.
   */
  _altitude() {
    const c = settings.origami;
    const b = this._b;
    return (
      c.lift + c.openLift * Easing.outCubic(b.open) - c.sink * c.sinkTime * Easing.inQuad(b.fall)
    );
  }

  /**
   * The flock.
   *
   * One note that cost an hour: `FoldMesh.setBasis(origin, direction, side)`
   * derives its own up as `direction × side`, and the base class's `side` is
   * `direction × worldUp` — so the natural argument order hands it an up vector
   * pointing at the **floor**, and the entire flock flies underground with its
   * cranes upside down. The mirrored side is passed instead. The dice are
   * symmetric about zero so mirroring costs nothing but the sign of the lateral
   * scatter, which nobody can see.
   */
  _syncPaper() {
    const c = settings.origami;
    const g = settings.global;
    const b = this._b;
    const p = _paper;

    p.count = Math.max(0, Math.min(MAX_SHEETS, Math.round(c.sheets)));

    /* --- the sheet --- */
    p.sheetWidth = c.sheetWidth;
    p.sheetLength = c.sheetLength;
    p.aspect = c.aspect;
    p.sizeJitter = c.sizeJitter * g.randomness;
    p.thickness = c.thickness;

    /* --- the fold: the one number --- */
    // From a stagger's worth above 1 down to 0. Above 1 so that the *earliest*
    // bird in the stagger is still fully folded on the first frame of the
    // unfold: `prog = progress − die × stagger`, so a die of 1 needs the shared
    // parameter to start at 1 + stagger for that bird to start closed.
    p.progress = lerp(1 + c.foldStagger, 0, Easing.inOutCubic(b.open));
    p.foldGain = c.foldGain;
    p.hinge = c.hinge;
    p.stageEase = c.stageEase;
    p.foldStagger = c.foldStagger;

    /* --- where the flock is --- */
    p.travel = this._travelFraction();
    p.spread = c.spread;
    p.stretch = c.stretch;
    p.lift = this._altitude();
    p.liftJitter = c.liftJitter * g.randomness;
    p.bob = c.bob;
    p.bobRate = c.bobRate;

    /* --- attitude. Both open terms are angles, not rates. --- */
    const open = Easing.inOutCubic(b.open);
    p.pitch = c.flyPitch + c.openPitch * open;
    p.yaw = 0;
    p.yawJitter = c.yawJitter * g.randomness;
    p.roll = c.openRoll * open;
    p.rollJitter = c.rollJitter * g.randomness;
    p.tumble = c.tumble;

    /* --- appearing --- */
    p.reveal = b.appear;
    p.revealSpread = c.revealSpread;

    /* --- the paper itself --- */
    p.ambient = c.ambient;
    p.wrap = c.wrap;
    p.transmit = c.transmit;
    p.transmitPower = c.transmitPower;
    p.sheen = c.sheen;
    p.gloss = c.gloss;

    p.grain = c.grain;
    p.grainScale = c.grainScale;
    p.grainAngle = c.grainAngle;
    p.grainAniso = c.grainAniso;
    p.fleck = c.fleck;
    p.laid = c.laid;
    p.laidPitch = c.laidPitch;
    p.chainPitch = c.chainPitch;

    p.creaseGlow = c.creaseGlow;
    p.creaseDark = c.creaseDark;
    p.creaseSharp = c.creaseSharp;

    p.ink = c.ink;
    p.inkRows = c.inkRows;
    p.inkCols = c.inkCols;
    p.inkFill = c.inkFill;
    p.inkWeight = c.inkWeight;
    p.inkMargin = c.inkMargin;
    p.inkSeed = c.inkSeed;
    p.inkGhost = c.inkGhost;

    p.edge = c.edge;
    p.tintSpread = c.tintSpread;
    p.opacity = c.paperOpacity * g.opacity * b.fade;

    this.paper.setColors(c.colorPaper, c.colorShade, c.colorTransmit, c.colorInk, c.colorCrease);
    _basis.copy(this.side).negate();
    this.paper.setBasis(this.origin, this.direction, _basis, this.length);
    this.paper.update(this.age, p);
  }

  /**
   * The scrap cloud.
   *
   * `leadRate` is the flock's own speed expressed in lane-fractions per second,
   * and it is not decoration: the lattice's third axis is *time*, so with a
   * rate of zero every rank shares one home point and the cloud collapses into
   * a flat card. It stays at the true rate for the whole cast — including after
   * the flock has stopped — because it is what sets the cloud's depth, and a
   * depth that changes as the birds arrive reads as the cloud being sucked
   * forward.
   *
   * The `LINE` lead clamps at the target, so once the cranes coast past the end
   * of the line the scraps stop with the target and the flock leaves them
   * behind. That is correct and it is free: the paper is going somewhere, the
   * paper it shed is not.
   */
  _syncScraps() {
    const c = settings.origami;
    const g = settings.global;
    const b = this._b;
    const p = _flock;

    p.count = Math.round(Math.min(MAX_SCRAPS, c.scraps) * g.particleCount);

    p.leadMode = LeadPath.LINE;
    p.leadS = this._travelFraction();
    p.leadRate = (c.speed * g.speed) / Math.max(this.length, 1e-3);
    p.leadRise = c.scrapRise;
    p.handForward = 0;
    p.handSide = 0;
    p.handHeight = c.lift;
    p.endHeight = c.scrapEnd;

    p.latticeX = c.scrapLatticeX;
    p.latticeY = c.scrapLatticeY;
    p.latticeZ = c.scrapLatticeZ;
    p.spacingSide = c.scrapSpacing;
    p.spacingUp = c.scrapSpacingUp;
    p.jitter = c.scrapJitter * g.randomness;
    p.lag = c.scrapLag;
    p.churn = c.scrapChurn;
    p.breathe = c.scrapBreathe;
    p.breatheRate = c.scrapBreatheRate;
    p.wander = c.scrapWander * g.turbulence;
    p.wanderScale = c.scrapWanderScale * g.noiseFrequency;
    p.wanderSpeed = c.scrapWanderSpeed * g.noiseSpeed;
    p.gather = c.scrapGather;

    p.size = c.scrapSize * g.particleSize;
    p.aspect = c.scrapAspect;
    p.sizeJitter = c.scrapSizeJitter * g.randomness;
    p.billboard = 0;
    p.bank = c.scrapBank;
    p.bankMax = c.scrapBankMax;
    p.dihedral = 0;
    p.flapRate = 0;
    p.curl = c.scrapCurl;
    p.edgeStretch = c.scrapEdgeStretch;

    // A scrap exists exactly to the extent that a crane has come apart: one
    // beat, two consumers, and the cloud cannot get ahead of the unfold.
    p.reveal = Easing.outQuad(this._b.open);
    p.revealSpread = c.scrapRevealSpread;

    p.silhouette = Silhouette.LEAF;
    p.edgeGain = 1;
    // Lit, not emissive. This is the school where that is the whole point.
    p.lit = 1;
    p.tint = c.scrapTint;
    p.tintJitter = c.scrapTintJitter * g.randomness;
    p.tintAlong = c.scrapTintAlong;
    p.opacity = c.scrapOpacity * g.opacity * b.fade;
    p.glow = c.scrapGlow * g.glow;
    p.softFade = c.scrapSoftFade;

    this.scraps.setColors(c.colorScrapA, c.colorScrapB, c.colorScrapC, c.colorScrapD);
    _basis.copy(this.side).negate();
    this.scraps.setBasis(this.origin, this.direction, _basis, this.length);
    this.scraps.update(this.age, p);
  }

  /** The two particle systems, re-coloured and re-scaled every frame. */
  _syncParticles() {
    const c = settings.origami;
    const g = settings.global;

    this.dust.setGradient(
      getColor(c.colorDustA),
      getColor(c.colorDustB),
      getColor(c.colorDustC),
      getColor(c.colorDustD)
    );
    this.dust.uniforms.uGravity.value.set(0, c.dustRise, 0);
    this.dust.uniforms.uSizeScale.value = c.dustSize * g.particleSize;
    this.dust.uniforms.uLifeScale.value = c.dustLifetime * 0.5 * g.particleLifetime;
    this.dust.uniforms.uSpeedScale.value = g.particleSpeed;
    this.dust.uniforms.uOpacity.value = c.dustOpacity * g.opacity;
    this.dust.uniforms.uTurbulence.value = c.dustTurbulence * g.turbulence;

    this.chaff.setGradient(
      getColor(c.colorChaffA),
      getColor(c.colorChaffB),
      getColor(c.colorChaffC),
      getColor(c.colorChaffD)
    );
    this.chaff.uniforms.uGravity.value.set(0, c.chaffGravity, 0);
    this.chaff.uniforms.uSizeScale.value = c.chaffSize * g.particleSize * 7;
    this.chaff.uniforms.uLifeScale.value = c.chaffLifetime * 0.5 * g.particleLifetime;
    this.chaff.uniforms.uSpeedScale.value = g.particleSpeed;
    this.chaff.uniforms.uOpacity.value = g.opacity;
  }

  /**
   * A point on a live sheet, in world space.
   *
   * `sheetPoint` is the CPU mirror of the *placement* half of the vertex
   * shader — it deliberately does not mirror the fold, so this is where the
   * bird is rather than where its left wing got to, which is all an emitter
   * needs. Handed the same params block the paper was synced with on this
   * frame, so the two cannot disagree.
   */
  _sheetPoint(out) {
    const count = Math.max(1, Math.round(_paper.count));
    return this.paper.sheetPoint(Math.floor(Math.random() * count), _paper, out);
  }

  /**
   * Dust and chaff shed off the flock.
   *
   * @param {number} scale 0..1 — the emission ramp, so the shedding follows the
   *   unfold rather than running at a flat rate for the whole cast
   */
  _flockFx(dt, scale) {
    const c = settings.origami;
    const g = settings.global;
    const time = frame.uTime.value;
    if (scale <= 0) return;

    const dustCount = Math.round(this.dustEmitter.tick(dt, c.dustRate * scale) * g.particleCount);
    if (dustCount > 0) {
      this._sheetPoint(_pos);
      _emit.position = _pos;
      _emit.radius = c.sheetWidth * 0.9;
      _emit.anchor = null;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.dustSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = c.dustSpread;
      _emit.inherit = null;
      _emit.size = 0.5;
      _emit.sizeVariance = 0.5;
      _emit.life = c.dustLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.3;
      _emit.tint = null;
      _emit.time = time;
      this.dust.emit(dustCount, _emit);
    }

    const chaffCount = Math.round(this.chaffEmitter.tick(dt, c.chaffRate * scale) * g.particleCount);
    if (chaffCount > 0) {
      this._sheetPoint(_pos);
      _emit.position = _pos;
      _emit.radius = c.sheetWidth * 0.7;
      _emit.anchor = null;
      // Thrown backwards and up: the flock is moving forward, so what comes off
      // it goes the other way. Copying `direction` and negating is what makes
      // the chaff read as *shed* rather than as fired.
      _emit.direction = _dir.copy(this.direction).multiplyScalar(-0.5).setY(0.7).normalize();
      _emit.speed = c.chaffSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = c.chaffSpread;
      _emit.inherit = null;
      _emit.size = 0.12;
      _emit.sizeVariance = 0.65;
      _emit.life = c.chaffLifetime;
      _emit.lifeVariance = 0.45;
      _emit.spin = c.chaffSpin;
      _emit.tint = null;
      _emit.time = time;
      this.chaff.emit(chaffCount, _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._resolveBeats(0);
    this._sync();
    // Almost nothing while the birds are still folded: a crane in flight sheds
    // a little dust and no chaff at all. The ramp is the fly beat itself, so a
    // long cast sheds more than a short one.
    this._flockFx(dt, this._b.fly * 0.15);
    this.ctx.shake.rumble(settings.origami.rumble * settings.global.cameraShake, dt);
  }

  /** THE UNFOLD — the frame the flock starts to come apart. */
  onImpact() {
    const c = settings.origami;
    const g = settings.global;
    const time = frame.uTime.value;

    this._resolveBeats(0);
    this._sync();

    /* the ring of dust the flock knocks off the floor beneath it */
    this.pointAt(1, _pos);
    this.ctx.decals.spawn(DecalType.DUSTRING, _pos, {
      radius: c.ringRadius * g.explosionIntensity,
      life: c.ringLife,
      intensity: c.ringIntensity,
      growth: 0.6,
      colorA: getColor(c.colorRingA),
      colorB: getColor(c.colorRingB),
      height: 0.012
    });

    /* the torn corners, thrown from the flock rather than from the floor */
    this._sheetPoint(_pos);
    _emit.position = _pos;
    _emit.radius = c.stretch * 0.5;
    _emit.anchor = null;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(-0.35).setY(0.85).normalize();
    _emit.speed = c.chaffSpeed * 1.4;
    _emit.speedVariance = 0.85;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.size = 0.14;
    _emit.sizeVariance = 0.75;
    _emit.life = c.chaffLifetime * 1.2;
    _emit.lifeVariance = 0.5;
    _emit.spin = c.chaffSpin * 1.3;
    _emit.tint = null;
    _emit.time = time;
    this.chaff.emit(Math.round(c.chaffBurst * g.particleCount), _emit);

    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.dustSpeed * 1.6;
    _emit.spread = 1.0;
    _emit.size = 0.6;
    _emit.life = c.dustLifetime * 1.15;
    _emit.spin = 0.4;
    this.dust.emit(Math.round(c.dustBurst * g.particleCount), _emit);

    this.ctx.shake.add(
      c.openShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      18
    );
    // No `ctx.flash`. Deliberately: see the class header. Paper coming apart is
    // not an explosion and the ink school does not get a screen flash.
    this.lightBoost = c.lightIntensity * 0.25 * g.explosionIntensity;
  }

  onFade(dt, t) {
    this._resolveBeats(t);
    this._sync();

    const b = this._b;
    // Shedding peaks while the creases are actually moving and stops once the
    // sheets are flat: `1 − open` is the rate the fold is still changing at, to
    // within an easing, and it costs nothing to reuse it.
    const opening = t <= 1 ? 1 - Easing.inQuad(b.open) : 0;
    this._flockFx(dt, opening);

    if (t <= 1) {
      this.ctx.shake.rumble(settings.origami.rumble * settings.global.cameraShake, dt);
    }
  }

  onDestroy() {
    this.paper.reset();
    this.scraps.reset();
  }

  dispose() {
    this.paper.dispose();
    this.scraps.dispose();
    super.dispose();
  }
}
