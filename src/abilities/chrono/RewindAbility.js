import { BufferAttribute, BufferGeometry, Color, Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { GroundField, GroundMode, groundFieldParams } from '../../vfx/GroundField.js';
import { ShatterField, ShatterLayout, shatterParams } from '../../vfx/ShatterField.js';
import {
  timeField,
  timeRegionParams,
  reverseParams,
  reverseTime,
  reverseRate,
  RewindGate
} from '../../vfx/TimeControl.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, hash11, randRange } from '../../utils/math.js';

/**
 * Places along the line where the floor gives way, and therefore how many
 * `RewindGate`s the ability owns. A structural ceiling in the sense
 * `MAX_STRANDS` is in `ThunderAbility`: the gates are allocated once, and
 * `breakGap` decides how far apart in *time* they actually fire, so a cast can
 * use anywhere between one and all six of them without the array changing size.
 */
const BREAK_STATIONS = 6;
/** Fragment silhouettes. Two is the module's default and is right for rubble. */
const SHARD_VARIANTS = 2;
/** Ring size for the debris. Six stations × ~13 fragments, with headroom. */
const SHARD_CAPACITY = 128;

const TAU = Math.PI * 2;

/* Module-scope scratch. Nothing in the frame path allocates — invariant I3. */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _centre = new Vector3();
const _origin = new Vector3();
const _ground = groundFieldParams();
const _shatter = shatterParams();
const _warp = timeRegionParams();
const _beat = reverseParams();
const _look = {
  colorA: new Color(),
  colorB: new Color(),
  colorEdge: new Color(),
  colorScene: new Color(),
  opacity: 1,
  glow: 0,
  rim: 0,
  rimPower: 2,
  shade: 1,
  ambient: 0.3,
  fadeStart: 0.8,
  soft: 0.3,
  sceneMix: 0,
  refract: 0,
  saturation: 1
};

/**
 * One lump of floor, in unit space, for the break.
 *
 * Chunky and closed rather than the flat flakes `ChronofractureAbility` breaks
 * its panes into — this is stone coming out of the ground, and a flake reads as
 * glass at any size. Deterministic: every vertex comes off `hash11` rather than
 * `Math.random`, so two runs of the harness build byte-identical buffers and a
 * change in the geometry checksum means something actually changed.
 *
 * @param {number} variant 0 or 1 — a wedge and a block
 */
function createRubbleGeometry(variant) {
  const sides = 5 + variant * 2;
  const rings = 2;
  const count = sides * rings + 2;
  const positions = new Float32Array(count * 3);
  const indices = [];

  // Two rings between a bottom and a top point: the cheapest closed solid that
  // still has a silhouette. A box would be cheaper and reads as a crate.
  const write = (i, x, y, z) => {
    positions[i * 3 + 0] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
  };

  for (let r = 0; r < rings; r++) {
    const v = (r + 1) / (rings + 1);
    const y = (v - 0.5) * (0.7 + 0.5 * hash11(variant * 3.1 + r * 7.7));
    for (let i = 0; i < sides; i++) {
      const angle = (i / sides) * TAU + r * 0.4 + variant * 1.13;
      const radius = 0.32 + 0.5 * hash11(i * 5.19 + r * 11.7 + variant * 2.3);
      write(r * sides + i, Math.cos(angle) * radius, y, Math.sin(angle) * radius);
    }
  }
  const bottom = sides * rings;
  const top = bottom + 1;
  write(bottom, 0, -0.55 - 0.2 * hash11(variant * 9.7), 0);
  write(top, 0, 0.5 + 0.25 * hash11(variant * 13.3), 0);

  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    indices.push(bottom, j, i);
    indices.push(i, j, sides + j);
    indices.push(i, sides + j, sides + i);
    indices.push(sides + i, sides + j, top);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * REWIND — a gouge torn down the line, and then untorn.
 *
 * ## THE TRICK — there is no reverse code in this file
 *
 * Not one effect here is written twice. The floor is a `GroundField(RUT)` whose
 * track is a function of `progress`; the debris is a `ShatterField` whose every
 * fragment is a closed-form flight `p(t) = p₀ + (v₀ − g/k)(1 − e^{−kt})/k +
 * (g/k)t`; the dust is the shared particle system, which is nine attributes and
 * a trajectory evaluated fresh in the vertex shader. All three are pure
 * functions of a clock, and all three are handed the *same* clock:
 *
 *     reverseTime(age, p)   // forward at `rate` to `turnAt`, held, then back
 *
 * A number that goes up and then comes down. That is the ability. The roster
 * entry's "the reason it works is that every effect in this project is a
 * closed-form function of time" is not a boast, it is a load-bearing property,
 * and this slot exists to spend it.
 *
 * ## The closed form, not the integrator
 *
 * `vfx/TimeControl.js` ships both `reverseTime()` and `TimeWarpClock`, and this
 * uses the former for a reason that is easy to see and hard to undo: **an
 * accumulated clock cannot be re-derived.** Pause halfway through the return,
 * drag `backRate`, and the closed form re-times the entire reversal
 * retroactively — the debris in the air re-flies from scratch and the gouge
 * re-closes to a different length, on a frame of zero length. The integrator
 * would keep every second it had already spent, and the slider would only bite
 * going forward. Invariant I1 says the first behaviour is the correct one.
 *
 * ## How one region reverses somebody else's particles
 *
 * The time region is locked at the instant of the cast and given a rate of
 * `reverseTime(age) / age`. That looks like a strange thing to publish until
 * you write out what the field does with it. A region maps the world clock to
 *
 *     interior = hold + (clock − hold) × rate
 *
 * and with `hold` stamped at the cast, `clock − hold` **is** `age`, so
 * `interior = castClock + reverseTime(age)`: exactly the bent clock this
 * ability is already driving its own modules with, published for everybody
 * else. Forward at `forwardRate`, flat through the hold, then negative. No
 * discontinuity anywhere, because the rate is derived from the clock rather
 * than switched at the beats — the first version switched it, and every beat
 * jumped the interior by `holdTime × backRate` seconds in one frame.
 *
 * The consequence is the good bit. A particle inside the sphere has its own age
 * driven back down to zero, reaches its emitter, and **stops existing there** —
 * the kill test runs on the bent age, so it un-spawns properly rather than
 * fading out. Somebody else's dust gathers up as readily as this ability's,
 * which is the point of the school.
 *
 * ## What reverses, and what had to be left out
 *
 * | | |
 * | --- | --- |
 * | `GroundField(RUT)` | **yes** — the track is `progress`, and `progress` is the clock |
 * | `ShatterField` | **yes**, with one caveat below |
 * | the shared particles | **yes**, but only through the region — an ability clock cannot reach them |
 * | `RateEmitter` | **no.** A spawn is a log entry. A negative step drives its fractional accumulator the wrong way, emits nothing, and banks credit that dumps in one lump on the next forward frame. Emission is gated on `reverseRate() > 0` |
 * | decals, fissures, bursts | **no.** Pooled one-shots on the app's forward clock; nothing can un-spawn one. This ability lays **no decals at all** — see the settings block |
 * | `Ability.advance()` | **no**, and it is not ours to reverse. The front and the phase machine stay monotone; the bent clock feeds only the modules |
 *
 * **The `ShatterField` caveat, which cost an afternoon.** `update()` retires a
 * fragment permanently the first time its own age passes `lifetime` — it writes
 * `record.born = -1` and no clock brings it back. So a shard that runs out its
 * life on the forward leg is simply *not there* to reassemble, and the failure
 * looks like the reversal working perfectly for the last two stations and not
 * at all for the first. `shardLife` therefore has to outlast `turnAt − breakAt`,
 * and the schema says so on the slider. A fragment whose age goes *negative*, by
 * contrast, is handled correctly and beautifully: it parks out of view, which is
 * precisely "it has not broken off yet".
 *
 * ## The one thing that does not run backwards
 *
 * The pressure shell at the turn. It is a pooled `BurstSphere` on the world's
 * clock and it could not reverse if it wanted to — but it also *must not*,
 * because a beat that runs backwards cannot announce anything. It, the flash and
 * the shake are the cast telling you which way time is about to go, and they are
 * the only three things in the file that are allowed to be one-way.
 *
 * ## The rule that makes the editor work
 *
 * A cast captures a seed, the instant it started, and six gate states. The seed
 * and the timestamp are events; a `RewindGate` holds one sign and a count, which
 * is why it takes its `mark` as an argument to `poll()` rather than keeping it —
 * drag `breakAt` while paused and the stations fire under your cursor. Every
 * metre, every second and every rate is re-resolved from `settings.rewind`
 * inside the update loop, on a zero-length frame included.
 */
export class RewindAbility extends Ability {
  constructor(context) {
    super('rewind', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /* --- the gouge --- */
    this.rut = new GroundField(this.group, {
      mode: GroundMode.RUT,
      additive: false,
      renderOrder: 3,
      name: 'rewind.rut'
    });
    this.rut.setVisible(false);

    /* --- what comes out of it --- */
    this.shards = new ShatterField(this.group, {
      geometry: createRubbleGeometry,
      variants: SHARD_VARIANTS,
      capacity: SHARD_CAPACITY,
      additive: false,
      depthWrite: true,
      renderOrder: 5
    });

    /** The slot in the shared field. May be `null` — I6. */
    this._region = null;

    /**
     * One crossing latch per station. Allocated here and never again: a gate
     * is two numbers, and `poll()` takes the mark it is watching as an
     * argument, so the *positions* of all six stations stay live sliders while
     * the gates themselves hold nothing but which side of them the clock is on.
     */
    this._gates = [];
    for (let i = 0; i < BREAK_STATIONS; i++) this._gates.push(new RewindGate());
    /** The turn itself, watched the same way. */
    this._turnGate = new RewindGate();

    /** Re-rolled per cast so two wakes do not tear identically. A dice roll. */
    this._seed = 0;
    /** The instant the cast started, in `frame.uTime`'s clock. A timestamp. */
    this._spawnClock = 0;
    /** Live fragments, for the HUD readout. */
    this._live = 0;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // The dust off the head of the gouge. Non-additive so it genuinely
    // occludes, and it is the system the whole trick is easiest to read on:
    // when the clock turns, this is what visibly *gathers*.
    this.dust = particles.get('rewind.dust', {
      capacity: 2000,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.1
    });
    this.dust.uniforms.uDrag.value = 1.9;
    this.dust.uniforms.uEndSize.value = 3.0;
    this.dust.uniforms.uSizeIn.value = 0.12;
    this.dust.uniforms.uFadeIn.value = 0.14;
    this.dust.uniforms.uFadeOut.value = 0.34;

    // Chips flicked out of the trough. Lit rather than additive: rock.
    this.grit = particles.get('rewind.grit', {
      capacity: 1200,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.grit.uniforms.uDrag.value = 0.35;
    this.grit.uniforms.uEndSize.value = 0.8;
    this.grit.uniforms.uFadeOut.value = 0.65;

    this.dustEmitter = new RateEmitter();
    this.gritEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this._live + 1;
  }

  /** Seconds of cast age at which the clock stops going forward. */
  get _turnAt() {
    return Math.max(0.05, settings.rewind.turnAt * settings.global.lifetime);
  }

  /** Seconds it is held there. */
  get _holdSpan() {
    return Math.max(0, settings.rewind.holdTime * settings.global.lifetime);
  }

  /**
   * How long the reverse leg takes, in seconds — derived, never typed.
   *
   * The clock has `turnAt × forwardRate − reachBack` seconds to give back and
   * gives them back at `backRate`, so this is exactly the moment the closed form
   * flattens out against its floor. Typing it as its own slider instead is how
   * you get a cast that finishes half a second before the reversal does, every
   * time somebody drags `backRate`.
   */
  get _rewindSpan() {
    const c = settings.rewind;
    const peak = this._turnAt * c.forwardRate;
    return Math.max(0, peak - c.reachBack) / Math.max(0.05, c.backRate);
  }

  /**
   * The impact phase carries the forward leg that is left after the front has
   * landed, plus the hold.
   *
   * `turnAt` is an age rather than a phase offset, so the travel time has to
   * come out of it — and travel time is `length / speed`, re-resolved here
   * every frame rather than captured, which is why dragging `speed` mid-cast
   * still lands the turn at the age you asked for.
   */
  get impactDuration() {
    const c = settings.rewind;
    const travel = this.length / Math.max(1e-3, c.speed * settings.global.speed);
    return Math.max(0.05, this._turnAt + this._holdSpan - travel);
  }

  /** The fade is the reverse leg plus the settle after it. */
  get fadeDuration() {
    return Math.max(0.05, this._rewindSpan + settings.rewind.settleTime);
  }

  /**
   * The key dips once the clock has turned over.
   *
   * The one place in the ability where the *lighting* states which way time is
   * going. It is a step rather than a ramp because the turn is a beat and the
   * whole design of `holdTime` is that the beat should be visible; a light that
   * eases into the reversal hides the moment the ability is about.
   */
  lightShimmer() {
    const c = settings.rewind;
    const rate = reverseRate(this.age, this._fillBeat());
    return rate < 0 ? 1 - saturate(c.lightSag) : 1;
  }

  /* ------------------------------------------------------------------ */
  /* The clock                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Refill the module-scope `reverseParams()` block from live settings.
   *
   * Returned rather than stored so nothing can hold a stale copy across a
   * slider drag. Every caller reads it immediately.
   */
  _fillBeat() {
    const c = settings.rewind;
    _beat.rate = c.forwardRate;
    _beat.turnAt = this._turnAt;
    _beat.hold = this._holdSpan;
    _beat.back = c.backRate;
    _beat.floor = c.reachBack;
    return _beat;
  }

  /** The bent clock, in seconds of cast age. Can go negative — that is the job. */
  _bentAge() {
    return reverseTime(this.age, this._fillBeat());
  }

  /**
   * How far the head of the gouge has got, 0..1.
   *
   * `min` with `u` while the front is still travelling, because the tear cannot
   * outrun the thing making it — and once the phase machine has landed, `u` is
   * pinned at 1 and the clock has the head to itself, forwards and back.
   */
  _head(bent) {
    const c = settings.rewind;
    const drawn = saturate(bent / Math.max(0.02, c.rutTime));
    return this.phase === AbilityPhase.TRAVEL ? Math.min(drawn, this.u) : drawn;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.dustEmitter.reset();
    this.gritEmitter.reset();
    this.shards.clear();
    this.rut.clearMarks();
    this.rut.setVisible(true);

    this._seed = Math.random() * 100;
    this._spawnClock = frame.uTime.value;
    this._live = 0;
    for (const gate of this._gates) gate.reset();
    this._turnGate.reset();

    // I6 — may be null, and every use below is guarded. Locked at the cast so
    // that `clock − hold` is the cast's own age; see the class doc for why the
    // rate the region is then given is `reverseTime(age) / age`.
    this._region = this.borrow(timeField.acquire(this._spawnClock));
    this._region?.lock(this._spawnClock);

    this._sync(0);
    this._castFx();
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the bent clock into the region and both meshes.
   *
   * @param {number} bent the clock, in seconds of cast age
   */
  _sync(bent) {
    this._syncRegion();
    this._syncRut(bent);
    this._syncShardLook();
    this._syncShardFlight();
    this._live = this.shards.update(bent, _shatter);
    this._syncParticles();

    // The light rides the head of the gouge — including on the way home, which
    // is the cheapest way to say that the *place* things are happening is
    // running backwards too.
    this.pointAt(this._head(bent), this.position);
    this.position.y = 0.5;
  }

  /**
   * The region. Zero draw calls, and everybody else's half of the ability.
   *
   * `rate` is `reverseTime(age) / age` rather than `reverseRate(age)`. Those are
   * two different quantities and picking the wrong one is the mistake worth
   * naming: `reverseRate` is the *derivative* of the bent clock, and a region
   * carries a **linear map about its hold instant**, not a speed. Publishing the
   * derivative gives an interior that agrees with this ability only at the
   * instant the leg started and drifts further out for every second afterwards.
   */
  _syncRegion() {
    const c = settings.rewind;
    const region = this._region;
    if (!region) return;

    this.pointAt(saturate(c.fieldAlong), _centre);
    _centre.y = c.fieldHeight;
    region.place(_centre);

    const age = this.age;
    _warp.radius = Math.max(0.05, c.fieldRadius);
    _warp.core = saturate(c.fieldCore);
    _warp.strength = saturate(c.fieldStrength);
    // Below a frame's worth of age the quotient is 0/0; the answer there is the
    // forward rate, which is what the closed form is doing anyway.
    _warp.rate = age > 1e-4 ? reverseTime(age, this._fillBeat()) / age : c.forwardRate;
    region.sync(_warp);
  }

  /** The gouge. Its whole beat is `progress`, and `progress` is the clock. */
  _syncRut(bent) {
    const c = settings.rewind;
    const g = settings.global;
    const head = this._head(bent);

    _ground.centre = _origin.copy(this.origin);
    _ground.yaw = Math.atan2(this.direction.x, this.direction.z);
    _ground.height = c.rutHeight;
    // In RUT the radius only sizes the quad; the track's own width is `width`.
    _ground.radius = Math.max(0.2, c.rutWidth * 3);
    _ground.length = Math.max(0.5, this.length);
    _ground.progress = head;
    _ground.grow = 1;
    _ground.recede = 0;
    _ground.inscribe = 1;
    _ground.ignite = 0;
    // The track does not dim as it closes — it *shortens*, and then the last of
    // it goes. Fading it out instead reads as the mark healing over, which is a
    // different and much weaker idea.
    _ground.fade = head > 0.001 ? 1 : 0;
    _ground.seed = this._seed;

    _ground.edge = c.rutEdge;
    _ground.ragged = c.rutRagged;
    _ground.raggedScale = c.rutRaggedScale;
    _ground.warp = c.rutWarp;

    _ground.relief = c.rutRelief;
    _ground.normalStep = c.rutNormalStep;
    _ground.ambient = c.rutAmbient;
    _ground.wrap = c.rutWrap;
    _ground.specular = c.rutSpecular;
    _ground.gloss = c.rutGloss;
    _ground.parallax = c.rutParallax;

    _ground.width = c.rutWidth;
    _ground.depth = c.rutDepth;
    _ground.sharp = c.rutSharp;
    _ground.cell = Math.max(0.05, c.rutChatter);
    _ground.detail = c.rutChatterDepth;
    _ground.lift = c.rutSpoil;
    _ground.thickness = c.rutSpoilWidth;
    _ground.seam = 0.05;
    _ground.swirl = c.rutDrift;
    _ground.speed = 1;
    _ground.flow = 0;
    _ground.windAngle = 0;

    _ground.additive = false;
    _ground.emissive = c.rutEmissive;
    _ground.opacity = c.rutOpacity;
    _ground.depthFade = c.rutDepthFade;
    _ground.colorBase = c.colorRutBase;
    _ground.colorEdge = c.colorRutEdge;
    _ground.colorGlow = c.colorRutChurn;
    _ground.colorDeep = c.colorRutDeep;

    _ground.noiseStrength = g.noiseStrength;
    _ground.noiseFrequency = g.noiseFrequency;
    _ground.noiseSpeed = g.noiseSpeed;
    _ground.opacityScale = g.opacity;

    this.rut.update(_ground);
  }

  /** Colours and shading for the rubble. Pushed every frame, live. */
  _syncShardLook() {
    const c = settings.rewind;
    const g = settings.global;

    _look.colorA.copy(getColor(c.colorShardA));
    _look.colorB.copy(getColor(c.colorShardB));
    _look.colorEdge.copy(getColor(c.colorShardEdge));
    _look.colorScene.copy(getColor(c.colorShardScene));
    _look.opacity = c.shardOpacity * g.opacity;
    _look.glow = c.shardGlow * g.glow;
    _look.rim = c.shardRim * g.fresnel;
    _look.rimPower = c.shardRimPower;
    _look.shade = c.shardShade;
    _look.ambient = c.shardAmbient;
    _look.fadeStart = c.shardFadeStart;
    _look.soft = c.shardSoft;
    _look.sceneMix = c.shardSceneMix;
    _look.refract = c.shardRefract;
    _look.saturation = c.shardSaturation;
    this.shards.sync(_look);
  }

  /** The rubble's basis and flight, re-resolved every frame. */
  _syncShardFlight() {
    const c = settings.rewind;
    const g = settings.global;

    _shatter.layout = ShatterLayout.LINE;
    _shatter.origin = _origin.copy(this.origin);
    _shatter.direction = this.direction;
    _shatter.side = this.side;
    _shatter.length = this.length;
    _shatter.width = Math.max(0.05, c.rutWidth);
    _shatter.centre = null;
    _shatter.radius = Math.max(0.05, c.rutWidth);

    _shatter.spawnRadius = c.shardScatter;
    _shatter.spawnHeight = c.shardHeight;

    _shatter.speed = c.shardSpeed;
    _shatter.speedJitter = c.shardSpeedJitter;
    _shatter.spread = c.shardSpread;
    _shatter.upBias = c.shardUp;
    _shatter.inherit = null;
    _shatter.inheritScale = 1;

    _shatter.gravity = c.shardGravity;
    _shatter.drag = c.shardDrag;

    _shatter.size = c.shardSize * g.particleSize;
    _shatter.sizeJitter = c.shardSizeJitter;
    _shatter.shrink = c.shardShrink;
    _shatter.shrinkPower = c.shardShrinkPower;
    _shatter.spin = c.shardSpin;
    _shatter.spinJitter = c.shardSpinJitter;

    _shatter.lifetime = Math.max(0.05, c.shardLife);
    _shatter.floor = c.shardFloor;
    _shatter.floorSpin = c.shardFloorSpin;
    _shatter.randomness = g.randomness;
  }

  /** Both particle systems, re-coloured and re-scaled every frame. */
  _syncParticles() {
    const c = settings.rewind;
    const g = settings.global;

    this.dust.setGradient(
      getColor(c.colorDustA),
      getColor(c.colorDustB),
      getColor(c.colorDustC),
      getColor(c.colorDustD)
    );
    this.dust.uniforms.uGravity.value.set(0, c.dustRise, 0);
    this.dust.uniforms.uSizeScale.value = c.dustSize * g.particleSize;
    this.dust.uniforms.uLifeScale.value = c.dustLife * 0.5 * g.particleLifetime;
    this.dust.uniforms.uSpeedScale.value = c.dustSpeed * g.particleSpeed;
    this.dust.uniforms.uOpacity.value = c.dustOpacity * g.opacity;
    this.dust.uniforms.uTurbulence.value = c.dustTurbulence * g.turbulence;

    this.grit.setGradient(
      getColor(c.colorGritA),
      getColor(c.colorGritB),
      getColor(c.colorGritC),
      getColor(c.colorGritD)
    );
    this.grit.uniforms.uGravity.value.set(0, c.gritGravity, 0);
    this.grit.uniforms.uSizeScale.value = c.gritSize * g.particleSize * 7;
    this.grit.uniforms.uLifeScale.value = c.gritLife * 0.5 * g.particleLifetime;
    this.grit.uniforms.uSpeedScale.value = g.particleSpeed;
    this.grit.uniforms.uOpacity.value = g.opacity;
  }

  /** The front leaving the caster. */
  _castFx() {
    const c = settings.rewind;
    const g = settings.global;
    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.3 * g.explosionIntensity;
  }

  /**
   * Dust and grit off the head of the gouge.
   *
   * Gated on the sign of the clock by the caller, not here, so that this method
   * stays the ordinary emission body every other ability in the project has —
   * which is the point of the whole slot.
   */
  _wakeFx(dt, head) {
    const c = settings.rewind;
    const g = settings.global;
    const time = frame.uTime.value;

    const dustCount = Math.round(this.dustEmitter.tick(dt, c.dustRate) * g.particleCount);
    if (dustCount > 0) {
      this.pointAt(Math.max(0, head - Math.random() * 0.12), _pos);
      _pos.x += this.side.x * randRange(-c.rutWidth, c.rutWidth);
      _pos.z += this.side.z * randRange(-c.rutWidth, c.rutWidth);
      _pos.y = 0.15;

      _emit.position = _pos;
      _emit.radius = c.rutWidth * 0.8;
      _emit.direction = _dir.copy(this.direction).multiplyScalar(0.35).setY(1).normalize();
      _emit.speed = c.dustSpeed;
      _emit.speedVariance = 0.75;
      _emit.spread = c.dustSpread;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.7;
      _emit.sizeVariance = 0.5;
      _emit.life = c.dustLife;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.35;
      _emit.tint = null;
      _emit.time = time;
      this.dust.emit(dustCount, _emit);
    }

    const gritCount = Math.round(this.gritEmitter.tick(dt, c.gritRate) * g.particleCount);
    if (gritCount > 0) {
      this.pointAt(Math.max(0, head - Math.random() * 0.08), _pos);
      _pos.y = 0.08;

      _emit.position = _pos;
      _emit.radius = c.rutWidth * 0.9;
      _emit.direction = _dir.copy(this.direction).multiplyScalar(0.45).setY(1).normalize();
      _emit.speed = c.gritSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = c.gritSpread;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.1;
      _emit.sizeVariance = 0.7;
      _emit.life = c.gritLife;
      _emit.lifeVariance = 0.45;
      _emit.spin = 9;
      _emit.tint = null;
      _emit.time = time;
      this.grit.emit(gritCount, _emit);
    }
  }

  /**
   * Poll the six stations against the bent clock.
   *
   * `poll()` returns `+1` on a forward crossing and `-1` on a backward one. The
   * forward crossing throws a handful of fragments; the backward crossing does
   * **nothing at all**, and that is the correct answer rather than a shortcut —
   * the fragments thrown at that station have already flown themselves back into
   * the floor by the time the clock reaches the mark, because their own age went
   * negative on the way. There is nothing left to undo. The gate still has to be
   * polled so it re-arms, which is the whole reason it is a crossing rather than
   * a boolean.
   */
  _pollStations(bent) {
    const c = settings.rewind;
    const g = settings.global;
    const count = Math.max(0, Math.round(c.breakShards * g.particleCount));

    for (let i = 0; i < BREAK_STATIONS; i++) {
      const mark = c.breakAt + i * c.breakGap;
      if (this._gates[i].poll(bent, mark) <= 0) continue;
      // Where the head was when this station gave way — the same expression the
      // gouge uses, so the rubble comes out of the trough rather than near it.
      const along = this._head(mark);
      this.shards.burst(bent, count, along, randRange(-0.7, 0.7));
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const bent = this._bentAge();
    this._pollStations(bent);
    this._sync(bent);
    this._wakeFx(dt, this._head(bent));
    this.ctx.shake.rumble(settings.rewind.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    // Nothing. The front reaching the end of the line is not a beat in this
    // ability — the turn is, and the turn is an instant on the clock rather
    // than a phase transition, so it is polled in `onFade` like everything else.
    // Putting a punch here as well gives the cast two climaxes half a second
    // apart and neither of them lands.
  }

  onFade(dt, _t) {
    const c = settings.rewind;
    const g = settings.global;
    const bent = this._bentAge();
    const rate = reverseRate(this.age, this._fillBeat());

    // The turn, watched as a *crossing* of the peak rather than as a phase. On
    // the way up the clock crosses it forward and nothing happens; a moment
    // later it crosses back and that is the frame the shell goes off.
    if (this._turnGate.poll(bent, this._turnAt * c.forwardRate) < 0) this._turnFx();

    this._pollStations(bent);
    this._sync(bent);

    // Emission only while the clock is going forward. See the class doc: a
    // `RateEmitter` handed a reversal banks credit and dumps it later.
    if (rate > 0) this._wakeFx(dt, this._head(bent));

    if (rate > 0) {
      this.ctx.shake.rumble(c.rumble * g.cameraShake, dt);
    } else if (rate < 0) {
      // A different, finer rumble on the way home — the floor closing is not
      // the floor opening played at the same volume.
      this.ctx.shake.rumble(c.rumble * 0.45 * g.cameraShake, dt);
    }
  }

  /** THE TURN — the one beat in the cast that is allowed to be one-way. */
  _turnFx() {
    const c = settings.rewind;
    const g = settings.global;

    this.pointAt(saturate(c.fieldAlong), _pos);
    _pos.y = c.fieldHeight;

    this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
      radius: c.turnBurstSize * 0.2,
      endRadius: c.turnBurstSize * g.explosionIntensity,
      life: 0.5,
      intensity: c.turnBurstIntensity,
      opacity: 0.75,
      fresnel: 2.4,
      displace: 0.3,
      squash: 0.85,
      colorA: getColor(c.colorTurnA),
      colorB: getColor(c.colorTurnB),
      colorC: getColor(c.colorTurnC)
    });

    this.ctx.shake.add(
      c.turnShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      20
    );
    this.ctx.flash.trigger(getColor(c.colorTurnFlash), c.turnFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.7 * g.explosionIntensity;
  }

  onDestroy() {
    // Give the slot back on the frame the cast ends. `Ability#destroy()` would
    // do it anyway through `borrow()` and `release()` is idempotent, so the
    // ordinary path never leans on the safety net.
    this._region = this._region?.release() ?? null;
    this.shards.clear();
    this.rut.clearMarks();
    this.rut.setVisible(false);
    for (const gate of this._gates) gate.reset();
    this._turnGate.reset();
    this._live = 0;
  }

  dispose() {
    this.rut.dispose();
    this.shards.dispose();
    super.dispose();
  }
}
