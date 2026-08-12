import { Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { FoldMesh, FoldPattern, FoldLayout, foldMeshParams } from '../../vfx/FoldMesh.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, Easing } from '../../utils/math.js';

/** Hard ceiling on scrolls. The editor's `scrolls` slider clamps here. */
const MAX_SCROLLS = 20;
/**
 * Grid resolution across a scroll, and along it.
 *
 * `UNROLL` spends almost everything on the second number. Across the sheet the
 * paper is dead straight and ten quads is generous; *along* it the sheet has to
 * resolve a spiral whose turns are a few centimetres across, and the roll is
 * the thing the eye goes to.
 *
 * The number that matters is **segments per turn**, and because the module
 * places by arc length it comes out constant for free:
 * `SEGMENTS_ALONG × 2πr / sheetLength`. At 80, a 60 mm core and the shipped
 * 3.2 m sheet that is a shade over ten all the way from a full roll to an empty
 * one — a decagon, which at the size a 13 cm roll occupies on screen is round.
 * Sixty-four gave eight and the roll read as a nut; the fix people reach for
 * first is a smaller `core`, which makes it *worse*, because a tighter roll has
 * more turns in the same length of paper and gets fewer segments each.
 */
const SEGMENTS_ACROSS = 10;
const SEGMENTS_ALONG = 80;

/* Module-scope scratch. Nothing in the frame path allocates — invariant I3. */
const _paper = foldMeshParams();
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _centre = new Vector3();
/** The mirrored side vector — see `_syncPaper`. Never `this.side` itself. */
const _basis = new Vector3();

/**
 * SCROLLWARD — a ring of scrolls that pays itself out into a wall of text.
 *
 * The cast lands on the aimed circle and a ring of rolled paper stands up
 * around it, spools uppermost. The spools climb; the paper hangs behind them;
 * a few seconds later there is a wall of writing at head height that you can
 * orbit and read from either side. Then the whole thing winds back onto its
 * rolls and goes.
 *
 * ## THE TRICK — cylindrical unrolling, placed by arc length
 *
 * The sheet is not a plane with a scrolling texture on it and it is not two
 * meshes crossfading. It is one continuous bend, and `FoldMesh`'s `UNROLL` mode
 * places every material point on it **by arc length measured from the free
 * end**:
 *
 *  - the paid-out run is an arc of constant curvature — paper remembers having
 *    been rolled — and this ability walks that curvature from `curlRoll` down
 *    to `curlFlat` as the payout grows, because a sheet with two metres still
 *    on the spool hangs with far more set in it than the same sheet fully out.
 *    That relaxation is why the wall straightens as it rises rather than
 *    keeping one lean the whole way up;
 *  - the wound part is a real Archimedean spiral, `r = √(r₀² + wt/π)` — the
 *    exact relation between wound length and radius for paper of thickness `t`
 *    on a core of radius `r₀`. It is **tightest at the spool** because that is
 *    what a square root does, not because anybody authored a taper.
 *
 * And then the part that makes it worth doing. Every mark on the paper — the
 * fibre grain, the laid lines, the writing — is a function of the **sheet
 * coordinate** and of nothing else, so the text is printed on the material
 * rather than projected onto the surface. The foreshortening as a column of
 * characters turns onto the roll is therefore free, and it is *right*: the
 * shader never learns it is on a curve, and the writing compresses where it
 * does because the paper it is on genuinely is compressed there in screen
 * space. Place the sheet by *fraction* instead of by arc length — which is the
 * obvious implementation, and it is one line shorter — and a tight inner turn
 * and a flat metre of run are declared the same amount of material: the text
 * bunches at the spool, stretches on the run, and the whole illusion is gone.
 *
 * ## The wall
 *
 * `FoldLayout.ZONE` stands the scrolls upright on a circle facing outward, so
 * the ring reads as a wall from outside and as a room from inside, and `arc`
 * turns it into a screen when a room is too much. They pay out **together**:
 * the layout has no per-instance stagger on `payout` and it should not have
 * one, because thirteen scrolls dropping raggedly reads as thirteen separate
 * events, and this is one. The variety comes from where they stand and how big
 * they are, all of it on unitless dice.
 *
 * ## What is not here
 *
 * **Nothing glows.** Ink is the matte school: the paper is the one tone-mapped
 * material in `src/vfx/`, the dust is non-additive so it occludes the wall
 * behind it, and there is no screen flash. The single lamp climbs inside the
 * ring with the wall, and it is there so that the paper's translucency has
 * something to be translucent *to* — the inside faces of the far scrolls glow
 * through and their writing shows as a shadow inside the sheet, which is the
 * one line in `FoldMesh`'s fragment shader that separates paper from card.
 *
 * ## The rule that makes the editor work
 *
 * A cast captures exactly one thing: `_seed`, so two rings do not stand in the
 * same places. It is an event and it carries no unit. Every metre — the ring,
 * the sheet, the core of the roll, the thickness of the paper — is resolved
 * from `settings.scrollward` inside the update loop, on a zero-length frame
 * included. Pause with **P** halfway
 * through the payout and drag `paper`: the roll swells, the spiral re-solves
 * with fatter turns, and the tangent point where the paper leaves it moves —
 * live, because the spiral is evaluated in the vertex shader from a uniform and
 * was never baked into anything.
 */
export class ScrollwardAbility extends Ability {
  constructor(context) {
    super('scrollward', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /* --- the wall. One draw call for every scroll in it. --- */
    this.paper = new FoldMesh(this.group, {
      pattern: FoldPattern.UNROLL,
      layout: FoldLayout.ZONE,
      capacity: MAX_SCROLLS,
      segments: SEGMENTS_ACROSS,
      segmentsV: SEGMENTS_ALONG,
      renderOrder: 4,
      name: 'Scrollward:scrolls'
    });

    /** Re-rolled per cast so no two rings stand in the same places. */
    this._seed = 0;

    /**
     * The cast's beats, all unitless, refilled every frame. One object, reused.
     *
     *   pay    0..1  how far through the payout the wall is
     *   appear 0..1  the wave that brings the scrolls into being
     *   wind   0..1  how far through the wind-back it is
     *   fade   1..0  master opacity
     */
    this._b = { pay: 0, appear: 0, wind: 0, fade: 1 };
  }

  createParticles() {
    const particles = this.ctx.particles;

    // The dust that comes off a roll that has been somewhere for a long time.
    // Non-additive: it has to sit in front of the wall and dim it, and an
    // additive puff in front of bone-coloured paper is invisible anyway.
    this.dust = particles.get('scrollward.dust', {
      capacity: 1200,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 0.6
    });
    this.dust.uniforms.uDrag.value = 2.6;
    this.dust.uniforms.uEndSize.value = 2.4;
    this.dust.uniforms.uSizeIn.value = 0.16;
    this.dust.uniforms.uFadeIn.value = 0.2;
    this.dust.uniforms.uFadeOut.value = 0.45;

    // Flakes off the edge of an old sheet. `LEAF`, not `CHIP`: a flake of paper
    // has a chord and flutters, and a chip is a rock and does not.
    this.flakes = particles.get('scrollward.flakes', {
      capacity: 1000,
      shape: ParticleShape.LEAF,
      additive: false,
      lit: true,
      softFade: 0.3
    });
    this.flakes.uniforms.uDrag.value = 2.1;
    this.flakes.uniforms.uEndSize.value = 0.9;
    this.flakes.uniforms.uSizeIn.value = 0.07;
    this.flakes.uniforms.uFadeIn.value = 0.06;
    this.flakes.uniforms.uFadeOut.value = 0.55;

    this.dustEmitter = new RateEmitter();
    this.flakeEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this.paper.count;
  }

  /** The payout and the hold share the impact phase. */
  get impactDuration() {
    const c = settings.scrollward;
    return Math.max(0.05, (c.unrollTime + c.holdTime) * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.scrollward.windTime);
  }

  /** A lamp in a room, not a flame. It breathes with the paper. */
  lightShimmer() {
    return 1 + 0.05 * Math.sin(this.age * settings.scrollward.bobRate);
  }

  /* ------------------------------------------------------------------ */
  /* The beats — fractions only. Metres are resolved in the sync methods. */
  /* ------------------------------------------------------------------ */

  /**
   * @param {number} t 0..1 through the impact phase, then 1..2 through the fade
   */
  _resolveBeats(t) {
    const c = settings.scrollward;
    const b = this._b;

    if (this.phase === AbilityPhase.TRAVEL) {
      // The rolls are already lying on the circle; the cast is what wakes them.
      b.pay = 0;
      b.appear = Easing.outQuad(this.u);
      b.wind = 0;
      b.fade = 1;
      return;
    }

    b.appear = 1;

    if (t <= 1) {
      const payFrac = saturate(c.unrollTime / Math.max(c.unrollTime + c.holdTime, 1e-3));
      b.pay = saturate(t / Math.max(payFrac, 1e-3));
      b.wind = 0;
      b.fade = 1;
      return;
    }

    b.pay = 1;
    const s = saturate(t - 1);
    b.wind = s;
    // The wall has to be *seen* winding back, so it holds full opacity for the
    // first `windHold` of the fade and only then leaves. The first version
    // faded from the opening frame of the phase and the rewind — which is the
    // payout run backwards and the best half-second in the ability — happened
    // entirely inside a dissolve.
    const hold = saturate(c.windHold);
    b.fade = 1 - Easing.inCubic(saturate((s - hold) / Math.max(1 - hold, 1e-3)));
  }

  /**
   * The payout, 0..1 of the sheet off the roll — the module's one beat.
   *
   * Resolved here rather than in `_resolveBeats` because both ends of it are
   * *sliders*, and a beat that has read a slider is no longer a fraction of a
   * phase. Dragging `payoutEnd` while paused re-solves the spiral and moves the
   * tangent point, which is the whole demonstration.
   */
  _payout() {
    const c = settings.scrollward;
    const b = this._b;
    if (this.phase === AbilityPhase.TRAVEL) return c.payoutSeed;
    const out = lerp(c.payoutSeed, c.payoutEnd, Easing.outCubic(b.pay));
    return lerp(out, c.rewind, Easing.inOutCubic(b.wind));
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.dustEmitter.reset();
    this.flakeEmitter.reset();

    // The one thing a cast captures. Everything else is resolved per frame.
    this._seed = Math.random() * 100;
    this.paper.roll(this._seed);
    this.paper.visible = true;

    this._resolveBeats(0);
    this._sync();
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  _sync() {
    this._syncPaper();
    this._syncParticles();

    // The lamp climbs inside the ring with the wall, so the inside faces stay
    // lit as they rise. `lightHeight` is a fraction of the paid-out run, which
    // means it tracks `sheetLength` for free.
    const c = settings.scrollward;
    this.pointAt(1, this.position);
    this.position.y = c.lift + c.lightHeight * this._payout() * c.sheetLength;
  }

  /**
   * The ring.
   *
   * Two things here are not obvious and both cost time to find.
   *
   * **The basis.** `FoldMesh.setBasis(origin, direction, side)` derives its own
   * up as `direction × side`, and the base class's `side` is `direction ×
   * worldUp` — so the natural argument order hands it an up vector pointing at
   * the **floor**, and thirteen scrolls stand up *through* it. The mirrored side
   * is passed instead; the only visible consequence is which way round the ring
   * the bearings run, and the dice are symmetric.
   *
   * **The origin is the circle, not the caster.** A `ZONE` cast's `origin` is
   * where the player is standing and `pointAt(1)` is the footprint the
   * indicator drew. Hand `FoldMesh` the former and the ring stands round the
   * caster's ankles.
   */
  _syncPaper() {
    const c = settings.scrollward;
    const g = settings.global;
    const b = this._b;
    const p = _paper;
    const payout = this._payout();

    p.count = Math.max(0, Math.min(MAX_SCROLLS, Math.round(c.scrolls)));

    /* --- the sheet --- */
    p.sheetWidth = c.sheetWidth;
    p.sheetLength = c.sheetLength;
    p.aspect = c.aspect;
    p.sizeJitter = c.sizeJitter * g.randomness;
    p.thickness = c.thickness;

    /* --- the roll: the trick --- */
    p.payout = payout;
    p.core = c.core;
    p.paper = c.paper;
    // The run relaxes as it comes off: a sheet with most of its length still
    // wound hangs with far more set in it than the same sheet fully paid out.
    p.curl = lerp(c.curlRoll, c.curlFlat, saturate(payout));
    p.spoolClimb = c.spoolClimb;
    p.spin = c.spin;

    /* --- where the scrolls stand --- */
    p.radius = c.ringRadius * c.zoneRadius;
    p.radiusJitter = c.radiusJitter;
    p.arc = c.arc;
    p.arcPhase = c.arcPhase;
    p.lift = c.lift;
    p.liftJitter = c.liftJitter * g.randomness;
    p.bob = c.bob;
    p.bobRate = c.bobRate;

    /* --- attitude --- */
    p.pitch = c.pitch;
    p.yaw = 0;
    p.yawJitter = c.yawJitter * g.randomness;
    p.roll = 0;
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
    p.woundShade = c.woundShade;
    p.opacity = c.paperOpacity * g.opacity * b.fade;

    this.paper.setColors(c.colorPaper, c.colorShade, c.colorTransmit, c.colorInk, c.colorCrease);
    _basis.copy(this.side).negate();
    this.paper.setBasis(this.pointAt(1, _centre), this.direction, _basis, this.length);
    this.paper.update(this.age, p);
  }

  /** The two particle systems, re-coloured and re-scaled every frame. */
  _syncParticles() {
    const c = settings.scrollward;
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
    this.flakes.uniforms.uOpacity.value = g.opacity;
  }

  /**
   * Where a scroll's spool currently is, in world space.
   *
   * `spoolPoint` is the CPU mirror of the placement half of the vertex shader
   * plus the arc the paid-out run makes, so it climbs as the wall does — which
   * is exactly where the dust wants to come from, because the dust is what the
   * roll is shedding as it turns.
   */
  _spoolPoint(index, out) {
    const count = Math.max(1, Math.round(_paper.count));
    return this.paper.spoolPoint(index % count, _paper, out);
  }

  /**
   * Dust and flakes off the turning spools.
   *
   * @param {number} scale 0..1 — the emission ramp; the rolls shed while they
   *   are turning and stop when they stop
   */
  _wallFx(dt, scale) {
    const c = settings.scrollward;
    const g = settings.global;
    const time = frame.uTime.value;
    if (scale <= 0) return;

    const dustCount = Math.round(this.dustEmitter.tick(dt, c.dustRate * scale) * g.particleCount);
    if (dustCount > 0) {
      this._spoolPoint(Math.floor(Math.random() * MAX_SCROLLS), _pos);
      _emit.position = _pos;
      _emit.radius = c.sheetWidth * 0.6;
      _emit.anchor = null;
      // Downward and outward: dust falls off a turning roll, it is not blown
      // off one. The first version fired it up and the ring looked like it was
      // on fire, which in this school is the worst thing it could look like.
      _emit.direction = _dir.set(0, -1, 0);
      _emit.speed = c.dustSpeed;
      _emit.speedVariance = 0.75;
      _emit.spread = c.dustSpread;
      _emit.inherit = null;
      _emit.size = 0.45;
      _emit.sizeVariance = 0.5;
      _emit.life = c.dustLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.25;
      _emit.tint = null;
      _emit.time = time;
      this.dust.emit(dustCount, _emit);
    }

    const flakeCount = Math.round(this.flakeEmitter.tick(dt, c.flakeRate * scale) * g.particleCount);
    if (flakeCount > 0) {
      this._spoolPoint(Math.floor(Math.random() * MAX_SCROLLS), _pos);
      _emit.position = _pos;
      _emit.radius = c.sheetWidth * 0.5;
      _emit.anchor = null;
      _emit.direction = _dir.set(0, -0.35, 0).normalize();
      _emit.speed = c.flakeSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = c.flakeSpread;
      _emit.inherit = null;
      _emit.size = 0.1;
      _emit.sizeVariance = 0.6;
      _emit.life = c.flakeLifetime;
      _emit.lifeVariance = 0.45;
      _emit.spin = c.flakeSpin;
      _emit.tint = null;
      _emit.time = time;
      this.flakes.emit(flakeCount, _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._resolveBeats(0);
    this._sync();
    // Barely anything: the rolls are lying there waiting, and a roll that is
    // not turning does not shed. The ramp is the reveal, so a scroll that has
    // not appeared yet is not making dust either.
    this._wallFx(dt, this._b.appear * 0.12);
    this.ctx.shake.rumble(settings.scrollward.rumble * settings.global.cameraShake, dt);
  }

  /** THE STAND-UP — the frame the ring starts to pay out. */
  onImpact() {
    const c = settings.scrollward;
    const g = settings.global;
    const time = frame.uTime.value;

    this._resolveBeats(0);
    this._sync();

    /* dust knocked off the floor at the foot of a few of the scrolls */
    const marks = Math.max(0, Math.min(MAX_SCROLLS, Math.round(c.markCount)));
    const live = Math.max(1, Math.round(_paper.count));
    for (let i = 0; i < marks; i++) {
      // Spread across the live scrolls rather than taking the first N, so a
      // ring of thirteen with six marks gets them all the way round it.
      this.paper.sheetPoint(Math.floor((i * live) / Math.max(marks, 1)), _paper, _pos);
      this.ctx.decals.spawn(DecalType.DUSTRING, _pos, {
        radius: c.markRadius * g.explosionIntensity,
        life: c.markLife,
        intensity: c.markIntensity,
        growth: 0.35,
        colorA: getColor(c.colorMarkA),
        colorB: getColor(c.colorMarkB),
        height: 0.011
      });
    }

    /* the puff of a room's worth of old paper being moved at once */
    this.pointAt(1, _pos);
    _pos.y = c.lift;
    _emit.position = _pos;
    _emit.radius = c.ringRadius * c.zoneRadius;
    _emit.anchor = null;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.dustSpeed * 1.5;
    _emit.speedVariance = 0.8;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.size = 0.55;
    _emit.sizeVariance = 0.55;
    _emit.life = c.dustLifetime * 1.2;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0.3;
    _emit.tint = null;
    _emit.time = time;
    this.dust.emit(Math.round(c.dustBurst * g.particleCount), _emit);

    _emit.direction = _dir.set(0, 0.6, 0).normalize();
    _emit.speed = c.flakeSpeed * 1.6;
    _emit.spread = 1.0;
    _emit.size = 0.11;
    _emit.life = c.flakeLifetime;
    _emit.spin = c.flakeSpin * 1.2;
    this.flakes.emit(Math.round(c.flakeBurst * g.particleCount), _emit);

    this.ctx.shake.add(
      c.standShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      16
    );
    // No `ctx.flash`. Paper standing up is not an explosion, and the ink school
    // does not get a screen flash — see the class header.
    this.lightBoost = c.lightIntensity * 0.2 * g.explosionIntensity;
  }

  onFade(dt, t) {
    this._resolveBeats(t);
    this._sync();

    const b = this._b;
    // The rolls shed while they are turning, in either direction: hard through
    // the payout, and again while they wind back up.
    const turning = t <= 1 ? 1 - Easing.inQuad(b.pay) : Easing.outQuad(1 - b.wind) * 0.7;
    this._wallFx(dt, turning * b.fade);

    if (t <= 1) {
      this.ctx.shake.rumble(
        settings.scrollward.rumble * (1 - Easing.inQuad(b.pay)) * settings.global.cameraShake,
        dt
      );
    }
  }

  onDestroy() {
    this.paper.reset();
  }

  dispose() {
    this.paper.dispose();
    super.dispose();
  }
}
