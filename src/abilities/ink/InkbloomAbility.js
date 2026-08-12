import { Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { InkDiffusion, InkMode, inkDiffusionParams } from '../../vfx/InkDiffusion.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, Easing, randRange } from '../../utils/math.js';

const TAU = Math.PI * 2;

/* --- module-scope scratch. Nothing below allocates during a cast (I3) --- */
const _wash = inkDiffusionParams();
const _bloom = inkDiffusionParams();
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _nucleus = new Vector3();
const _centre = new Vector3();

/**
 * INKBLOOM — a bead of ink dropped into standing water.
 *
 * ## The trick: a fingering instability, not a mask over a disc
 *
 * The obvious way to draw this is to grow a circle and cut a wobbly silhouette
 * out of it. That is wrong in a way you can see from across the room: a masked
 * disc is **the same shape at every size**, so what you are watching is a
 * picture being scaled rather than a front being pushed. Real ink opens because
 * the interface between a thin fluid and a thick one is *unstable* — a bulge
 * sees a steeper local gradient, moves faster, and becomes a finger — and,
 * crucially, because the coarse modes are **physically inadmissible until the
 * blob has grown into them**. A lobe two metres across cannot exist on a blob
 * that is not yet two metres across. So a young bloom is a small crinkled disc
 * and a mature one is a handful of enormous branching lobes with that same
 * crinkle still riding on their tips.
 *
 * `vfx/InkDiffusion.js` owns that mechanism — five octaves admitted by front
 * radius, each then growing on the linear instability's exponential and
 * saturating at its own wavelength — and this ability's whole job is to aim it.
 * There is no silhouette anywhere in this file. **One seed per cast** goes into
 * `roll()` and the pattern that comes out has never existed before and will not
 * again; the ability itself does not know what shape is on the floor and cannot
 * ask.
 *
 * ## Two fronts, because ink in water is two substances
 *
 * The first version drew one field and it read as a stain rather than as
 * something happening in a liquid. What was missing is the part of the
 * phenomenon that has nothing to do with the instability: **the solvent runs
 * ahead of the pigment.** Paper chromatography is exactly this effect and it is
 * why a watercolour has a pale wet halo outside its ink with a hard deposition
 * line at the outside of *that*.
 *
 * So there are two `InkDiffusion` fields on one clock:
 *
 *  - the **wash**, `InkMode.WASH` — the water. Stable by construction: the
 *    instability term is not compiled into that mode at all. It spreads faster
 *    (`washSpread` ≫ `bloomSpread`), has a deliberately wide interface, and
 *    carries a strong ring at its edge. That ring is the cauliflower line.
 *  - the **bloom**, `InkMode.BLOOM` — the pigment. It starts `pigmentDelay`
 *    later, spreads sub-Fickian because pigment drags on the fibre, breaks into
 *    four nuclei on its way in, and fingers.
 *
 * Drag `washSpread` below `bloomSpread` with the clock stopped and the whole
 * thing collapses into a decal with a halo painted round it. The *ordering* of
 * the two fronts is doing more work here than any amount of noise.
 *
 * ## Wet in front, dry behind, with no history
 *
 * A fragment's ink arrived when the front radius equalled its distance, and
 * `r = spread · t^power` inverts in closed form — so the film's age is known
 * exactly everywhere, the gloss is `exp(-age / dryTime)`, and the wet leading
 * edge dries backwards into a matte body with no buffer and no per-fragment
 * state. Which means dragging `bloomDryTime` on a paused bloom re-dries the
 * whole mark at once, including the parts that are already matte.
 *
 * ## The school with no bloom in it
 *
 * No flash, no burst shell, no additive particle, no decal, and the two fields
 * hard-clamp their own luminance below `post.bloomThreshold`. The single
 * specular term in the ability is the sheen on the wet edge, and it is inside
 * that clamp: a reflection that cannot exceed the bloom threshold is an
 * observation about a wet surface rather than an emission. Both particle
 * systems are `additive: false` — pigment suspended in water does not emit, and
 * the moment one of them adds light the slot becomes a purple explosion.
 *
 * ## What a cast captures
 *
 * One seed and one timestamp — the moment the bead broke the surface. Not one
 * metre, radian or second. The pool radius, both spread laws, the finger
 * wavelength, the nucleus stagger, the drying times and every colour are
 * resolved against `settings.inkbloom` inside the update loop, on a zero-length
 * frame included.
 *
 * **Two draw calls** for the mark — one quad each — plus two shared particle
 * systems.
 */
export class InkbloomAbility extends Ability {
  constructor(context) {
    super('inkbloom', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /**
     * The solvent. One nucleus, because the water goes in where the bead did
     * and nowhere else — the *pigment* is the thing that breaks up.
     *
     * `satellites: 1` is the module's floor rather than a choice: the satellite
     * loop is behind `#if INK_MODE == 1` and does not exist in this program at
     * all, so the array is one slot of dead uniform and nothing else.
     */
    this.wash = new InkDiffusion(this.group, {
      mode: InkMode.WASH,
      sources: 1,
      satellites: 1,
      layer: LAYER.VFX,
      // Under the pigment, and lower in the world by `washHeight` against
      // `bloomHeight` as well. Render order alone is not enough: these are two
      // depth-tested quads and a millimetre of real separation is what stops
      // them stitching when the camera drops to floor level.
      renderOrder: 5,
      name: 'inkbloom.wash'
    });

    /**
     * The pigment. Four nuclei — a bead that hits water does not stay one bead,
     * and a single nucleus gives a symmetric flower that reads as a stamp.
     */
    this.pigment = new InkDiffusion(this.group, {
      mode: InkMode.BLOOM,
      sources: 4,
      satellites: 1,
      layer: LAYER.VFX,
      renderOrder: 6,
      name: 'inkbloom.pigment'
    });

    /* --- what a cast captures: one seed and one timestamp --- */
    /** Unitless. Decorrelates the fingers, the nuclei and the granulation. */
    this._seed = 0;
    /** True once the bead has broken the surface. One-way. */
    this._landed = false;
    /** The moment it did, on the cast's own clock. An event, not a duration. */
    this._landAt = 0;
    /** Metres of bead travel already paid out in grains. */
    this._beadDistance = 0;
    /** HUD readout only. */
    this._live = 2;
  }

  createParticles() {
    const particles = this.ctx.particles;

    /*
     * Pigment grains riding the fingering front, and the same substance
     * trailing off the bead on the way out.
     *
     * `additive: false` is the whole school in one flag. The first pass had
     * these additive out of habit — every other particle system in the sandbox
     * is — and a hundred glowing violet dots over a matte mark looked like a
     * mana effect. Non-additive dark grains over a dark mark are nearly
     * invisible individually, which is correct: what you see is the *texture*
     * they give the edge.
     */
    this.grains = particles.get('inkbloom.grains', {
      capacity: 1400,
      shape: ParticleShape.SOFT,
      additive: false,
      curl: true,
      softFade: 0.3
    });
    this.grains.uniforms.uDrag.value = 2.4; //  water, not air
    this.grains.uniforms.uEndSize.value = 0.55;
    this.grains.uniforms.uSizeIn.value = 0.08;
    this.grains.uniforms.uFadeIn.value = 0.12;
    this.grains.uniforms.uFadeOut.value = 0.5;

    // The slow tendril of colour standing off the drop. Non-additive so it
    // genuinely occludes the mark under it — a veil that adds light is steam.
    this.veil = particles.get('inkbloom.veil', {
      capacity: 700,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.0
    });
    this.veil.uniforms.uDrag.value = 2.1;
    this.veil.uniforms.uEndSize.value = 2.4;
    this.veil.uniforms.uSizeIn.value = 0.2;
    this.veil.uniforms.uFadeIn.value = 0.25;
    this.veil.uniforms.uFadeOut.value = 0.4;

    this.grainEmitter = new RateEmitter();
    this.veilEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * A beat's length in seconds, under the global lifetime knob.
   *
   * `pigmentDelay` goes through here too, which is not obvious and is the
   * point: a slow-motion bloom whose pigment still catches its water up in the
   * same sixth of a second is a bloom whose two fronts have stopped being two.
   */
  _span(seconds) {
    return Math.max(0.005, seconds * settings.global.lifetime);
  }

  get impactDuration() {
    return this._span(settings.inkbloom.holdTime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.inkbloom.fadeTime);
  }

  get instanceCount() {
    return this._live;
  }

  /**
   * A pool swells; it does not gutter.
   *
   * The base class's default shimmer is a two-frequency beat meant for a
   * crystal glinting. On something this dim it reads as a fault in the light
   * rather than as anything on the floor, so this is one slow cosine and
   * nothing else.
   */
  lightShimmer() {
    const c = settings.inkbloom;
    return 1 - saturate(c.lightPulse) * 0.5 * (1 - Math.cos(this.age * c.lightPulseSpeed));
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  /** The live footprint, metres. What the aim circle measured out. */
  get radius() {
    return Math.max(0.2, settings.inkbloom.zoneRadius);
  }

  /** Where the pool is: the far end of the aimed line, on the floor. */
  _centrePoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /**
   * A point on the bead's flight at `s` along it, 0..1.
   *
   * It drops from the hand to just above the water, so the grains it sheds fall
   * into the pool rather than being dusted in from head height.
   */
  _beadPoint(s, out) {
    const c = settings.inkbloom;
    const t = saturate(s);
    out
      .copy(this.origin)
      .addScaledVector(this.direction, lerp(c.handForward, this.length, t))
      .addScaledVector(this.side, c.handSide * (1 - t));
    out.y = lerp(c.handHeight, c.dropLift, t);
    return out;
  }

  /** Seconds since the bead broke the surface. The wash's whole clock. */
  _soak() {
    return this._landed ? Math.max(0, this.age - this._landAt) : 0;
  }

  /** Seconds the pigment has been spreading. Negative before it starts. */
  _pigmentAge() {
    return this._soak() - this._span(settings.inkbloom.pigmentDelay);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.grainEmitter.reset();
    this.veilEmitter.reset();

    this._landed = false;
    this._landAt = 0;
    this._beadDistance = 0;

    /*
     * The one thing a cast captures, and it is unitless.
     *
     * Both fields are rolled from it, because the water and the ink went into
     * the same pool in the same place — decorrelating their granulation phases
     * put two different papers on top of each other and the wash stopped
     * looking like the thing the pigment was spreading *through*.
     */
    this._seed = Math.random() * 100;
    this.wash.roll(this._seed);
    this.pigment.roll(this._seed);

    this._sync(0);
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings into both fields and both particle systems.
   *
   * @param {number} fade 1 while the bloom stands, ramping to 0 as it soaks away
   */
  _sync(fade) {
    const c = settings.inkbloom;
    const g = settings.global;

    this._centrePoint(_centre);
    const radius = this.radius;
    const soak = this._soak();

    /* ---------------- the wash: the solvent ---------------- */
    const w = _wash;
    w.radius = radius;
    w.height = c.washHeight;

    w.spread = c.washSpread;
    w.spreadPower = c.washSpreadPower;
    w.edge = c.washEdge;
    w.clipSoft = c.washClipSoft;
    // One nucleus. The scatter and the stagger are the pigment's business.
    w.sources = 1;
    w.sourceScatter = 0;
    w.sourceDelay = 0;

    // Not read in WASH — the instability is `#if`'d out of that program — but
    // written anyway, because a params object filled in only where the current
    // mode happens to look is a params object that breaks the day somebody
    // changes the mode.
    w.finger = 0;
    w.fingerMax = 0;

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
    w.colorWash = c.washColorThin;
    w.colorBody = c.washColorBody;
    w.colorDeep = c.washColorDeep;
    w.colorPool = c.washColorPool;
    w.colorRing = c.washColorRing;
    w.colorWet = c.washColorWet;
    w.colorGloss = c.washColorGloss;

    this.wash.setPlacement(_centre, this.direction);
    this.wash.update(soak, w);

    /* ---------------- the bloom: the pigment ---------------- */
    const b = _bloom;
    b.radius = radius;
    b.height = c.bloomHeight;

    b.spread = c.bloomSpread;
    b.spreadPower = c.bloomSpreadPower;
    b.edge = c.bloomEdge;
    b.clipSoft = c.bloomClipSoft;
    b.sources = c.bloomSources;
    b.sourceScatter = c.bloomSourceScatter;
    b.sourceDelay = c.bloomSourceDelay;

    b.finger = c.bloomFinger;
    b.fingerMax = c.bloomFingerMax;
    b.coarse = c.bloomCoarse;
    b.onset = c.bloomOnset;
    b.growth = c.bloomGrowth;
    b.growthMax = c.bloomGrowthMax;

    b.core = c.bloomCore;
    b.falloff = c.bloomFalloff;
    b.film = c.bloomFilm;
    b.granulation = c.bloomGranulation;
    b.granScale = c.bloomGranScale;
    b.ring = c.bloomRing;
    b.ringWidth = c.bloomRingWidth;

    b.dryTime = c.bloomDryTime;
    b.wetDarken = c.bloomWetDarken;
    b.gloss = c.bloomGloss;
    b.glossPower = c.bloomGlossPower;
    b.meniscus = c.bloomMeniscus;

    b.opacity = c.bloomOpacity * g.opacity;
    b.fade = fade;
    b.ceiling = c.bloomCeiling;
    b.softFade = c.bloomSoftFade;
    b.tint = c.bloomTint;
    b.tintDensity = c.bloomTintDensity;
    b.colorWash = c.bloomColorThin;
    b.colorBody = c.bloomColorBody;
    b.colorDeep = c.bloomColorDeep;
    b.colorPool = c.bloomColorPool;
    b.colorRing = c.bloomColorRing;
    b.colorWet = c.bloomColorWet;
    b.colorGloss = c.bloomColorGloss;

    this.pigment.setPlacement(_centre, this.direction);
    // Clamped at zero rather than skipped: the front law wants a time and the
    // whole point of this module is that it re-resolves on any clock you hand
    // it, including one that has not started.
    this.pigment.update(Math.max(0, this._pigmentAge()), b);

    this._live = 1 + Math.max(1, Math.round(c.bloomSources));

    /* ---------------- the two particle systems ---------------- */
    this.grains.setGradient(
      getColor(c.colorGrainA),
      getColor(c.colorGrainB),
      getColor(c.colorGrainC),
      getColor(c.colorGrainD)
    );
    // Negative: pigment settles. Grains that rise are steam and this is not.
    this.grains.uniforms.uGravity.value.set(0, c.grainSink, 0);
    this.grains.uniforms.uSizeScale.value = c.grainSize * g.particleSize * 7;
    this.grains.uniforms.uLifeScale.value = c.grainLifetime * 0.5 * g.particleLifetime;
    this.grains.uniforms.uSpeedScale.value = g.particleSpeed;
    this.grains.uniforms.uOpacity.value = g.opacity;
    this.grains.uniforms.uTurbulence.value = c.grainTurbulence * g.turbulence;

    this.veil.setGradient(
      getColor(c.colorVeilA),
      getColor(c.colorVeilB),
      getColor(c.colorVeilC),
      getColor(c.colorVeilD)
    );
    this.veil.uniforms.uGravity.value.set(0, c.veilRise, 0);
    this.veil.uniforms.uSizeScale.value = c.veilSize * g.particleSize;
    this.veil.uniforms.uLifeScale.value = c.veilLifetime * 0.5 * g.particleLifetime;
    this.veil.uniforms.uSpeedScale.value = c.veilSpeed * g.particleSpeed;
    this.veil.uniforms.uOpacity.value = c.veilOpacity * g.opacity;
    this.veil.uniforms.uTurbulence.value = 0.5 * g.turbulence;
  }

  /**
   * Grains paid out per metre of the bead's flight, so the trail arrives at the
   * same density whether the pool was chosen at four metres or at twenty.
   * Keyed off distance rather than off time for exactly that reason.
   */
  _beadFx() {
    const c = settings.inkbloom;
    const step = 1 / Math.max(0.05, c.dropRate);
    const time = frame.uTime.value;

    while (this.front - this._beadDistance >= step) {
      this._beadDistance += step;
      const s = saturate(this._beadDistance / this.length);
      this._beadPoint(s, _pos);

      _emit.position = _pos;
      _emit.radius = 0.05;
      _emit.direction = _dir.set(0, -1, 0);
      _emit.speed = c.grainSpeed * 0.5;
      _emit.speedVariance = 0.6;
      _emit.spread = 0.7;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.7;
      _emit.sizeVariance = 0.5;
      _emit.life = c.grainLifetime * 0.5;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.grains.emit(2, _emit);
    }
  }

  /**
   * Everything the standing bloom sheds.
   *
   * The grains are emitted **on the front**, not over the disc: the field's own
   * CPU mirror is asked where each nucleus's front is this frame, and the
   * annulus follows it outward. Scattering them uniformly over the mark was the
   * first attempt and it read as dust lying on a stain — the whole information
   * in a grain is that it is being carried by an edge that is moving.
   *
   * @param {number} dt
   * @param {number} scale 0..1 — thinned as the bloom soaks away
   */
  _bloomFx(dt, scale) {
    const c = settings.inkbloom;
    const g = settings.global;
    const time = frame.uTime.value;
    const sources = Math.max(1, Math.round(c.bloomSources));

    /* --- grains on the pigment front --- */
    const grainCount = Math.round(this.grainEmitter.tick(dt, c.grainRate * scale) * g.particleCount);
    if (grainCount > 0) {
      // Whichever nucleus the dice pick this frame, at its *own* front radius.
      // The later nuclei are behind the first by `bloomSourceDelay`, so the
      // band is genuinely several rings and not one.
      const which = Math.min(sources - 1, Math.floor(Math.random() * sources));
      this.pigment.sourcePoint(which, _nucleus);
      const front = this.pigment.frontRadius(which);
      const band = front * saturate(c.grainBand);
      const angle = Math.random() * TAU;
      const r = Math.max(0, front + randRange(-band, band));

      _pos.set(_nucleus.x + Math.cos(angle) * r, c.bloomHeight + 0.02, _nucleus.z + Math.sin(angle) * r);
      _emit.position = _pos;
      _emit.radius = band * 0.5 + 0.04;
      // Outward along the front's own normal, which is what a grain carried by
      // a spreading edge does. A vertical direction here made them puff.
      _emit.direction = _dir.set(Math.cos(angle), 0.25, Math.sin(angle)).normalize();
      _emit.speed = c.grainSpeed;
      _emit.speedVariance = 0.75;
      _emit.spread = 0.55;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 1;
      _emit.sizeVariance = 0.65;
      _emit.life = c.grainLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.grains.emit(grainCount, _emit);
    }

    /* --- the veil standing over the drop --- */
    const veilCount = Math.round(this.veilEmitter.tick(dt, c.veilRate * scale) * g.particleCount);
    if (veilCount > 0) {
      const front = Math.max(0.05, this.pigment.frontRadius(0));
      const angle = Math.random() * TAU;
      // sqrt of a uniform draw is uniform over the disc; without it the veil
      // crowds the middle and the tendril becomes a chimney.
      const r = front * Math.sqrt(Math.random()) * 0.7;
      this.pigment.sourcePoint(0, _nucleus);

      _pos.set(_nucleus.x + Math.cos(angle) * r, randRange(0.05, 0.35), _nucleus.z + Math.sin(angle) * r);
      _emit.position = _pos;
      _emit.radius = front * 0.12 + 0.05;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.veilSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.85;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 1;
      _emit.sizeVariance = 0.5;
      _emit.life = c.veilLifetime;
      _emit.lifeVariance = 0.45;
      _emit.spin = 0.2;
      _emit.tint = null;
      _emit.time = time;
      this.veil.emit(veilCount, _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    // Both fields are synced every frame of the flight even though neither is
    // drawing anything yet: their `fade` is zero, but their metres are not, and
    // an author who drags `zoneRadius` while a bead is in the air must get the
    // pool they chose when it lands.
    this._sync(0);

    // The light rides the bead out to the water.
    this._beadPoint(this.u, this.position);

    this._beadFx();
    this.ctx.shake.rumble(settings.inkbloom.rumble * settings.global.cameraShake * 0.5, dt);
  }

  onImpact() {
    const c = settings.inkbloom;
    const g = settings.global;

    // The one timestamp a cast records past the seed.
    this._landed = true;
    this._landAt = this.age;

    this._centrePoint(this.position);
    this.position.y = 0.15;

    // No flash and no burst: the two pieces of impact vocabulary this sandbox
    // reaches for first are both emissive, and this school does not emit. A
    // bead of ink hitting water is a small wet sound and a kick, and that is
    // all the punctuation it gets.
    this.ctx.shake.add(
      c.dropShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      18
    );
    this._sync(1);
  }

  onFade(dt, t) {
    /*
     * `t` runs 0..1 while the bloom opens, then 1..2 while it soaks away.
     *
     * The emissive schools blow out on `inCubic` — hang on, then go, the way a
     * light being switched off does. A stain does not do that. It thins evenly
     * as the water leaves it, so this is `inQuad`, which is gentle enough to
     * read as absorption and steep enough that the slot does not outstay the
     * cooldown.
     */
    const fade = t <= 1 ? 1 : 1 - Easing.inQuad(saturate(t - 1));
    this._sync(fade);

    this._centrePoint(this.position);
    this.position.y = 0.15;

    // Thinned as it dies, and thinned again once the front has reached the
    // boundary — a bloom that has stopped spreading has stopped carrying
    // anything to its edge, so the grains should stop with it.
    const front = this.pigment.frontRadius(0);
    const spreading = 1 - saturate(front / Math.max(0.2, this.radius));
    this._bloomFx(dt, fade * (0.25 + 0.75 * spreading));

    this.ctx.shake.rumble(settings.inkbloom.rumble * fade * settings.global.cameraShake, dt);
  }

  onDestroy() {
    this._live = 2;
    this._landed = false;
    this._landAt = 0;
    this.wash.reset();
    this.pigment.reset();
  }

  dispose() {
    this.wash.dispose();
    this.pigment.dispose();
    super.dispose();
  }
}
