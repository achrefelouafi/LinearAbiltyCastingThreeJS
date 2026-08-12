import { Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { VolumeHull, HullShape, Medium } from '../../vfx/VolumeHull.js';
import { GroundField, GroundMode } from '../../vfx/GroundField.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, Easing, randRange } from '../../utils/math.js';

/* ---------------------------------------------------------------- */
/* Scratch — module scope (I3). Nothing below allocates per frame.   */
/* ---------------------------------------------------------------- */

const _pos = new Vector3();
const _dir = new Vector3();
const _hub = new Vector3();
const _emit = {};
/** Refilled every frame and handed to `GroundField.update`. Never rebuilt. */
const _floor = {};

const TAU = Math.PI * 2;

/**
 * NIGHTFALL — the only ability in the set that makes the frame darker.
 *
 * A far cast. A dome of `Medium.VOID` closes over the footprint from the rim
 * inward, stands sealed, and opens again. The floor under it goes to near
 * black, a slow starfield turns inside it, and the caster's own dynamic light
 * is visibly losing.
 *
 * ## THE TRICK — subtraction, three times over
 *
 * **1 · The volume multiplies.** `VolumeHull` draws a non-additive medium with
 * premultiplied "over" — `ONE, ONE_MINUS_SRC_ALPHA` — and premultiplied over
 * with a near-black premultiplied colour *is* multiplication: the destination
 * is scaled by `1 - alpha` and almost nothing is added back. That is why the
 * palette bottoms out at `#000000` and why `nightScatter` is kept an order
 * under `nightAbsorption`; a medium whose scatter approaches its absorption
 * hands light back, and this one may not.
 *
 * **What tone mapping did to it, and what fixed it.** The dome draws into the
 * linear HDR buffer and ACES runs later, in `OutputPass`. ACES is monotonic, so
 * scaling the input down always scales the output down — but it is compressive
 * at the top, so taking a bloomed highlight to a fifth of itself buys far less
 * than a fifth on screen, and the first build read as "slightly hazy" over
 * anything bright. The fix is *not* more density: absorption high enough to
 * black the dome out on its own kills the transmittance in the first
 * half-metre and every star behind that integrates at `T = 0` and never
 * appears. It is `nightVoidBite`, which lifts the *final alpha* after the
 * emission has been gathered — so the dome reaches genuine black and keeps its
 * stars. Bloom is the residual: `UnrealBloomPass` runs before tone mapping and
 * after the dome, so bright geometry just outside the footprint still bleeds
 * energy back over it. Nothing here can stop that; what it can do is not add to
 * it, which is why there is no burst shell, no additive decal, and no additive
 * particle system except the stars.
 *
 * **2 · The floor shades.** `GroundField(WET)`, alpha-blended, is the one mode
 * in the library built to come out *darker* than the stone it lies on.
 *
 * **3 · The flash is negative.** `GradeShader` mixes the frame *toward* the
 * flash colour rather than adding it, so `ctx.flash.trigger(black, castDim)` is
 * a screen-wide dim. Nothing else in the project uses `ScreenFlash` that way.
 *
 * ## The lid, and the uniform that is really an aperture
 *
 * `HullShape.DOME` has no aperture parameter — `Hollow` and `Throat` are
 * cone-only — and a second hull would mean a second raymarch over the same
 * pixels. So the lid is `heightBias` driven past its nominal `0..1`: the
 * silhouette term is `(1 - r) · (1 - bias·yn)`, which goes **negative** above
 * `yn = 1/bias`, and negative silhouette is zero density. The medium therefore
 * fills only the part of the dome below that latitude, and the circle where it
 * meets the dome's surface has radius `R·sqrt(1 - (1/bias)²)`. Walking that
 * circle from the boundary up to the apex closes the hole from the rim inward,
 * in one uniform. See `_lidBias` for why the beat authors the *circle* and
 * inverts for the uniform rather than the other way round.
 *
 * It closes *raggedly* for free, too. Erosion in `mediumDensity` scales with
 * `clamp(1 - shape, 0, 2)²`, which peaks exactly where the silhouette crosses
 * zero — the lip of the aperture. A hard analytic edge would have been the tell
 * and nothing had to be written to avoid it.
 *
 * The value is poked into `uHeightBias` immediately after `sync()`, not written
 * into the settings block: `nightHeightBias` stays the author's base and the
 * beat is added on top, so both are live under a paused clock.
 *
 * Two draw calls for the whole cast, plus two shared particle systems.
 */
export class NightfallAbility extends Ability {
  constructor(context) {
    super('nightfall', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    // 30 steps and no shadow taps. A dome this wide covers a large slice of the
    // frame and there is nothing inside it to light, so the taps would be paid
    // for and thrown away — see the cost table on `VolumeHull`.
    this.dome = new VolumeHull({
      hull: HullShape.DOME,
      medium: Medium.VOID,
      prefix: 'night',
      maxSteps: 48,
      shadow: false,
      renderOrder: 12,
      seed: 0
    });
    this.group.add(this.dome.mesh);

    // Non-additive, because the whole point is that it shades. `depthTest` is
    // left on: the character standing in the footprint should occlude the mark
    // rather than be painted over by it.
    this.floor = new GroundField(this.group, {
      mode: GroundMode.WET,
      additive: false,
      depthTest: true,
      name: 'nightfall.floor'
    });
    this.floor.setVisible(false);

    /** Re-rolled per cast: decorrelates the medium and the floor grain. */
    this._seed = 0;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // The veil. Non-additive — the only particle system in the project whose
    // job is to *occlude*. Additive smoke around a subtractive dome lights its
    // own outline, which is precisely backwards, and that is what the first
    // build looked like: a black dome wearing a grey halo.
    this.veil = particles.get('nightfall.veil', {
      capacity: 900,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.2
    });
    this.veil.uniforms.uDrag.value = 1.9;
    this.veil.uniforms.uEndSize.value = 2.4;
    this.veil.uniforms.uSizeIn.value = 0.18;
    this.veil.uniforms.uFadeIn.value = 0.24;
    this.veil.uniforms.uFadeOut.value = 0.45;

    // The stars that lift inside it. The only additive thing the ability owns,
    // and deliberately tiny: they are the same read as the volume's own specks,
    // carried out past the medium so the dome does not look like a shell with
    // a painting inside it.
    this.stars = particles.get('nightfall.stars', {
      capacity: 500,
      shape: ParticleShape.SOFT,
      additive: true,
      softFade: 0.5
    });
    this.stars.uniforms.uDrag.value = 1.1;
    this.stars.uniforms.uEndSize.value = 0.45;
    this.stars.uniforms.uSizeIn.value = 0.16;
    this.stars.uniforms.uFadeIn.value = 0.2;
    this.stars.uniforms.uFadeOut.value = 0.5;

    this.veilEmitter = new RateEmitter();
    this.starEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return (this.dome.mesh.visible ? 1 : 0) + (this.floor.object3D.visible ? 1 : 0);
  }

  /** The lid closes, then it stands sealed. */
  get impactDuration() {
    const c = settings.nightfall;
    return Math.max(0.2, (c.closeTime + c.holdTime) * settings.global.lifetime);
  }

  /** The lid opens, then the last of the medium thins out. */
  get fadeDuration() {
    const c = settings.nightfall;
    return Math.max(0.2, c.openTime + c.settleTime);
  }

  /** The live footprint, metres. What the indicator measured out. */
  get radius() {
    return Math.max(0.1, settings.nightfall.zoneRadius);
  }

  /* ------------------------------------------------------------------ */
  /* The beats — all unitless, all resolved against live times            */
  /* ------------------------------------------------------------------ */

  /** Centre of the footprint: the far end of the aimed line. */
  _hubPoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /**
   * 0 while the sky is open, 1 when the lid has met at the apex.
   *
   * A pure function of the phase clocks against the *live* `closeTime` and
   * `openTime`, so dragging either re-times a dome that is already moving.
   */
  _seal() {
    const c = settings.nightfall;
    if (this.phase === AbilityPhase.TRAVEL) return 0;
    if (this.phase === AbilityPhase.FADE) {
      return 1 - Easing.inOutCubic(saturate(this.fadeTime / Math.max(0.05, c.openTime)));
    }
    return Easing.inOutCubic(saturate(this.impactTime / Math.max(0.05, c.closeTime)));
  }

  /** 0..1 through the tail of the fade, where the medium thins out entirely. */
  _settle() {
    const c = settings.nightfall;
    if (this.phase !== AbilityPhase.FADE) return 0;
    return saturate((this.fadeTime - c.openTime) / Math.max(0.05, c.settleTime));
  }

  /**
   * The lid, expressed as a `heightBias` — see the class doc for why that
   * uniform is an aperture at all.
   *
   * The beat is authored as the **rim of the hole**, `rho`, a fraction of the
   * dome's radius, and the uniform is *inverted out of it*:
   * `rho = sqrt(1 - 1/bias²)`, so `bias = 1/sqrt(1 - rho²)`. That inversion is
   * not decoration. The relation is violently non-linear near `bias = 1` — bias
   * 5.4 puts the rim at 0.98 R and bias 1.15 puts it at 0.49 R — so sweeping
   * the *uniform* linearly leaves the closing circle loitering near the
   * boundary for two thirds of the close and then snapping shut in the last
   * few frames. It reads as a dropped frame, not as a lid. Sweeping `rho`
   * linearly and solving for the uniform makes the circle travel evenly.
   *
   * Two stages. `lidRimShare` of the close walks the rim from `lidOpenRim` to
   * the apex; the rest takes the bias on down to `lidSeal`, which stops the
   * density falling with height at all and settles the sealed dome into solid
   * black. Splitting them matters: blending toward `lidSeal` while the rim is
   * still travelling collapses the aperture early, because `lidSeal` is a much
   * smaller number than any bias the aperture is passing through.
   */
  _lidBias(seal) {
    const c = settings.nightfall;
    const share = Math.min(0.99, Math.max(0.01, c.lidRimShare));
    const rimPhase = saturate(seal / share);
    const fillPhase = saturate((seal - share) / (1 - share));

    const rho = saturate(c.lidOpenRim) * (1 - Math.pow(rimPhase, Math.max(0.05, c.lidCurve)));
    // Clamped away from 1: rho = 1 is a hole the size of the dome, which is no
    // dome at all, and the reciprocal goes to infinity on the way there.
    const aperture = 1 / Math.sqrt(Math.max(0.004, 1 - rho * rho));
    return lerp(aperture, c.lidSeal, Easing.inOutCubic(fillPhase));
  }

  /** Master density envelope. 0 hides the hull outright — a real cost control. */
  _domeFade() {
    const c = settings.nightfall;
    if (this.phase === AbilityPhase.TRAVEL) return 0;
    if (this.phase === AbilityPhase.FADE) return 1 - Easing.inQuad(this._settle());
    return Easing.outQuad(saturate(this.impactTime / Math.max(0.02, c.formTime)));
  }

  /**
   * The caster's light, losing.
   *
   * Two terms: a flutter it fights with, and a straight scaling by the seal.
   * The second one is the read — a light that merely flickers inside a black
   * dome looks like a light in fog, and a light that visibly gives ground looks
   * like a light being *taken*.
   */
  lightShimmer() {
    const c = settings.nightfall;
    const w = c.lightStruggle * this.age;
    const flutter = 0.84 + 0.16 * Math.sin(w) * Math.sin(w * 0.41);
    return flutter * (1 - saturate(c.lightSmother) * this._seal());
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /** Push live settings and the current beat into both draw calls. */
  _syncNight() {
    const c = settings.nightfall;
    const g = settings.global;

    const R = this.radius;
    const seal = this._seal();
    const fade = this._domeFade();

    /* ---------------- the dome ---------------- */
    this._hubPoint(_hub);
    this.dome
      .place(_hub, this.direction)
      .setSize(R * c.domeSpread, R * c.domeHeight, R * c.domeSpread)
      .setFade(fade)
      .sync(c, g);

    this.dome.material.uniforms.uHeightBias.value = c.nightHeightBias + this._lidBias(seal);

    /* ---------------- the floor ---------------- */
    const opening =
      this.phase === AbilityPhase.FADE
        ? Easing.inQuad(saturate(this.fadeTime / Math.max(0.05, c.openTime)))
        : 0;

    _floor.centre = _hub;
    _floor.yaw = Math.atan2(this.direction.x, this.direction.z);
    _floor.height = c.floorHeight;
    _floor.radius = R * c.floorSpread;
    // The footprint snaps out with the cast and then *deepens in place*. The
    // first build grew it outward from the centre while the lid closed inward,
    // and two fronts running opposite ways read as two effects rather than one.
    _floor.grow =
      this.phase === AbilityPhase.IMPACT
        ? Easing.outCubic(saturate(this.impactTime / Math.max(0.02, c.floorGrow)))
        : 1;
    // Dries back from the edges as the lid reopens — which is the one direction
    // `recede` runs, and happily the one the reopening wants.
    _floor.recede = opening;
    _floor.fade = fade;
    _floor.seed = this._seed;
    _floor.edge = c.floorEdge;
    _floor.ragged = c.floorRagged;
    _floor.raggedScale = c.floorRaggedScale;
    _floor.warp = c.floorWarp;
    _floor.relief = c.floorRelief;
    _floor.normalStep = c.floorNormalStep;
    _floor.ambient = c.floorAmbient;
    _floor.wrap = c.floorWrap;
    _floor.specular = c.floorSpecular;
    _floor.gloss = c.floorGloss;
    _floor.parallax = c.floorParallax;
    _floor.cell = c.floorCell;
    _floor.depth = c.floorDepth;
    _floor.lift = c.floorLift;
    _floor.detail = c.floorDetail;
    _floor.speed = c.floorSpeed;
    _floor.flow = c.floorFlow;
    _floor.windAngle = c.floorWind;
    _floor.additive = false;
    _floor.emissive = c.floorEmissive * g.glow;
    _floor.opacity = c.floorOpacity * lerp(saturate(c.floorShallow), 1, seal);
    _floor.opacityScale = g.opacity;
    _floor.depthFade = c.floorDepthFade;
    _floor.colorBase = c.colorFloor;
    _floor.colorEdge = c.colorFloorEdge;
    _floor.colorGlow = c.colorFloorGlow;
    _floor.colorDeep = c.colorFloorDeep;
    _floor.noiseStrength = g.noiseStrength;
    _floor.noiseFrequency = g.noiseFrequency;
    _floor.noiseSpeed = g.noiseSpeed;
    this.floor.update(_floor);

    /* ---------------- the two particle systems ---------------- */
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
    this.veil.uniforms.uTurbulence.value = c.veilTurbulence * g.turbulence;

    this.stars.setGradient(
      getColor(c.colorStarA),
      getColor(c.colorStarB),
      getColor(c.colorStarC),
      getColor(c.colorStarD)
    );
    this.stars.uniforms.uGravity.value.set(0, c.starRise, 0);
    this.stars.uniforms.uSizeScale.value = c.starSize * g.particleSize * 7;
    this.stars.uniforms.uLifeScale.value = c.starLifetime * 0.5 * g.particleLifetime;
    this.stars.uniforms.uSpeedScale.value = c.starSpeed * g.particleSpeed;
    this.stars.uniforms.uOpacity.value = g.opacity;
    this.stars.uniforms.uGlow.value = 1.6 * g.glow;
    this.stars.uniforms.uTurbulence.value = c.starTurbulence * g.turbulence;
  }

  /**
   * The veil boiling off the dome's skin, and the stars lifting inside it.
   *
   * @param {number} scale 0..1 — thinned as the medium forms and again as it goes
   */
  _nightFx(dt, scale) {
    const c = settings.nightfall;
    const g = settings.global;
    const time = frame.uTime.value;
    const R = this.radius;

    this._hubPoint(_hub);

    const veilCount = Math.round(this.veilEmitter.tick(dt, c.veilRate * scale) * g.particleCount);
    if (veilCount > 0) {
      // Seated on a ring, not scattered through the disc: the veil is the
      // dome's *skin* coming off, and a disc of it fills the interior with grey
      // — which is the one colour the interior may not be.
      const a = Math.random() * TAU;
      const seat = R * c.veilSeat;
      _pos.set(_hub.x + Math.cos(a) * seat, 0.1, _hub.z + Math.sin(a) * seat);
      _emit.position = _pos;
      _emit.radius = R * 0.16;
      _emit.direction = _dir.set(Math.cos(a) * 0.25, 1, Math.sin(a) * 0.25).normalize();
      _emit.speed = c.veilSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.75;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 1.0;
      _emit.sizeVariance = 0.5;
      _emit.life = c.veilLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.25;
      _emit.tint = null;
      _emit.time = time;
      this.veil.emit(veilCount, _emit);
    }

    const starCount = Math.round(this.starEmitter.tick(dt, c.starRate * scale) * g.particleCount);
    if (starCount > 0) {
      const a = Math.random() * TAU;
      const seat = R * c.starSeat * Math.sqrt(Math.random());
      _pos.set(_hub.x + Math.cos(a) * seat, randRange(0.1, R * c.domeHeight * 0.7), _hub.z + Math.sin(a) * seat);
      _emit.position = _pos;
      _emit.radius = R * 0.1;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.starSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.9;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.09;
      _emit.sizeVariance = 0.75;
      _emit.life = c.starLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.stars.emit(starCount, _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.veilEmitter.reset();
    this.starEmitter.reset();
    // The one thing this cast captures, besides its own timestamps.
    this._seed = Math.random() * 100;

    this.floor.setVisible(true);
    this._syncNight();
  }

  onTravel(dt) {
    // Nothing has formed yet — `_domeFade()` is 0 through TRAVEL, so the hull
    // is hidden and the floor mark has not grown. Syncing anyway is not waste:
    // it keeps every uniform resolved from live settings on every frame,
    // including the paused ones, which is the whole of I1.
    this._syncNight();
    this.pointAt(this.u, this.position);
    this.position.y = settings.nightfall.lightHeight * 0.5;
  }

  onImpact() {
    const c = settings.nightfall;
    const g = settings.global;

    // The negative flash. `GradeShader` mixes the frame toward this colour, so
    // a near-black one dims the whole screen rather than blowing it out. It is
    // the only place in the project where `ScreenFlash` subtracts, and it is
    // why the dome does not need to fight the tone curve on its own.
    this.ctx.flash.trigger(getColor(c.colorFall), c.castDim * g.explosionIntensity);

    this.ctx.shake.add(
      c.sealShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      9
    );
  }

  /**
   * Both the sealed hold and the reopening run through here — the base class
   * calls it for `IMPACT` (`t` 0..1) and `FADE` (`t` 1..2). Nothing here reads
   * `t`: every beat is a pure function of `impactTime` / `fadeTime` against the
   * live durations, which is what lets all four of them be dragged mid-cast.
   */
  onFade(dt, _t) {
    const c = settings.nightfall;
    this._syncNight();

    // The light climbs to its working height and sits in the middle of the
    // dome, where it can be seen to lose.
    this._hubPoint(this.position);
    this.position.y = c.lightHeight;

    const seal = this._seal();
    this._nightFx(dt, this._domeFade() * (0.4 + 0.6 * seal));
    // The rumble belongs to the lid *moving*, not to the phase: it is loud
    // while the aperture is travelling in either direction and drops to almost
    // nothing while the dome stands. Keying it off `t` instead put the loud
    // rumble across the whole hold, which read as an engine rather than a seal.
    this.ctx.shake.rumble(
      (seal > 0.995 ? c.holdRumble : c.rumble) * settings.global.cameraShake,
      dt
    );
  }

  onDestroy() {
    // `setFade(0)` hides the hull outright. `frustumCulled` is off on a volume,
    // so an invisible-but-drawn dome would keep paying full fill rate.
    this.dome.setFade(0);
    this.floor.setVisible(false);
  }

  dispose() {
    this.dome.dispose();
    this.floor.dispose();
    super.dispose();
  }
}
