import { MeshStandardMaterial, Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { Projectile, FlightMode, Stagger } from '../../vfx/Projectile.js';
import { GroundField, GroundMode } from '../../vfx/GroundField.js';
import { ShatterField, ShatterLayout } from '../../vfx/ShatterField.js';
import { createAsteroidGeometry } from '../../assets/ProceduralGeometry.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, clamp, Easing, randRange } from '../../utils/math.js';

const TAU = Math.PI * 2;
/** Contact samples the rut's fragment shader carries. A ring buffer. */
const RUT_MARKS = 16;
/** Distinct fragment silhouettes when it breaks. Two draw calls. */
const CHUNK_VARIANTS = 2;

/* --- module-scope scratch: nothing below allocates on a frame (I3) --- */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _contact = new Vector3();
const _anchor = new Vector3();
const _inherit = new Vector3();
/** Params objects, rewritten whole every frame and never cached between them. */
const _flight = {};
const _rut = { centre: new Vector3() };
const _debris = { origin: new Vector3(), direction: new Vector3(), side: new Vector3() };
const _look = {};

/**
 * ROLLING RUIN — a boulder is put on the ground and shoved.
 *
 * It rolls the whole way. It gouges a rut behind it whose depth follows how
 * hard it is pressing, throws chips and dust off the **contact point** rather
 * than out of its middle, rumbles the floor in proportion to how fast it is
 * going, and shatters into pieces of itself when it arrives.
 *
 * **THE TRICK — it never skates.** A rolling body's contact point is
 * instantaneously at rest, so its angular velocity is fixed by its linear one:
 *
 * ```
 *   v = ω × r        ⇒    ω = v / r
 *   θ(t) = ∫ ω dt    ⇒    θ = s / r          (s = arc length travelled)
 * ```
 *
 * — the rotation is **distance over radius and nothing else**. No spin rate, no
 * tumble slider, no `× 1.2` because it looked better. `vfx/Projectile.js` in
 * `ROLL` mode does exactly that (`-travelled / radius` about the cast's `side`
 * axis, negative because a body moving along `direction` turns *forward*), and
 * the one thing this ability must not do is fight it: `spin` and `align` are
 * left out of the params entirely. Get the factor wrong by any amount at all
 * and the rock reads as a sphere being dragged, which is the first thing anyone
 * notices and the only thing they will remember.
 *
 * Two smaller derivations hang off the same idea:
 *
 *  - **The chatter pitch is the circumference.** The rut mode prints the body's
 *    own rim into the soft floor at a pitch of `cell` metres; that pitch is
 *    `2π · radius · rutChatter`, derived from the live body radius rather than
 *    typed in, so growing the boulder lengthens the marks it leaves behind it.
 *  - **The contact load is the speed.** `Projectile` publishes `contact` and
 *    `contactLoad` but deliberately keeps the load flat, because only the
 *    ability knows whether its body is accelerating. This one is: `pathCurve`
 *    is above 1, so the closed-form speed is
 *    `v = speed · pathCurve · u^(pathCurve−1)`, and the load posted to the rut
 *    is that speed against `loadSpeed`, curved. The gouge therefore *deepens*
 *    down the track, which is the whole reason `GroundField(RUT)` interpolates
 *    a force from posted samples instead of drawing a trench of constant depth.
 *
 * **One clock.** The projectile is not given the wall clock. It is given the
 * ability's own front — `now = u · flightTime` — so the rock is exactly where
 * `advance()` says the cast is and `arrivals` fires on precisely the frame the
 * base class enters IMPACT. Two clocks in one ability is how a projectile ends
 * up landing a frame before its own impact, and how a rut ends up with its head
 * somewhere the boulder is not.
 *
 * **The rule that makes the editor work.** A cast captures a seed and a boolean
 * (has it broken yet). Everything else — the radius, the track, the rut's
 * width and depth, the load, the shatter — is resolved from `settings.boulder`
 * inside the update loop, on a zero-length frame included. Pause it mid-roll
 * and drag `radius`: the rock grows, the rut widens under it, the chatter marks
 * lengthen because the circumference did, and the rotation re-derives itself
 * from the new radius so it is still not skating.
 */
export class BoulderAbility extends Ability {
  constructor(context) {
    super('boulder', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /* ---- the rock ---- */
    this.rockMaterial = new MeshStandardMaterial({
      color: 0x6e6455,
      roughness: 0.95,
      metalness: 0.02,
      flatShading: true
    });

    this.body = new Projectile(this.group, {
      capacity: 1,
      geometry: () => this._rockGeometry(),
      // The shape controls displace real vertices — the silhouette and the
      // shadow have to see them — so a change rebuilds rather than being faked
      // per instance. A few hundred triangles is cheap enough to regenerate,
      // and that is what keeps them live sliders.
      shapeKey: () => this._shapeKey(),
      material: this.rockMaterial,
      // No trail: a rock is not on fire. What it leaves behind is the rut, and
      // that is a ground field, not a ribbon.
      trail: false,
      layer: LAYER.WORLD,
      renderOrder: 2,
      castShadow: true
    });

    /* ---- the rut it gouges ---- */
    this.rut = new GroundField(this.group, {
      mode: GroundMode.RUT,
      marks: RUT_MARKS,
      additive: false, // a gouge is a hole: it shades the floor, never lights it
      depthTest: true,
      layer: LAYER.VFX,
      name: 'BoulderRut'
    });
    this.rut.setVisible(false);

    /* ---- what it breaks into ---- */
    // The same rock, cut. `createAsteroidGeometry` slices planar facets off a
    // lumpy sphere; wind `cuts` up and `cutDepth` deep and what comes back is a
    // wedge with flat fracture faces, which is what a boulder actually breaks
    // into. The first version used tetrahedra and read as gravel.
    this.chunks = new ShatterField(this.group, {
      geometry: (variant) => this._chunkGeometry(variant),
      variants: CHUNK_VARIANTS,
      capacity: 160,
      additive: false,
      depthWrite: true,
      layer: LAYER.WORLD,
      renderOrder: 2,
      castShadow: true,
      receiveShadow: true
    });

    /** The one boolean a cast captures: has it come apart yet. */
    this._shattered = false;
    this._seed = 0;

    /**
     * The contact samples, and why the ability keeps hold of them.
     *
     * `GroundField#mark()` hands back the `Vector4` it wrote into — and that
     * vector *is* the uniform, not a copy of it. Keeping the references lets
     * the load and the along-track position of every sample already on the
     * floor be **re-derived** from the live settings on every frame, including
     * a zero-length one. Without that, `loadSpeed`, `loadCurve`, `loadPeak` and
     * `pathCurve` would be baked into the rut at the instant each sample was
     * posted, and dragging any of them on a paused boulder would do nothing to
     * the trench behind it: three dead sliders and a fourth half-dead, all
     * because the ability had written down a dimension. The *events* here are
     * `_markU` — the unitless fraction of the cast each sample was taken at —
     * and nothing else.
     */
    this._markSlots = new Array(RUT_MARKS).fill(null);
    this._markU = new Float32Array(RUT_MARKS);
    this._markCount = 0;
    /** The cast fraction the last sample was taken at, 0..1. */
    this._markedU = 0;
  }

  /** The body, in unit space. Every number here is a live shape slider. */
  _rockGeometry() {
    const c = settings.boulder;
    return createAsteroidGeometry({
      seed: 6.1,
      detail: clamp(Math.round(c.rockDetail), 0, 3),
      lumpiness: c.rockLumps,
      noiseScale: c.rockLumpScale,
      roughness: c.rockRough,
      cuts: Math.round(c.rockCuts),
      cutDepth: c.rockCutDepth,
      craters: Math.round(c.rockCraters),
      craterDepth: c.rockCraterDepth
    });
  }

  /** One fragment silhouette: the same stone, cut much harder. */
  _chunkGeometry(variant) {
    const c = settings.boulder;
    return createAsteroidGeometry({
      seed: 21.7 + variant * 13.3,
      // Low subdivision on purpose: a heavily sliced rock at detail 2 rounds
      // itself back off into a pebble, and these have to keep their corners.
      detail: 1,
      lumpiness: c.rockLumps * 0.8,
      noiseScale: c.rockLumpScale * 1.6,
      roughness: c.rockRough,
      cuts: 9 + variant * 2,
      cutDepth: 0.55,
      craters: 1
    });
  }

  /** Hashed by `Projectile#syncGeometry`; a change rebuilds the body. */
  _shapeKey() {
    const c = settings.boulder;
    return `${Math.round(c.rockDetail)}|${c.rockLumps.toFixed(3)}|${c.rockLumpScale.toFixed(3)}|${c.rockRough.toFixed(3)}|${Math.round(c.rockCuts)}|${c.rockCutDepth.toFixed(3)}|${Math.round(c.rockCraters)}|${c.rockCraterDepth.toFixed(3)}`;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // The plume off the contact patch. Non-additive: dust thrown up by
    // something heavy has to occlude, or the rock reads as travelling through
    // a fog rather than making one.
    this.dust = particles.get('boulder.dust', {
      capacity: 2600,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.1
    });
    this.dust.uniforms.uDrag.value = 2.0;
    this.dust.uniforms.uEndSize.value = 3.0;
    this.dust.uniforms.uSizeIn.value = 0.1;
    this.dust.uniforms.uFadeIn.value = 0.12;
    this.dust.uniforms.uFadeOut.value = 0.36;

    // Chips of floor spat backwards out from under it.
    this.chips = particles.get('boulder.chips', {
      capacity: 2200,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.chips.uniforms.uDrag.value = 0.22;
    this.chips.uniforms.uEndSize.value = 0.85;
    this.chips.uniforms.uFadeOut.value = 0.74;

    this.dustEmitter = new RateEmitter();
    this.chipEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this.body.count + this.chunks.count;
  }

  /** The pieces have to have finished flying before the rut starts to go. */
  get impactDuration() {
    const c = settings.boulder;
    return Math.max(0.3, (c.debrisLifetime + c.holdTime) * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.2, settings.boulder.rutFadeTime);
  }

  /** Body radius, metres. Read in six places, so it lives in one. */
  get rockRadius() {
    return Math.max(0.05, settings.boulder.radius);
  }

  /**
   * Ground speed of the rock right now, metres/second.
   *
   * Closed form, not a difference of two positions. The flight is
   * `s(u) = length · u^pathCurve` against a front that `advance()` moves at
   * `speed · global.speed`, so `ds/dt = speed · pathCurve · u^(pathCurve−1)`.
   * Differencing positions would work while the clock runs and return zero the
   * moment it stops, which is exactly when the sliders are being dragged — the
   * rut would flatten out under a paused boulder and nobody would understand
   * why. (The base class's 80 ms ease-off-the-mark is not mirrored here; at
   * `pathCurve > 1` the `u^(pathCurve−1)` term already starts the rock at
   * zero, which is the part that has to be true.)
   */
  get rollSpeed() {
    return this._speedAt(this.u);
  }

  /** Ground speed at any point of the cast, metres/second. */
  _speedAt(u) {
    const c = settings.boulder;
    const curve = Math.max(0.05, c.pathCurve);
    const base = c.speed * settings.global.speed;
    return base * curve * Math.pow(Math.max(u, 1e-4), curve - 1);
  }

  /** 0..1 — how hard it is pressing on the floor, and how deep the rut goes. */
  get contactLoad() {
    return this._loadAt(this.u);
  }

  /** The load at any point of the cast. Re-evaluated, never remembered. */
  _loadAt(u) {
    const c = settings.boulder;
    const ratio = this._speedAt(u) / Math.max(0.1, c.loadSpeed);
    return saturate(Math.pow(saturate(ratio), Math.max(0.05, c.loadCurve)) * c.loadPeak);
  }

  /** How far down the track the body is, 0..1. The rut's head sits here. */
  get trackProgress() {
    return this._trackAt(this.u);
  }

  /** Where a cast fraction sits along the track, 0..1 — the flight's own `s`. */
  _trackAt(u) {
    return saturate(Math.pow(saturate(u), Math.max(0.05, settings.boulder.pathCurve)));
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.dustEmitter.reset();
    this.chipEmitter.reset();

    this._seed = Math.random() * 100;
    this._shattered = false;
    this._markedU = 0;
    this._markCount = 0;
    this._markSlots.fill(null);

    this.body.reset();
    this.body.roll(this._seed);
    this.chunks.clear();
    this.rut.clearMarks();
    this.rut.setVisible(false);

    this._sync(0, 1);
    this._muzzleFx();
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Re-resolve everything and drive the three modules.
   *
   * @param {number} dt    seconds; zero on a paused frame, which must still work
   * @param {number} fade  1 while the rut is fresh, ramping to 0 as it goes
   */
  _sync(dt, fade) {
    const c = settings.boulder;
    const g = settings.global;

    /* ---- the flight ---- */
    _flight.mode = FlightMode.ROLL;
    _flight.stagger = Stagger.NONE;
    _flight.count = this._shattered ? 0 : 1;
    _flight.radius = this.rockRadius;
    _flight.sizeJitter = 0;
    _flight.stretch = 1;
    // `align` and `spin` are deliberately absent. Either of them would put a
    // second rotation on top of the rolling one and the contact point would
    // stop being at rest — see the class comment.
    _flight.flash = c.flash;
    _flight.handForward = c.handForward;
    _flight.handSide = c.handSide;
    _flight.spreadSide = 0;
    _flight.spreadForward = 0;
    _flight.pathCurve = c.pathCurve;
    _flight.apex = 0; // it is on the floor. A rolling body that lofts is a bounce.
    _flight.load = this.contactLoad;
    _flight.linger = 0;
    _flight.sink = 0;
    // Any positive number works — the clock below is the ability's own front,
    // not the wall clock — but deriving it from the cast keeps `speed` meaning
    // seconds if anything ever reads `flightTime` back.
    const flightTime = Math.max(0.05, this.length / Math.max(0.2, c.speed * g.speed));
    _flight.flightTime = flightTime;
    _flight.speedJitter = 0;
    _flight.lead = 0;
    _flight.window = 0;

    this.body.setBasis(this.origin, this.direction, this.side, this.length);
    this.body.update(this.u * flightTime, _flight);

    /* ---- where it is pressing ---- */
    if (!this._shattered && this.body.count > 0) {
      _contact.copy(this.body.contact);
    }

    /* ---- the rut ---- */
    this._syncRut(c, g, fade);

    /* ---- the pieces ---- */
    this._syncChunks(c, g, fade);

    /* ---- the two particle systems ---- */
    this.dust.setGradient(
      getColor(c.colorDustA),
      getColor(c.colorDustB),
      getColor(c.colorDustC),
      getColor(c.colorDustD)
    );
    this.dust.uniforms.uGravity.value.set(0, c.dustRise, 0);
    this.dust.uniforms.uSizeScale.value = c.dustSize * g.particleSize;
    this.dust.uniforms.uLifeScale.value = c.dustLifetime * 0.5 * g.particleLifetime;
    this.dust.uniforms.uSpeedScale.value = c.dustSpeed * g.particleSpeed;
    this.dust.uniforms.uOpacity.value = c.dustOpacity * g.opacity;
    this.dust.uniforms.uTurbulence.value = c.dustTurbulence * g.turbulence;

    this.chips.setGradient(
      getColor(c.colorChipA),
      getColor(c.colorChipB),
      getColor(c.colorChipC),
      getColor(c.colorChipD)
    );
    this.chips.uniforms.uGravity.value.set(0, c.chipGravity, 0);
    this.chips.uniforms.uSizeScale.value = c.chipSize * g.particleSize * 7;
    this.chips.uniforms.uLifeScale.value = g.particleLifetime;
    this.chips.uniforms.uSpeedScale.value = g.particleSpeed;
    this.chips.uniforms.uOpacity.value = g.opacity;

    this.rockMaterial.color.copy(getColor(c.colorRock));
  }

  /**
   * The gouge.
   *
   * `GroundField(RUT)` anchors at the **start** of the track and slides its own
   * quad downrange, so the anchor is where the boulder was put down and the
   * length is what is left of the cast in front of it. `progress` is the head:
   * it is `u^pathCurve`, the same expression the body's own position uses, so
   * the churn at the end of the rut is under the rock and not chasing it.
   */
  _syncRut(c, g, fade) {
    // Re-derive every sample already on the floor. `_markU` is the fraction of
    // the cast it was taken at — an event; where that is along the track and
    // how hard the body was pressing there are both consequences of the live
    // sliders, so they are recomputed rather than remembered. This is the line
    // that makes `loadSpeed`, `loadCurve`, `loadPeak` and `pathCurve` reshape a
    // rut that is already lying in the floor with the clock stopped.
    for (let i = 0; i < this._markCount; i++) {
      const slot = this._markSlots[i];
      if (!slot) continue;
      const u = this._markU[i];
      slot.y = this._trackAt(u);
      slot.w = this._loadAt(u);
    }

    _rut.centre.copy(this.origin).addScaledVector(this.direction, c.handForward);
    _rut.yaw = Math.atan2(this.direction.x, this.direction.z);
    _rut.height = c.rutHeight;
    _rut.radius = Math.max(0.2, c.rutWidth * 3); // only used to size the quad in RUT
    _rut.length = Math.max(0.5, this.length - c.handForward);
    _rut.progress = this.trackProgress;
    _rut.grow = 1;
    _rut.recede = 0;
    _rut.fade = fade;
    _rut.seed = this._seed;

    _rut.edge = c.rutEdge;
    _rut.ragged = c.rutRagged;
    _rut.raggedScale = c.rutRaggedScale;
    _rut.warp = c.rutWarp;

    _rut.relief = c.rutRelief;
    _rut.normalStep = c.rutNormalStep;
    _rut.ambient = c.rutAmbient;
    _rut.wrap = c.rutWrap;
    _rut.specular = c.rutSpecular;
    _rut.gloss = c.rutGloss;
    _rut.parallax = c.rutParallax;

    _rut.width = c.rutWidth;
    _rut.depth = c.rutDepth;
    _rut.sharp = c.rutSharp;
    _rut.detail = c.rutChatterDepth;
    // The pitch of the chatter is the body's own circumference. Derived, not
    // typed: grow the boulder and the marks it prints get further apart, which
    // is the whole reason they read as *its* marks.
    _rut.cell = Math.max(0.05, TAU * this.rockRadius * c.rutChatter);
    _rut.lift = c.rutSpoil;
    _rut.thickness = c.rutSpoilWidth;
    _rut.seam = c.rutSampleBlend;
    // The track's own lateral drift, off by default: this boulder rolls down
    // the cast line and a rut that wanders away from it is a rut belonging to
    // something else.
    _rut.swirl = c.rutDrift;
    _rut.speed = 1;
    _rut.flow = 0;
    _rut.windAngle = 0;

    _rut.additive = false;
    _rut.emissive = c.rutEmissive;
    _rut.opacity = c.rutOpacity;
    _rut.depthFade = c.rutDepthFade;
    _rut.colorBase = c.colorRutBase;
    _rut.colorEdge = c.colorRutEdge;
    _rut.colorGlow = c.colorRutChurn;
    _rut.colorDeep = c.colorRutDeep;

    _rut.noiseStrength = g.noiseStrength;
    _rut.noiseFrequency = g.noiseFrequency;
    _rut.noiseSpeed = g.noiseSpeed;
    _rut.opacityScale = g.opacity;

    this.rut.update(_rut);
    this.rut.setVisible(fade > 0.004 && this.trackProgress > 0.001);
  }

  /** The pieces, once there are any. */
  _syncChunks(c, g, fade) {
    _debris.layout = ShatterLayout.LINE;
    _debris.origin.copy(this.origin);
    _debris.direction.copy(this.direction);
    _debris.side.copy(this.side);
    _debris.length = this.length;
    _debris.width = this.rockRadius;
    _debris.spawnRadius = this.rockRadius * c.debrisScatter;
    _debris.spawnHeight = this.rockRadius * c.debrisHeight;

    _debris.speed = c.debrisSpeed;
    _debris.speedJitter = c.debrisSpeedJitter;
    _debris.spread = c.debrisSpread;
    _debris.upBias = c.debrisUp;
    // What it was doing when it stopped. A burst with an inherited velocity and
    // a low spread is a thing that shattered; the same burst at spread 1 is a
    // firework, which is the note in the module's own docs and it is correct.
    _debris.inherit = _inherit.copy(this.direction).multiplyScalar(this.rollSpeed);
    _debris.inheritScale = c.debrisInherit;

    _debris.gravity = c.debrisGravity;
    _debris.drag = c.debrisDrag;
    _debris.size = c.debrisSize;
    _debris.sizeJitter = c.debrisSizeJitter;
    _debris.shrink = c.debrisShrink;
    _debris.shrinkPower = c.debrisShrinkPower;
    _debris.spin = c.debrisSpin;
    _debris.spinJitter = c.debrisSpinJitter;
    _debris.lifetime = c.debrisLifetime * settings.global.lifetime;
    _debris.floor = 0;
    _debris.floorSpin = c.debrisFloorSpin;
    _debris.randomness = g.randomness;

    _look.colorA = getColor(c.colorChunkA);
    _look.colorB = getColor(c.colorChunkB);
    _look.colorEdge = getColor(c.colorChunkEdge);
    _look.colorScene = getColor(c.colorChunkTint);
    _look.opacity = fade * g.opacity;
    _look.glow = c.chunkGlow * g.glow;
    _look.rim = c.chunkRim * g.fresnel;
    _look.rimPower = c.chunkRimPower;
    _look.shade = c.chunkShade;
    _look.ambient = c.chunkAmbient;
    _look.fadeStart = c.chunkFadeStart;
    _look.soft = c.chunkSoft;
    _look.sceneMix = 0;
    _look.refract = 0;
    _look.saturation = 0;

    this.chunks.sync(_look);
    this.chunks.update(this.age, _debris);
  }

  /**
   * Record that the body was in contact at cast fraction `u`.
   *
   * The ring buffer holds `RUT_MARKS`; posting past it would recycle a slot
   * this ability is still holding a reference to, so it simply stops. Sixteen
   * samples over a twenty-metre track is one every 1.3 m, and the shader blends
   * between them over `rutSampleBlend` metres anyway.
   */
  _postSample(u) {
    if (this._markCount >= RUT_MARKS) return;
    const index = this._markCount++;
    this._markU[index] = saturate(u);
    this._markSlots[index] = this.rut.mark(0, this._trackAt(u), this.age, this._loadAt(u));
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /** The thud as it is put down and shoved. */
  _muzzleFx() {
    const c = settings.boulder;
    const g = settings.global;

    _pos.copy(this.origin).addScaledVector(this.direction, c.handForward);
    _pos.y = this.rockRadius * 0.4;

    this.ctx.bursts.spawn(BurstMode.EARTH, _pos, {
      radius: c.muzzleSize * 0.3,
      endRadius: c.muzzleSize * g.explosionIntensity,
      life: 0.5,
      intensity: c.muzzleIntensity,
      opacity: 0.7,
      fresnel: 1.1,
      displace: 0.6,
      squash: 0.5,
      colorA: getColor(c.colorDustB),
      colorB: getColor(c.colorDustA),
      colorC: getColor(c.colorRock)
    });

    _emit.position = _pos;
    _emit.radius = this.rockRadius * 0.8;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(-0.4).setY(1).normalize();
    _emit.speed = c.chipSpeed * 0.7;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.1;
    _emit.sizeVariance = 0.7;
    _emit.life = c.chipLifetime * 0.7;
    _emit.lifeVariance = 0.5;
    _emit.spin = 8;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.chips.emit(Math.round(12 * g.particleCount), _emit);

    this.lightBoost = c.lightIntensity * 0.4 * g.explosionIntensity;
  }

  /**
   * Everything thrown off the **contact point**.
   *
   * Not off the centre. A rolling body sheds from the patch where it is
   * touching the ground — backwards and out to the sides, because that is where
   * the material it is displacing has to go — and the difference between
   * emitting there and emitting at the middle of the rock is the difference
   * between a boulder and a sphere with a smoke emitter parented to it.
   * `Projectile` publishes `contact` for exactly this.
   */
  _contactFx(dt, load) {
    const c = settings.boulder;
    const g = settings.global;
    const time = frame.uTime.value;

    const dustCount = Math.round(this.dustEmitter.tick(dt, c.dustRate * load) * g.particleCount);
    if (dustCount > 0) {
      _pos.copy(_contact);
      _pos.y = c.dustHeight;
      _emit.position = _pos;
      _emit.radius = this.rockRadius * 0.9;
      // Behind and up: the plume is what the rock has already run over.
      _emit.direction = _dir.copy(this.direction).multiplyScalar(-c.dustBack).setY(1).normalize();
      _emit.speed = c.dustSpeed;
      _emit.speedVariance = 0.75;
      _emit.spread = 0.9;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.75;
      _emit.sizeVariance = 0.5;
      _emit.life = c.dustLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.5;
      _emit.tint = null;
      _emit.time = time;
      this.dust.emit(dustCount, _emit);
    }

    const chipCount = Math.round(this.chipEmitter.tick(dt, c.chipRate * load) * g.particleCount);
    if (chipCount > 0) {
      _pos.copy(_contact);
      _pos.y = 0.04;
      _emit.position = _pos;
      _emit.radius = this.rockRadius * 0.7;
      // Spat out sideways off the contact patch, alternating sides, with a
      // little backspin — the spray a wheel throws.
      const sign = Math.random() < 0.5 ? 1 : -1;
      _emit.direction = _dir
        .copy(this.side)
        .multiplyScalar(sign * c.chipSpray)
        .addScaledVector(this.direction, -c.chipBack)
        .setY(1)
        .normalize();
      _emit.speed = c.chipSpeed;
      _emit.speedVariance = 0.85;
      _emit.spread = 0.6;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.1;
      _emit.sizeVariance = 0.75;
      _emit.life = c.chipLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 10;
      _emit.tint = null;
      _emit.time = time;
      this.chips.emit(chipCount, _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = settings.boulder;
    const g = settings.global;

    this._sync(dt, 1);

    // Straight off the module on the frame it resolved them: `Projectile`
    // publishes the contact patch and how hard the body is pressing, and both
    // are consumed here, immediately after `update()`, before anything can
    // move them.
    const load = this.body.contactLoad;

    /*
     * Post a contact sample every `1/rutSamples` of the *cast*, not of the
     * track: the two differ by `pathCurve`, and stepping in the cast fraction
     * is what lets that curve stay a live slider (see `_syncRut`). `mark()`
     * takes a fraction across, a fraction along, a timestamp and a 0..1
     * strength — four unitless numbers — so the samples re-place and re-scale
     * themselves when the range or the width moves.
     */
    const step = 1 / clamp(Math.round(c.rutSamples), 1, RUT_MARKS);
    while (this.u - this._markedU >= step) {
      this._markedU += step;
      this._postSample(this._markedU);
    }

    // The light rides with the rock, low, so the dust it is making catches it.
    this.position.y = c.lightHeight;

    this._contactFx(dt, load);

    // Rumble the whole way, scaled by speed. A rolling boulder is a continuous
    // event, so this is a continuous read of how fast it is going rather than
    // anything scheduled.
    this.ctx.shake.rumble(
      c.rumble * saturate(this.rollSpeed / Math.max(0.1, c.loadSpeed)) * g.cameraShake,
      dt
    );
  }

  onImpact() {
    const c = settings.boulder;
    const g = settings.global;
    const time = frame.uTime.value;

    // The last sample, at the very end of the track, so the rut's head is
    // filled in rather than stopping one step short of the crater.
    this._postSample(1);
    this._markedU = 1;

    this.pointAt(1, _pos);
    _contact.copy(_pos).setY(0);
    _pos.y = this.rockRadius;

    /*
     * It breaks. `along = 1` puts the fragments at the far end of the line and
     * the inherited velocity — set in `_syncChunks` and re-read every frame —
     * carries them on down it, so the pile ends up in front of where the rock
     * stopped rather than around it.
     */
    this.chunks.burst(this.age, Math.round(c.debrisCount * g.particleCount), 1, 0);
    this._shattered = true;

    this.ctx.bursts.spawn(BurstMode.EARTH, _pos, {
      radius: c.burstSize * 0.3,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.8,
      intensity: c.burstIntensity,
      opacity: 0.85,
      fresnel: 1.1,
      displace: 0.7,
      squash: 0.55,
      colorA: getColor(c.colorDustB),
      colorB: getColor(c.colorDustA),
      colorC: getColor(c.colorRock)
    });

    this.ctx.decals.spawn(DecalType.CRACK, _contact, {
      radius: c.crackRadius,
      life: c.crackLife,
      width: c.crackWidth,
      intensity: c.crackIntensity,
      colorA: getColor(c.colorRutDeep),
      colorB: getColor(c.colorRutChurn),
      height: 0.014
    });

    this.ctx.decals.spawn(DecalType.DUSTRING, _contact, {
      radius: c.impactDust,
      life: c.crackLife * 0.5,
      intensity: 0.6,
      colorA: getColor(c.colorDustA),
      colorB: getColor(c.colorDustB),
      height: 0.01
    });

    _emit.position = _pos;
    _emit.radius = this.rockRadius;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.5).setY(1).normalize();
    _emit.speed = c.chipSpeed * 1.8;
    _emit.speedVariance = 0.85;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.13;
    _emit.sizeVariance = 0.8;
    _emit.life = c.chipLifetime * 1.3;
    _emit.lifeVariance = 0.5;
    _emit.spin = 12;
    _emit.tint = null;
    _emit.time = time;
    this.chips.emit(Math.round(c.burstChips * g.particleCount), _emit);

    _emit.radius = this.rockRadius * 1.6;
    _emit.speed = c.dustSpeed * 1.9;
    _emit.spread = 1.0;
    _emit.size = 1.1;
    _emit.life = c.dustLifetime * 1.2;
    _emit.spin = 0.6;
    this.dust.emit(Math.round(c.burstDust * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      17
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.4 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.boulder;
    // `t` runs 0..1 while the pieces are flying, then 1..2 while the rut goes.
    const fade = t <= 1 ? 1 : 1 - Easing.inQuad(saturate(t - 1));

    this._sync(dt, fade);
    this.pointAt(1, this.position).setY(c.lightHeight);

    // Dust keeps rolling off the pile for a moment after it lands, then stops.
    const settle = this.phase === AbilityPhase.IMPACT ? 1 - saturate(t / 0.6) : 0;
    if (settle > 0.001) this._contactFx(dt, settle * c.settleDust);

    this.ctx.shake.rumble(c.settleRumble * fade * settings.global.cameraShake, dt);
  }

  onDestroy() {
    this._shattered = false;
    this._markedU = 0;
    this._markCount = 0;
    this._markSlots.fill(null);
    this.body.reset();
    this.chunks.clear();
    this.rut.clearMarks();
    this.rut.setVisible(false);
  }

  dispose() {
    this.body.dispose();
    this.rut.dispose();
    this.chunks.dispose();
    this.rockMaterial.dispose();
    super.dispose();
  }
}
