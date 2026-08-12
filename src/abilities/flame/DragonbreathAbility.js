import { Matrix4, Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { VolumeHull, HullShape, Medium } from '../../vfx/VolumeHull.js';
import { GroundField, GroundMode, groundFieldParams } from '../../vfx/GroundField.js';
import { FilamentPaths, filamentLook } from '../../vfx/FilamentPaths.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, Easing, randRange } from '../../utils/math.js';

const TAU = Math.PI * 2;

/**
 * Contact samples the floor burn carries.
 *
 * Twenty, and the posting step is clamped so a full-length track always fits
 * inside them — see `_postContacts()`. The list is a ring buffer, so overrunning
 * it would quietly evict the samples nearest the caster, which are exactly the
 * ones carrying the taper that stands in for a wedge.
 */
const CONTACTS = 20;

/* Module-scope scratch. A sustained breath allocates nothing — I3. */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _apex = new Vector3();
const _mouth = new Vector3();
const _from = new Vector3();
const _to = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();
const _localUp = new Vector3();
const _up = new Vector3(0, 1, 0);
const _basis = new Matrix4();
/** The ground field's params bag, refilled from settings every frame. */
const _burn = groundFieldParams();
/** The filament strip's shared look, likewise. */
const _look = filamentLook();

/**
 * WYRM'S BREATH — a **real** cone of flame, sustained.
 *
 * A line cast held open. The apex is pinned at the caster's hand, the mouth is
 * out at the aimed point, and the gout between them is a raymarched volume
 * inside a `CONE` hull — not a widening billboard, not a stack of camera-facing
 * cards. The floor beneath it takes a burn that grows along the cone's own
 * ground intersection while the breath is held, and a handful of loose
 * filaments lick out past the front edge.
 *
 * ## THE TRICK — the density peak is off the axis
 *
 * `VolumeHull`'s cone silhouette is
 *
 *   core = 1 − |r − hollow| / (1 − hollow)
 *
 * where `r` is normalised by the *local* radius, so it means the same thing at
 * every station down the cone. With `flameHollow` at 0 that is `1 − r`: a solid
 * cone, densest on the axis, and it reads as a cardboard megaphone from every
 * single angle because there is nothing to see through. Push it to about 0.45
 * and the peak moves halfway out to the wall with the middle left empty — which
 * is what a nozzle actually does, since fuel burns in the shear layer and not
 * in the core. Orbit the cast and you look *through* the near wall of the
 * tongue at the far one, and the thing stops being a shape and becomes a
 * volume. That single number is the ability.
 *
 * The sustain is the second half of it. `Medium.FLAME` samples its field in
 * `localDomain()` — hull space — and `flameJet` slides that domain backwards
 * along the hull's own +Z, so the turbulence crawls *outward* at a real
 * metres-per-second and yaws with the caster instead of being swum through.
 * (Pyroclasm needs precisely the opposite and its comment says so; the two
 * abilities are the two halves of the same argument.)
 *
 * ## Why the hull is not placed with `place()`
 *
 * `VolumeHull#place()` applies **yaw only**, and it is right to: a dome or a
 * floor slab that pitched with the aim line would lift off the ground at one
 * edge and bury itself at the other. A breath cone is the exception — its apex
 * is at chest height and its mouth is nearly on the floor, so it has to pitch.
 * `_placeCone()` builds the rigid basis itself. Rigid is the requirement, not
 * axis-aligned: the march carries one parameter in world metres and only cares
 * that the matrix has no scale in it.
 *
 * ## Reach, and why the burn follows it
 *
 * Every metre downstream comes from one number: `span`, the distance from the
 * apex to the mouth, re-derived every frame from `this.length × reach`. The
 * hull's three half-extents, the tongues' start and overshoot, the light's
 * seat, the burn's length — all of them. So dragging `reach` on a paused,
 * standing breath shortens the gout **and pulls the floor burn back in with
 * it**, because the burn's `length` is that same number and `GroundField`
 * re-scales its quad, its grain and its growth front together. A decal spawned
 * at impact captures its radius on the frame it was born; this cannot.
 *
 * The half-extents are divided by `1 − flameMargin` before they reach
 * `setSize()`. That is not a fudge factor: the margin holds the medium's
 * nominal surface that fraction *inside* the proxy, so compensating for it is
 * what makes `reach` mean the reach of the flame rather than the reach of an
 * invisible box around it. Without the compensation, raising the margin to stop
 * the erosion being sliced also silently shortened the gout, and the two
 * sliders fought each other every time.
 *
 * ## What a cast captures
 *
 * `_seed`, one dice roll, and `_contactDistance`, a metres-of-front-travel
 * counter that paces the contact samples — the same bookkeeping
 * `ThunderAbility._burnDistance` does, and for the same reason. No dimension is
 * stored: every metre, radian, second and colour is resolved against
 * `settings.dragonbreath` inside the update loop, zero-length frames included.
 *
 * ## Cost
 *
 * Four draw calls: the volume, the floor burn, and the filament strip's two
 * passes. One dynamic light.
 */
export class DragonbreathAbility extends Ability {
  constructor(context) {
    super('dragonbreath', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /**
     * The gout. Emissive, so the shader is compiled without the self-shadow
     * branch at all — `VolumeHull` does that for `Medium.FLAME` by default, and
     * it is what pays for 38 steps on a hull this close to the eye.
     */
    this.hull = new VolumeHull({
      hull: HullShape.CONE,
      medium: Medium.FLAME,
      prefix: 'flame',
      maxSteps: 56,
      renderOrder: 12
    });
    this.group.add(this.hull.mesh);

    /**
     * The floor. `RUT` is the only `GroundField` mode whose front runs *down* a
     * length rather than out from a centre, which is what a cone's ground
     * intersection needs. It carries a live `length` and a live `progress`, and
     * a list of contact samples that let the burn taper toward the caster.
     */
    this.scorch = new GroundField(this.group, {
      mode: GroundMode.RUT,
      marks: CONTACTS,
      additive: false,
      name: 'Dragonbreath:burn'
    });
    this.scorch.setVisible(false);

    /**
     * The tongues. One role of the shared strip — two draw calls whatever the
     * filament count, because the halo is drawn as real ribbon underneath the
     * core rather than left to bloom, which is what keeps the glow attached to
     * every kink.
     */
    this.tongues = new FilamentPaths(this.group, {
      samples: 56,
      capacity: 24,
      renderOrder: 13
    });
    this.tongues.visible = false;

    /** Re-rolled per cast so no two breaths draw the same flame. */
    this._seed = 0;
    /** Metres of front travel already paid out in contact samples. */
    this._contactDistance = 0;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Sparks torn out of the mouth. Velocity-stretched, so a fast one reads as
    // a streak of burning fuel rather than as a dot.
    this.embers = particles.get('dragonbreath.embers', {
      capacity: 3000,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.25
    });
    this.embers.uniforms.uDrag.value = 1.5;
    this.embers.uniforms.uEndSize.value = 0.22;
    this.embers.uniforms.uSizeIn.value = 0.03;
    this.embers.uniforms.uFadeIn.value = 0.04;
    this.embers.uniforms.uFadeOut.value = 0.45;

    // Burning fuel that failed to burn, falling out of the underside of the
    // cone. This is the system that tells you the gout has weight.
    this.drips = particles.get('dragonbreath.drips', {
      capacity: 1200,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.35
    });
    this.drips.uniforms.uDrag.value = 0.9;
    this.drips.uniforms.uEndSize.value = 0.28;
    this.drips.uniforms.uSizeIn.value = 0.06;
    this.drips.uniforms.uFadeIn.value = 0.07;
    this.drips.uniforms.uFadeOut.value = 0.5;

    // Smoke off the burnt floor. Non-additive so it genuinely occludes.
    this.smoke = particles.get('dragonbreath.smoke', {
      capacity: 2000,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.1
    });
    this.smoke.uniforms.uDrag.value = 1.8;
    this.smoke.uniforms.uEndSize.value = 3.1;
    this.smoke.uniforms.uSizeIn.value = 0.12;
    this.smoke.uniforms.uFadeIn.value = 0.16;
    this.smoke.uniforms.uFadeOut.value = 0.3;

    this.emberEmitter = new RateEmitter();
    this.dripEmitter = new RateEmitter();
    this.smokeEmitter = new RateEmitter();
    this.shellEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this.tongues.liveCount;
  }

  /** The sustain. This is the beat the ability is for. */
  get impactDuration() {
    return Math.max(0.1, settings.dragonbreath.sustainTime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.dragonbreath.fadeTime);
  }

  /** Flame breathes rather than gutters: a fast, shallow, unquantised wobble. */
  lightShimmer() {
    return 0.88 + 0.12 * Math.sin(this.age * 17.3) * Math.sin(this.age * 6.1);
  }

  /* ------------------------------------------------------------------ */
  /* The beats                                                           */
  /* ------------------------------------------------------------------ */

  /** 0..1 through the gutter-out. */
  _gutter() {
    if (this.phase !== AbilityPhase.FADE) return 0;
    return saturate(this.fadeTime / Math.max(0.05, settings.dragonbreath.fadeTime));
  }

  /** Master fade. Thins the medium as well as dimming it — see `setFade()`. */
  _fadeAmount() {
    return 1 - Easing.inQuad(this._gutter());
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  /**
   * How far down the cast line the mouth currently sits, as a fraction of
   * `this.length`.
   *
   * `reach` is the live multiplier; `this.length` is the distance the cast was
   * aimed at, which the base class owns. During the gutter the mouth walks back
   * toward the caster, so the gout is *withdrawn* rather than merely faded —
   * fading alone leaves a ghost cone hanging in the air at full length, which
   * looked like the effect had been switched off rather than stopped.
   */
  _reachFraction() {
    const c = settings.dragonbreath;
    if (this.phase === AbilityPhase.TRAVEL) return this.u * c.reach;
    if (this.phase !== AbilityPhase.FADE) return c.reach;
    return c.reach * lerp(1, c.dieback, Easing.inQuad(this._gutter()));
  }

  /** The apex, at the caster's hand. */
  _apexPoint(out) {
    const c = settings.dragonbreath;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /** The centre of the mouth, out at the target. */
  _mouthPoint(out) {
    this.pointAt(this._reachFraction(), out);
    out.y = settings.dragonbreath.endHeight;
    return out;
  }

  /**
   * A point on the cone's axis, `f` of the way from apex to mouth.
   *
   * `f` past 1 extrapolates, which is deliberate: the tongues aim past the
   * mouth and that is the only reason they can outrun the volume.
   */
  _axisPoint(f, out) {
    this._apexPoint(_apex);
    this._mouthPoint(_mouth);
    return out.copy(_apex).lerp(_mouth, f);
  }

  /** Apex-to-mouth distance, metres. */
  _span() {
    this._apexPoint(_apex);
    this._mouthPoint(_mouth);
    return Math.max(0.05, _apex.distanceTo(_mouth));
  }

  /** Half-width of the mouth, metres. Every fan in the cast is scaled off it. */
  _mouthRadius() {
    return this._span() * settings.dragonbreath.coneFlare;
  }

  /**
   * Pin the hull: apex at `_apex`, local +Z down the axis, local +Y as close to
   * world up as the pitch allows.
   *
   * See the class comment for why this does not go through `place()`. The
   * degenerate case — a cast aimed straight up or down — leaves `up × forward`
   * at zero length, and a normalised zero is NaN geometry that the harness
   * reports as a non-finite instance matrix rather than as anything you could
   * look at, so it is guarded rather than trusted.
   */
  _placeCone() {
    const mesh = this.hull.mesh;
    _fwd.subVectors(_mouth, _apex);
    const span = _fwd.length();
    if (span < 1e-4) _fwd.copy(this.direction);
    else _fwd.divideScalar(span);

    _right.crossVectors(_up, _fwd);
    if (_right.lengthSq() < 1e-8) _right.copy(this.side);
    _right.normalize();
    _localUp.crossVectors(_fwd, _right).normalize();

    _basis.makeBasis(_right, _localUp, _fwd);
    mesh.quaternion.setFromRotationMatrix(_basis);
    mesh.position.copy(_apex);
    mesh.updateMatrix();
  }

  /** Yaw of the cast, radians — the frame the floor burn is drawn in. */
  _yaw() {
    return Math.atan2(this.direction.x, this.direction.z);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.emberEmitter.reset();
    this.dripEmitter.reset();
    this.smokeEmitter.reset();
    this.shellEmitter.reset();
    this._contactDistance = 0;
    this.scorch.clearMarks();

    // The one thing a cast captures. Everything else is resolved per frame.
    this._seed = Math.random() * 100;

    this.scorch.setVisible(false);
    this._sync(1);
    this._muzzleFx();
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /** @param {number} fade 1 while the breath is held, ramping to 0 as it gutters */
  _sync(fade) {
    this._apexPoint(_apex);
    this._mouthPoint(_mouth);
    this._syncVolume(fade);
    this._syncTongues(fade);
    this._syncBurn(fade);
    this._syncParticles();
  }

  /** The cone itself. */
  _syncVolume(fade) {
    const c = settings.dragonbreath;
    const g = settings.global;
    const span = Math.max(0.05, _apex.distanceTo(_mouth));

    // Margin compensation: the medium's nominal surface sits `flameMargin` of
    // the way inside the proxy, so the proxy has to be that much bigger for the
    // flame's own reach to equal `span`. `coneSlack` is the extra headroom the
    // erosion spills into on top of that.
    const k = Math.max(1, c.coneSlack) / Math.max(0.2, 1 - c.flameMargin);
    const half = span * c.coneFlare;

    this._placeCone();
    this.hull
      // CONE: x and y are the mouth's half-extents, z is the axial length.
      .setSize(half * k, half * c.coneSquash * k, span * k)
      .setFade(fade)
      .sync(c, g);
  }

  /**
   * The tongues at the front edge.
   *
   * They are drawn *short* and their draw length oscillates about
   * `tongueLickBase`, so on the up-swing they run past the volume's own tip and
   * on the down-swing they fall back inside it. The first version oscillated
   * their target point instead, which moves the whole filament including the
   * end anchored in the cone — the tongues slid back and forth like pistons
   * rather than licking, and the fault was not visible until they were slowed
   * down.
   */
  _syncTongues(fade) {
    const c = settings.dragonbreath;
    const g = settings.global;
    const span = Math.max(0.05, _apex.distanceTo(_mouth));
    const role = this.tongues.role(0);

    _from.copy(_apex).lerp(_mouth, c.tongueStart);
    _to.copy(_apex).lerp(_mouth, c.tongueOvershoot);

    role.count = Math.max(0, Math.round(c.tongueCount));
    role.line(
      _from,
      _to,
      c.tongueSag,
      c.tongueNear,
      span * c.coneFlare * c.tongueFan,
      c.tongueSpreadCurve,
      c.tongueTwist,
      c.tongueTwistSpeed,
      c.tongueConverge
    );
    role.style(c.tongueKink, c.tongueWidthScale, c.tongueDim, c.tongueGroundDamp);
    role.ends(c.tongueFadeStart, c.tongueFadeEnd, c.tongueTaperStart, c.tongueTaperEnd);

    const lick = c.tongueLickBase + c.tongueLickDepth * Math.sin(this.age * c.tongueLickSpeed * TAU);
    // While the gout is still on its way out the tongues cannot be ahead of a
    // front that has not arrived, so the travel progress caps the lick.
    const drawn = this.phase === AbilityPhase.TRAVEL ? Math.min(this.u, lick) : lick;
    role.draw(drawn, c.tongueTipLength, c.tongueFloor, c.tongueTipGlow);

    _look.width = c.tongueWidth;
    _look.glowWidth = c.tongueGlowWidth;
    _look.glowOpacity = c.tongueGlowOpacity;
    _look.jitter = c.tongueJitter;
    _look.jitterScale = c.tongueJitterScale;
    _look.octaves = c.tongueOctaves;
    _look.jitterFalloff = c.tongueJitterFalloff;
    _look.crawl = c.tongueCrawl;
    _look.pinch = c.tonguePinch;
    _look.restrike = c.tongueRestrike;
    _look.flicker = c.tongueFlicker;
    _look.flickerSpeed = c.tongueFlickerSpeed;
    _look.strandFlash = c.tongueStrandFlash;
    _look.coreSharp = c.tongueCoreSharp;
    _look.glowFalloff = c.tongueGlowFalloff;
    _look.softFade = c.tongueSoftFade;
    _look.opacity = c.tongueOpacity;
    _look.glow = c.tongueGlow;
    _look.colorCore = c.colorTongueCore;
    _look.colorInner = c.colorTongueInner;
    _look.colorOuter = c.colorTongueOuter;
    _look.colorHalo = c.colorTongueHalo;
    _look.randomness = g.randomness;
    _look.noiseStrength = g.noiseStrength;
    _look.noiseFrequency = g.noiseFrequency;
    _look.noiseSpeed = g.noiseSpeed;
    _look.opacityScale = g.opacity;
    _look.glowScale = g.glow;

    // `sync()` overwrites the counts, so they are set above, every frame.
    this.tongues.sync(_look, fade, this._seed);
    this.tongues.visible = fade > 0.01 && role.count > 0;
  }

  /** The floor, burning along the cone's ground intersection. */
  _syncBurn(fade) {
    const c = settings.dragonbreath;
    const g = settings.global;

    // The horizontal run of the track, from under the apex to under the mouth.
    // `full` is what the quad is sized to and `now` is how far the burn has
    // been drawn — both live, so `reach` moves them together.
    const full = Math.max(0.3, this.length * c.reach - c.handForward);
    const now = Math.max(0, this.length * this._reachFraction() - c.handForward);

    _pos.set(_apex.x, 0, _apex.z);
    _burn.centre = _pos;
    _burn.yaw = this._yaw();
    _burn.height = c.scorchHeight;
    _burn.length = full;
    _burn.progress = saturate(now / full);
    _burn.fade = fade;
    _burn.seed = this._seed;

    _burn.edge = c.scorchEdge;
    _burn.raggedScale = c.scorchRaggedScale;

    _burn.relief = c.scorchRelief;
    _burn.normalStep = c.scorchNormalStep;
    _burn.ambient = c.scorchAmbient;
    _burn.wrap = c.scorchWrap;
    _burn.specular = c.scorchSpecular;
    _burn.gloss = c.scorchGloss;
    _burn.parallax = c.scorchParallax;

    // The track is as wide as the mouth it came out of, so widening the cone
    // widens the burn. A cone's footprint is really a wedge and none of
    // GroundField's ten modes draws one — the taper is carried by the contact
    // samples instead, which shade and thin the near end.
    _burn.width = Math.max(0.05, this._mouthRadius() * c.scorchWidth);
    _burn.depth = c.scorchDepth;
    _burn.lift = c.scorchLift;
    _burn.thickness = c.scorchThickness;
    _burn.seam = c.scorchSeam;
    _burn.cell = c.scorchCell;
    _burn.swirl = c.scorchWander;
    _burn.sharp = c.scorchSharp;
    _burn.detail = c.scorchDetail;

    _burn.additive = false;
    _burn.emissive = c.scorchEmissive;
    _burn.opacity = c.scorchOpacity;
    _burn.depthFade = c.scorchDepthFade;
    _burn.colorBase = c.colorScorchBase;
    _burn.colorEdge = c.colorScorchEdge;
    _burn.colorGlow = c.colorScorchGlow;
    _burn.colorDeep = c.colorScorchDeep;

    _burn.noiseStrength = g.noiseStrength;
    _burn.noiseFrequency = g.noiseFrequency;
    _burn.noiseSpeed = g.noiseSpeed;
    _burn.opacityScale = g.opacity;

    this.scorch.update(_burn);
    this.scorch.setVisible(fade > 0.004 && _burn.progress > 0.002);
  }

  /** The three particle systems. */
  _syncParticles() {
    const c = settings.dragonbreath;
    const g = settings.global;

    this.embers.setGradient(
      getColor(c.colorEmberA),
      getColor(c.colorEmberB),
      getColor(c.colorEmberC),
      getColor(c.colorEmberD)
    );
    this.embers.uniforms.uGravity.value.set(0, c.emberGravity, 0);
    this.embers.uniforms.uSizeScale.value = c.emberSize * g.particleSize * 7;
    this.embers.uniforms.uLifeScale.value = c.emberLifetime * 0.5 * g.particleLifetime;
    this.embers.uniforms.uSpeedScale.value = g.particleSpeed;
    this.embers.uniforms.uOpacity.value = g.opacity;
    this.embers.uniforms.uGlow.value = c.emberGlow * g.glow;
    this.embers.uniforms.uStretch.value = c.emberStretch;
    this.embers.uniforms.uTurbulence.value = 0.3 * g.turbulence;

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
    this.drips.uniforms.uOpacity.value = g.opacity;
    this.drips.uniforms.uGlow.value = c.dripGlow * g.glow;
    this.drips.uniforms.uTurbulence.value = c.dripTurbulence * g.turbulence;

    this.smoke.setGradient(
      getColor(c.colorSmokeA),
      getColor(c.colorSmokeB),
      getColor(c.colorSmokeC),
      getColor(c.colorSmokeD)
    );
    this.smoke.uniforms.uGravity.value.set(0, c.smokeRise, 0);
    this.smoke.uniforms.uSizeScale.value = c.smokeSize * g.particleSize;
    this.smoke.uniforms.uLifeScale.value = c.smokeLifetime * 0.5 * g.particleLifetime;
    this.smoke.uniforms.uSpeedScale.value = c.smokeSpeed * g.particleSpeed;
    this.smoke.uniforms.uOpacity.value = c.smokeOpacity * g.opacity;
    this.smoke.uniforms.uTurbulence.value = 0.35 * g.turbulence;
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Contact samples posted as the front runs out.
   *
   * Paced by *distance*, the way `ThunderAbility` paces its ground burns, so
   * the samples are evenly spaced along the track however fast the front is
   * moving. The step is floored at one-nineteenth of the full track: `markRate`
   * is a slider and a generous one would otherwise overrun the ring buffer and
   * evict the near-caster samples, which are the ones holding the taper.
   */
  _postContacts() {
    const c = settings.dragonbreath;
    const full = Math.max(0.3, this.length * c.reach - c.handForward);
    const step = Math.max(1 / Math.max(0.05, c.markRate), full / (CONTACTS - 1));
    const time = frame.uTime.value;

    while (this.front - this._contactDistance >= step) {
      this._contactDistance += step;
      const s = saturate((this._contactDistance - c.handForward) / full);
      // x is unused by RUT; z is the fraction along the track and w the force.
      this.scorch.mark(0, s, time, lerp(c.markNear, 1, s));
    }
  }

  /** The flare at the hand as the breath starts. */
  _muzzleFx() {
    const c = settings.dragonbreath;
    const g = settings.global;

    this._apexPoint(_pos);

    this.ctx.bursts.spawn(BurstMode.FIRE, _pos, {
      radius: c.muzzleSize * 0.25,
      endRadius: c.muzzleSize * g.explosionIntensity,
      life: 0.4,
      intensity: c.muzzleIntensity,
      opacity: 0.8,
      fresnel: 1.4,
      displace: 0.6,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    _emit.position = _pos;
    _emit.radius = 0.16;
    _emit.direction = _dir.copy(this.direction);
    _emit.speed = c.emberSpeed * 1.2;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.7;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.18;
    _emit.sizeVariance = 0.7;
    _emit.life = c.emberLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.embers.emit(Math.round(30 * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.5 * g.explosionIntensity;
  }

  /**
   * Everything the gout sheds: embers out of the mouth, burning fuel off its
   * underside, smoke off the track behind it, and shells of burning air at the
   * mouth while it is held.
   *
   * @param {number} scale 0..1 — thinned out as the breath gutters
   */
  _breathFx(dt, scale) {
    const c = settings.dragonbreath;
    const g = settings.global;
    const time = frame.uTime.value;
    const span = this._span();
    const mouthRadius = this._mouthRadius();

    /* --- embers streaming out of the mouth, along the axis --- */
    const emberCount = Math.round(this.emberEmitter.tick(dt, c.emberRate * scale) * g.particleCount);
    if (emberCount > 0) {
      // Born a little short of the mouth so they are already inside the flame
      // when they appear, rather than popping into being in clear air.
      this._axisPoint(randRange(0.6, 1.0), _pos);
      _emit.position = _pos;
      _emit.radius = mouthRadius * 0.65;
      _emit.direction = _dir.subVectors(_mouth, _apex).normalize();
      _emit.speed = c.emberSpeed;
      _emit.speedVariance = 0.85;
      _emit.spread = c.emberSpread;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.16;
      _emit.sizeVariance = 0.7;
      _emit.life = c.emberLifetime;
      _emit.lifeVariance = 0.55;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.embers.emit(emberCount, _emit);
    }

    /* --- burning fuel falling off the underside --- */
    const dripCount = Math.round(this.dripEmitter.tick(dt, c.dripRate * scale) * g.particleCount);
    if (dripCount > 0) {
      const f = randRange(c.dripSeat * 0.6, c.dripSeat * 1.25);
      this._axisPoint(f, _pos);
      // The cone's local radius grows linearly with f, so the drips come off
      // the wall rather than out of the middle — the middle is hollow.
      _pos.y -= span * c.coneFlare * f * c.coneSquash * 0.7;
      _emit.position = _pos;
      _emit.radius = mouthRadius * f * 0.5;
      _emit.direction = _dir.set(0, -1, 0);
      _emit.speed = c.dripSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.85;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.12;
      _emit.sizeVariance = 0.7;
      _emit.life = c.dripLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.drips.emit(dripCount, _emit);
    }

    /* --- smoke off the track behind the front --- */
    const smokeCount = Math.round(this.smokeEmitter.tick(dt, c.smokeRate * scale) * g.particleCount);
    if (smokeCount > 0) {
      this.pointAt(randRange(0.05, 1) * this._reachFraction(), _pos).setY(0.18);
      _emit.position = _pos;
      _emit.radius = mouthRadius * c.scorchWidth;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.smokeSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.9;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.85;
      _emit.sizeVariance = 0.5;
      _emit.life = c.smokeLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.4;
      _emit.tint = null;
      _emit.time = time;
      this.smoke.emit(smokeCount, _emit);
    }

    /* --- shells of burning air shed at the mouth --- */
    const shells = this.shellEmitter.tick(dt, c.mouthBurstRate * scale);
    for (let i = 0; i < shells; i++) {
      this._axisPoint(randRange(0.8, 1.05), _pos);
      this.ctx.bursts.spawn(BurstMode.FIRE, _pos, {
        radius: c.mouthBurstSize * 0.2,
        endRadius: c.mouthBurstSize * g.explosionIntensity,
        life: 0.55,
        intensity: c.mouthBurstIntensity,
        opacity: 0.45,
        fresnel: 1.5,
        displace: 0.7,
        squash: 0.75,
        colorA: getColor(c.colorBurstA),
        colorB: getColor(c.colorBurstB),
        colorC: getColor(c.colorBurstC)
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = settings.dragonbreath;
    this._sync(1);
    this._postContacts();

    // The light rides the cone rather than the floor line the base put it on.
    this._axisPoint(saturate(c.lightSpan), this.position);

    this._breathFx(dt, this.u);
    this.ctx.shake.rumble(c.rumble * settings.global.cameraShake, dt);
  }

  /** The gout reaches the mouth. The sustain begins. */
  onImpact() {
    const c = settings.dragonbreath;
    const g = settings.global;

    // The last step of the front, which `onTravel` stopped one step short of.
    this._postContacts();

    this._apexPoint(_apex);
    this._mouthPoint(_mouth);
    _pos.copy(_mouth);

    this.ctx.bursts.spawn(BurstMode.FIRE, _pos, {
      radius: c.mouthBurstSize * 0.25,
      endRadius: c.mouthBurstSize * 1.6 * g.explosionIntensity,
      life: 0.8,
      intensity: c.mouthBurstIntensity * 1.4,
      opacity: 0.8,
      fresnel: 1.4,
      displace: 0.75,
      squash: 0.7,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      20
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.8 * g.explosionIntensity;
  }

  onFade(dt, _t) {
    const c = settings.dragonbreath;
    const fade = this._fadeAmount();

    this._sync(fade);
    this._axisPoint(saturate(c.lightSpan), this.position);

    this._breathFx(dt, fade);
    this.ctx.shake.rumble(c.rumble * fade * settings.global.cameraShake, dt);
  }

  onDestroy() {
    this._contactDistance = 0;
    this.hull.setFade(0);
    this.tongues.clear();
    this.tongues.visible = false;
    this.scorch.clearMarks();
    this.scorch.setVisible(false);
  }

  dispose() {
    this.hull.dispose();
    this.tongues.dispose();
    this.scorch.dispose();
    super.dispose();
  }
}
