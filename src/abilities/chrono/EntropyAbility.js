import { Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { DistortionField, DistortionMode, DistortionFacing } from '../../vfx/Distortion.js';
import { sceneHooks, Hook } from '../../vfx/SceneHooks.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, clamp, lerp, Easing, randRange } from '../../utils/math.js';

const TAU = Math.PI * 2;

/* Module-scope scratch. Nothing in the frame path allocates — invariant I3. */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _centre = new Vector3();
const _front = {};

/**
 * ENTROPY WAVE — one number ages a material.
 *
 * A ring of decay crosses the floor, the whole circle stands rusted, mossed,
 * pitted and bleached for a beat, and then the decay collapses back to the
 * point it came from and the stone is exactly what it was.
 *
 * ## THE TRICK — the floor is a real PBR material, so this is a patch, not a decal
 *
 * The only thing this ability really does is hold **`Hook.AGE`** and write one
 * 0..1 into it every frame. `vfx/SceneHooks.js` has already patched the ground's
 * `MeshStandardMaterial` at `<metalnessmap_fragment>`, which is the single
 * injection point in three's physical shader where `diffuseColor`,
 * `roughnessFactor` *and* `metalnessFactor` are all in scope and all still
 * mutable. Five terms come off that one field and each one moves a different
 * channel:
 *
 * | term | what it moves |
 * | --- | --- |
 * | rust | albedo toward the picker, roughness up, **metalness up** |
 * | dust | albedo, roughness hard up, metalness down |
 * | moss | albedo in the low-frequency hollows, metalness down |
 * | pit | albedo down in specks, roughness up |
 * | bleach | desaturate and lift whatever survived the other four |
 *
 * Metalness is the whole reason this does not read as a coloured circle painted
 * on clean stone. Rust that has gone metallic catches the key light at a
 * different angle from the stone next to it, and the eye reads *a different
 * substance* before it reads the colour. Drag `wearRust` to zero with the other
 * four at full and the effect collapses back into a stain — that comparison is
 * the fastest way to see what the ability is.
 *
 * ## The sweep, and why the retreat is hollow
 *
 * `lead` is the leading edge, a fraction of `fieldSpread × zoneRadius`. It runs
 * out, holds, and comes back. One number: the age token's radius, the
 * refraction ring's wavefront and the annulus the particles are seeded in are
 * all it, so the shimmer, the flakes and the rust cannot end up a frame apart.
 *
 * The retreat also lifts the token's **inner cut** (`retreatTrail`), which turns
 * the shrinking disc into a shrinking *ring*. The version without it is a blob
 * that gets smaller, and a blob that gets smaller reads as a fade — the eye
 * needs a trailing edge to see a wave going back the way it came.
 *
 * ## What is drawn: almost nothing, on purpose
 *
 * One draw call. A `DistortionField` in `SHOCK` mode lying flat on the floor is
 * the front, and three particle systems shed off the ground behind it. There is
 * deliberately no `GroundField` under this: a ground quad drawing its own rust
 * would be a decal sitting on top of a material that is already rusting, and
 * the two would disagree at the edges. The ability that ages the world should
 * not also be carrying a picture of the world ageing.
 *
 * `frontDepthReject` ships at **0**, and it is the first thing to check if the
 * ring vanishes. The quad lies on the surface it is bending, so the emitter's
 * occlusion term — which rejects fragments that opaque geometry sits in front
 * of — throws the entire ring away. This is the same trap `SingularityAbility`
 * documents for its lens, in the one other place in the project where an
 * emitter is coplanar with what it distorts.
 *
 * ## The particles are a read-back, not a second opinion
 *
 * A mote, a flake or a spore is seeded at a random point in the live annulus,
 * and the *rate* at that point is `sceneHooks.ageAt(x, z)` — the CPU mirror of
 * the same `sceneAgeField()` the floor's shader runs, smoothstep for smoothstep.
 * So dust only lifts where the ground has actually pitted, and the shed thins
 * out through the field's soft edge instead of stopping at a circle nobody drew.
 * The flakes are additionally gated on `rustOnset` and the spores on
 * `mossOnset`, because rust flakes cannot come off a floor that has not rusted.
 *
 * ## Restore is exact, and the ability does not do it
 *
 * Nothing here puts the floor back. `this.borrow()` hands the token to the
 * ledger and the ledger writes the neutral on release, on every one of the four
 * ways a cast can end — three of which are not this ability's idea. An earlier
 * draft did it by hand in `onDestroy()` and it was correct right up until the
 * concurrency cap destroyed a cast mid-sweep from a code path that had already
 * been torn down, at which point the floor stayed rusted until reload. That is
 * the failure `SceneHooks` exists to make unrepresentable, and the correct
 * amount of restore code in this file is none.
 *
 * ## What a cast captures
 *
 * `_seed` and three fired-yet flags. Every metre, second and fraction — the
 * radius, the five weights, the five onsets, the grain, the three durations —
 * is resolved from `settings.entropy` inside the update loop, zero-length
 * frames included. Pause with **P** at full spread and drag `wearMoss`: the
 * floor greens under a stopped clock.
 */
export class EntropyAbility extends Ability {
  constructor(context) {
    super('entropy', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /**
     * The front. `GROUND` facing rather than `BILLBOARD`: the wave is a thing
     * happening *to the floor*, so its plane is the floor's, and a billboard
     * would stand the ring up and turn it into a bubble as soon as you orbit.
     */
    this.ring = new DistortionField({
      mode: DistortionMode.SHOCK,
      facing: DistortionFacing.GROUND,
      name: 'Entropy:front'
    });
    this.group.add(this.ring.object3D);

    /**
     * Park the ageing block where the harness's pause probe looks (I8, and
     * `SceneHooks#observe`). This ability's main output is a hook, so without
     * this it owns almost no uniforms and reads as a dead slider bank while it
     * is rusting the stage.
     */
    sceneHooks.observe(this.ring.material);

    /** Re-rolled per cast. The only dice roll. */
    this._seed = 0;
    /** Fired-yet flags. Events, not dimensions. */
    this._peaked = false;
    this._restored = false;
    /** The live age token, or null between casts. */
    this._age = null;

    /**
     * The cast's beats, all unitless, refilled every frame. One object, reused.
     *
     *   lead    0..1  leading edge, as a fraction of the field radius
     *   inner   0..1  the token's inner cut — the retreat's trailing edge
     *   amount  0..1  strength of the whole field; the master
     *   age     0..1  how old the zone is, which is what the five onsets read
     *   move    0..1  1 while the front is travelling, 0 while it is parked
     */
    this._b = { lead: 0, inner: 0, amount: 0, age: 0, move: 1 };
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Fine dust lifting out of the pitting. Non-additive: this school does not
    // glow, and dust that adds light reads as embers.
    this.motes = particles.get('entropy.motes', {
      capacity: 1600,
      shape: ParticleShape.SOFT,
      additive: false,
      curl: true,
      softFade: 0.5
    });
    this.motes.uniforms.uDrag.value = 1.7;
    this.motes.uniforms.uEndSize.value = 1.6;
    this.motes.uniforms.uSizeIn.value = 0.1;
    this.motes.uniforms.uFadeIn.value = 0.15;
    this.motes.uniforms.uFadeOut.value = 0.35;

    // Rust flakes peeling off. Lit chips — they are matter, and they have to
    // be silhouetted against the floor rather than lighting it.
    this.flakes = particles.get('entropy.flakes', {
      capacity: 900,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.flakes.uniforms.uDrag.value = 1.1;
    this.flakes.uniforms.uEndSize.value = 0.6;
    this.flakes.uniforms.uSizeIn.value = 0.05;
    this.flakes.uniforms.uFadeOut.value = 0.5;

    // Moss spores, once there is moss. LEAF rather than SOFT so they are not a
    // third cloud of round blobs; the silhouette is the only thing separating
    // them from the dust at this size.
    this.spores = particles.get('entropy.spores', {
      capacity: 900,
      shape: ParticleShape.LEAF,
      additive: false,
      lit: true,
      softFade: 0.4
    });
    this.spores.uniforms.uDrag.value = 1.9;
    this.spores.uniforms.uEndSize.value = 0.9;
    this.spores.uniforms.uSizeIn.value = 0.08;
    this.spores.uniforms.uFadeIn.value = 0.2;
    this.spores.uniforms.uFadeOut.value = 0.4;

    this.moteEmitter = new RateEmitter();
    this.flakeEmitter = new RateEmitter();
    this.sporeEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  /** Nothing here is instanced: one ground quad and the floor's own material. */
  get instanceCount() {
    return 0;
  }

  /** The spread and the hold share the impact phase. */
  get impactDuration() {
    const c = settings.entropy;
    return Math.max(0.05, (c.spreadTime + c.holdTime) * settings.global.lifetime);
  }

  /**
   * The retreat owns the whole fade phase. There is no fourth window: a
   * "settle" after the retreat was a second of an empty floor with the cast
   * still nominally live, and folding the wash-out into the back of the retreat
   * (`restoreHold`) says the same thing while the ring is still moving.
   */
  get fadeDuration() {
    return Math.max(0.05, settings.entropy.retreatTime);
  }

  /**
   * A light cannot be negative, so the honest move for an ability whose subject
   * is *loss* is to under-drive the light and take it further down as the field
   * peaks. The floor's own darkening — pitting and dust both cut albedo — does
   * the rest, and it does it in the material rather than in the lighting, which
   * is the only place it can look like decay instead of like a dimmer.
   */
  lightShimmer() {
    return 1 - saturate(settings.entropy.lightDrain) * this._b.amount;
  }

  /* ------------------------------------------------------------------ */
  /* The beats                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * How far through its own onset a wear term is, 0..1.
   *
   * The five terms all read the same `age` beat and differ only in when they
   * are allowed to start. Rescaling the remainder — rather than simply clamping
   * — means a term with a late onset still reaches full strength by the time
   * the zone is fully aged, so raising `mossOnset` makes the moss *arrive*
   * later rather than end up weaker, which is what the slider says it does.
   */
  _onset(delay) {
    const d = saturate(delay);
    return saturate((this._b.age - d) / Math.max(1 - d, 1e-3));
  }

  /**
   * Refill `this._b`.
   *
   * @param {number} t 0..1 through the impact phase, then 1..2 through the fade
   */
  _resolveBeats(t) {
    const c = settings.entropy;
    const b = this._b;

    if (this.phase === AbilityPhase.TRAVEL) {
      const reach = saturate(c.seedReach) * Easing.outQuad(this.u);
      b.lead = reach;
      b.inner = 0;
      b.amount = reach;
      b.age = 0;
      b.move = 1;
      return;
    }

    if (t <= 1) {
      const total = Math.max(1e-3, c.spreadTime + c.holdTime);
      const spread = saturate(c.spreadTime / total);
      if (t < spread) {
        const k = saturate(t / Math.max(spread, 1e-3));
        // A power rather than an easing curve: `spreadCurve` below 1 makes the
        // front leave hard and arrive slowly, which is how a front that is
        // running out of energy behaves, and it is a slider because the
        // opposite reading — a wave that accelerates — is also a look.
        b.lead = lerp(saturate(c.seedReach), 1, Math.pow(k, Math.max(0.05, c.spreadCurve)));
        b.amount = Easing.outCubic(k);
        b.move = 1;
      } else {
        b.lead = 1;
        b.amount = 1;
        b.move = 0;
      }
      b.inner = 0;
      b.age = saturate(t);
      return;
    }

    const s = saturate(t - 1);
    b.lead = 1 - Math.pow(s, Math.max(0.05, c.retreatCurve));
    // The trailing edge. Without it the aged disc shrinks as a blob, and a blob
    // that shrinks reads as a fade rather than as a wave going home.
    b.inner = clamp(c.retreatTrail * s, 0, 0.98);
    const hold = saturate(c.restoreHold);
    b.amount = 1 - Easing.inQuad(saturate((s - hold) / Math.max(1 - hold, 1e-3)));
    b.age = 1;
    b.move = 1;
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  /** The centre of the circle. Rides the front while the cast is travelling. */
  _zoneCentre(out) {
    const s = this.phase === AbilityPhase.TRAVEL ? this.u : 1;
    return this.pointAt(s, out);
  }

  /** The field's outer radius at full spread, metres. */
  _fieldRadius() {
    const c = settings.entropy;
    return Math.max(0.05, c.fieldSpread * c.zoneRadius);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.moteEmitter.reset();
    this.flakeEmitter.reset();
    this.sporeEmitter.reset();
    this._peaked = false;
    this._restored = false;
    this._seed = Math.random() * 100;

    // The world, borrowed. Released by the base class however the cast ends —
    // see the class doc on why none of the restore lives in this file.
    this._age = this.borrow(sceneHooks.acquire(Hook.AGE, this));

    this.ring.visible = true;

    this._resolveBeats(0);
    this._sync();
    this._castFx();
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Write the field, publish it, then draw everything that reads it.
   *
   * `sceneHooks.apply()` is idempotent — every hook blends from `settings`
   * rather than from the live value — so calling it here and again from
   * `App.frame` costs a pass over six short arrays and changes nothing. It is
   * called here because the particles below read the *published* block through
   * `sceneHooks.ageAt()`, and because the harness's pause probe cannot see a
   * hook-only ability until something has actually written the uniforms.
   */
  _sync() {
    this._zoneCentre(_centre);
    this._syncAge();
    sceneHooks.apply();
    this._syncFront();
    this._syncParticles();

    // The light sits at the centre of the circle, a little off the floor.
    this.position.copy(_centre);
    this.position.y = settings.entropy.frontLift;
  }

  /** The one field. Five weights, five onsets, one radius. */
  _syncAge() {
    const c = settings.entropy;
    const b = this._b;
    if (!this._age) return;

    const radius = Math.max(0.05, this._fieldRadius() * Math.max(b.lead, 1e-3));

    this._age
      .atPoint(_centre)
      .field(
        radius,
        clamp(c.fieldEdge, 0.01, 1),
        saturate(c.fieldAmount) * saturate(b.amount),
        clamp(b.inner, 0, 0.98)
      )
      .wear(
        c.wearRust * this._onset(c.rustOnset),
        c.wearDust * this._onset(c.dustOnset),
        c.wearMoss * this._onset(c.mossOnset),
        c.wearPit * this._onset(c.pitOnset),
        c.wearBleach * this._onset(c.bleachOnset)
      )
      .scale(Math.max(0.05, c.fieldGrain))
      .colours(c.colorRust, c.colorDust, c.colorMoss)
      .blend(1);
  }

  /**
   * The refraction ring riding the leading edge.
   *
   * Magnitudes are **screen fractions**; the post pass multiplies by
   * `post.distortion × global.distortion` exactly once, so nothing in this
   * method may touch either of them.
   */
  _syncFront() {
    const c = settings.entropy;
    const b = this._b;
    const extent = this._fieldRadius();

    // The quad has to be exactly twice the falloff radius or the window is cut
    // off square at the corners.
    _front.width = extent * 2;
    _front.height = extent * 2;
    _front.radius = extent;
    _front.wave = extent * saturate(b.lead);
    _front.thickness = c.frontThickness;
    _front.compression = c.frontCompression;
    _front.rarefaction = c.frontRarefaction;
    _front.rings = c.frontRings;
    _front.ringGap = c.frontRingGap;
    _front.ringDecay = c.frontRingDecay;
    _front.window = c.frontWindow;
    _front.maxOffset = c.frontMaxOffset;

    // A parked front still shimmers, but only a little: the read is that the
    // damage is being *done* while the ring is moving.
    _front.strength =
      c.frontStrength * saturate(b.amount) * lerp(saturate(c.frontFalloff), 1, saturate(b.move));
    _front.opacity = c.frontOpacity * saturate(b.amount);
    _front.depthReject = c.frontDepthReject;
    _front.depthFade = c.frontDepthFade;
    _front.perspective = c.frontPerspective;
    _front.perspectiveRef = c.frontPerspectiveRef;
    _front.seed = this._seed;

    this.ring.setAnchorXYZ(_centre.x, c.frontLift, _centre.z);
    this.ring.update(_front);
  }

  /** The three particle systems, re-coloured and re-scaled every frame. */
  _syncParticles() {
    const c = settings.entropy;
    const g = settings.global;

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
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;

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

    this.spores.setGradient(
      getColor(c.colorSporeA),
      getColor(c.colorSporeB),
      getColor(c.colorSporeC),
      getColor(c.colorSporeD)
    );
    this.spores.uniforms.uGravity.value.set(0, c.sporeRise, 0);
    this.spores.uniforms.uSizeScale.value = c.sporeSize * g.particleSize * 7;
    this.spores.uniforms.uLifeScale.value = c.sporeLifetime * 0.5 * g.particleLifetime;
    this.spores.uniforms.uSpeedScale.value = g.particleSpeed;
    this.spores.uniforms.uOpacity.value = g.opacity;
    this.spores.uniforms.uGlow.value = c.sporeGlow * g.glow;
    this.spores.uniforms.uTurbulence.value = c.sporeTurbulence * g.turbulence;
  }

  /**
   * A random point in the live annulus, on the floor.
   *
   * `sqrt` on the radial fraction, because a uniform fraction of the radius
   * piles every sample into the middle: area goes as r², so the inverse-CDF is
   * the square root. The first version did not, and the shed came off a
   * bullseye at the centre of the zone with nothing at the rim, which is
   * exactly backwards for a wave.
   */
  _annulusPoint(out) {
    const b = this._b;
    const extent = this._fieldRadius();
    const outer = Math.max(0.05, extent * saturate(b.lead));
    const inner = outer * clamp(b.inner, 0, 0.98);
    const bearing = Math.random() * TAU;
    const u = Math.random();
    const r = Math.sqrt(inner * inner + u * (outer * outer - inner * inner));
    out.copy(_centre);
    out.x += Math.cos(bearing) * r;
    out.z += Math.sin(bearing) * r;
    out.y = 0;
    return out;
  }

  /**
   * What comes off the floor.
   *
   * Each system samples one point in the annulus and asks the **published**
   * field how aged the ground is there; that answer scales the rate. So the
   * shed thins out through the field's own soft edge instead of stopping at a
   * circle, and it cannot appear anywhere the shader has not rusted. It is the
   * CPU mirror of `sceneAgeField()`, smoothstep for smoothstep, which is what
   * makes "cannot" true rather than approximately true.
   *
   * @param {number} scale 0..1, thinned once the wave is only holding
   */
  _shedFx(dt, scale) {
    const c = settings.entropy;
    const g = settings.global;
    const time = frame.uTime.value;
    const bias = saturate(c.ageBias);

    /* --- dust out of the pitting --- */
    this._annulusPoint(_pos);
    let bite = sceneHooks.ageAt(_pos.x, _pos.z);
    let count = Math.round(
      this.moteEmitter.tick(dt, c.moteRate * scale * (bite > bias ? bite : 0)) * g.particleCount
    );
    if (count > 0) {
      _pos.y = randRange(0.02, 0.22);
      _emit.position = _pos;
      _emit.radius = 0.35;
      _emit.anchor = null;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.75;
      _emit.spread = 0.95;
      _emit.inherit = null;
      _emit.size = 0.5;
      _emit.sizeVariance = 0.6;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.2;
      _emit.tint = null;
      _emit.time = time;
      this.motes.emit(count, _emit);
    }

    /* --- rust flakes: gated on the rust term's own onset --- */
    this._annulusPoint(_pos);
    bite = sceneHooks.ageAt(_pos.x, _pos.z) * this._onset(c.rustOnset);
    count = Math.round(
      this.flakeEmitter.tick(dt, c.flakeRate * scale * (bite > bias ? bite : 0)) * g.particleCount
    );
    if (count > 0) {
      _pos.y = randRange(0.02, 0.14);
      // Flakes lift and blow outward from the centre — the direction the front
      // that loosened them was going.
      _dir.set(_pos.x - _centre.x, 0, _pos.z - _centre.z);
      if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, 1);
      _dir.normalize().setY(0.85).normalize();

      _emit.position = _pos;
      _emit.radius = 0.25;
      _emit.anchor = null;
      _emit.direction = _dir;
      _emit.speed = c.flakeSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.6;
      _emit.inherit = null;
      _emit.size = 0.12;
      _emit.sizeVariance = 0.7;
      _emit.life = c.flakeLifetime;
      _emit.lifeVariance = 0.45;
      _emit.spin = c.flakeSpin;
      _emit.tint = null;
      _emit.time = time;
      this.flakes.emit(count, _emit);
    }

    /* --- moss spores: gated on the moss term's onset, so they are last --- */
    this._annulusPoint(_pos);
    bite = sceneHooks.ageAt(_pos.x, _pos.z) * this._onset(c.mossOnset);
    count = Math.round(
      this.sporeEmitter.tick(dt, c.sporeRate * scale * (bite > bias ? bite : 0)) * g.particleCount
    );
    if (count > 0) {
      _pos.y = randRange(0.02, 0.3);
      _emit.position = _pos;
      _emit.radius = 0.4;
      _emit.anchor = null;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.sporeSpeed;
      _emit.speedVariance = 0.85;
      _emit.spread = 1;
      _emit.inherit = null;
      _emit.size = 0.1;
      _emit.sizeVariance = 0.75;
      _emit.life = c.sporeLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 2.5;
      _emit.tint = null;
      _emit.time = time;
      this.spores.emit(count, _emit);
    }
  }

  /** The seed leaving the caster's hand. */
  _castFx() {
    const c = settings.entropy;
    const g = settings.global;

    _pos
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .setY(c.handHeight);

    this.ctx.bursts.spawn(BurstMode.EARTH, _pos, {
      radius: c.castBurstSize * 0.3,
      endRadius: c.castBurstSize * g.explosionIntensity,
      life: 0.4,
      intensity: c.castBurstIntensity,
      opacity: 0.7,
      fresnel: 2.0,
      displace: 0.35,
      colorA: getColor(c.colorCastA),
      colorB: getColor(c.colorCastB),
      colorC: getColor(c.colorCastC)
    });

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._resolveBeats(0);
    this._sync();
    this._shedFx(dt, saturate(this._b.amount));
  }

  /** The seed lands and the wave starts across the floor. */
  onImpact() {
    const c = settings.entropy;
    const g = settings.global;

    this._resolveBeats(0);
    this._zoneCentre(_pos);

    this.ctx.decals.spawn(DecalType.DUSTRING, _pos, {
      radius: this._fieldRadius() * 0.4 * g.explosionIntensity,
      life: 1.3,
      intensity: 0.8,
      colorA: getColor(c.colorCastA),
      colorB: getColor(c.colorCastB)
    });

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      14
    );
    this.lightBoost = c.lightIntensity * 0.4 * g.explosionIntensity;
  }

  onFade(dt, t) {
    this._resolveBeats(t);
    const b = this._b;

    // The wave reaching the rim. A flag on the beat rather than a timestamp:
    // re-timing `spreadTime` mid-cast moves the moment with it.
    if (!this._peaked && b.lead >= 0.995 && t <= 1) {
      this._peaked = true;
      this._peakFx();
    }
    // The floor beginning to come back — the first frame the wear is falling.
    if (!this._restored && t > 1 && b.amount < 0.999) {
      this._restored = true;
      this._restoreFx();
    }

    this._sync();
    this._shedFx(dt, t <= 1 ? 1 : saturate(b.amount));

    if (t <= 1) {
      this.ctx.shake.rumble(settings.entropy.rumble * settings.global.cameraShake, dt);
    }
  }

  /** The front arriving at the rim. */
  _peakFx() {
    const c = settings.entropy;
    const g = settings.global;

    this._zoneCentre(_pos);
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _pos, {
      radius: c.peakRingRadius * g.explosionIntensity,
      life: 1.1,
      width: 0.06,
      intensity: c.peakRingIntensity,
      colorA: getColor(c.colorRingA),
      colorB: getColor(c.colorRingB)
    });
  }

  /** The stone coming back. Deliberately the quietest beat in the ability. */
  _restoreFx() {
    const c = settings.entropy;
    const g = settings.global;

    this.ctx.flash.trigger(getColor(c.colorRestoreFlash), c.restoreFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.3 * g.explosionIntensity;
  }

  onDestroy() {
    // The token is given back by the base class through `borrow()`, which is
    // what neutralises the floor exactly. Nothing is restored here on purpose —
    // see the class doc.
    this._age = null;
    this._peaked = false;
    this._restored = false;
    this.ring.visible = false;
    this._b.amount = 0;
    this._b.lead = 0;
  }

  dispose() {
    this.ring.dispose();
    super.dispose();
  }
}
