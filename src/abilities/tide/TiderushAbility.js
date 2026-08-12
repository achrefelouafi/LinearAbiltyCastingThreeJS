import { Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { LiquidSurface, LiquidMode, liquidParams } from '../../vfx/LiquidSurface.js';
import { Caustics, CausticSource, CausticShape, causticsParams } from '../../vfx/Caustics.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, Easing, randRange } from '../../utils/math.js';

/**
 * How many points along the lip one frame's droplets are split between.
 *
 * A breaking wave sheds along the *whole* lip. Firing a frame's droplets from
 * one `across` reads as a hose pointed sideways — the same mistake the bolt's
 * sparks made before they were batched, and it is worth paying five emits a
 * frame to avoid it.
 */
const SPRAY_BATCHES = 5;

/* ---------------------------------------------------------------- */
/* Scratch — module scope (I3). Filled and consumed inside one call. */
/* ---------------------------------------------------------------- */

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _lip = new Vector3();
const _anchor = new Vector3();
const _netCentre = new Vector3();
const _up = new Vector3(0, 1, 0);

/** The two params blocks the shared modules read. Refilled every frame. */
const _liquid = liquidParams();
const _net = causticsParams();
_net.centre = _netCentre;

/**
 * TIDERUSH — a breaking wave that lights the floor through itself.
 *
 * Three beats: **surge**, **break**, **run-off**. A heightfield wave travels
 * down the aimed line, curls, dumps past the end of it and drains away. That
 * much is a wave. What makes it this ability is what happens on the *ground*.
 *
 * ## THE TRICK — the light on the floor is the wave, seen a second time
 *
 * `vfx/Caustics.js` is built to be driven rather than to animate itself, and
 * `bindSource()` is the whole hook: it swaps the net's uniform boxes for
 * `LiquidSurface`'s, **by identity**, so the swell, the chop, the crest profile
 * and every live ripple packet are one set of numbers with one author. The net
 * on the floor is then not a decal that happens to look wet — it is the image
 * of the surface above it, computed from the same height field the vertex
 * shader displaces the water with.
 *
 * The net is not drawn as a pattern. Light entering the surface at `xz` lands
 * on the floor at `A(xz) = xz − (1 − 1/ior)·D·∇h`, and its brightness there is
 * `1/|det J|` of that map: where the map **folds**, `det J` crosses zero and a
 * hairline filament appears. Two consequences fall out for free and they are
 * the reason this cast is worth casting:
 *
 *  - **The crest's face is the brightest thing on the floor.** The face is an
 *    exponential with a `crestFace`-metre decay length, so its second
 *    derivative is enormous and the fold term detonates along a line a metre or
 *    so *ahead* of the lip. Nothing tells it to be there.
 *  - **You read the water's thickness off the ground.** The net is attenuated
 *    by `exp(−absorb · (depth + h))` — the column of water over that floor
 *    point. Under the body of the wave that column is a metre deeper than it is
 *    on the face, so the ground goes dark under the mass and flares in the thin
 *    water in front of it. Set `netAbsorb` to 0 and the cast still renders
 *    perfectly; the ability is gone.
 *
 * `netDepthCrest` closes the loop by feeding the crest's *current* height back
 * into `D`, the lever arm of the fold, so the net sharpens as the wave stands
 * up and slackens as it collapses. That is one number and it does more for the
 * cast than any colour picker in the block.
 *
 * ## The handedness, which cost an afternoon
 *
 * The caustic quad is `vfx/quads.js`'s ground quad and its local frame
 * `(+X, +Y, +Z)` is right-handed. `LiquidSurface`'s frame is `(axisX, up,
 * cross(up, axisX))`, and `axisX × up = −axisZ` — it is **left**-handed. No
 * rotation about `Y` can align both, which means the fragment at surface
 * coordinate `(x, z)` is handed `(x, −z)` by the net, and the light on the
 * floor is the water's mirror image across the lane.
 *
 * The first version ignored this and it is not invisible: the grain of the net
 * leaned one way and the grain of the water leaned the other, and the whole
 * point of binding the two together quietly evaporated. The fix is not code, it
 * is authoring. The swell is written in **mirror pairs** — A/B and C/D at
 * `±angle` with equal amplitude, length and speed — and a wave set symmetric
 * about the lane is mapped onto itself by that mirror, so the net and the water
 * agree exactly. The crest is symmetric already. What is left is the chop
 * (isotropic noise: statistically identical either way, no systematic lean) and
 * the ripple packets, which is why `rippleSpan` defaults to a quarter and is
 * documented as the one term where the mirror is visible: a packet posted a
 * metre to the left of the lane rings the floor a metre to its right.
 *
 * ## The sheet is a window, not a canal
 *
 * `CrimsonTideAbility` re-cuts its plane to the whole run the surge has covered.
 * This one carries a **fixed-length window** of water, `sheetSpan` metres of it,
 * with the crest seated at a constant `crestSeat` fraction along it. The
 * consequence is worth stating: `waveFront` is a *constant*. The crest never
 * moves in the sheet's own coordinates — the sheet moves under the world — so
 * there is exactly `sheetSpan · (1 − crestSeat)` metres of water in front of
 * the lip at all times, which is the floor the caustics play on and the reason
 * the bright line ahead of the wave never runs out of water to be in.
 *
 * The tail is pinned `sheetTail` metres behind the caster until the window has
 * travelled far enough to unpin it, so the surge grows out of his feet instead
 * of appearing behind him. While it is pinned, `waveFront` is solved from the
 * window's real extent — the same solve `CrimsonTideAbility` does every frame,
 * for the same reason, and it is only interesting here for the first metre.
 *
 * ## Two things `LiquidSurface` does that water must be told not to do
 *
 * `crust` is never written, so the whole crust block — a flow field plus two
 * advected fbm phases, the most expensive thing in that fragment shader — is
 * skipped. But `meltGlow` and `seamGlow` are **not** gated by `crust`, and
 * `meltGlow` defaults to 1.2: with foam on (which computes a surface speed)
 * that term lights the entire sheet with `colorHot`, and a warm emissive haze
 * over cold water was the first thing this cast got wrong. Both are pinned to
 * zero by hand, in `_sync`, with this comment attached.
 *
 * ## What a cast captures
 *
 * One number — `_seed`, so two waves do not break identically — and timestamps.
 * Not a metre, not a radian, not a second. Pause with **P** mid-surge and drag
 * `netDepth`: the filaments on the floor tighten and separate into their red
 * and blue folds while the water above them does not move, because the net is
 * solved from the height field every frame rather than advanced.
 */
export class TiderushAbility extends Ability {
  constructor(context) {
    super('tiderush', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /*
     * 96 segments a side. Below about 48 the Gerstner cusps facet and the curl
     * turns into a chamfer; above 160 you are paying vertex cost for detail the
     * fragment normal already carries for nothing.
     */
    this.surface = new LiquidSurface({
      segments: 96,
      mode: LiquidMode.WAVE,
      depthWrite: true, //  a heightfield is a solid; its crest must hide its own back
      doubleSide: true, //  required the moment `crestCurl` folds the sheet over
      renderOrder: 8,
      name: 'Tiderush:sheet'
    });
    this.group.add(this.surface.object3D);

    /*
     * The net. `DISC` rather than `LANE`, and that is forced rather than
     * chosen: `LANE`'s envelope measures its front along the quad's local `+Z`,
     * while the bound height field has to be sampled with the quad's local `+X`
     * pointing downrange — the two cannot both be true, and sampling the wave
     * transposed draws the crest as a wall running *across* the lane. A disc is
     * rotationally symmetric, so it does not care which way the quad is turned,
     * and it is sized and centred on the travelling window every frame.
     */
    this.net = new Caustics(this.group, {
      source: CausticSource.WAVE,
      shape: CausticShape.DISC,
      additive: true,
      depthTest: true,
      renderOrder: 7,
      name: 'Tiderush:net'
    });
    // One height field, two consumers. Everything in `CAUSTIC_BOUND_KEYS` now
    // belongs to the surface and `Caustics#update` skips it.
    this.net.bindSource(this.surface.uniforms);

    /** Re-rolled per cast so no two waves break the same way. */
    this._seed = 0;
    /** Metres of front travel already paid out in floor marks. */
    this._wetDistance = 0;
    /** Live ripple packets, for the HUD readout. */
    this._packets = 0;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // The droplets thrown off the lip. Soft rounds, not streaks: a water bead
    // stretched along its velocity turns the whole plume into rain, and this
    // plume is being thrown rather than falling.
    this.spray = particles.get('tiderush.spray', {
      capacity: 2400,
      shape: ParticleShape.SOFT,
      additive: false,
      lit: true,
      softFade: 0.3
    });
    this.spray.uniforms.uDrag.value = 0.6;
    this.spray.uniforms.uEndSize.value = 0.5;
    this.spray.uniforms.uSizeIn.value = 0.03;
    this.spray.uniforms.uFadeIn.value = 0.04;
    this.spray.uniforms.uFadeOut.value = 0.5;

    // The haze standing over the break. Non-additive so it genuinely occludes
    // the sheet behind it — additive mist over dark water is a blue fog.
    this.mist = particles.get('tiderush.mist', {
      capacity: 1200,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.0
    });
    this.mist.uniforms.uDrag.value = 1.9;
    this.mist.uniforms.uEndSize.value = 2.4;
    this.mist.uniforms.uSizeIn.value = 0.14;
    this.mist.uniforms.uFadeIn.value = 0.2;
    this.mist.uniforms.uFadeOut.value = 0.35;

    // Glints: the airborne droplets that catch the same refracted light the
    // floor is catching. The only additive system in the cast, deliberately —
    // they are the one thing here that *is* light rather than water.
    this.glints = particles.get('tiderush.glints', {
      capacity: 1400,
      shape: ParticleShape.SOFT,
      additive: true,
      softFade: 0.2
    });
    this.glints.uniforms.uDrag.value = 0.9;
    this.glints.uniforms.uEndSize.value = 0.3;
    this.glints.uniforms.uSizeIn.value = 0.02;
    this.glints.uniforms.uFadeIn.value = 0.03;
    this.glints.uniforms.uFadeOut.value = 0.55;

    this.sprayEmitter = new RateEmitter();
    this.mistEmitter = new RateEmitter();
    this.glintEmitter = new RateEmitter();
    this.rippleEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Nothing here is instanced — a subdivided plane, a ground quad and three
   * particle systems. The honest readout is how many of the sheet's eight
   * ripple slots this cast has posted into, because that is the only thing in
   * the cast with a count, and it is also the number that says how much of the
   * net is being driven by impacts rather than by the swell.
   */
  get instanceCount() {
    return this._packets;
  }

  /** The crest pitches over and collapses. */
  get impactDuration() {
    return Math.max(0.05, settings.tiderush.breakTime * settings.global.lifetime);
  }

  /** Then it runs off the floor. */
  get fadeDuration() {
    return Math.max(0.05, settings.tiderush.drainTime);
  }

  /**
   * Water does not gutter. A slow swell at roughly the rate the longest wave
   * component runs at, so the wet floor breathes instead of sitting flat.
   */
  lightShimmer() {
    return 0.87 + 0.13 * Math.sin(this.age * 2.3);
  }

  /* ------------------------------------------------------------------ */
  /* The beats — pure functions of the phase clock and live settings      */
  /* ------------------------------------------------------------------ */

  /** 0..1 how far the crest has run down the line. */
  _surge() {
    return this.phase === AbilityPhase.TRAVEL ? this.u : 1;
  }

  /**
   * 0..1 through the break, and 0..1 through the run-off.
   *
   * Recovered from the phase clock rather than stored, so a mid-cast change to
   * `breakTime` re-times the beat it is in.
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
   * Three regimes and the middle one is the ability: on the way out it grows
   * over the first `crestRise` of the run, at the break it swells to
   * `crestPeak` and dumps, and through the run-off it is a dying swell. The
   * net reads this number twice — once as the height field it folds light
   * through, and once through `netDepthCrest` as the depth of water that light
   * is crossing.
   */
  _crestHeightNow() {
    const c = settings.tiderush;
    const brk = this._breakAmount();
    const drain = this._drainAmount();
    if (drain > 0) return c.crestHeight * 0.24 * (1 - Easing.outQuad(drain));
    if (brk > 0) {
      // Fast rise, slow dump: the lip is highest just as it pitches forward.
      const bump = Math.sin(Math.PI * Math.pow(brk, 0.8));
      return c.crestHeight * lerp(1, c.crestPeak, bump) * (1 - Easing.inQuad(brk) * 0.7);
    }
    const rise = saturate(this._surge() / Math.max(0.02, c.crestRise));
    return c.crestHeight * Easing.outCubic(rise);
  }

  /** Metres of forward throw per metre of height — the overhang. */
  _crestCurlNow() {
    const c = settings.tiderush;
    return c.crestCurl * lerp(1, c.crestCurlPeak, Easing.outCubic(this._breakAmount()));
  }

  /** 0..1 how ragged the lip is — it tears itself apart as it goes over. */
  _crestBreakNow() {
    const c = settings.tiderush;
    return Math.min(1, c.crestBreak * lerp(1, c.crestBreakPeak, Easing.outCubic(this._breakAmount())));
  }

  /** Metres down the line the crest stands, including its throw past the end. */
  _crestDistance() {
    const c = settings.tiderush;
    return this._surge() * this.length + c.crestOvershoot * Easing.outCubic(this._breakAmount());
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.sprayEmitter.reset();
    this.mistEmitter.reset();
    this.glintEmitter.reset();
    this.rippleEmitter.reset();
    this._wetDistance = 0;
    this._packets = 0;

    this.surface.clearRipples();
    this.net.reset();

    // The one thing a cast captures. Everything else is resolved per frame.
    this._seed = Math.random() * 100;

    this._sync(1);
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Re-resolve the window, the sheet and the net from live settings.
   *
   * Order matters in exactly one place: the surface is updated before the net,
   * because the net's params are read *after* the bound boxes have this frame's
   * numbers in them and because `_netCentre` has to be the window's centre for
   * this frame, not the last one. Everything the net is handed here is about
   * the light; everything about the water went in above it.
   *
   * @param {number} fade 1 while the wave stands, ramping to 0 as it runs off
   */
  _sync(fade) {
    const c = settings.tiderush;
    const g = settings.global;

    /* ---------------- the travelling window ---------------- */
    // Metres, measured this frame. `tail` is pinned behind the caster until the
    // window has run far enough for its own length to take over.
    const crest = this._crestDistance();
    const head = crest + c.sheetSpan * (1 - c.crestSeat);
    const tail = Math.max(crest - c.sheetSpan * c.crestSeat, -c.sheetTail);
    const span = Math.max(0.2, head - tail);

    _anchor
      .copy(this.origin)
      .addScaledVector(this.direction, (head + tail) * 0.5)
      .setY(c.sheetHeight);
    this.surface.setPlacement(_anchor, this.direction, _up);

    _liquid.sizeX = span;
    _liquid.sizeZ = Math.max(0.2, c.sheetWidth);
    // Solved rather than swept. Once the tail unpins this is exactly
    // `crestSeat` and stays there for the rest of the cast — the crest does not
    // move in the sheet's own coordinates, the sheet moves under the world.
    _liquid.waveFront = saturate((crest - tail) / span);
    _liquid.fill = c.sheetFill * lerp(1, 0.05, Easing.inQuad(this._drainAmount()));
    _liquid.round = c.sheetRound;
    _liquid.edgeSoft = c.sheetEdge;
    _liquid.edgeNoise = c.sheetRagged;
    _liquid.edgeScale = c.sheetRaggedScale;
    _liquid.seed = this._seed;
    _liquid.opacity = c.sheetOpacity * fade * g.opacity;
    _liquid.contactFade = c.contactFade;

    /* ---------------- the swell, in mirror pairs ---------------- */
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

    /* ---------------- the flow: foam, and nothing else ---------------- */
    _liquid.flowAngle = c.flowAngle;
    _liquid.flowSpeed = c.flowSpeed;
    _liquid.flowRadial = c.flowRadial;
    _liquid.flowRadialFall = c.flowRadialFall;
    _liquid.flowEddy = c.flowEddy;
    _liquid.flowEddyScale = c.flowEddyScale;
    _liquid.flowEddySpeed = c.flowEddySpeed;
    _liquid.flowGravity = c.flowGravity;

    _liquid.foam = c.foam;
    _liquid.foamScale = c.foamScale * g.noiseFrequency;
    _liquid.foamSharp = c.foamSharp;
    _liquid.foamCrest = c.foamCrest;
    _liquid.foamSpeed = c.foamSpeed;
    // The froth's speed gate. These two boxes are the crust's as well, and the
    // crust is off — see the header.
    _liquid.crustForm = c.foamGateLow;
    _liquid.crustBreak = Math.max(c.foamGateHigh, c.foamGateLow + 0.01);
    // Neither of these is gated by `crust`, and `meltGlow` defaults to 1.2.
    // Leave them alone and the whole sheet picks up a warm emissive haze the
    // moment foam asks for a surface speed. Water is not lit from inside.
    _liquid.meltGlow = 0;
    _liquid.seamGlow = 0;

    /* ---------------- the crest ---------------- */
    const crestHeight = this._crestHeightNow();
    _liquid.crestHeight = crestHeight;
    _liquid.crestBack = c.crestBack;
    _liquid.crestFace = c.crestFace;
    _liquid.crestCurl = this._crestCurlNow();
    _liquid.crestWidth = c.crestWidth;
    _liquid.crestFeather = c.crestFeather;
    _liquid.crestBreak = this._crestBreakNow();
    _liquid.crestBreakScale = c.crestBreakScale * g.noiseFrequency;

    /* ---------------- shading ---------------- */
    _liquid.poolDepth = c.poolDepth;
    _liquid.depthTint = c.depthTint;
    _liquid.translucency = c.translucency;
    _liquid.ambient = c.ambient;
    _liquid.specular = c.specular;
    _liquid.shininess = c.shininess;
    _liquid.fresnel = c.fresnel * g.fresnel;
    _liquid.envIntensity = c.envIntensity;
    _liquid.skyIntensity = c.skyIntensity;
    _liquid.glow = c.glow * g.glow;
    _liquid.normalEps = c.normalEps;
    _liquid.colorDeep = c.colorDeep;
    _liquid.colorShallow = c.colorShallow;
    _liquid.colorFoam = c.colorFoam;
    _liquid.colorSpec = c.colorSpec;
    _liquid.colorSky = c.colorSky;

    this.surface.visible = _liquid.opacity > 0.002;
    this.surface.update(this.age, _liquid);

    /* ---------------- the net ---------------- */
    // Centred on the window, in the window's own frame. The yaw is *not* the
    // usual `atan2(direction.x, direction.z)`: it is chosen so the quad's local
    // +X lies along the sheet's `axisX`, because the bound height field is
    // sampled in the sheet's parametric metres and nothing else lines those two
    // up. See the handedness note in the class comment for what the remaining
    // sign costs and how it is paid for.
    _netCentre.copy(_anchor).setY(0);
    _net.yaw = Math.atan2(-this.direction.z, this.direction.x);
    _net.height = c.netHeight;
    // A disc measured in the sheet's frame, sized off the water's half-width so
    // the pool of light stops where the water does. See the settings note.
    _net.radius = Math.max(0.2, c.sheetWidth * 0.5 * c.netReach);
    _net.fade = fade;
    // `depth` is the lever arm of the fold, and the crest is the water the
    // light actually crosses — so the net sharpens as the wave stands up.
    _net.depth = c.netDepth + c.netDepthCrest * crestHeight;
    _net.ior = c.netIor;
    _net.dispersion = c.netDispersion;
    _net.sampleStep = c.netStep;
    _net.absorb = c.netAbsorb;
    _net.foldFloor = c.netFoldFloor;
    _net.threshold = c.netThreshold;
    // The collapse folds the surface harder than anything else in the cast, so
    // the floor is allowed to flare with it.
    _net.gain = c.netGain * lerp(1, c.netBreakGain, Easing.outQuad(this._breakAmount()) * (1 - this._drainAmount()));
    _net.sharpness = c.netSharp;
    _net.rolloff = c.netRolloff;
    _net.penumbra = c.netPenumbra;
    _net.wash = c.netWash;
    _net.fringeAt = c.netFringeAt;
    _net.emissive = c.netEmissive;
    _net.opacity = c.netOpacity;
    _net.depthFade = c.netDepthFade;
    _net.additive = true;
    _net.colorNet = c.colorNet;
    _net.colorFringe = c.colorFringe;
    _net.colorWash = c.colorWash;
    _net.noiseStrength = g.noiseStrength;
    _net.noiseFrequency = g.noiseFrequency;
    _net.noiseSpeed = g.noiseSpeed;
    _net.opacityScale = g.opacity;
    this.net.setVisible(fade > 0.002);
    this.net.update(_net);

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
    this.spray.uniforms.uGlow.value = 0.4 * g.glow;
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

    this.glints.setGradient(
      getColor(c.colorGlintA),
      getColor(c.colorGlintB),
      getColor(c.colorGlintC),
      getColor(c.colorGlintD)
    );
    this.glints.uniforms.uGravity.value.set(0, c.glintGravity, 0);
    this.glints.uniforms.uSizeScale.value = c.glintSize * g.particleSize * 7;
    this.glints.uniforms.uLifeScale.value = c.glintLifetime * 0.5 * g.particleLifetime;
    this.glints.uniforms.uSpeedScale.value = g.particleSpeed;
    this.glints.uniforms.uOpacity.value = g.opacity;
    this.glints.uniforms.uGlow.value = c.glintGlow * g.glow;
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Droplets, mist and glints off the lip, and the ripple packets the lip
   * leaves in the water behind it.
   *
   * The packets are the one place the cast writes into a box the net is also
   * reading: `LiquidSurface#ripple` stores a *fraction, a timestamp and a
   * strength*, `Caustics` has bound that array, and the ring that appears on
   * the water and the ring that appears on the floor are therefore the same
   * eight numbers. Posting them from here — rather than only at the break — is
   * what keeps the net alive while the wave is still travelling.
   *
   * @param {number} dt    seconds
   * @param {number} scale 0..1 — thinned out once the wave is only running off
   */
  _tideFx(dt, scale) {
    const c = settings.tiderush;
    const g = settings.global;
    const time = frame.uTime.value;

    let sprayCount = Math.round(this.sprayEmitter.tick(dt, c.sprayRate * scale) * g.particleCount);
    if (sprayCount > 0) {
      _emit.direction = _dir.copy(this.direction).multiplyScalar(0.75).setY(0.65).normalize();
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

      // Split along the lip, never all from one point — see SPRAY_BATCHES.
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

    const glintCount = Math.round(this.glintEmitter.tick(dt, c.glintRate * scale) * g.particleCount);
    if (glintCount > 0) {
      this.surface.lipPosition(_liquid, _pos, randRange(-1, 1));
      _emit.position = _pos;
      _emit.radius = c.sheetWidth * 0.12;
      _emit.direction = _dir.copy(this.direction).multiplyScalar(0.5).setY(0.85).normalize();
      _emit.speed = c.glintSpeed;
      _emit.speedVariance = 0.85;
      _emit.spread = 0.9;
      _emit.size = 0.07;
      _emit.sizeVariance = 0.8;
      _emit.life = c.glintLifetime;
      _emit.lifeVariance = 0.6;
      _emit.spin = 0;
      _emit.time = time;
      this.glints.emit(glintCount, _emit);
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

    // The lip smacking the water behind it. `waveFront` is already a 0..1
    // fraction of the sheet, so the packet's `u` is one subtraction away and no
    // metre is involved anywhere.
    const packets = this.rippleEmitter.tick(dt, c.rippleRate * scale);
    for (let i = 0; i < packets; i++) {
      const u = _liquid.waveFront * 2 - 1;
      this.surface.ripple(u, randRange(-c.rippleSpan, c.rippleSpan), randRange(0.5, 1.1), this.age);
    }
    if (packets > 0) this._packets = Math.min(8, this._packets + packets);
  }

  /**
   * The wet strip the wave leaves behind it.
   *
   * Laid per *metre of front travel* rather than per second, so the trail has
   * the same spacing whatever `speed` is set to — a mark rate in Hz gives a
   * dotted line at 40 m/s and a solid smear at 4.
   */
  _wetFx() {
    const c = settings.tiderush;
    const step = 1 / Math.max(0.05, c.wetRate);

    while (this.front - this._wetDistance >= step) {
      this._wetDistance += step;
      const s = saturate(this._wetDistance / this.length);
      this.pointAt(s, _pos);
      // Jittered across the line so the marks do not read as a row of coins.
      const wander = c.sheetWidth * 0.2;
      _pos.x += this.side.x * randRange(-wander, wander);
      _pos.z += this.side.z * randRange(-wander, wander);

      this.ctx.decals.spawn(DecalType.FOAM, _pos, {
        radius: c.wetRadius * randRange(0.75, 1.25),
        life: c.wetLife,
        intensity: c.wetIntensity,
        colorA: getColor(c.colorWetA),
        colorB: getColor(c.colorWetB),
        height: 0.013
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
    this._wetFx();

    this.ctx.shake.rumble(settings.tiderush.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.tiderush;
    const g = settings.global;
    const time = frame.uTime.value;

    this.surface.lipPosition(_liquid, _lip, 0);
    this.pointAt(1, _pos);

    /*
     * The sheet of water thrown up where it dumps. `WATER` rather than `FIRE`:
     * that mode is a fresnel-heavy splash dome with almost no body, which is
     * the only one of the six that does not read as a fireball someone has
     * painted blue.
     */
    this.ctx.bursts.spawn(BurstMode.WATER, _lip, {
      radius: c.burstSize * 0.25,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.6,
      intensity: c.burstIntensity,
      opacity: 0.85,
      fresnel: 1.5,
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
      width: 0.06,
      intensity: 0.9,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    /* the tide line where it dumped */
    this.ctx.decals.spawn(DecalType.FOAM, _pos, {
      radius: c.wetRadius * 2.1,
      life: c.wetLife * 1.5,
      intensity: c.wetIntensity * 1.2,
      colorA: getColor(c.colorWetA),
      colorB: getColor(c.colorWetB),
      height: 0.014
    });

    /*
     * Ring the sheet hard. The packets are fractions plus a timestamp, never a
     * metre, and the net has bound the same array — so the rings that spread
     * across the water and the rings that spread across the floor are one set
     * of eight numbers arriving in both shaders at once. This is the frame the
     * trick is most obvious on.
     */
    const packets = Math.max(0, Math.round(c.burstRipples));
    const frontU = _liquid.waveFront * 2 - 1;
    for (let i = 0; i < packets; i++) {
      this.surface.ripple(frontU, randRange(-c.rippleSpan, c.rippleSpan), randRange(0.7, 1.3), this.age);
    }
    this._packets = Math.min(8, this._packets + packets);

    /* droplets and glints thrown out of the collapse */
    _emit.position = _lip;
    _emit.radius = c.sheetWidth * 0.28;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.6).setY(0.8).normalize();
    _emit.speed = c.spraySpeed * 2.1;
    _emit.speedVariance = 0.85;
    _emit.spread = 0.95;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.12;
    _emit.sizeVariance = 0.8;
    _emit.life = c.sprayLifetime * 1.4;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.spray.emit(Math.round(c.burstSpray * g.particleCount), _emit);

    _emit.speed = c.glintSpeed * 2.4;
    _emit.size = 0.08;
    _emit.life = c.glintLifetime * 1.3;
    this.glints.emit(Math.round(c.burstGlints * g.particleCount), _emit);

    _emit.position = _pos;
    _emit.radius = c.sheetWidth * 0.32;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.mistSpeed * 2.4;
    _emit.spread = 1.0;
    _emit.size = 1.1;
    _emit.life = c.mistLifetime * 1.2;
    _emit.spin = 0.4;
    this.mist.emit(Math.round(36 * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      18
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.5 * g.explosionIntensity;
  }

  onFade(dt, t) {
    // `t` runs 0..1 while the crest breaks, then 1..2 while the sheet runs off.
    // Quadratic-in, so the water hangs and then goes rather than dissolving at
    // a constant rate — liquid leaves a floor all at once.
    const fade = t <= 1 ? 1 : 1 - Easing.inQuad(saturate(t - 1));
    this._sync(fade);

    this.surface.lipPosition(_liquid, this.position, 0);

    // The break is the loudest beat; the run-off is nearly silent.
    this._tideFx(dt, t <= 1 ? 1.3 - 0.4 * t : fade * 0.2);
  }

  onDestroy() {
    this._packets = 0;
    this.surface.reset();
    this.net.clearRipples();
    this.net.setVisible(false);
  }

  dispose() {
    this.surface.dispose();
    this.net.dispose();
    super.dispose();
  }
}
