import { Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { LiquidSurface, LiquidMode, liquidParams } from '../../vfx/LiquidSurface.js';
import { GroundField, GroundMode, groundFieldParams } from '../../vfx/GroundField.js';
import { Swarm, Silhouette, LeadPath, swarmParams } from '../../vfx/Swarm.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, Easing, randRange } from '../../utils/math.js';

/**
 * How many points along the lip one frame's spray is split between.
 *
 * A breaking wave sheds along the *whole* lip. Firing a frame's droplets from a
 * single `across` reads as a hose pointed sideways, which is the same mistake
 * the bolt's sparks made before they were batched.
 */
const SPRAY_BATCHES = 5;

/** Hard ceiling on the droplet flock. The `dropCount` slider clamps here. */
const MAX_DROPLETS = 256;

/* ---------------------------------------------------------------- */
/* Scratch — module scope (I3). Filled and consumed inside one call. */
/* ---------------------------------------------------------------- */

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _lip = new Vector3();
const _anchor = new Vector3();
const _centre = new Vector3();
const _up = new Vector3(0, 1, 0);

/** The three params blocks the shared modules read. Refilled every frame. */
const _liquid = liquidParams();
const _wet = groundFieldParams();
const _drops = swarmParams();
_wet.centre = _centre;

/**
 * CRIMSON TIDE — a real wave, thrown down the aimed line.
 *
 * Three beats: **surge**, **break**, **drain**. A heightfield wave races out
 * from the caster at `speed`, curls, throws its lip forward past the end of the
 * line, collapses, and soaks into the floor leaving wet flagstone that dries
 * from the edges in.
 *
 * ## The trick — the sheet is re-cut every frame, so the crest is never sliding
 *
 * The obvious way to build this is a fixed plane the length of the cast with a
 * `waveFront` uniform swept from 0 to 1 across it. It was the first version and
 * it is wrong in a way that is hard to unsee: the water in front of the crest
 * is *already there*, so the wave reads as a bulge travelling through a canal
 * rather than as a mass of liquid arriving. A surge has nothing in front of it.
 *
 * So the sheet is cut to exactly the run the surge has covered. Every frame the
 * plane's downrange extent is rebuilt as
 *
 * ```
 *   tail = -sheetTail                       (metres behind the caster)
 *   head =  u · length + sheetLead          (metres past the crest)
 * ```
 *
 * and `waveFront` is then *solved* so the crest lands on the travelled distance
 * in world space whatever those two numbers are. `sheetLead` is the only water
 * ahead of the lip — a metre or two of it, so the curl has something to break
 * into — and dragging it while the wave is in the air moves the leading edge
 * without moving the crest. That is the whole design: the crest is a fixed
 * world point that the sheet is stretched around, not a parameter sliding along
 * a plane.
 *
 * ## What each module is doing
 *
 * - **`LiquidSurface(WAVE)`** — the wave. The curl is Gerstner pushed hard:
 *   horizontal throw proportional to *height*, so the top of the crest outruns
 *   its foot and the sheet genuinely folds over itself. Where it has folded the
 *   shader thins alpha and adds a backlight, which is the "front face thin
 *   enough to be translucent" the brief asks for — `translucency` is the slider
 *   that owns it and it does more for this cast than any colour picker.
 * - **`Swarm(DROPLET)`** — the coherent sheet of spray the lip drags with it.
 *   Its lead is pinned to `lipPosition()`, and because cohesion in that module
 *   is a *lag* rather than a history buffer, the flock strings out behind the
 *   lip exactly as thrown water does. The droplets that *fall* are particles;
 *   these are the ones still travelling with the wave.
 * - **`GroundField(WET)`** — the puddle left where the tide stood. Alpha
 *   blended, so soaked stone comes out genuinely darker than dry stone rather
 *   than brighter, and `recede` eats it back from the outside in.
 *
 * The first version tried to make that last field cover the whole run by
 * setting its radius to half the cast length. `GroundField` measures its front
 * radially, so on a 22 m line that is a 22 m-wide disc of wet floor and the
 * cast read as a flood, not as a wave that had passed. The **strip** is carried
 * by `FOAM` decals dropped under the crest as it travels — those are allowed to
 * capture a radius, being transient — and the field is the standing puddle at
 * the break.
 *
 * ## Low emission, on purpose
 *
 * `emissive` is 0 and `glow` sits below 1. Nothing here is a light source. The
 * wave reads by silhouette and by specular off a curling face, which is why
 * `specular`, `shininess` and `translucency` are the three sliders that matter
 * and why the dynamic light is dim and deep red: it exists to give the wet
 * stone and the folded lip something to catch, not to make the cast glow.
 *
 * ## What a cast captures
 *
 * One number — `_seed`, so two tides do not break identically — and timestamps.
 * Not a metre, not a radian, not a second. The sheet, the crest, the puddle and
 * the flock are all re-resolved from `settings.crimsontide` inside the update
 * loop, on a zero-length frame included. Pause with **P** mid-surge and drag
 * `crestFace`: the wave in front of you steepens.
 */
export class CrimsonTideAbility extends Ability {
  constructor(context) {
    super('crimsontide', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /*
     * 96 segments a side. Below about 48 the Gerstner cusps facet visibly and
     * the curl turns into a chamfer; above 160 you are paying vertex cost for
     * detail the fragment normal already carries for nothing.
     */
    this.surface = new LiquidSurface({
      segments: 96,
      mode: LiquidMode.WAVE,
      depthWrite: true, //  a heightfield is a solid; its crest must hide its own back
      doubleSide: true, //  required the moment `crestCurl` folds the sheet over
      renderOrder: 8,
      name: 'CrimsonTide:sheet'
    });
    this.group.add(this.surface.object3D);

    /*
     * The puddle. Non-additive is the entire point of this mode: soaked stone
     * is *darker* than dry stone and shinier, and an additive mark can only
     * ever be a lit stone.
     */
    this.wet = new GroundField(this.group, {
      mode: GroundMode.WET,
      additive: false,
      depthTest: true,
      renderOrder: 5,
      name: 'CrimsonTide:wet'
    });

    /*
     * The spray flock. Non-additive and `lit` for the same reason: a blood
     * droplet is a dark wet body, and additive droplets over a dark floor read
     * as embers.
     */
    this.droplets = new Swarm(this.group, {
      capacity: MAX_DROPLETS,
      silhouette: Silhouette.DROPLET,
      additive: false,
      renderOrder: 12
    });

    /** Re-rolled per cast so no two tides break the same way. */
    this._seed = 0;
    /** Metres of front travel already paid out in floor marks. */
    this._slickDistance = 0;
    /** Agents drawn last frame — the HUD readout. */
    this._live = 0;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Spray: the droplets that leave the lip and fall. Soft rounds rather than
    // streaks — a blood droplet is a bead, not a spark, and stretching it along
    // its velocity turns the whole plume into rain.
    this.spray = particles.get('crimsontide.spray', {
      capacity: 2400,
      shape: ParticleShape.SOFT,
      additive: false,
      lit: true,
      softFade: 0.3
    });
    this.spray.uniforms.uDrag.value = 0.6;
    this.spray.uniforms.uEndSize.value = 0.55;
    this.spray.uniforms.uSizeIn.value = 0.03;
    this.spray.uniforms.uFadeIn.value = 0.04;
    this.spray.uniforms.uFadeOut.value = 0.5;

    // The fine red haze standing over the wave. Non-additive so it genuinely
    // occludes the sheet behind it — additive mist over dark blood is a pink fog.
    this.mist = particles.get('crimsontide.mist', {
      capacity: 1200,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.0
    });
    this.mist.uniforms.uDrag.value = 1.9;
    this.mist.uniforms.uEndSize.value = 2.6;
    this.mist.uniforms.uSizeIn.value = 0.14;
    this.mist.uniforms.uFadeIn.value = 0.2;
    this.mist.uniforms.uFadeOut.value = 0.35;

    // Clots: the heavy gobbets that roll off the back of the wave and land.
    this.clots = particles.get('crimsontide.clots', {
      capacity: 900,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.clots.uniforms.uDrag.value = 0.2;
    this.clots.uniforms.uEndSize.value = 0.7;
    this.clots.uniforms.uFadeOut.value = 0.65;

    this.sprayEmitter = new RateEmitter();
    this.mistEmitter = new RateEmitter();
    this.clotEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this._live;
  }

  /** The crest curls over and collapses. */
  get impactDuration() {
    return Math.max(0.05, settings.crimsontide.breakTime * settings.global.lifetime);
  }

  /** Then it soaks away. */
  get fadeDuration() {
    return Math.max(0.05, settings.crimsontide.drainTime);
  }

  /**
   * Blood does not gutter and it does not glint. A slow swell on the light, at
   * roughly the rate the biggest wave component runs at, so the wet floor
   * breathes instead of sitting flat.
   */
  lightShimmer() {
    return 0.88 + 0.12 * Math.sin(this.age * 2.6);
  }

  /* ------------------------------------------------------------------ */
  /* The beats — pure functions of the phase clock and live settings      */
  /* ------------------------------------------------------------------ */

  /** 0..1 how far the crest has run down the line. */
  _surge() {
    return this.phase === AbilityPhase.TRAVEL ? this.u : 1;
  }

  /**
   * 0..1 through the break, and 0..1 through the drain.
   *
   * `onFade` is handed `t` running 0..1 while the crest breaks and 1..2 while
   * the sheet drains; both are recovered from the phase clock here rather than
   * stored, so a mid-cast change to `breakTime` re-times the beat it is in.
   */
  _breakAmount() {
    if (this.phase === AbilityPhase.TRAVEL) return 0;
    if (this.phase === AbilityPhase.IMPACT) return saturate(this.impactTime / this.impactDuration);
    return 1;
  }

  _drainAmount() {
    if (this.phase !== AbilityPhase.FADE) return 0;
    return saturate(this.fadeTime / this.fadeDuration);
  }

  /**
   * The crest's height in metres, right now.
   *
   * Three regimes, and the middle one is the ability. On the way out the crest
   * grows over the first `crestRise` of the run — a wave that starts at full
   * height has no surge in it. At the break it swells to `crestPeak` and then
   * falls away as it dumps. Through the drain it is a low, dying swell.
   */
  _crestHeightNow() {
    const c = settings.crimsontide;
    const brk = this._breakAmount();
    const drain = this._drainAmount();
    if (drain > 0) return c.crestHeight * 0.28 * (1 - Easing.outQuad(drain));
    if (brk > 0) {
      // Fast rise, slow dump: the lip is highest just as it pitches forward.
      const bump = Math.sin(Math.PI * Math.pow(brk, 0.8));
      return c.crestHeight * lerp(1, c.crestPeak, bump) * (1 - Easing.inQuad(brk) * 0.72);
    }
    const rise = saturate(this._surge() / Math.max(0.02, c.crestRise));
    return c.crestHeight * Easing.outCubic(rise);
  }

  /** Metres of forward throw per metre of height — the overhang. */
  _crestCurlNow() {
    const c = settings.crimsontide;
    const brk = this._breakAmount();
    return c.crestCurl * lerp(1, c.crestCurlPeak, Easing.outCubic(brk));
  }

  /** 0..1 how ragged the lip is — it tears itself apart as it breaks. */
  _crestBreakNow() {
    const c = settings.crimsontide;
    const brk = this._breakAmount();
    return Math.min(1, c.crestBreak * lerp(1, c.crestBreakPeak, Easing.outCubic(brk)));
  }

  /** Metres down the line the crest stands, including its throw past the end. */
  _crestDistance() {
    const c = settings.crimsontide;
    return this._surge() * this.length + c.crestOvershoot * Easing.outCubic(this._breakAmount());
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.sprayEmitter.reset();
    this.mistEmitter.reset();
    this.clotEmitter.reset();
    this._slickDistance = 0;

    this.surface.clearRipples();

    // The one thing a cast captures. Everything else is resolved per frame.
    this._seed = Math.random() * 100;
    this.droplets.roll(this._seed);

    this._sync(1);
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Re-resolve the sheet, the puddle and the flock from live settings and push
   * them into their modules.
   *
   * @param {number} fade 1 while the tide stands, ramping to 0 as it drains
   */
  _sync(fade) {
    const c = settings.crimsontide;
    const g = settings.global;

    /* ---------------- the sheet, re-cut around the crest ---------------- */
    // Everything here is metres, measured this frame. `tail` is negative: the
    // sheet starts behind the caster so the surge does not appear to be poured
    // out of a hole in the floor at his feet.
    const crest = this._crestDistance();
    const tail = -c.sheetTail;
    const head = crest + c.sheetLead;
    const span = Math.max(0.2, head - tail);

    _anchor
      .copy(this.origin)
      .addScaledVector(this.direction, (head + tail) * 0.5)
      .setY(c.sheetHeight);
    this.surface.setPlacement(_anchor, this.direction, _up);

    _liquid.sizeX = span;
    _liquid.sizeZ = Math.max(0.2, c.sheetWidth);
    // Solved, not swept: whatever the sheet's extent, the crest lands on the
    // distance the surge has actually covered.
    _liquid.waveFront = saturate((crest - tail) / span);
    _liquid.fill = c.sheetFill * lerp(1, 0.04, Easing.inQuad(this._drainAmount()));
    _liquid.round = c.sheetRound;
    _liquid.edgeSoft = c.sheetEdge;
    _liquid.edgeNoise = c.sheetRagged;
    _liquid.edgeScale = c.sheetRaggedScale;
    _liquid.seed = this._seed;
    _liquid.opacity = c.sheetOpacity * fade * g.opacity;
    _liquid.contactFade = c.contactFade;

    _liquid.waveAmpA = c.swellAmpA;
    _liquid.waveAmpB = c.swellAmpB;
    _liquid.waveAmpC = c.swellAmpC;
    _liquid.waveAmpD = c.swellAmpD;
    _liquid.waveLengthA = c.swellLengthA;
    _liquid.waveLengthB = c.swellLengthB;
    _liquid.waveLengthC = c.swellLengthC;
    _liquid.waveLengthD = c.swellLengthD;
    _liquid.waveSpeedA = c.swellSpeedA;
    _liquid.waveSpeedB = c.swellSpeedB;
    _liquid.waveSpeedC = c.swellSpeedC;
    _liquid.waveSpeedD = c.swellSpeedD;
    _liquid.waveAngleA = c.swellAngleA;
    _liquid.waveAngleB = c.swellAngleB;
    _liquid.waveAngleC = c.swellAngleC;
    _liquid.waveAngleD = c.swellAngleD;
    _liquid.steepness = c.steepness;

    _liquid.chop = c.chop * g.noiseStrength;
    _liquid.chopScale = c.chopScale * g.noiseFrequency;
    _liquid.chopSpeed = c.chopSpeed * g.noiseSpeed;
    _liquid.detail = c.detail * g.noiseStrength;
    _liquid.detailScale = c.detailScale * g.noiseFrequency;
    _liquid.detailSpeed = c.detailSpeed * g.noiseSpeed;

    _liquid.rippleAmp = c.rippleAmp;
    _liquid.rippleSpeed = c.rippleSpeed;
    _liquid.rippleLength = c.rippleLength;
    _liquid.rippleWidth = c.rippleWidth;
    _liquid.rippleDecay = c.rippleDecay;
    _liquid.rippleSpread = c.rippleSpread;

    _liquid.flowAngle = c.flowAngle;
    _liquid.flowSpeed = c.flowSpeed;
    _liquid.flowRadial = c.flowRadial;
    _liquid.flowRadialFall = c.flowRadialFall;
    _liquid.flowEddy = c.flowEddy;
    _liquid.flowEddyScale = c.flowEddyScale;
    _liquid.flowEddySpeed = c.flowEddySpeed;
    _liquid.flowGravity = c.flowGravity;

    // The skin only starts to matter once the sheet slows down, so it is faded
    // in with the break rather than paid for during the surge — the crust block
    // is a flow map plus two advected fbm phases, and it is the most expensive
    // thing in this fragment shader.
    _liquid.crust = c.crust * Easing.outQuad(this._breakAmount());
    _liquid.crustForm = c.crustForm;
    _liquid.crustBreak = c.crustBreak;
    _liquid.crustFormTime = c.crustFormTime;
    _liquid.crackScale = c.crackScale * g.noiseFrequency;
    _liquid.crackStretch = c.crackStretch;
    _liquid.crackWidth = c.crackWidth;
    _liquid.crustAdvect = c.crustAdvect;
    _liquid.crustPeriod = c.crustPeriod;
    _liquid.crustBump = c.crustBump;
    _liquid.seamGlow = c.seamGlow;
    _liquid.meltGlow = c.meltGlow;

    _liquid.foam = c.foam;
    _liquid.foamScale = c.foamScale * g.noiseFrequency;
    _liquid.foamSharp = c.foamSharp;
    _liquid.foamCrest = c.foamCrest;
    _liquid.foamSpeed = c.foamSpeed;

    _liquid.crestHeight = this._crestHeightNow();
    _liquid.crestBack = c.crestBack;
    _liquid.crestFace = c.crestFace;
    _liquid.crestCurl = this._crestCurlNow();
    _liquid.crestWidth = c.crestWidth;
    _liquid.crestFeather = c.crestFeather;
    _liquid.crestBreak = this._crestBreakNow();
    _liquid.crestBreakScale = c.crestBreakScale * g.noiseFrequency;

    _liquid.poolDepth = c.poolDepth;
    _liquid.depthTint = c.depthTint;
    _liquid.translucency = c.translucency;
    _liquid.ambient = c.ambient;
    _liquid.specular = c.specular;
    _liquid.shininess = c.shininess;
    _liquid.fresnel = c.fresnel * g.fresnel;
    _liquid.envIntensity = c.envIntensity;
    _liquid.skyIntensity = c.skyIntensity;
    _liquid.emissive = c.emissive;
    _liquid.glow = c.glow * g.glow;
    _liquid.normalEps = c.normalEps;

    _liquid.colorDeep = c.colorDeep;
    _liquid.colorShallow = c.colorShallow;
    _liquid.colorCrust = c.colorCrust;
    _liquid.colorSeam = c.colorSeam;
    _liquid.colorHot = c.colorHot;
    _liquid.colorFoam = c.colorFoam;
    _liquid.colorSpec = c.colorSpec;
    _liquid.colorSky = c.colorSky;

    this.surface.visible = _liquid.opacity > 0.002;
    this.surface.update(this.age, _liquid);

    /* ---------------- the puddle ---------------- */
    _centre.copy(this.origin).addScaledVector(this.direction, c.wetAlong * this.length);
    _wet.yaw = Math.atan2(this.direction.x, this.direction.z);
    _wet.height = c.wetHeight;
    _wet.radius = c.wetRadius;
    // The tide mark fills as the surge reaches the middle of the puddle, then
    // holds; drying eats it back from the outside once the sheet is draining.
    _wet.grow = saturate(this._surge() / Math.max(0.05, c.wetAlong));
    const dry = saturate((this._drainAmount() - c.wetDryDelay) / Math.max(0.02, c.wetDryTime));
    _wet.recede = Easing.inQuad(dry);
    _wet.fade = 1;
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
    _wet.lift = c.wetLift;
    _wet.depth = c.wetDepth;
    _wet.detail = c.wetDetail;
    _wet.speed = c.wetSpeed;
    _wet.flow = c.wetFlow;
    _wet.windAngle = c.wetWindAngle;
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
    this.wet.setVisible(_wet.grow > 0.002 && _wet.recede < 0.999);
    this.wet.update(_wet);

    /* ---------------- the droplet flock ---------------- */
    // The lip in world space, this frame. `lipPosition` deliberately ignores
    // the chop and the ripples: droplets want to leave a clean moving line, and
    // sampling the full field jitters every emitter by the finest octave in it,
    // which reads as a fault in the emitter rather than as detail in the wave.
    this.surface.lipPosition(_liquid, _lip, 0);

    this.droplets.setBasis(this.origin, this.direction, this.side, Math.max(0.2, this.length));
    _drops.count = Math.min(MAX_DROPLETS, Math.round(c.dropCount * g.particleCount));
    _drops.leadMode = LeadPath.LINE;
    // The lead is the lip: `leadS` is where along the cast line it stands, and
    // the two heights are the lip's own height, so the flock's home is the
    // breaking edge and not a line drawn through the air near it.
    _drops.leadS = saturate(this._crestDistance() / Math.max(0.2, this.length));
    _drops.leadRate = 0;
    _drops.leadRise = c.dropRise;
    _drops.handForward = 0;
    _drops.handSide = 0;
    _drops.handHeight = _lip.y + c.dropLift;
    _drops.endHeight = _lip.y + c.dropLift;
    _drops.latticeX = c.dropLatticeX;
    _drops.latticeY = c.dropLatticeY;
    _drops.latticeZ = c.dropLatticeZ;
    _drops.spacingSide = c.dropSpacingSide;
    _drops.spacingUp = c.dropSpacingUp;
    _drops.lag = c.dropLag;
    _drops.jitter = c.dropJitter * g.randomness;
    _drops.churn = c.dropChurn;
    _drops.breathe = c.dropBreathe;
    _drops.breatheRate = c.dropBreatheRate;
    _drops.wander = c.dropWander * g.noiseStrength;
    _drops.wanderScale = c.dropWanderScale * g.noiseFrequency;
    _drops.wanderSpeed = c.dropWanderSpeed * g.noiseSpeed;
    _drops.gather = c.dropGather;
    _drops.size = c.dropSize * g.particleSize;
    _drops.aspect = c.dropAspect;
    _drops.sizeJitter = c.dropSizeJitter * g.randomness;
    _drops.billboard = c.dropBillboard;
    _drops.bank = c.dropBank;
    _drops.bankMax = c.dropBankMax;
    _drops.dihedral = 0;
    _drops.flapRate = 0;
    _drops.curl = c.dropCurl;
    _drops.edgeStretch = c.dropEdgeStretch;
    _drops.edgeGain = c.dropEdgeGain;
    // Droplets exist while the wave does. The reveal wave takes them out from
    // the back of the flock forward as the sheet drains, which reads as spray
    // falling out of the air rather than as the whole plume dimming at once.
    _drops.reveal = fade;
    _drops.revealSpread = c.dropRevealSpread;
    _drops.silhouette = Silhouette.DROPLET;
    _drops.lit = c.dropLit;
    _drops.tint = c.dropTint;
    _drops.tintJitter = c.dropTintJitter;
    _drops.tintAlong = c.dropTintAlong;
    _drops.opacity = c.dropOpacity * g.opacity;
    _drops.glow = c.dropGlow * g.glow;
    _drops.softFade = c.dropSoftFade;
    this.droplets.setColors(c.colorDropA, c.colorDropB, c.colorDropC, c.colorDropD);
    this.droplets.update(this.age, _drops);
    this._live = this.droplets.count;

    /* ---------------- the particle systems ---------------- */
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
    this.spray.uniforms.uGlow.value = 0.5 * g.glow;
    this.spray.uniforms.uTurbulence.value = 0.2 * g.turbulence;

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
    this.mist.uniforms.uTurbulence.value = c.mistTurbulence * g.turbulence;

    this.clots.setGradient(
      getColor(c.colorClotA),
      getColor(c.colorClotB),
      getColor(c.colorClotC),
      getColor(c.colorClotD)
    );
    this.clots.uniforms.uGravity.value.set(0, c.clotGravity, 0);
    this.clots.uniforms.uSizeScale.value = c.clotSize * g.particleSize * 7;
    this.clots.uniforms.uLifeScale.value = c.clotLifetime * 0.5 * g.particleLifetime;
    this.clots.uniforms.uSpeedScale.value = g.particleSpeed;
    this.clots.uniforms.uOpacity.value = g.opacity;
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Spray, mist and clots shed off the breaking lip.
   *
   * @param {number} dt    seconds
   * @param {number} scale 0..1 — thinned out once the wave is only draining
   */
  _tideFx(dt, scale) {
    const c = settings.crimsontide;
    const g = settings.global;
    const time = frame.uTime.value;

    let sprayCount = Math.round(this.sprayEmitter.tick(dt, c.sprayRate * scale) * g.particleCount);
    if (sprayCount > 0) {
      _emit.direction = _dir.copy(this.direction).multiplyScalar(0.7).setY(0.7).normalize();
      _emit.speed = c.spraySpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.7;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.1;
      _emit.sizeVariance = 0.75;
      _emit.life = c.sprayLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;

      // Split across the lip, never all from one point — see SPRAY_BATCHES.
      const batches = Math.min(sprayCount, SPRAY_BATCHES);
      const per = Math.ceil(sprayCount / batches);
      while (sprayCount > 0) {
        this.surface.lipPosition(_liquid, _pos, randRange(-1, 1));
        _emit.position = _pos;
        _emit.radius = c.spraySize * 2.5 + 0.08;
        this.spray.emit(Math.min(per, sprayCount), _emit);
        sprayCount -= per;
      }
    }

    const mistCount = Math.round(this.mistEmitter.tick(dt, c.mistRate * scale) * g.particleCount);
    if (mistCount > 0) {
      this.surface.lipPosition(_liquid, _pos, randRange(-0.8, 0.8));
      _emit.position = _pos;
      _emit.radius = c.sheetWidth * 0.22;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.mistSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 1.0;
      _emit.size = 0.7;
      _emit.sizeVariance = 0.5;
      _emit.life = c.mistLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.3;
      _emit.time = time;
      this.mist.emit(mistCount, _emit);
    }

    const clotCount = Math.round(this.clotEmitter.tick(dt, c.clotRate * scale) * g.particleCount);
    if (clotCount > 0) {
      // Clots come off the *back* of the crest, where the sheet is slowest and
      // the skin is already forming. Off the lip they read as more spray.
      this.pointAt(saturate(this._surge() - 0.12), _pos).setY(c.sheetHeight + 0.1);
      _emit.position = _pos;
      _emit.radius = c.sheetWidth * 0.3;
      _emit.direction = _dir.copy(this.direction).multiplyScalar(0.4).setY(1).normalize();
      _emit.speed = c.clotSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.85;
      _emit.size = 0.1;
      _emit.sizeVariance = 0.7;
      _emit.life = c.clotLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 6;
      _emit.time = time;
      this.clots.emit(clotCount, _emit);
    }
  }

  /**
   * The wet strip under the crest.
   *
   * Laid per *metre of front travel* rather than per second, so the trail has
   * the same spacing whatever `speed` is set to — a mark rate in Hz gives a
   * dotted line at 40 m/s and a solid smear at 4.
   */
  _slickFx() {
    const c = settings.crimsontide;
    const step = 1 / Math.max(0.05, c.slickRate);

    while (this.front - this._slickDistance >= step) {
      this._slickDistance += step;
      const s = saturate(this._slickDistance / this.length);
      this.pointAt(s, _pos);
      // Jittered across the line so the marks do not read as a row of coins.
      const wander = c.sheetWidth * 0.22;
      _pos.x += this.side.x * randRange(-wander, wander);
      _pos.z += this.side.z * randRange(-wander, wander);

      this.ctx.decals.spawn(DecalType.FOAM, _pos, {
        radius: c.slickRadius * randRange(0.75, 1.25),
        life: c.slickLife,
        intensity: c.slickIntensity,
        colorA: getColor(c.colorSlickA),
        colorB: getColor(c.colorSlickB),
        height: 0.014
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._sync(1);

    // The light rides the lip, not the floor under it.
    this.surface.lipPosition(_liquid, this.position, 0);

    this._tideFx(dt, 1);
    this._slickFx();

    this.ctx.shake.rumble(settings.crimsontide.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.crimsontide;
    const g = settings.global;
    const time = frame.uTime.value;

    this.surface.lipPosition(_liquid, _lip, 0);
    this.pointAt(1, _pos);

    /*
     * The sheet of blood thrown up where it dumps. `WATER` rather than `FIRE`:
     * that mode is a fresnel-heavy splash dome with almost no body, which is
     * the only one of the six that can be recoloured to blood without reading
     * as a fireball someone painted red.
     */
    this.ctx.bursts.spawn(BurstMode.WATER, _lip, {
      radius: c.burstSize * 0.25,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.6,
      intensity: c.burstIntensity,
      opacity: 0.85,
      fresnel: 1.4,
      displace: 0.7,
      squash: 0.55,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    /* the ring that runs out across the floor */
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _pos, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.55,
      width: 0.07,
      intensity: 0.8,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    /* a wide slick where the tide dumped */
    this.ctx.decals.spawn(DecalType.FOAM, _pos, {
      radius: c.slickRadius * 2.1,
      life: c.slickLife * 1.5,
      intensity: c.slickIntensity * 1.2,
      colorA: getColor(c.colorSlickA),
      colorB: getColor(c.colorSlickB),
      height: 0.015
    });

    /*
     * Ring the sheet. The packets are stored as *fractions* of the half-extents
     * plus a timestamp — never a metre — so a paused wave re-rings itself when
     * `sheetWidth` moves, which is the observable proof I1 is being kept here.
     */
    const packets = Math.max(0, Math.round(c.burstRipples));
    const frontU = _liquid.waveFront * 2 - 1;
    for (let i = 0; i < packets; i++) {
      this.surface.ripple(frontU, randRange(-0.8, 0.8), randRange(0.6, 1.2), this.age);
    }

    /* spray and clots thrown out of the break */
    _emit.position = _lip;
    _emit.radius = c.sheetWidth * 0.3;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.6).setY(0.8).normalize();
    _emit.speed = c.spraySpeed * 2.1;
    _emit.speedVariance = 0.85;
    _emit.spread = 0.95;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.13;
    _emit.sizeVariance = 0.8;
    _emit.life = c.sprayLifetime * 1.4;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.spray.emit(Math.round(c.burstSpray * g.particleCount), _emit);

    _emit.position = _pos;
    _emit.radius = c.sheetWidth * 0.35;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.35).setY(1).normalize();
    _emit.speed = c.clotSpeed * 1.7;
    _emit.size = 0.12;
    _emit.life = c.clotLifetime * 1.3;
    _emit.spin = 9;
    this.clots.emit(Math.round(c.burstClots * g.particleCount), _emit);

    _emit.speed = c.mistSpeed * 2.4;
    _emit.spread = 1.0;
    _emit.size = 1.2;
    _emit.life = c.mistLifetime * 1.2;
    _emit.spin = 0.4;
    this.mist.emit(Math.round(34 * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      18
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = settings.crimsontide.lightIntensity * 0.5 * g.explosionIntensity;
  }

  onFade(dt, t) {
    // `t` runs 0..1 while the crest breaks, then 1..2 while the sheet drains.
    // The drain is quadratic-in so the water hangs and then goes, rather than
    // dissolving at a constant rate — liquid leaves a floor all at once.
    const fade = t <= 1 ? 1 : 1 - Easing.inQuad(saturate(t - 1));
    this._sync(fade);

    this.surface.lipPosition(_liquid, this.position, 0);

    // The break is the loudest beat; the drain is nearly silent.
    this._tideFx(dt, t <= 1 ? 1.35 * (1 - 0.4 * (t - 0)) : fade * 0.22);
  }

  onDestroy() {
    this._live = 0;
    this.surface.reset();
    this.droplets.reset();
    this.wet.setVisible(false);
    this.wet.clearMarks();
  }

  dispose() {
    this.surface.dispose();
    this.wet.dispose();
    this.droplets.dispose();
    super.dispose();
  }
}
