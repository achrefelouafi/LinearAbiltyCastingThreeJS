import { Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { Curtain, CurtainMode, CurtainLayout } from '../../vfx/Curtain.js';
import { FilamentPaths } from '../../vfx/FilamentPaths.js';
import { GroundField, GroundMode } from '../../vfx/GroundField.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, clamp, Easing, randRange } from '../../utils/math.js';

/** Role slots on the one filament strip. Structural role first — see `sync()`. */
const ROLE_BOLT = 0;
const ROLE_FOOT = 1;

/** Hard ceilings. Their sum is the strip's instance capacity, allocated once. */
const MAX_BOLT = 20;
const MAX_FOOT = 12;

/**
 * Samples along one filament. The ceiling on kink detail: anything
 * higher-frequency than one kink per two samples only aliases.
 */
const NODES = 64;

const UP = new Vector3(0, 1, 0);

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _anchor = new Vector3();
const _from = new Vector3();
const _to = new Vector3();
const _wetCentre = new Vector3();

/** Params objects, filled from settings every frame and never re-created (I3). */
const _cloth = {};
const _wet = {};
const _look = {};

/**
 * STORMWALL — the aimed line is the wall's **normal**.
 *
 * Every other line cast in the project builds *along* the line: the bolt runs
 * down it, the beam lies on it, the lash whips along it. This one turns ninety
 * degrees. A rain curtain stands **across** the heading at the target point,
 * and the arrow indicator is measuring out where the wall goes and how far away
 * it is — never how long it is. Its length is `wallWidth` and it is measured
 * sideways.
 *
 * Mechanically the whole trick is one argument:
 *
 * ```js
 * this.cloth.setPlacement(anchor, this.side, UP);   // side, NOT direction
 * ```
 *
 * `Curtain` lays a `LINE` rank along whatever vector it is handed and gives
 * each sheet a normal perpendicular to it. Hand it `this.direction` and you get
 * a corridor of rain you walk down; hand it `this.side` and you get a wall you
 * hide behind. The module's own doc names this slot as the reason the choice
 * exists, and it is the only line in the file that could not be written any
 * other way.
 *
 * **Three beats, and the third one is the interesting one.**
 *
 *  1. `riseTime` — the wall comes up out of the floor, staggered across the
 *     rank by `riseSpread`.
 *  2. `holdTime` — it stands. Rain streaks down the face, lightning restrikes
 *     *inside the wall's own plane* every `1 / strikeRate` seconds, and current
 *     crawls along the soaked floor at its foot.
 *  3. `fallTime` — it **drains**. `rise` runs back to zero, which collapses
 *     every sheet onto its own foot rather than dimming it, and `fallSink`
 *     takes the foot below the floor. The first version faded `opacity` to zero
 *     and the wall read as a decal being switched off — all the weight the rise
 *     had bought was thrown away in the last second and a half.
 *
 * **The lightning is inside the water, not in front of it.** Both ends of the
 * `CRACK` trunk are placed in the plane spanned by the wall's own width and
 * height — `side` and world up — so the discharge is occluded by the sheets in
 * front of it and lights the ones behind. Placing it on the cast's *direction*
 * axis, which is what you get if you copy any other storm slot, puts it through
 * the wall at right angles and the whole thing reads as two effects that happen
 * to be in the same place.
 *
 * **What a cast captures.** A seed, and three unitless dice per strike: where
 * each end of the trunk sits across the wall, and a decorrelation seed. Not a
 * metre. The rank pitch, the sheet width, the strike's endpoints, the crawl
 * along the foot and the wet patch are resolved from `settings.stormwall` on
 * every frame, zero-length ones included — pause a standing wall, drag
 * `wallWidth`, and the rank re-lays itself, the lightning re-spans it and the
 * puddle re-scales under it together.
 */
export class StormwallAbility extends Ability {
  constructor(context) {
    super('stormwall', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /* --- the water --- */
    // segmentsX is the one that matters: the travelling ripple lives on the
    // across-axis tessellation, and a wall at 12 quads across folds in visible
    // facets the moment the camera moves along it.
    this.cloth = new Curtain({
      capacity: 16,
      segmentsX: 40,
      segmentsY: 18,
      mode: CurtainMode.RAIN,
      layout: CurtainLayout.LINE,
      floor: false, //  the floor is a GroundField(WET) instead — see below
      renderOrder: 9,
      name: 'stormwall.cloth'
    });
    this.group.add(this.cloth.object3D);

    /* --- the lightning: two roles, one strip, two draw calls --- */
    this.paths = new FilamentPaths(this.group, {
      samples: NODES,
      capacity: MAX_BOLT + MAX_FOOT,
      renderOrder: 11
    });
    this.bolt = this.paths.role(ROLE_BOLT);
    this.foot = this.paths.role(ROLE_FOOT);

    /* --- the floor --- */
    // `Curtain` ships a floor companion that walks the same sheet frame, and it
    // is very good; it is not used here because it draws puddles *per sheet* and
    // what this slot wants is one continuous soaked patch that spreads while the
    // squall runs out and dries from the edges in while the wall drains. That is
    // GroundField(WET)'s grow/recede pair, and it is one draw call either way.
    this.wet = new GroundField(this.group, {
      mode: GroundMode.WET,
      additive: false, //  a wet stone that ADDS light is a lit stone
      depthTest: true,
      name: 'stormwall.wet'
    });

    /** Re-rolled per cast. Unitless. */
    this._seed = 0;
    /** Timestamp of the last lightning strike, seconds into the cast. */
    this._strikeAt = -1e4;
    /** Where the current strike's two ends sit across the wall, −1..1. */
    this._strikeX0 = 0;
    this._strikeX1 = 0;
    /** Decorrelates the strike's kinks from the last one. */
    this._strikeSeed = 0;
    this._boltCount = 0;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Droplets bouncing off the foot of the wall. Non-additive: water is not
    // light, and an additive spray turns the base into a bloom smear.
    this.spray = particles.get('stormwall.spray', {
      capacity: 1200,
      shape: ParticleShape.SOFT,
      additive: false,
      softFade: 0.2
    });
    this.spray.uniforms.uDrag.value = 1.1;
    this.spray.uniforms.uEndSize.value = 0.4;
    this.spray.uniforms.uSizeIn.value = 0.05;
    this.spray.uniforms.uFadeIn.value = 0.05;
    this.spray.uniforms.uFadeOut.value = 0.5;

    // The haze rolling off the face and out along the floor.
    this.mist = particles.get('stormwall.mist', {
      capacity: 1400,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.2
    });
    this.mist.uniforms.uDrag.value = 1.7;
    this.mist.uniforms.uEndSize.value = 2.6;
    this.mist.uniforms.uSizeIn.value = 0.14;
    this.mist.uniforms.uFadeIn.value = 0.2;
    this.mist.uniforms.uFadeOut.value = 0.35;

    // Sparks off a strike. The only additive system in the ability.
    this.sparks = particles.get('stormwall.sparks', {
      capacity: 1400,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.25
    });
    this.sparks.uniforms.uDrag.value = 1.5;
    this.sparks.uniforms.uEndSize.value = 0.25;
    this.sparks.uniforms.uSizeIn.value = 0.02;
    this.sparks.uniforms.uFadeIn.value = 0.03;
    this.sparks.uniforms.uFadeOut.value = 0.45;

    this.sprayEmitter = new RateEmitter();
    this.mistEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  _riseSpan() {
    return Math.max(0.02, settings.stormwall.riseTime * settings.global.lifetime);
  }

  /** Rise plus hold: the wall is standing for the whole impact phase. */
  get impactDuration() {
    const c = settings.stormwall;
    return this._riseSpan() + Math.max(0.05, c.holdTime * settings.global.lifetime);
  }

  /** The drain. */
  get fadeDuration() {
    return Math.max(0.05, settings.stormwall.fallTime);
  }

  get instanceCount() {
    return this.cloth.instanceCount + this.paths.liveCount;
  }

  /** Seconds into the drain, 0..1. Zero until the fade phase starts. */
  _drain() {
    if (this.phase !== AbilityPhase.FADE) return 0;
    return saturate(this.fadeTime / this.fadeDuration);
  }

  /**
   * How far up the wall is, 0..1.
   *
   * Rebuilt from `riseTime` every frame rather than taken from the base class's
   * `t`, which was divided by an impact duration that two sliders can move
   * underneath a standing cast.
   */
  _rise() {
    if (this.phase === AbilityPhase.TRAVEL) return 0;
    if (this.phase === AbilityPhase.FADE) {
      // The drain accelerates. A linear collapse looks like a lift descending;
      // water lets go slowly and then all at once.
      return 1 - Easing.inQuad(this._drain());
    }
    return saturate(this.impactTime / this._riseSpan());
  }

  /** A gutter with a strike punched into it. */
  lightShimmer() {
    return 0.82 + 0.18 * Math.sin(this.age * 2.7) * Math.sin(this.age * 1.1) + this._strikeLit();
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  /** Where the wall stands, on the floor. */
  _wallPoint(out) {
    return this.pointAt(1, out);
  }

  /** Half the wall's length, metres — measured across the heading. */
  _halfWidth() {
    return Math.max(0.05, settings.stormwall.wallWidth) * 0.5;
  }

  /**
   * The rank pitch, metres.
   *
   * `wallWidth` is the promise, so the pitch is read off it rather than being
   * its own slider: sizing sheets independently and hoping they add up to a
   * wall is how you get a wall with a hole in it. `sheetOverlap` then decides
   * how much wider than the pitch one sheet is — below about 1.2 you can see
   * between them and it reads as a fence.
   */
  _pitch() {
    const c = settings.stormwall;
    return Math.max(0.05, c.wallWidth) / Math.max(1, Math.round(c.sheets));
  }

  /** 0..1 how much of the strike is left. */
  _strikeLit() {
    const c = settings.stormwall;
    const since = this.age - this._strikeAt;
    if (since < 0) return 0;
    return saturate(1 - since / Math.max(0.02, c.strikeHold));
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.sprayEmitter.reset();
    this.mistEmitter.reset();

    this._seed = Math.random() * 100;
    this._strikeAt = -1e4;
    this._strikeX0 = 0;
    this._strikeX1 = 0;
    this._strikeSeed = 0;
    this._boltCount = 0;

    this.cloth.reset();
    this.cloth.roll(this._seed);
    this.cloth.visible = false; //  the wall does not exist until the squall lands
    this.wet.setVisible(true);
    this.paths.clear();
    this.paths.visible = true;

    this._syncCloth(0, 0);
    this._syncWet(0, 0, 0);
    this._syncBolt(0, 0);
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * The curtain: the rank, the cloth, the two curves and the rain.
   *
   * Called on every frame including those where the wall is not drawn, so the
   * whole folder stays live under the editor while the squall is still on its
   * way out. An invisible curtain costs a few dozen uniform writes.
   *
   * @param {number} rise 0..1 how far up it is
   * @param {number} live 0..1 master on opacity — the cast's own aliveness
   */
  _syncCloth(rise, live) {
    const c = settings.stormwall;
    const g = settings.global;

    this._wallPoint(_anchor);
    // THE TRICK, and it is this one argument: the rank is laid along the cast's
    // SIDE vector, so the line you aimed is the wall's normal.
    this.cloth.setPlacement(_anchor, this.side, UP);

    const pitch = this._pitch();

    _cloth.count = Math.round(c.sheets);
    _cloth.spacing = pitch;
    _cloth.scatter = c.sheetScatter;
    _cloth.seed = this._seed;

    _cloth.width = pitch * Math.max(0.05, c.sheetOverlap);
    _cloth.widthJitter = c.sheetWidthJitter;
    _cloth.height = Math.max(0.05, c.wallHeight);
    _cloth.heightJitter = c.sheetHeightJitter;
    // The drain takes the foot under the floor as well as the head down to it,
    // which is what stops the last few centimetres reading as a puddle of cloth.
    _cloth.base = -c.fallSink * this._drain();
    _cloth.taper = c.sheetTaper;
    _cloth.lean = c.sheetLean;
    _cloth.leanJitter = c.sheetLeanJitter;
    _cloth.rise = rise;
    _cloth.riseSpread = c.riseSpread;

    _cloth.rippleAmp = c.rippleAmp * g.turbulence;
    _cloth.rippleLength = c.rippleLength;
    _cloth.rippleSpeed = c.rippleSpeed * g.speed;
    _cloth.rippleCurve = c.rippleCurve;
    _cloth.foldAmp = c.foldAmp * g.turbulence;
    _cloth.foldLength = c.foldLength;
    _cloth.foldSpeed = c.foldSpeed * g.speed;
    _cloth.rippleNoise = c.rippleNoise * g.noiseStrength;
    _cloth.rippleNoiseScale = c.rippleNoiseScale * g.noiseFrequency;
    _cloth.rippleNoiseSpeed = c.rippleNoiseSpeed * g.noiseSpeed;
    _cloth.phaseSpread = c.phaseSpread;

    // These two are meant to disagree — see the module's "the mismatch is the
    // effect". Set them equal once and the wall becomes a hanging ribbon.
    _cloth.alphaBase = c.alphaBase;
    _cloth.alphaTop = c.alphaTop;
    _cloth.alphaCurve = c.alphaCurve;
    _cloth.emissionBase = c.emissionBase;
    _cloth.emissionTop = c.emissionTop;
    _cloth.emissionCurve = c.emissionCurve;

    _cloth.body = c.body;
    _cloth.footFade = c.footFade;
    _cloth.headFade = c.headFade;
    _cloth.edgeFade = c.edgeFade;
    _cloth.graze = c.graze;
    _cloth.grazeFloor = c.grazeFloor;
    _cloth.softFade = c.curtainSoftFade;
    _cloth.opacity = c.curtainOpacity * g.opacity * live;
    _cloth.glow = c.curtainGlow * g.glow;
    _cloth.tintSpread = c.tintSpread;

    _cloth.streakDensity = c.streakDensity;
    _cloth.streakRepeat = c.streakRepeat;
    _cloth.streakSpeed = c.streakSpeed * g.speed;
    _cloth.streakSpeedJitter = c.streakSpeedJitter;
    _cloth.streakWidth = c.streakWidth;
    _cloth.streakTail = c.streakTail;
    _cloth.streakDuty = c.streakDuty;
    _cloth.haze = c.haze;

    _cloth.colorA = c.colorRainTail;
    _cloth.colorB = c.colorRainHead;
    _cloth.colorBody = c.colorRainBody;

    // The clock argument is ignored — the sheets run off frame.uTime inside the
    // shader — but it is passed honestly rather than as a zero, because the
    // signature will grow a use for it before the module does.
    this.cloth.update(this.age, _cloth);
  }

  /**
   * The soaked floor.
   *
   * @param {number} grow   0..1 the front spreading out
   * @param {number} recede 0..1 the outside drying back in
   * @param {number} fade   0..1 master
   */
  _syncWet(grow, recede, fade) {
    const c = settings.stormwall;
    const g = settings.global;

    this._wallPoint(_anchor);
    // Under the wall *and in front of it*, so the sheen reads from the caster's
    // side as well as through the curtain.
    _wetCentre.copy(_anchor).addScaledVector(this.direction, c.wetForward);

    _wet.centre = _wetCentre;
    _wet.yaw = Math.atan2(this.direction.x, this.direction.z);
    _wet.height = c.wetHeight;
    _wet.radius = Math.max(0.1, c.wetRadius);

    _wet.grow = grow;
    _wet.recede = recede;
    _wet.fade = fade;
    _wet.seed = this._seed;

    _wet.edge = c.wetEdge;
    _wet.ragged = c.wetRagged;
    _wet.raggedScale = c.wetRaggedScale;
    _wet.warp = c.wetWarp;

    _wet.relief = c.wetRelief;
    _wet.normalStep = c.wetNormalStep;
    _wet.ambient = c.wetAmbient;
    _wet.wrap = c.wetWrap;
    _wet.specular = c.wetSpecular;
    _wet.gloss = c.wetGloss;
    _wet.parallax = c.wetParallax;

    _wet.cell = c.wetCell;
    _wet.cellJitter = c.wetCellJitter;
    _wet.lift = c.wetLift;
    _wet.depth = c.wetDepth;
    _wet.sharp = c.wetSharp;
    _wet.detail = c.wetDetail;
    _wet.speed = c.wetSpeed;
    _wet.flow = c.wetFlow;
    _wet.windAngle = c.wetWind;

    _wet.additive = false;
    _wet.emissive = c.wetEmissive;
    _wet.opacity = c.wetOpacity;
    _wet.depthFade = c.wetDepthFade;
    _wet.colorBase = c.colorWetBase;
    _wet.colorEdge = c.colorWetEdge;
    _wet.colorGlow = c.colorWetGlow;
    _wet.colorDeep = c.colorWetDeep;

    _wet.noiseStrength = g.noiseStrength;
    _wet.noiseFrequency = g.noiseFrequency;
    _wet.noiseSpeed = g.noiseSpeed;
    _wet.opacityScale = g.opacity;

    this.wet.update(_wet);
  }

  /**
   * The lightning: a `CRACK` inside the wall's plane, and a crawl along its
   * foot.
   *
   * Both roles are filled from settings every frame, which is the module's one
   * rule — a role setter takes resolved metres, so the call belongs next to the
   * settings read that produced them and never in `onSpawn`.
   *
   * @param {number} lit  0..1 how much of the current strike is left
   * @param {number} live 0..1 the wall's own aliveness
   */
  _syncBolt(lit, live) {
    const c = settings.stormwall;
    const g = settings.global;

    this._wallPoint(_anchor);
    const half = this._halfWidth();
    const height = Math.max(0.05, c.wallHeight);

    /* --- the strike, in the plane of the wall --- */
    // `side` and world up span the wall. Nothing here touches `direction`,
    // which is what keeps the discharge inside the water.
    _from
      .copy(_anchor)
      .addScaledVector(this.side, this._strikeX0 * half)
      .addScaledVector(UP, c.boltTop * height);
    _to
      .copy(_anchor)
      .addScaledVector(this.side, this._strikeX1 * half)
      .addScaledVector(UP, c.boltBottom * height);

    this._boltCount = lit > 0 ? Math.min(MAX_BOLT, Math.round(c.boltFilaments)) : 0;
    this.bolt.count = this._boltCount;
    this.bolt
      .crack(_from, _to, c.crackAngle, c.crackLength, c.crackFalloff, c.crackSpread,
        c.crackStart, c.crackSag, c.crackFork)
      .style(1, 1, Math.pow(lit, 0.6), 1)
      .ends(c.boltTaper, c.boltTaper, c.boltTaper, c.boltTaper)
      .draw(2, 0.08, 0, 1.6);

    /* --- and the current crawling along the soaked foot --- */
    _from.copy(_anchor).addScaledVector(this.side, -half).setY(c.footFloor);
    _to.copy(_anchor).addScaledVector(this.side, half).setY(c.footFloor);

    this.foot.count = Math.min(MAX_FOOT, Math.round(c.footFilaments * live));
    this.foot
      .line(_from, _to, c.footSag, c.footSpread * 0.35, c.footSpread, 1.0, 0.25, 0.35, 0.85)
      // groundDamp below ~0.4 on anything running flat, or half of every
      // filament buries itself in the floor and the crawl reads as a dotted
      // line. The snare learnt that the hard way; `footFloor` clamps the rest.
      .style(c.footKink, 0.7, c.footDim * live, c.footDamp)
      .ends(1, 1, 1, 1)
      .draw(2, 0.06, c.footFloor, 0.4);

    /* --- the shared look --- */
    _look.width = c.filWidth;
    _look.glowWidth = c.filGlowWidth;
    _look.glowOpacity = c.filGlowOpacity;
    _look.jitter = c.filJitter;
    _look.jitterScale = c.filJitterScale;
    _look.octaves = c.filOctaves;
    _look.jitterFalloff = c.filJitterFalloff;
    _look.crawl = c.filCrawl;
    _look.pinch = c.filPinch;
    _look.restrike = c.filRestrike;
    _look.flicker = c.filFlicker;
    _look.flickerSpeed = c.filFlickerSpeed;
    _look.strandFlash = c.filStrandFlash;
    _look.coreSharp = c.filCoreSharp;
    _look.glowFalloff = c.filGlowFalloff;
    _look.softFade = c.filSoftFade;
    _look.opacity = c.filOpacity;
    _look.glow = c.filGlow;
    _look.colorCore = c.colorBoltCore;
    _look.colorInner = c.colorBoltInner;
    _look.colorOuter = c.colorBoltOuter;
    _look.colorHalo = c.colorBoltHalo;

    _look.randomness = g.randomness;
    _look.noiseStrength = g.noiseStrength;
    _look.noiseFrequency = g.noiseFrequency;
    _look.noiseSpeed = g.noiseSpeed;
    _look.opacityScale = g.opacity;
    _look.glowScale = g.glow;

    this.paths.sync(_look, 1, this._seed + this._strikeSeed);
  }

  /**
   * Roll a new strike.
   *
   * The three numbers a cast writes down are all here and all unitless: where
   * each end of the trunk sits across the wall as a fraction of the half-width,
   * and a seed. What that becomes in metres is decided by `_syncBolt` on the
   * frame it is drawn.
   */
  _strike() {
    const c = settings.stormwall;
    const g = settings.global;

    this._strikeAt = this.age;
    this._strikeSeed = Math.random() * 40;
    this._strikeX0 = randRange(-0.85, 0.85);
    this._strikeX1 = clamp(this._strikeX0 + randRange(-c.boltDrift, c.boltDrift), -1, 1);

    this._wallPoint(_anchor);
    _pos
      .copy(_anchor)
      .addScaledVector(this.side, this._strikeX1 * this._halfWidth())
      .setY(Math.max(0.05, c.wallHeight) * c.boltBottom + 0.1);

    _emit.position = _pos;
    _emit.radius = 0.25;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.sparkSpeed;
    _emit.speedVariance = 0.85;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.18;
    _emit.sizeVariance = 0.7;
    _emit.life = c.sparkLifetime;
    _emit.lifeVariance = 0.55;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.sparks.emit(Math.round(c.strikeSparks * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorStrikeFlash), c.strikeFlash * g.explosionIntensity);
    this.lightBoost = c.strikeLight * g.explosionIntensity;
  }

  /** Push the live gradients and scales into the three particle systems. */
  _syncParticles() {
    const c = settings.stormwall;
    const g = settings.global;

    this.spray.setGradient(
      getColor(c.colorSprayA),
      getColor(c.colorSprayB),
      getColor(c.colorSprayC),
      getColor(c.colorSprayD)
    );
    this.spray.uniforms.uGravity.value.set(0, c.sprayGravity, 0);
    this.spray.uniforms.uSizeScale.value = c.spraySize * g.particleSize * 7;
    this.spray.uniforms.uLifeScale.value = c.sprayLifetime * 0.5 * g.particleLifetime;
    this.spray.uniforms.uSpeedScale.value = g.particleSpeed;
    this.spray.uniforms.uOpacity.value = g.opacity;

    this.mist.setGradient(
      getColor(c.colorMistA),
      getColor(c.colorMistB),
      getColor(c.colorMistC),
      getColor(c.colorMistD)
    );
    this.mist.uniforms.uGravity.value.set(0, c.mistRise, 0);
    this.mist.uniforms.uSizeScale.value = c.mistSize * g.particleSize;
    this.mist.uniforms.uLifeScale.value = c.mistLifetime * 0.5 * g.particleLifetime;
    this.mist.uniforms.uSpeedScale.value = c.mistSpeed * g.particleSpeed;
    this.mist.uniforms.uOpacity.value = c.mistOpacity * g.opacity;
    this.mist.uniforms.uTurbulence.value = 0.4 * g.turbulence;

    this.sparks.setGradient(
      getColor(c.colorSparkA),
      getColor(c.colorSparkB),
      getColor(c.colorSparkC),
      getColor(c.colorSparkD)
    );
    this.sparks.uniforms.uGravity.value.set(0, c.sparkGravity, 0);
    this.sparks.uniforms.uSizeScale.value = c.sparkSize * g.particleSize * 7;
    this.sparks.uniforms.uLifeScale.value = c.sparkLifetime * 0.5 * g.particleLifetime;
    this.sparks.uniforms.uSpeedScale.value = g.particleSpeed;
    this.sparks.uniforms.uOpacity.value = g.opacity;
    this.sparks.uniforms.uGlow.value = c.filGlow * 0.5 * g.glow;
    this.sparks.uniforms.uStretch.value = c.sparkStretch;
  }

  /**
   * Spray off the wall's foot, hung on the sheets themselves.
   *
   * `sheetPoint()` reads the same dice the vertex shader reads, so a droplet
   * leaves the sheet it is meant to leave rather than the average position of
   * the rank — which is what you get from emitting at the anchor with a radius,
   * and it shows the moment `sheetScatter` is anything but zero.
   */
  _wallFx(dt, live) {
    const c = settings.stormwall;
    const g = settings.global;
    const time = frame.uTime.value;
    const count = Math.max(1, Math.round(c.sheets));

    const sprayCount = Math.round(this.sprayEmitter.tick(dt, c.sprayRate * live) * g.particleCount);
    if (sprayCount > 0) {
      const sheet = Math.floor(Math.random() * count);
      this.cloth.sheetPoint(sheet, _cloth, _pos, randRange(-0.9, 0.9), 0);
      _pos.y = 0.04;
      _emit.position = _pos;
      _emit.radius = this._pitch() * 0.5;
      // Off the face rather than straight up: the drops are bouncing, and the
      // face they bounce off is the one whose normal is the cast heading.
      _emit.direction = _dir.copy(this.direction).multiplyScalar(randRange(-1, 1) * 0.5).setY(1).normalize();
      _emit.speed = c.spraySpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = saturate(c.spraySpread);
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.1;
      _emit.sizeVariance = 0.7;
      _emit.life = c.sprayLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.spray.emit(sprayCount, _emit);
    }

    const mistCount = Math.round(this.mistEmitter.tick(dt, c.mistRate * live) * g.particleCount);
    if (mistCount > 0) {
      const sheet = Math.floor(Math.random() * count);
      this.cloth.sheetPoint(sheet, _cloth, _pos, randRange(-1, 1), randRange(0, 0.35));
      _emit.position = _pos;
      _emit.radius = this._pitch();
      _emit.direction = _dir.copy(this.direction).multiplyScalar(0.4).setY(1).normalize();
      _emit.speed = c.mistSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.9;
      _emit.size = 1.2;
      _emit.sizeVariance = 0.5;
      _emit.life = c.mistLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.25;
      _emit.time = time;
      this.mist.emit(mistCount, _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = settings.stormwall;
    const g = settings.global;

    // Nothing stands yet. The squall runs out along the aimed line and the
    // floor at the target darkens ahead of it, so the wall has somewhere to
    // come up out of.
    this.cloth.visible = false;
    this._syncCloth(0, 0);
    this._syncWet(this.u, 0, this.u);
    this._syncBolt(0, 0);
    this._syncParticles();

    const mistCount = Math.round(this.mistEmitter.tick(dt, c.mistRate * 0.6) * g.particleCount);
    if (mistCount > 0) {
      _pos.copy(this.position).setY(0.2);
      _emit.position = _pos;
      _emit.radius = 0.6;
      _emit.direction = _dir.copy(this.direction).multiplyScalar(0.7).setY(0.5).normalize();
      _emit.speed = c.mistSpeed * 1.6;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.85;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.9;
      _emit.sizeVariance = 0.5;
      _emit.life = c.mistLifetime * 0.6;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.2;
      _emit.tint = null;
      _emit.time = frame.uTime.value;
      this.mist.emit(mistCount, _emit);
    }
  }

  onImpact() {
    const c = settings.stormwall;
    const g = settings.global;

    this.cloth.visible = true;
    // `CameraShake#add` already folds in `global.cameraShake`, so this does not
    // apply it a second time.
    this.ctx.shake.add(c.riseShake * g.explosionIntensity, 1 / Math.max(0.05, c.riseShakeTime), 18);
    // The first strike lands as the wall tops out rather than on a timer, so
    // the rise has a punctuation mark on it.
    this._strikeAt = -1e4;
  }

  onFade(dt, _t) {
    const c = settings.stormwall;

    const drain = this._drain();
    const rise = this._rise();
    const standing = this.phase === AbilityPhase.FADE ? 1 - drain : 1;

    this._wallPoint(_anchor);
    this.position.copy(_anchor);
    this.position.y = Math.max(0.1, c.wallHeight * 0.4);

    /* --- the lightning restrikes on its own clock --- */
    // Gated on a real frame: a strike is an *event*, and a paused frame has no
    // events in it. Without the guard, dragging `strikeRate` with the clock
    // stopped would fire a new bolt on every probe.
    const period = 1 / Math.max(0.05, c.strikeRate);
    const alive = rise > 0.35 && standing > 0.15;
    if (dt > 0 && alive && this.age - this._strikeAt >= period) this._strike();
    const lit = alive ? this._strikeLit() : 0;

    this.cloth.visible = rise > 0.001;
    this._syncCloth(rise, standing);
    this._syncWet(1, drain * saturate(c.wetDry), 1 - Easing.inQuad(drain));
    this._syncBolt(lit, standing);
    this._syncParticles();

    this._wallFx(dt, rise * standing);
    this.ctx.shake.rumble(c.holdRumble * standing, dt);
  }

  onDestroy() {
    this.cloth.reset();
    this.paths.clear();
    this.wet.setVisible(false);
    this._boltCount = 0;
    this._strikeAt = -1e4;
  }

  dispose() {
    this.cloth.dispose();
    this.paths.dispose();
    this.wet.dispose();
    super.dispose();
  }
}
