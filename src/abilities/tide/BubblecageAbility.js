import { Mesh, Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { createThinFilmMaterial, createBubbleGeometry } from '../../materials/ThinFilmMaterial.js';
import { Shell, ShellMode } from '../../vfx/Shell.js';
import { GroundField, GroundMode, groundFieldParams } from '../../vfx/GroundField.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, randRange } from '../../utils/math.js';

const TAU = Math.PI * 2;
/**
 * The golden angle, which is the whole reason the cage looks *woven* rather
 * than gridded. A Fibonacci lattice spaces N points on a sphere with no seam,
 * no pole and no repeating row; a latitude/longitude grid — the first version —
 * piles half the bubbles onto the two poles and leaves a visible ladder of
 * meridians down the sides.
 */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** Hard ceiling on bubbles. The editor's `bubbles` slider clamps here. */
const MAX_BUBBLES = 64;

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _centre = new Vector3();
const _ground = groundFieldParams();

/**
 * ABYSSAL CAGE — a far cast whose colour is a **measurement**.
 *
 * A bell of black water heaves out of the circle, and what it leaves standing
 * is a cage of soap film: thirty-odd bubbles interlocked on a squashed sphere
 * around the footprint, draining, marbling, and bursting one at a time from
 * their own crowns.
 *
 * ## THE TRICK — thin-film interference, actually computed
 *
 * Every other iridescent surface in this project — and every one I have seen
 * shipped anywhere — gets its rainbow from a fresnel term indexing a hand-drawn
 * gradient. That is a perfectly good effect and it is not this. Here the hue of
 * a pixel of film comes from that film's **thickness** against the **view
 * angle**: the two reflections (front face, back face) differ in optical path
 * by `Δ = 2·n·d·cos θₜ`, plus the half-wave the hard front reflection adds, and
 * the resulting spectrum `I(λ) = ½ − ½cos(2πΔ/λ)` is integrated across the
 * visible band against the CIE colour matching functions and converted to sRGB.
 * `materials/ThinFilmMaterial.js` has the derivation.
 *
 * Three things fall out of that which no ramp gives you, and they are the
 * reason it was worth doing:
 *
 *  - **the bands are in the right order.** Gold, magenta, blue, silver, going
 *    up a draining bubble. Nobody authored the sequence; it is what a film that
 *    thickness does.
 *  - **the bands crowd toward the silhouette**, because a grazing ray travels
 *    further through the film. A fresnel ramp does the opposite — it puts one
 *    band *on* the silhouette and nothing anywhere else.
 *  - **the crown goes black before it bursts.** Below a quarter-wave every
 *    wavelength cancels, because of the half-wave shift. The first version of
 *    the shader left the `π` out and a thinning film went brilliant white,
 *    which turns out to be the single most obviously wrong thing a bubble can
 *    do.
 *
 * ## What the rest of it is
 *
 * `vfx/Shell.js` in `DOME` mode is the water bell (1 draw call); one instanced
 * sphere carries every bubble (1); `vfx/GroundField.js` in `POOL` mode is the
 * standing water underneath (1). Three draw calls for the cast. The bubbles are
 * placed **entirely in the vertex shader** from uniforms — there is no
 * `instanceMatrix` anywhere in this ability — so pausing and dragging
 * `cageRadius` genuinely re-hangs a standing cage.
 *
 * ## The rupture, and why it is not a fade
 *
 * A film does not dim. A hole opens at the thinnest point and its rim retracts
 * across the bubble in milliseconds, dragging the film into itself. So the
 * fragment shader cuts an angular cap around a per-bubble rupture direction and
 * lights the band just outside it. Fading alpha instead — the first attempt —
 * reads as thirty bubbles being switched off, which is somehow *less*
 * convincing than one bubble popping.
 *
 * ## What a cast captures
 *
 * One seed, and four unitless dice per bubble: a direction on the cage, a size
 * fraction, a decorrelation seed and a pop roll. Not one metre, radian, second
 * or nanometre. The pop **latch** is re-armable exactly the way Thunderclap's
 * boom is — the deadline is recomputed from live settings every frame, so
 * dragging `popTime` backward with the clock stopped un-pops bubbles and
 * dragging it forward pops them, rather than firing once and never again.
 */
export class BubblecageAbility extends Ability {
  constructor(context) {
    super('bubblecage', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /* --- beat 1: the water bell --- */
    this.bell = new Shell({ mode: ShellMode.DOME, prefix: 'bell', nodes: 40, sides: 52 });
    this.group.add(this.bell.group);

    /* --- the cage itself: one instanced sphere, one draw call --- */
    this.filmGeometry = createBubbleGeometry(MAX_BUBBLES, 26, 18);
    this.filmMaterial = createThinFilmMaterial();
    this.filmMesh = new Mesh(this.filmGeometry, this.filmMaterial);
    this.filmMesh.frustumCulled = false;
    this.filmMesh.matrixAutoUpdate = false;
    this.filmMesh.layers.set(LAYER.VFX);
    this.filmMesh.renderOrder = 13;
    this.group.add(this.filmMesh);

    /* --- the standing water it is all sitting in --- */
    this.pool = new GroundField(this.group, {
      mode: GroundMode.POOL,
      depthTest: true,
      name: 'bubblecage.pool'
    });

    /** Re-rolled per cast so two cages are not the same weave. */
    this._seed = 0;
    /** How many bubbles this cast planted. */
    this._count = 0;

    /* --- the per-bubble dice, allocated once (I3) --- */
    /** Unit directions on the cage sphere, packed xyz. Unitless. */
    this._dirs = new Float32Array(MAX_BUBBLES * 3);
    /** Decorrelation seeds, 0..1. */
    this._seeds = new Float32Array(MAX_BUBBLES);
    /** Size fractions. Unitless — the metre is `bubbleRadius`. */
    this._scales = new Float32Array(MAX_BUBBLES);
    /** Where in `popSpread` each bubble's deadline sits, 0..1. */
    this._pops = new Float32Array(MAX_BUBBLES);
    /** Re-armable latch: has this one burst *as of this frame*. */
    this._burst = new Uint8Array(MAX_BUBBLES);

    // Scratch handed to the bell each frame. One object, reused.
    this._state = {
      origin: new Vector3(),
      axis: new Vector3(0, 1, 0),
      side: new Vector3(1, 0, 0),
      span: 0,
      t: 0,
      fade: 1,
      seed: 0
    };
    // ...and to the film.
    this._film = { centre: new Vector3(), age: 0, seed: 0, fade: 1, collapse: 0 };
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Droplets flung off a bursting film. Lit rather than additive: water
    // catches the key light, it does not emit. An additive droplet is a spark,
    // and thirty sparks coming off a bubble reads as an explosion.
    this.drops = particles.get('bubblecage.drops', {
      capacity: 2400,
      shape: ParticleShape.SOFT,
      additive: false,
      lit: true,
      softFade: 0.2
    });
    this.drops.uniforms.uDrag.value = 0.9;
    this.drops.uniforms.uEndSize.value = 0.5;
    this.drops.uniforms.uSizeIn.value = 0.04;
    this.drops.uniforms.uFadeIn.value = 0.05;
    this.drops.uniforms.uFadeOut.value = 0.5;

    // The haze the bell throws up and the bursts keep topping up.
    this.mist = particles.get('bubblecage.mist', {
      capacity: 1800,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.0
    });
    this.mist.uniforms.uDrag.value = 2.4;
    this.mist.uniforms.uEndSize.value = 2.6;
    this.mist.uniforms.uSizeIn.value = 0.12;
    this.mist.uniforms.uFadeIn.value = 0.18;
    this.mist.uniforms.uFadeOut.value = 0.35;

    // Fizz: the small bubbles running up the inside of the cage. Additive,
    // because these *are* little films and the whole school is lit from below.
    this.fizz = particles.get('bubblecage.fizz', {
      capacity: 1600,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.3
    });
    this.fizz.uniforms.uDrag.value = 1.1;
    this.fizz.uniforms.uEndSize.value = 1.4;
    this.fizz.uniforms.uSizeIn.value = 0.1;
    this.fizz.uniforms.uFadeIn.value = 0.1;
    this.fizz.uniforms.uFadeOut.value = 0.45;

    this.dropEmitter = new RateEmitter();
    this.mistEmitter = new RateEmitter();
    this.fizzEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing — every beat re-resolved every frame                         */
  /* ------------------------------------------------------------------ */

  /** Beat 1, seconds: the water bell heaving up and going again. */
  _bellSpan() {
    return Math.max(0.02, settings.bubblecage.bellTime * settings.global.lifetime);
  }

  /** Beat 2, seconds: the cage standing. */
  _holdSpan() {
    return Math.max(0.05, settings.bubblecage.holdTime * settings.global.lifetime);
  }

  get impactDuration() {
    return this._bellSpan() + this._holdSpan();
  }

  get fadeDuration() {
    return Math.max(0.05, settings.bubblecage.fadeTime);
  }

  /** Bubbles still standing. HUD readout only. */
  get instanceCount() {
    let live = 0;
    for (let i = 0; i < this._count; i++) if (!this._burst[i]) live++;
    return live;
  }

  /**
   * Seconds since the bell landed.
   *
   * Deliberately not the `t` the base class hands `onFade`: that was divided by
   * an `impactDuration` which is two sliders, either of which may move under a
   * standing cage. Rebuilding the local clock from `impactTime` and the live
   * spans is what lets a paused `holdTime` drag walk the cage through its own
   * life, forward and backward.
   */
  _clock() {
    if (this.phase === AbilityPhase.FADE) return this.impactDuration + this.fadeTime;
    if (this.phase === AbilityPhase.TRAVEL) return 0;
    return this.impactTime;
  }

  /** 0 while the cage stands, ramping to 1 as the fade hauls the deadlines in. */
  _collapse() {
    if (this.phase !== AbilityPhase.FADE) return 0;
    return saturate(this.fadeTime / this.fadeDuration);
  }

  /**
   * A soft swell rather than a flicker: water does not gutter, it heaves. Keyed
   * off two incommensurate rates so it never settles into a visible period.
   */
  lightShimmer() {
    const c = settings.bubblecage;
    return 1 - saturate(c.cageBreathe * 4) * (0.5 - 0.5 * Math.cos(this.age * TAU * c.cageBreatheSpeed));
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  /** Where the cage hangs, world space. */
  _cageCentre(out) {
    const c = settings.bubblecage;
    this.pointAt(1, out);
    // Seated so the bottom of the squashed sphere just touches the stone.
    out.y = c.zoneRadius * c.cageRadius * c.cageSquash + c.cageLift;
    return out;
  }

  /**
   * The centre of bubble `i`, world space.
   *
   * A deliberate duplication of the placement in `FILM_VERTEX`, for the same
   * reason `Tube` mirrors its own axis in JS: reading it back off the GPU is a
   * pipeline stall, and this is queried once per burst. What is **not**
   * mirrored is the jostle noise — the JS side returns the mean position. A
   * droplet spray placed on the noisy position jitters against the bubble it
   * came off, and the wobble is centimetres.
   */
  _bubblePoint(index, out) {
    const c = settings.bubblecage;
    const radius = c.zoneRadius * c.cageRadius;
    const seed = this._seeds[index];
    const breathe = 1 + c.cageBreathe * Math.sin(this._clock() * TAU * c.cageBreatheSpeed + seed * TAU + this._seed);

    this._cageCentre(out);
    const k = radius * breathe;
    out.x += this._dirs[index * 3] * k;
    out.y += this._dirs[index * 3 + 1] * k * c.cageSquash;
    out.z += this._dirs[index * 3 + 2] * k;
    return out;
  }

  /** Seconds after the cage was raised at which bubble `i` gives way. */
  _popDeadline(index) {
    const c = settings.bubblecage;
    const born = this._seeds[index] * Math.max(0, c.bubbleStagger);
    const collapse = this._collapse();
    const life = Math.max(0.05, c.popTime * (1 - c.popCollapse * collapse));
    return born + life + this._pops[index] * c.popSpread * (1 - collapse);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Roll the cage. The only dice this ability throws, and none of them has a
   * unit: a direction, a size fraction, a decorrelation seed and a pop roll.
   */
  _plant() {
    const c = settings.bubblecage;
    const count = Math.max(1, Math.min(MAX_BUBBLES, Math.round(c.bubbles)));
    const scatter = saturate(c.bubbleScatter) * settings.global.randomness;
    // One rotation for the whole lattice, so two casts do not weave identically
    // while each one stays evenly spaced.
    const phase = Math.random() * TAU;

    for (let i = 0; i < count; i++) {
      const y = 1 - ((i + 0.5) * 2) / count;
      const ring = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = i * GOLDEN_ANGLE + phase;
      this._dirs[i * 3] = Math.cos(theta) * ring;
      this._dirs[i * 3 + 1] = y;
      this._dirs[i * 3 + 2] = Math.sin(theta) * ring;

      this._seeds[i] = Math.random();
      this._scales[i] = 1 + randRange(-scatter, scatter);
      this._pops[i] = Math.random();
      this._burst[i] = 0;
    }

    const attributes = this.filmGeometry.attributes;
    attributes.aDir.array.set(this._dirs.subarray(0, count * 3));
    attributes.aSeed.array.set(this._seeds.subarray(0, count));
    attributes.aScale.array.set(this._scales.subarray(0, count));
    attributes.aPop.array.set(this._pops.subarray(0, count));
    attributes.aDir.needsUpdate = true;
    attributes.aSeed.needsUpdate = true;
    attributes.aScale.needsUpdate = true;
    attributes.aPop.needsUpdate = true;

    this._count = count;
    this.filmGeometry.instanceCount = 0; //  nothing is drawn until the bell lands
  }

  onSpawn() {
    this.dropEmitter.reset();
    this.mistEmitter.reset();
    this.fizzEmitter.reset();

    // The one thing a cast captures that is not per-bubble, and it is unitless.
    this._seed = Math.random() * 100;

    this._plant();
    this.bell.visible = true;
    this.pool.setVisible(false);
    this._sync(0);
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings into all three renderers.
   *
   * The film's uniforms are written on *every* frame, travel included, even
   * though nothing is drawn yet — an instance count of zero costs nothing to
   * update, and it means `filmThickness` is a live slider during the wind-up as
   * well as during the hold, which is what you want when you are tuning a
   * quarter-second beat by dragging it.
   *
   * @param {number} fade 0..1 master on everything the cast draws
   */
  _sync(fade) {
    const c = settings.bubblecage;
    const g = settings.global;

    /* --- the cage --- */
    this._cageCentre(this._film.centre);
    this._film.age = this._clock();
    this._film.seed = this._seed;
    this._film.fade = fade;
    this._film.collapse = this._collapse();
    this.filmMaterial.userData.sync(this._film);

    /* --- the pool it stands in --- */
    const local = this._clock();
    _ground.centre = this.pointAt(1, _pos);
    _ground.yaw = Math.atan2(this.direction.x, this.direction.z);
    _ground.height = c.poolHeight;
    _ground.radius = Math.max(0.05, c.zoneRadius * c.poolRadius);
    _ground.grow = saturate(local / Math.max(0.02, c.poolGrow));
    _ground.recede = this._collapse() * saturate(c.poolDry);
    _ground.fade = fade;
    _ground.seed = this._seed;
    _ground.edge = c.poolEdge;
    _ground.ragged = c.poolRagged;
    _ground.raggedScale = c.poolRaggedScale * g.noiseFrequency;
    _ground.warp = c.poolWarp * g.noiseStrength;
    _ground.relief = c.poolRelief;
    _ground.normalStep = c.poolNormalStep;
    _ground.ambient = c.poolAmbient;
    _ground.wrap = c.poolWrap;
    _ground.specular = c.poolSpecular;
    _ground.gloss = c.poolGloss;
    _ground.cell = c.poolCell * g.noiseFrequency;
    _ground.depth = c.poolDepth;
    _ground.lift = c.poolLift;
    _ground.thickness = c.poolThickness;
    _ground.detail = c.poolDetail;
    _ground.flow = c.poolFlow;
    _ground.speed = c.poolSpeed * g.noiseSpeed;
    _ground.windAngle = c.poolWind;
    _ground.emissive = c.poolEmissive;
    _ground.opacity = c.poolOpacity;
    _ground.opacityScale = g.opacity;
    _ground.noiseStrength = g.noiseStrength;
    _ground.noiseFrequency = g.noiseFrequency;
    _ground.noiseSpeed = g.noiseSpeed;
    _ground.colorBase = c.colorPoolBase;
    _ground.colorEdge = c.colorPoolEdge;
    _ground.colorGlow = c.colorPoolGlow;
    _ground.colorDeep = c.colorPoolDeep;
    this.pool.update(_ground);

    /* --- the three particle systems --- */
    this.drops.setGradient(
      getColor(c.colorDropA),
      getColor(c.colorDropB),
      getColor(c.colorDropC),
      getColor(c.colorDropD)
    );
    this.drops.uniforms.uGravity.value.set(0, c.dropGravity, 0);
    this.drops.uniforms.uSizeScale.value = c.dropSize * g.particleSize * 7;
    this.drops.uniforms.uLifeScale.value = c.dropLifetime * 0.5 * g.particleLifetime;
    this.drops.uniforms.uSpeedScale.value = g.particleSpeed;
    this.drops.uniforms.uOpacity.value = g.opacity;

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
    this.mist.uniforms.uTurbulence.value = 0.3 * g.turbulence;

    this.fizz.setGradient(
      getColor(c.colorFizzA),
      getColor(c.colorFizzB),
      getColor(c.colorFizzC),
      getColor(c.colorFizzD)
    );
    this.fizz.uniforms.uGravity.value.set(0, c.fizzRise, 0);
    this.fizz.uniforms.uSizeScale.value = c.fizzSize * g.particleSize * 7;
    this.fizz.uniforms.uLifeScale.value = c.fizzLifetime * 0.5 * g.particleLifetime;
    this.fizz.uniforms.uSpeedScale.value = g.particleSpeed;
    this.fizz.uniforms.uOpacity.value = g.opacity;
    this.fizz.uniforms.uGlow.value = 1.1 * g.glow;
    this.fizz.uniforms.uTurbulence.value = c.fizzTurbulence * g.turbulence;
  }

  /**
   * The bell, wherever it currently is and however far through beat 1 it is.
   *
   * @param {THREE.Vector3} at where the hemisphere is seated
   * @param {number} t 0..1 through its heave
   * @param {number} fade 0..1 master
   */
  _syncBell(at, t, fade) {
    const state = this._state;
    state.origin.copy(at);
    state.origin.y = 0;
    state.axis.set(0, 1, 0);
    state.side.copy(this.side);
    state.t = saturate(t);
    state.fade = saturate(fade);
    state.seed = this._seed;
    this.bell.sync(settings.bubblecage, state, settings.global);
  }

  /* ------------------------------------------------------------------ */
  /* The rupture                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Walk the cage and fire whatever has crossed its deadline this frame.
   *
   * The latch is re-armed on the way *back*, which is the whole reason the
   * deadline is recomputed rather than stored: with the clock stopped, dragging
   * `popTime` up un-bursts the bubbles that had gone and dragging it down
   * bursts the ones that had not. The shader is reading the same numbers from
   * the same uniforms, so the two never disagree about which bubbles are
   * standing.
   */
  _rupture() {
    for (let i = 0; i < this._count; i++) {
      const gone = this._clock() >= this._popDeadline(i);
      if (gone === Boolean(this._burst[i])) continue;
      if (!gone) {
        this._burst[i] = 0;
        continue;
      }
      this._burst[i] = 1;
      this._burstFx(i);
    }
  }

  /** One bubble giving way: droplets, a puff, and a foam mark under it. */
  _burstFx(index) {
    const c = settings.bubblecage;
    const g = settings.global;
    const time = frame.uTime.value;
    const radius = c.zoneRadius * c.bubbleRadius * this._scales[index];

    this._bubblePoint(index, _pos);

    _emit.position = _pos;
    _emit.radius = radius * 0.85;
    // Outward from the cage centre — a film retracts into its own rim and
    // throws what it was carrying along the surface it used to be.
    _emit.direction = _dir.copy(_pos).sub(this._cageCentre(_centre)).normalize();
    _emit.speed = c.dropSpeed;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.95;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.12;
    _emit.sizeVariance = 0.7;
    _emit.life = c.dropLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.drops.emit(Math.round(c.popDroplets * g.particleCount), _emit);

    _emit.speed = c.mistSpeed * 1.6;
    _emit.spread = 1.0;
    _emit.size = 0.5;
    _emit.life = c.mistLifetime;
    _emit.spin = 0.3;
    this.mist.emit(Math.round(c.popMist * g.particleCount), _emit);

    // The foam it leaves on the water directly underneath.
    _pos.y = 0;
    this.ctx.decals.spawn(DecalType.FOAM, _pos, {
      radius: c.popFoamRadius * randRange(0.75, 1.3),
      life: c.popFoamLife,
      intensity: c.popFoamIntensity,
      colorA: getColor(c.colorFoamA),
      colorB: getColor(c.colorFoamB)
    });
  }

  /* ------------------------------------------------------------------ */
  /* Ambient emission                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * What the standing cage sheds: droplets running off the films, mist inside
   * it, and fizz climbing the inside of the wall.
   *
   * @param {number} scale 0..1 — thinned as the cage gives out
   */
  _cageFx(dt, scale) {
    const c = settings.bubblecage;
    const g = settings.global;
    const time = frame.uTime.value;
    if (this._count === 0) return;

    this._cageCentre(_centre);
    const radius = c.zoneRadius * c.cageRadius;

    const dropCount = Math.round(this.dropEmitter.tick(dt, c.dropRate * scale) * g.particleCount);
    if (dropCount > 0) {
      // Off a bubble, not off the middle: the drips come from the films.
      this._bubblePoint(Math.floor(Math.random() * this._count), _pos);
      _emit.position = _pos;
      _emit.radius = c.zoneRadius * c.bubbleRadius;
      _emit.direction = _dir.set(0, -1, 0);
      _emit.speed = c.dropSpeed * 0.35;
      _emit.speedVariance = 0.6;
      _emit.spread = 0.5;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.1;
      _emit.sizeVariance = 0.7;
      _emit.life = c.dropLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.drops.emit(dropCount, _emit);
    }

    const mistCount = Math.round(this.mistEmitter.tick(dt, c.mistRate * scale) * g.particleCount);
    if (mistCount > 0) {
      _emit.position = _centre;
      _emit.radius = radius * 0.8;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.mistSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 1.0;
      _emit.size = 0.7;
      _emit.sizeVariance = 0.5;
      _emit.life = c.mistLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.25;
      _emit.time = time;
      this.mist.emit(mistCount, _emit);
    }

    const fizzCount = Math.round(this.fizzEmitter.tick(dt, c.fizzRate * scale) * g.particleCount);
    if (fizzCount > 0) {
      this.pointAt(1, _pos);
      _pos.y = 0.05;
      _emit.position = _pos;
      _emit.radius = c.zoneRadius * c.poolRadius * 0.7;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.fizzSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.35;
      _emit.size = 0.09;
      _emit.sizeVariance = 0.7;
      _emit.life = c.fizzLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.time = time;
      this.fizz.emit(fizzCount, _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(_dt) {
    const c = settings.bubblecage;

    // A bead of black water on its way out — the bell held at its start radius,
    // dimmed, so the cage arrives from somewhere rather than being switched on.
    this.bell.visible = true;
    this._syncBell(this.position, 0, saturate(c.bellOpacity) * 0.5);
    this.filmGeometry.instanceCount = 0;
    this.pool.setVisible(false);
    this._sync(1);
  }

  onImpact() {
    const c = settings.bubblecage;
    const g = settings.global;
    const time = frame.uTime.value;

    for (let i = 0; i < this._count; i++) this._burst[i] = 0;
    this.filmGeometry.instanceCount = this._count;
    this.pool.setVisible(true);

    this.pointAt(1, _pos);

    this.ctx.bursts.spawn(BurstMode.WATER, _pos, {
      radius: c.burstSize * 0.25,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.65,
      intensity: c.burstIntensity,
      opacity: 0.9,
      fresnel: 2.0,
      displace: 0.55,
      squash: 0.75,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    this.ctx.decals.spawn(DecalType.RIPPLE, _pos, {
      radius: c.rippleRadius * g.explosionIntensity,
      life: c.rippleLife,
      intensity: c.rippleIntensity,
      colorA: getColor(c.colorRippleA),
      colorB: getColor(c.colorRippleB)
    });

    _emit.position = _pos;
    _emit.radius = c.zoneRadius * 0.3;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.dropSpeed * 2.4;
    _emit.speedVariance = 0.85;
    _emit.spread = 0.8;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.16;
    _emit.sizeVariance = 0.8;
    _emit.life = c.dropLifetime * 1.4;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.drops.emit(Math.round(c.popDroplets * 3 * g.particleCount), _emit);

    _emit.speed = c.mistSpeed * 3.0;
    _emit.spread = 1.0;
    _emit.size = 1.2;
    _emit.life = c.mistLifetime * 1.2;
    _emit.spin = 0.4;
    this.mist.emit(Math.round(c.mistRate * 0.8 * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity,
      1 / Math.max(0.05, c.shakeDuration),
      20
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.2 * g.explosionIntensity;
  }

  onFade(dt, _t) {
    const c = settings.bubblecage;

    const local = this._clock();
    const bell = this._bellSpan();
    const collapse = this._collapse();

    // The light sits at the cage's own height, so the bubbles throw shadow
    // outward across the wet stone rather than up at nothing.
    this._cageCentre(this.position);

    /* --- beat 1: the bell, which does not dim but goes --- */
    const inBell = local <= bell;
    this.bell.visible = inBell;
    const t1 = saturate(local / bell);
    this._syncBell(_pos.copy(this.position).setY(0), t1, inBell ? 1 - t1 * t1 * t1 : 0);

    /* --- beat 2: the cage --- */
    this.filmGeometry.instanceCount = this._count;
    this._sync(1 - collapse * 0.35);
    this._rupture();
    this._cageFx(dt, (1 - collapse) * (inBell ? 0.5 : 1));

    // A cage that is coming apart rumbles as its pool drains; almost nothing,
    // but the silence at this point reads as the effect having already ended.
    this.ctx.shake.rumble(c.impactShake * 0.06 * (1 - collapse) * settings.global.cameraShake, dt);
  }

  onDestroy() {
    this.filmGeometry.instanceCount = 0;
    this.bell.visible = false;
    this.pool.setVisible(false);
    this._count = 0;
    this._burst.fill(0);
  }

  dispose() {
    this.bell.dispose();
    this.pool.dispose();
    this.filmGeometry.dispose();
    this.filmMaterial.dispose();
    super.dispose();
  }
}
