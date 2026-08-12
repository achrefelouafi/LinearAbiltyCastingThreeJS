import { Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { Shell, ShellMode } from '../../vfx/Shell.js';
import { Caustics, CausticSource, CausticShape, causticsParams } from '../../vfx/Caustics.js';
import { LensFlare, lensFlareParams } from '../../vfx/LensFlare.js';
import { GroundField, GroundMode, groundFieldParams } from '../../vfx/GroundField.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, clamp, lerp, Easing, randRange } from '../../utils/math.js';

const TAU = Math.PI * 2;

/**
 * Pits the char field carries at once. The oldest is recycled, so this is how
 * far back the burn trail is legible rather than how many are ever laid: at 34
 * pits a turn and a walk of a turn and a half, sixty-four covers the whole
 * figure with a little history behind it.
 */
const CHAR_MARKS = 64;
/**
 * Ghost instances built into the flare. `flareGhosts` clamps into this; eight
 * is `MAX_FLARE_GHOSTS` and more than any real lens shows.
 */
const FLARE_GHOSTS = 8;
/**
 * Pits laid in one frame, ceiling. Only ever reached when somebody drags
 * `walkSpeed` or `charMarksPerTurn` a long way with the clock stopped — the
 * walk's phase jumps, and without this the ring buffer would be rewritten
 * several times over inside one paused frame for no visible gain.
 */
const MAX_MARKS_PER_FRAME = 6;

/* Module-scope scratch. Nothing in the frame path allocates — invariant I3. */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _lens = new Vector3();
const _focus = new Vector3();
const _walk = new Vector3();
const _axis = new Vector3();
const _centre = new Vector3();
const _disc = {
  origin: new Vector3(),
  axis: new Vector3(0, -1, 0),
  side: new Vector3(1, 0, 0),
  span: 1,
  t: 0,
  fade: 1,
  seed: 0
};
const _net = causticsParams();
const _flare = lensFlareParams();
const _char = groundFieldParams();

/**
 * SOLAR LENS — a burning glass hung over the aimed circle.
 *
 * Three beats. An element **climbs** out to the zone as the front runs down the
 * line; on arrival it **pulls focus**, the cone under it collapsing from a soft
 * wash into a spot the size of a coin; and then the spot **walks** a rosette
 * across the floor for `lifetime` seconds, charring a trail of pits behind it.
 *
 * ## THE TRICK — the flare is occlusion-tested, and that is the whole point
 *
 * The bright thing here is not the element in the air, it is the *burn on the
 * floor*, and a burn on the floor is something the character can stand in front
 * of. `vfx/LensFlare.js` is anchored to it, drawn after the scene with the
 * depth test off — a ghost that vanishes behind a pillar is a decal, not a lens
 * artefact — and buys the occlusion back by hand: the source's own screen
 * position is sampled against `frame.uSceneDepth` with an area-uniform disc
 * kernel, in the vertex shader, and every one of the eleven elements is scaled
 * by the fraction of the source's disc that is showing. Walk the character
 * across the burn and the streak, the ghosts and the iris ring all fall
 * together and come back. Set `flareOcclusion` to 0 once to see what it is
 * worth: the flare stops being a thing in the room and becomes a sticker on the
 * monitor, which is exactly the twenty-year-old tell the roster line names.
 *
 * One thing to know before anybody "fixes" it: `npm run check` reports
 * `flareOcclusion` as a **dead slider**, in both samples, and it is not. The
 * module degrades by data rather than by branch — with nothing bound to
 * `frame.uSceneDepth` it forces the occlusion term to 0 rather than sampling a
 * buffer of zeroes and concluding the flare is buried in a wall — and the
 * headless harness has no depth prepass. In the app the slider is the loudest
 * control on this ability.
 *
 * `flareOccRadius` is the second half of the same trick and is easy to
 * under-set. With a one-tap test the flare does not dim as a silhouette crosses
 * it, it *switches*, on the frame the edge crosses one pixel, and eleven
 * elements covering a third of the screen popping on and off is worse than no
 * occlusion at all. The kernel spreads over the source's apparent size, and
 * that size is this slider.
 *
 * ## What the light does on the way down
 *
 * `vfx/Caustics.js` in `CONE` mode is the light *arriving*. The apex is the
 * element itself and the axis is the element→spot vector, so a spot out at the
 * rim of the zone gives a correctly slanted ellipse on the floor for free — the
 * cosine test against the axis does that, which is the reason the axis is a
 * parameter at all. The pattern is a genuine fold: brightness is `1/|det J|` of
 * the refraction map, so the filaments come out hairline without being told to,
 * and the three channels fold in three slightly different places because they
 * refract at three indices. The medium is glass rather than water — `netIor`
 * 1.62, `netDispersion` 0.22 — which is why the fringes are as wide as they
 * are.
 *
 * Pulling focus is one number, `coneAngle`, ramped from `focusWide` to
 * `focusTight`. Nothing else about the ability is scheduled: the flare's
 * intensity, the light's radius, the ember rate and the pit strength all read
 * that same 0..1.
 *
 * ## The walk, and why the char trail survives a slider
 *
 * The spot's position is a rosette — carrier angle `walkSpeed × age`, radius
 * `walkInner..walkOuter` on `sin²(petals·θ/2)` — evaluated **fresh every
 * frame** from the settings and the cast's own clock. There is no integrator
 * and no captured path. Pause mid-burn and drag `walkPetals` and the burning
 * point *moves*, because where it is is a function of the slider.
 *
 * The pits it leaves are recorded in `vfx/GroundField.js` (`POCK`) as what the
 * module asks for and nothing more: an `x`/`z` pair that are **fractions of the
 * radius**, a timestamp, and a strength. Not one metre is stored, so dragging
 * `zoneRadius` afterwards re-places *and* re-scales a burn that is already on
 * the floor. A `DecalType.SCORCH` per pit would have been three lines shorter
 * and would have captured its radius the moment it landed, which is the exact
 * thing invariant I1 exists to forbid; the first version did that and the trail
 * simply stopped listening the moment it was drawn.
 *
 * Laying them is unitless too. The frame asks "how many pits *should* exist by
 * this phase" — `floor(phase × charMarksPerTurn)` — and lays the difference,
 * so the count is derived rather than accumulated and dragging the walk
 * backwards rewinds it instead of double-burning.
 *
 * ## Cost
 *
 * Four draw calls: the element (`Shell` `SUNDISC`), the net (`Caustics`), the
 * flare (`LensFlare`) and the char field (`GroundField`). Three shared particle
 * systems and one dynamic light. The expensive one is the caustic net, which is
 * fill-bound rather than draw-bound — hence `netRadius`, which sizes the quad
 * every frame and should stay honest.
 *
 * **What a cast captures:** a seed, one timestamp (`_igniteAt`, the moment
 * focus was pulled) and an integer count of pits laid. Three unitless things.
 */
export class SolarLensAbility extends Ability {
  constructor(context) {
    super('solarlens', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /* --- the element: one instanced annulus with an inner radius of zero --- */
    this.disc = new Shell({
      mode: ShellMode.SUNDISC,
      prefix: 'disc',
      segments: 96,
      renderOrder: 12
    });
    this.group.add(this.disc.group);

    /* --- the light arriving on the floor --- */
    this.net = new Caustics(this.group, {
      source: CausticSource.SCROLL,
      shape: CausticShape.CONE,
      additive: true,
      renderOrder: 7,
      name: 'SolarLens:net'
    });

    /* --- the char, under everything --- */
    this.char = new GroundField(this.group, {
      mode: GroundMode.POCK,
      marks: CHAR_MARKS,
      additive: false,
      renderOrder: 3,
      name: 'SolarLens:char'
    });

    /* --- the artefact on the glass. Added last: it draws at 3000. --- */
    this.flare = new LensFlare({ ghosts: FLARE_GHOSTS, name: 'SolarLens:flare' });
    this.group.add(this.flare.object3D);

    /** The one dice roll a cast makes. */
    this._seed = 0;
    /** When focus was pulled, in the cast's own clock. `-1` = has not happened. */
    this._igniteAt = -1;
    /** Pits laid so far. An integer, not a distance. */
    this._marksLaid = 0;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Embers off the burning point: velocity-stretched streaks that *rise*,
    // because a burn throws them up a thermal rather than out of an explosion.
    this.embers = particles.get('solarlens.embers', {
      capacity: 1600,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.25
    });
    this.embers.uniforms.uDrag.value = 1.9;
    this.embers.uniforms.uEndSize.value = 0.2;
    this.embers.uniforms.uSizeIn.value = 0.03;
    this.embers.uniforms.uFadeIn.value = 0.05;
    this.embers.uniforms.uFadeOut.value = 0.5;

    // The thread of smoke off the char. Non-additive so it genuinely occludes
    // the net underneath it — smoke over a caustic is the whole reason to have
    // both.
    this.smoke = particles.get('solarlens.smoke', {
      capacity: 1400,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.1
    });
    this.smoke.uniforms.uDrag.value = 1.7;
    this.smoke.uniforms.uEndSize.value = 3.2;
    this.smoke.uniforms.uSizeIn.value = 0.14;
    this.smoke.uniforms.uFadeIn.value = 0.2;
    this.smoke.uniforms.uFadeOut.value = 0.32;

    // Dust turning over inside the cone. This is what makes the cone read as
    // volume rather than as a decal on the floor.
    this.motes = particles.get('solarlens.motes', {
      capacity: 1200,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.motes.uniforms.uDrag.value = 1.5;
    this.motes.uniforms.uEndSize.value = 0.3;
    this.motes.uniforms.uSizeIn.value = 0.08;
    this.motes.uniforms.uFadeIn.value = 0.12;
    this.motes.uniforms.uFadeOut.value = 0.42;

    this.emberEmitter = new RateEmitter();
    this.smokeEmitter = new RateEmitter();
    this.moteEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this.char.markCount + this.disc.instanceCount;
  }

  /** The burn is the long phase; the element only travels for a moment. */
  get impactDuration() {
    return Math.max(0.05, settings.solarlens.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.solarlens.fadeTime);
  }

  /**
   * A lens breathes; it does not gutter. Anything quantised here would read as
   * an arc lamp, and the whole school is about light behaving like light.
   */
  lightShimmer() {
    const c = settings.solarlens;
    return 1 - c.lightPulse * (0.5 - 0.5 * Math.cos(this.age * c.lightPulseSpeed * TAU));
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                  */
  /* ------------------------------------------------------------------ */

  /** How far focus has been pulled, 0..1. Everything else reads this. */
  get focus() {
    const c = settings.solarlens;
    if (this._igniteAt < 0) return 0;
    const t = saturate((this.age - this._igniteAt) / Math.max(0.01, c.focusTime));
    return Math.pow(t, Math.max(0.05, c.focusCurve));
  }

  /** Turns of the carrier angle the walk has made. Unitless. */
  get walkPhase() {
    const c = settings.solarlens;
    if (this._igniteAt < 0) return 0;
    return Math.max(0, this.age - this._igniteAt) * c.walkSpeed;
  }

  /**
   * The rosette, in **fractions of `zoneRadius`**, in the cast's own frame:
   * `out.x` runs along `side`, `out.y` along `direction`.
   *
   * A rose rather than a circle because a circle is a brand and this is
   * supposed to be somebody sweeping a burning glass about. `sin²(petals·θ/2)`
   * rather than `|sin|` because the squared form has zero slope at both ends,
   * so the spot decelerates into the tightest radius instead of pinging off it.
   *
   * Non-integer `walkPetals` never closes the figure, which is the default: two
   * and a half lobes means the second pass over the floor misses the first.
   */
  _walkOffset(phase, out) {
    const c = settings.solarlens;
    const theta = phase * TAU + c.walkPhase;
    const lobe = 0.5 - 0.5 * Math.cos(c.walkPetals * theta);
    let r = lerp(c.walkInner, c.walkOuter, lobe);
    // A little secondary jitter so the trail is not a machined curve. On the
    // *radius* rather than on the position, or the spot judders sideways and
    // reads as frame drops.
    r += c.walkWobble * Math.sin(theta * c.walkWobbleRate + this._seed);
    out.x = Math.cos(theta) * r;
    out.y = Math.sin(theta) * r;
    return out;
  }

  /** Centre of the aimed circle, on the floor. */
  _zoneCentre(out) {
    return this.pointAt(1, out);
  }

  /**
   * Where the burning point is, world space.
   *
   * Before ignition it sits directly under the element, because an unfocused
   * lens throws its wash straight down; the walk only exists once there is
   * something worth walking.
   */
  _focusPoint(out) {
    const c = settings.solarlens;
    this._zoneCentre(out);
    if (this._igniteAt < 0) {
      out.addScaledVector(this.direction, c.lensLead);
      out.y = 0;
      return out;
    }
    // `_walk` and not `_pos`: a caller is entitled to pass `_pos` itself as the
    // output, and the first version used one scratch for both — which quietly
    // overwrote the zone centre with the offset and threw the burn a zone's
    // width away from where the flare was hanging, but only on the two frames
    // that happened to call it that way.
    this._walkOffset(this.walkPhase, _walk);
    const radius = c.zoneRadius;
    out.addScaledVector(this.side, _walk.x * radius).addScaledVector(this.direction, _walk.y * radius);
    out.y = 0;
    return out;
  }

  /**
   * Where the element is hanging, world space.
   *
   * It rides the front on the way out and climbs as it goes, so it is already
   * overhead by the time the circle is reached rather than arriving and *then*
   * getting up there. The bob is a live sine on the cast's clock rather than an
   * integrated drift, so dragging `lensBob` with the sandbox paused moves the
   * element instead of changing where it will drift to next.
   */
  _lensPoint(out) {
    const c = settings.solarlens;
    const u = this.phase === AbilityPhase.TRAVEL ? this.u : 1;
    const climb = Math.pow(u, Math.max(0.05, c.lensClimb));

    this.pointAt(u, out);
    out.addScaledVector(this.direction, c.lensLead * u);
    out.addScaledVector(this.side, c.lensSway * Math.sin(this.age * c.lensSwaySpeed * TAU + this._seed) * u);
    out.y = c.lensAltitude * climb + c.lensBob * Math.sin(this.age * c.lensBobSpeed * TAU + this._seed * 0.7) * u;
    return out;
  }

  /** Radius of the lit patch on the floor, metres. The spot. */
  _spotRadius() {
    const c = settings.solarlens;
    this._lensPoint(_lens);
    this._focusPoint(_focus);
    const drop = Math.max(0.2, _lens.distanceTo(_focus));
    return drop * Math.tan(lerp(c.focusWide, c.focusTight, this.focus));
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.emberEmitter.reset();
    this.smokeEmitter.reset();
    this.moteEmitter.reset();
    this.char.clearMarks();
    this.net.reset();

    this._igniteAt = -1;
    this._marksLaid = 0;
    // The one thing a cast captures. Everything else is resolved per frame.
    this._seed = Math.random() * 100;

    this.disc.visible = true;
    this.net.setVisible(true);
    this.char.setVisible(true);
    this.flare.visible = false; // nothing is burning yet

    this._syncUniforms(1);

    const c = settings.solarlens;
    const g = settings.global;
    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.3 * g.explosionIntensity;
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the current cast state into all four systems.
   * @param {number} fade 1 while the lens burns, ramping to 0 as it lets go
   */
  _syncUniforms(fade) {
    const c = settings.solarlens;
    const g = settings.global;
    const focus = this.focus;

    this._lensPoint(_lens);
    this._focusPoint(_focus);
    this._zoneCentre(_centre);
    _axis.subVectors(_focus, _lens);
    const drop = Math.max(0.2, _axis.length());
    _axis.multiplyScalar(1 / drop);

    /* --- the element ---------------------------------------------------- */
    // `t` is the ability's own normalised life, which is what `Shell` wants:
    // it interpolates `discRadius → discRadiusEnd` on a live easing exponent
    // itself, so the bloom reshapes under the sliders while it is standing.
    const disc = _disc;
    disc.origin.copy(_lens);
    disc.axis.copy(_axis);
    disc.side.copy(this.side);
    disc.span = Math.max(0.05, drop);
    disc.t = focus;
    disc.fade = fade;
    disc.seed = this._seed;
    this.disc.sync(c, disc, g);

    /* --- the light on the floor ----------------------------------------- */
    const net = _net;
    net.centre = _focus;
    net.lightAxis = _axis;
    net.yaw = 0;
    net.height = 0.016;
    net.radius = Math.max(0.1, c.netRadius);
    net.length = Math.max(0.2, c.netRadius * 2);
    net.fade = fade * lerp(0.35, 1, focus);
    net.front = 0.5;
    net.now = this._igniteAt < 0 ? 0 : this._igniteAt;
    net.seed = this._seed;

    net.depth = c.netDepth;
    net.ior = c.netIor;
    net.dispersion = c.netDispersion;
    net.sampleStep = c.netSampleStep;
    net.absorb = c.netAbsorb;

    net.foldFloor = c.netFoldFloor;
    net.threshold = c.netThreshold;
    net.gain = c.netGain;
    net.sharpness = c.netSharpness;
    net.rolloff = c.netRolloff;

    net.sourceAmp = c.netAmp;
    net.cellScale = c.netCellScale;
    net.cellRatio = c.netCellRatio;
    net.cellJitter = c.netCellJitter;
    net.driftAngle = c.netDriftAngle;
    net.driftSpeed = c.netDriftSpeed;
    net.boil = c.netBoil;
    net.ridgeMix = c.netRidgeMix;
    net.ridgeScale = c.netRidgeScale;
    net.ridgePower = c.netRidgePower;

    // The projector. `coneAngle` is the ability: everything visible about
    // pulling focus is this one number moving.
    net.penumbra = c.netPenumbra;
    net.coneAngle = clamp(lerp(c.focusWide, c.focusTight, focus), 0.01, 1.5);
    net.projectorHeight = drop;

    net.additive = true;
    net.emissive = c.netEmissive * g.glow;
    net.opacity = c.netOpacity * g.opacity;
    net.wash = c.netWash;
    net.fringeAt = c.netFringeAt;
    net.depthFade = c.netDepthFade;
    net.colorNet = c.colorNet;
    net.colorFringe = c.colorFringe;
    net.colorWash = c.colorWash;
    net.noiseStrength = g.noiseStrength;
    net.noiseFrequency = g.noiseFrequency;
    net.noiseSpeed = g.noiseSpeed;
    net.opacityScale = 1;
    this.net.update(net);

    /* --- the char ------------------------------------------------------- */
    const char = _char;
    char.centre = _centre;
    char.yaw = 0;
    char.height = 0.012;
    char.radius = Math.max(0.2, c.zoneRadius);
    char.length = Math.max(0.2, c.zoneRadius * 2);
    char.grow = 1;
    char.recede = 0;
    char.fade = fade;
    char.seed = this._seed;

    char.edge = c.charEdge;
    char.ragged = c.charRagged;
    char.raggedScale = c.charRaggedScale;
    char.warp = c.charWarp;

    char.relief = c.charRelief;
    char.normalStep = c.charNormalStep;
    char.ambient = c.charAmbient;
    char.wrap = c.charWrap;
    char.specular = c.charSpecular;
    char.gloss = c.charGloss;
    char.parallax = c.charParallax;

    char.depth = c.charDepth;
    char.lift = c.charLift;
    char.sharp = c.charSharp;
    char.detail = c.charDetail;

    char.markLife = c.charMarkLife;
    char.markRadius = c.charMarkRadius;

    char.additive = false;
    char.emissive = c.charEmissive * g.glow;
    char.opacity = c.charOpacity * g.opacity;
    char.depthFade = c.charDepthFade;
    char.colorBase = c.colorCharBase;
    char.colorEdge = c.colorCharEdge;
    char.colorGlow = c.colorCharGlow;
    char.colorDeep = c.colorCharDeep;
    char.noiseStrength = g.noiseStrength;
    char.noiseFrequency = g.noiseFrequency;
    char.noiseSpeed = g.noiseSpeed;
    char.opacityScale = 1;
    this.char.update(char);

    /* --- the flare ------------------------------------------------------ */
    // Anchored a few centimetres above the floor so the character's *body*
    // crosses it rather than only their feet. That lift is a slider because it
    // is the difference between an occlusion test that fires and one that never
    // quite does.
    this.flare.setAnchorXYZ(_focus.x, _focus.y + c.focusLift, _focus.z);

    const f = _flare;
    f.intensity = c.flareIntensity * focus * fade * g.glow;
    f.opacity = c.flareOpacity * g.opacity;
    f.seed = this._seed;
    f.headroom = c.flareHeadroom;
    f.occlusion = c.flareOcclusion;
    f.occRadius = c.flareOccRadius;
    f.occTaps = c.flareOccTaps;
    f.occFade = c.flareOccFade;
    f.occSpin = c.flareOccSpin;
    f.edgeStart = c.flareEdgeStart;
    f.edgeEnd = c.flareEdgeEnd;
    f.coreSize = c.flareCoreSize;
    f.coreGlow = c.flareCoreGlow;
    f.burstBlades = c.flareBurstBlades;
    f.burstLength = c.flareBurstLength;
    f.burstSharp = c.flareBurstSharp;
    f.burstJitter = c.flareBurstJitter;
    f.burstSpin = c.flareBurstSpin;
    f.haloSize = c.flareHaloSize;
    f.haloWidth = c.flareHaloWidth;
    f.haloGlow = c.flareHaloGlow;
    f.streakLength = c.flareStreakLength;
    f.streakThickness = c.flareStreakThickness;
    f.streakFalloff = c.flareStreakFalloff;
    f.streakTight = c.flareStreakTight;
    f.streakGlow = c.flareStreakGlow;
    f.streakTilt = c.flareStreakTilt;
    f.streakGrain = c.flareStreakGrain;
    f.streakChroma = c.flareStreakChroma;
    f.ghosts = c.flareGhosts;
    f.ghostSpacing = c.flareGhostSpacing;
    f.ghostStride = c.flareGhostStride;
    f.ghostScatter = c.flareGhostScatter;
    f.ghostSize = c.flareGhostSize;
    f.ghostSizeStep = c.flareGhostSizeStep;
    f.ghostSizeScatter = c.flareGhostSizeScatter;
    f.ghostBlades = c.flareGhostBlades;
    f.ghostRound = c.flareGhostRound;
    f.ghostRoundStep = c.flareGhostRoundStep;
    f.ghostSpin = c.flareGhostSpin;
    f.ghostFill = c.flareGhostFill;
    f.ghostRim = c.flareGhostRim;
    f.ghostRimWidth = c.flareGhostRimWidth;
    f.ghostSoft = c.flareGhostSoft;
    f.ghostChroma = c.flareGhostChroma;
    f.ghostGlow = c.flareGhostGlow;
    f.ring = c.flareRing;
    f.ringSpacing = c.flareRingSpacing;
    f.ringSize = c.flareRingSize;
    f.ringWidth = c.flareRingWidth;
    f.ringBlades = c.flareRingBlades;
    f.ringChroma = c.flareRingChroma;
    f.ringGlow = c.flareRingGlow;
    f.colorCore = c.colorFlareCore;
    f.colorHalo = c.colorFlareHalo;
    f.colorStreak = c.colorFlareStreak;
    f.colorStreakEdge = c.colorFlareStreakEdge;
    f.colorGhostA = c.colorFlareGhostA;
    f.colorGhostB = c.colorFlareGhostB;
    f.colorGhostC = c.colorFlareGhostC;
    f.colorGhostD = c.colorFlareGhostD;
    f.colorRing = c.colorFlareRing;
    this.flare.update(f);
    this.flare.visible = f.intensity > 0.005;

    /* --- the three particle systems ------------------------------------- */
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
    this.embers.uniforms.uGlow.value = 1.2 * g.glow;
    this.embers.uniforms.uStretch.value = c.emberStretch;
    this.embers.uniforms.uTurbulence.value = 0.3 * g.turbulence;

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
    this.smoke.uniforms.uTurbulence.value = 0.4 * g.turbulence;

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
    this.motes.uniforms.uOpacity.value = g.opacity;
    this.motes.uniforms.uGlow.value = 0.9 * g.glow;
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;

    // The dynamic light lives on the burn, not on the element: the floor is
    // where the energy ends up, and a light in the air over the circle lights
    // the character's hair instead of their feet.
    this.position.copy(_focus).setY(0.25);
  }

  /**
   * Lay whatever pits the walk's phase says should exist by now.
   *
   * Derived, not accumulated: `_marksLaid` is a count and the *want* is
   * recomputed from the live phase, so dragging `walkSpeed` negative rewinds
   * the trail instead of burning a second one on top of it.
   */
  _burnFloor() {
    const c = settings.solarlens;
    if (this._igniteAt < 0) return;

    const perTurn = Math.max(0.1, c.charMarksPerTurn);
    const want = Math.floor(Math.max(0, this.walkPhase) * perTurn);
    if (want < this._marksLaid) {
      this._marksLaid = want;
      return;
    }

    const now = frame.uTime.value;
    let laid = 0;
    while (this._marksLaid < want && laid < MAX_MARKS_PER_FRAME) {
      this._marksLaid++;
      laid++;
      // Placed at the phase the pit *belongs* to rather than at the current
      // one, so a long frame lays a line of pits along the path instead of a
      // cluster at its end.
      this._walkOffset(this._marksLaid / perTurn, _pos);
      this.char.mark(_pos.x, _pos.y, now, saturate(this.focus));
    }
  }

  /**
   * Embers, smoke and motes.
   * @param {number} scale 0..1 — thinned out as the lens lets go
   */
  _burnFx(dt, scale) {
    const c = settings.solarlens;
    const g = settings.global;
    const time = frame.uTime.value;
    const focus = this.focus;
    const spot = this._spotRadius();
    this._focusPoint(_focus);

    const emberCount = Math.round(this.emberEmitter.tick(dt, c.emberRate * focus * scale) * g.particleCount);
    if (emberCount > 0) {
      _emit.position = _focus;
      _emit.radius = Math.max(0.02, spot * 0.8 + c.emberScatter * c.zoneRadius);
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.emberSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.55;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.12;
      _emit.sizeVariance = 0.7;
      _emit.life = c.emberLifetime;
      _emit.lifeVariance = 0.55;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.embers.emit(emberCount, _emit);
    }

    const smokeCount = Math.round(this.smokeEmitter.tick(dt, c.smokeRate * focus * scale) * g.particleCount);
    if (smokeCount > 0) {
      _pos.copy(_focus).setY(0.1);
      _emit.position = _pos;
      _emit.radius = Math.max(0.05, spot * 1.2);
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.smokeSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.5;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.7;
      _emit.sizeVariance = 0.5;
      _emit.life = c.smokeLifetime;
      _emit.lifeVariance = 0.45;
      _emit.spin = 0.35;
      _emit.tint = null;
      _emit.time = time;
      this.smoke.emit(smokeCount, _emit);
    }

    const moteCount = Math.round(this.moteEmitter.tick(dt, c.moteRate * scale) * g.particleCount);
    if (moteCount > 0) {
      // Seeded inside the cone rather than on the floor: pick a height up the
      // axis and spread by the cone's own half-angle at that height, so the
      // motes fill the shape the caustics say the light is coming down.
      this._lensPoint(_lens);
      const up = Math.random();
      _pos.copy(_focus).lerp(_lens, up);
      _emit.position = _pos;
      _emit.radius = Math.max(0.05, lerp(spot, spot * 6, up) * c.moteSpread);
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.85;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.07;
      _emit.sizeVariance = 0.6;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.motes.emit(moteCount, _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = settings.solarlens;
    this._syncUniforms(1);
    // The light rides the element while it is still climbing — there is nothing
    // burning yet for it to sit on.
    this._lensPoint(this.position);
    this._burnFx(dt, 0.35);
    this.ctx.shake.rumble(c.rumble * 0.4 * settings.global.cameraShake, dt);
  }

  /** The element arrives and tips over: focus starts being pulled. */
  onImpact() {
    const c = settings.solarlens;
    const g = settings.global;

    this._igniteAt = this.age;
    this._marksLaid = 0;

    this._focusPoint(_pos);
    _pos.y = 0.2;

    this.ctx.bursts.spawn(BurstMode.FIRE, _pos, {
      radius: c.igniteSize * 0.2,
      endRadius: c.igniteSize * g.explosionIntensity,
      life: 0.5,
      intensity: c.igniteIntensity,
      opacity: 0.75,
      fresnel: 1.4,
      displace: 0.45,
      squash: 0.6,
      colorA: getColor(c.colorIgniteA),
      colorB: getColor(c.colorIgniteB),
      colorC: getColor(c.colorIgniteC)
    });

    _emit.position = _pos;
    _emit.radius = 0.18;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.emberSpeed * 2.2;
    _emit.speedVariance = 0.85;
    _emit.spread = 0.8;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.16;
    _emit.sizeVariance = 0.8;
    _emit.life = c.emberLifetime * 1.4;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.embers.emit(Math.round(c.igniteEmbers * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      18
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.igniteFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.7 * g.explosionIntensity;
  }

  onFade(dt, t) {
    // `t` runs 0..1 while the lens burns, then 1..2 while it lets go. Cubic on
    // the way out so the spot holds and then goes, rather than dimming for a
    // second — a lens that fades slowly reads as a torch on a dimmer.
    const fade = t <= 1 ? 1 : 1 - Easing.inCubic(saturate(t - 1));
    this._syncUniforms(fade);
    this._burnFloor();
    this._burnFx(dt, fade);
    this.ctx.shake.rumble(settings.solarlens.rumble * fade * settings.global.cameraShake, dt);
  }

  onDestroy() {
    this.flare.visible = false;
    this.disc.visible = false;
    this.net.setVisible(false);
    this.char.setVisible(false);
    this.char.clearMarks();
    this._igniteAt = -1;
    this._marksLaid = 0;
  }

  dispose() {
    this.disc.dispose();
    this.net.dispose();
    this.char.dispose();
    this.flare.dispose();
    super.dispose();
  }
}
