import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { createGeyserDropMaterial, setDropColors } from '../../materials/GeyserDropMaterial.js';
import { LiquidSurface, LiquidMode, liquidParams } from '../../vfx/LiquidSurface.js';
import { Projectile, FlightMode, Stagger, projectileParams } from '../../vfx/Projectile.js';
import { Tube, TubePath } from '../../vfx/Tube.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, clamp, lerp, Easing, randRange } from '../../utils/math.js';

const TAU = Math.PI * 2;

/** Hard ceiling on drops. The editor's `droplets` slider clamps here. */
const MAX_DROPS = 128;
/** Samples along the column. FUNNEL wants enough to keep the flare smooth. */
const COLUMN_NODES = 80;
/** Facets around the column's barrel. */
const COLUMN_SIDES = 26;
/**
 * Grid resolution of the vent pool. It is a small disc, so this is generous;
 * the cost that matters here is fill, not vertices.
 */
const POOL_SEGMENTS = 96;

/* --- module-scope scratch: the frame allocates nothing (I3) --- */
const _liq = liquidParams();
/* The lava terms the module ships on by default. Spring water has no skin, is
   not self-lit, and has no glowing seams. */
_liq.crust = 0;
_liq.emissive = 0;
_liq.seamGlow = 0;
_liq.meltGlow = 0;

const _proj = projectileParams();
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _centre = new Vector3();
const _hit = new Vector3();
const _up = new Vector3(0, 1, 0);

/* ---------------------------------------------------------------------- */
/* One drop                                                                */
/* ---------------------------------------------------------------------- */

/**
 * Unit-radius geometry for one falling drop.
 *
 * `Projectile` scales this by `dropRadius` and, with `align` at 1, lays its
 * **+Y** along the drop's own heading — so +Y is the *leading* end and −Y is
 * the trailing one. A falling drop is blunt where it is pushing air and drawn
 * out to a point behind, which is the way round this profile is built. Getting
 * it backwards makes every drop look like it is flying tail-first, and it is
 * surprisingly obvious once a hundred of them are on screen.
 *
 * @param {object} shape live numbers from `settings.geyser`
 */
function createDropletGeometry(shape) {
  const facets = clamp(Math.round(shape.facets), 4, 24);
  const rings = clamp(Math.round(shape.rings), 3, 24);
  const taper = Math.max(0, shape.taper);
  const pinch = clamp(shape.pinch, 0, 0.9);

  const levels = rings + 1;
  const radii = new Float32Array(levels);
  let widest = 1e-4;
  for (let i = 0; i < levels; i++) {
    // `u` runs 0 at the trailing point to 1 at the leading, blunt end.
    const u = i / rings;
    const y = -1 + 2 * u;
    // An ellipsoid of revolution, dragged to a point behind and necked just
    // aft of the shoulder. Two multiplications, and between them they cover
    // everything from a bead (taper 0, pinch 0) to a comet.
    let r = Math.sqrt(Math.max(0, 1 - y * y));
    r *= Math.pow(u, taper);
    r *= 1 - pinch * Math.exp(-Math.pow((u - 0.34) / 0.22, 2));
    radii[i] = Math.max(r, 0.004);
    if (radii[i] > widest) widest = radii[i];
  }
  // Normalised so `dropRadius` means the drop's actual half-width in metres
  // rather than "the half-width of the ellipsoid this was carved out of".
  const scale = 1 / widest;

  const positions = new Float32Array(levels * facets * 3);
  const indices = [];
  let write = 0;
  for (let i = 0; i < levels; i++) {
    const y = -1 + (2 * i) / rings;
    const r = radii[i] * scale;
    for (let f = 0; f < facets; f++) {
      const theta = (f / facets) * TAU;
      positions[write++] = Math.cos(theta) * r;
      positions[write++] = y;
      positions[write++] = Math.sin(theta) * r;
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let f = 0; f < facets; f++) {
      const next = (f + 1) % facets;
      const lowNear = i * facets + f;
      const lowFar = i * facets + next;
      const highNear = (i + 1) * facets + f;
      const highFar = (i + 1) * facets + next;
      indices.push(lowNear, highNear, lowFar, lowFar, highNear, highFar);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * GEYSER — a vent opens, a column stands out of it, and the column comes back
 * down as rain.
 *
 * Four beats. The cast reaches the circle and a pool wells up. The vent blows:
 * a column of water stands to `jetHeight` over `chargeTime` and holds at full
 * pressure for `holdTime`, breathing. Then the pressure **fails** — the column
 * collapses over `collapseTime` and, on that one frame, the water that was in
 * the air is handed to a hundred drops. They arc over, come down, and each one
 * puts its own ripple into the pool it came out of.
 *
 * **THE TRICK — the rain is the column, and every number it flies on is derived
 * from the column rather than authored beside it.**
 *
 * `vfx/Tube.js` in `FUNNEL` mode publishes `radiusAt(t)` and `pointAt(t)`, the
 * real profile and the real axis. At the moment of the pressure loss this file
 * asks it four questions and answers the whole flight with them:
 *
 * | asked | used for |
 * | --- | --- |
 * | `pointAt(seedAt).y` | the drops' launch altitude — `skyHeight` |
 * | `radiusAt(seedAt)` | how wide the cloud they leave from is — `skyScatter` |
 * | `columnSpeed × pressure` | the upward velocity they inherit → the apex |
 * | `2π · jetSpin · radiusAt(seedAt) · swirlCarry` | the tangential velocity they inherit → the ring |
 *
 * From those, the ballistics: they still climb `v²/2g`, they are in the air for
 * `v/g + sqrt(2(h + v²/2g)/g)` seconds, and they land at
 * `radiusAt(seedAt) + (swirl + spreadSpeed) × flightTime` metres from the vent.
 * **There is no `rainRadius` slider and no `dropFlightTime` slider.** The first
 * version had both, and they were never the same as the column twice: every
 * retune of the plume left the rain either falling inside the pool or out on
 * dry floor, with nothing in the panel to explain it. Drag `jetMouthFlare` now,
 * with the clock stopped, and the launch cloud widens *and* the landing ring
 * moves out with it, because both of them are `radiusAt()`.
 *
 * **The funnel is inverted, and the inversion is a profile and not a
 * transform.** `FUNNEL` is written for a tornado: a wide intake at the top, a
 * waist, and a skirt flaring where it touches the floor. This ability authors
 * `jetSkirtFlare` tiny — a collar around the vent bore — and `jetMouthFlare`
 * large with a low `jetMouthStart`, which is the same silhouette upside down.
 * Rotating the tube end for end was tried first and is worse in a way that is
 * easy to miss: `jetSwayCurve` weights the precession toward `t = 1`, so a
 * flipped tube whips at the *vent* and stands rigid at the head. Left the right
 * way up, the head whips and the foot stays planted, which is what a geyser
 * does.
 *
 * **The pool is the same water at the other end.** Every drop that crosses
 * τ = 1 raises an arrival, and the frame it does, `rippleAtWorld()` puts an
 * analytic packet into the heightfield at exactly where it landed. Nothing
 * approximates the rain as a "wet" decal: a hundred drops make a hundred
 * ripples, eight at a time in the module's ring buffer, and the pool is visibly
 * still ringing after the last one is down.
 *
 * **Ordering matters.** `rippleAtWorld()` converts a world point against *this
 * frame's* half-extents, so it must be called after `LiquidSurface.update()`.
 * The order here is therefore: column, then pool, then drops, then arrivals.
 * Column first because the drops read their launch geometry off it; pool before
 * drops because the arrivals are consumed the instant `Projectile.update()`
 * returns.
 *
 * A cast captures a seed and two timestamps — `_ventAt` (the vent opening) and
 * `_blowAt` (the pressure failing). Everything with a unit is resolved from
 * `settings.geyser` inside the update loop, zero-length frames included.
 *
 * **Six draw calls**: the pool, three column layers, the drops, their trails.
 */
export class GeyserAbility extends Ability {
  constructor(context) {
    super('geyser', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /* --- the vent pool ------------------------------------------------ */
    this.pool = new LiquidSurface({
      segments: POOL_SEGMENTS,
      mode: LiquidMode.POOL,
      depthWrite: true,
      doubleSide: true,
      renderOrder: 3,
      name: 'geyser.pool'
    });
    this.pool.object3D.layers.set(LAYER.VFX);
    this.group.add(this.pool.object3D);

    /* --- the column --------------------------------------------------- */
    this.column = new Tube({
      path: TubePath.FUNNEL,
      prefix: 'jet',
      nodes: COLUMN_NODES,
      sides: COLUMN_SIDES,
      renderOrder: 11
    });
    this.group.add(this.column.group);

    /* --- the rain ------------------------------------------------------ */
    /**
     * Live shape controls for the drop factory. Mutated in place — an object
     * literal per frame is the allocation I3 forbids. Declared *before* the
     * `Projectile` below, because its constructor calls the geometry factory
     * immediately and the factory reads this.
     */
    this._shape = { facets: 9, rings: 7, taper: 0.55, pinch: 0.28 };

    this.dropMaterial = createGeyserDropMaterial();
    this.drops = new Projectile(this.group, {
      capacity: MAX_DROPS,
      // A factory, not a geometry: `Projectile` takes ownership of what this
      // returns and rebuilds it whenever `shapeKey()` moves, which is what
      // makes the four shape sliders live.
      geometry: () => createDropletGeometry(this._shape),
      shapeKey: () => {
        const c = settings.geyser;
        return `${Math.round(c.dropFacets)}|${Math.round(c.dropRings)}|${c.dropTaper}|${c.dropPinch}`;
      },
      material: this.dropMaterial,
      trail: true,
      trailNodes: 22,
      trailAdditive: true,
      layer: LAYER.VFX,
      renderOrder: 6,
      castShadow: false
    });

    /** Scratch state handed to the column each frame. Dice and timestamps only. */
    this._state = {
      origin: new Vector3(),
      target: new Vector3(),
      side: new Vector3(),
      progress: 0,
      fade: 0,
      widthFade: 1,
      seed: 0,
      time: 0
    };

    /** Re-rolled per cast so two vents do not spit the same pattern. */
    this._seed = 0;
    /** `this.age` when the vent opened, or −1. A timestamp. */
    this._ventAt = -1;
    /** `this.age` when the pressure failed, or −1. A timestamp. */
    this._blowAt = -1;
    /** One-shot latch on the pressure loss. */
    this._blown = false;
    /** Drops drawn last frame, for the HUD's instance readout. */
    this._live = 0;
    /** 0..1 the column's pressure, resolved once per frame in `_sync`. */
    this._gate = 0;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // The water shed off the column, and the splash under every landing.
    this.spray = particles.get('geyser.spray', {
      capacity: 3200,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.3
    });
    this.spray.uniforms.uDrag.value = 1.4;
    this.spray.uniforms.uEndSize.value = 0.28;
    this.spray.uniforms.uSizeIn.value = 0.05;
    this.spray.uniforms.uFadeIn.value = 0.05;
    this.spray.uniforms.uFadeOut.value = 0.45;

    // The boil. Non-additive, so it genuinely occludes the column behind it —
    // steam that adds reads as light and the vent stops looking hot and wet.
    this.steam = particles.get('geyser.steam', {
      capacity: 1800,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.1
    });
    this.steam.uniforms.uDrag.value = 1.9;
    this.steam.uniforms.uEndSize.value = 3.0;
    this.steam.uniforms.uSizeIn.value = 0.14;
    this.steam.uniforms.uFadeIn.value = 0.2;
    this.steam.uniforms.uFadeOut.value = 0.32;

    // What the vent tears out of the floor with the water.
    this.grit = particles.get('geyser.grit', {
      capacity: 1200,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.grit.uniforms.uDrag.value = 0.35;
    this.grit.uniforms.uEndSize.value = 0.6;
    this.grit.uniforms.uFadeOut.value = 0.65;

    this.sprayEmitter = new RateEmitter();
    this.steamEmitter = new RateEmitter();
    this.gritEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this._live;
  }

  /** The vent runs for the whole of the impact phase. */
  get impactDuration() {
    return Math.max(0.1, settings.geyser.lifetime * settings.global.lifetime);
  }

  /** The pool settling once the rain is down. */
  get fadeDuration() {
    return Math.max(0.1, settings.geyser.fadeTime);
  }

  /* ------------------------------------------------------------------ */
  /* The beats                                                           */
  /* ------------------------------------------------------------------ */

  /** The centre of the footprint — the far end of the aimed line. */
  _ventPoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /**
   * Seconds since the vent opened.
   *
   * Measured across the phase boundary rather than off `impactTime` alone,
   * because `chargeTime + holdTime` is two sliders and nothing stops them being
   * dragged past `lifetime` — at which point `impactTime` has stopped
   * accumulating and the column would never lose pressure.
   */
  _runElapsed() {
    if (this._ventAt < 0) return -1;
    return this.age - this._ventAt;
  }

  /** 0..1 — how far the column has stood up. */
  _rise() {
    const c = settings.geyser;
    const elapsed = this._runElapsed();
    if (elapsed < 0) return 0;
    return Easing.outCubic(saturate(elapsed / Math.max(0.02, c.chargeTime)));
  }

  /** 0..1 — how far the column has fallen back in since it lost pressure. */
  _collapse() {
    if (!this._blown) return 0;
    const c = settings.geyser;
    return saturate((this.age - this._blowAt) / Math.max(0.05, c.collapseTime));
  }

  /**
   * 0..1 — the pressure in the column right now.
   *
   * The surge is a real term rather than a decoration: a geyser does not run at
   * a constant head, and the column's whole silhouette is a function of this
   * number, so breathing it also breathes the height, the width and the rate of
   * everything the vent throws.
   */
  _pressure() {
    const c = settings.geyser;
    const elapsed = this._runElapsed();
    if (elapsed < 0) return 0;
    const breathe = 1 + c.surge * Math.sin(elapsed * TAU * c.surgeRate);
    return saturate(this._rise() * (1 - Easing.inCubic(this._collapse())) * breathe);
  }

  /**
   * 0..1 — the pressure the column had on the frame it failed.
   *
   * Recomputed from two timestamps and the live `chargeTime` rather than
   * captured at the blow, so dragging the charge with the clock stopped
   * re-throws the rain that is already in the air.
   */
  _blowPressure() {
    if (!this._blown) return 0;
    const c = settings.geyser;
    const elapsed = Math.max(0, this._blowAt - this._ventAt);
    return Easing.outCubic(saturate(elapsed / Math.max(0.02, c.chargeTime)));
  }

  /** 0..1 — how far the pool has welled up. */
  _fill() {
    const c = settings.geyser;
    if (this.phase === AbilityPhase.TRAVEL) return saturate(c.preFill) * this.u;
    const open = Easing.outCubic(saturate(this._runElapsed() / Math.max(0.02, c.ventRise)));
    return lerp(saturate(c.preFill), 1, open);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.sprayEmitter.reset();
    this.steamEmitter.reset();
    this.gritEmitter.reset();

    this._seed = Math.random() * 100;
    this._ventAt = -1;
    this._blowAt = -1;
    this._blown = false;
    this._live = 0;
    this._gate = 0;

    this.pool.reset();
    this.pool.visible = true;
    this.drops.reset();
    this.drops.roll(this._seed);
    this.column.visible = false;

    this._sync();
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Resolve the column, the pool and the rain from live settings.
   *
   * Every metre, radian and second below is read on the frame it is used,
   * including a zero-length one. The order — column, pool, drops, arrivals — is
   * load-bearing; see the class comment.
   */
  _sync() {
    const c = settings.geyser;
    const g = settings.global;

    const pressure = this._pressure();
    this._gate = pressure;

    this._ventPoint(_centre);

    /* ---------------- the column ---------------- */
    const state = this._state;
    state.origin.copy(_centre);
    state.origin.y = c.poolHeight + c.jetBase;
    state.target.copy(state.origin);
    state.target.y = state.origin.y + Math.max(0.1, c.jetHeight);
    state.side.copy(this.side);
    // The column draws from the vent up to whatever it has reached, and
    // retracts from the head down as it falls in — which is right, because the
    // water that used to be up there is now the rain.
    state.progress = this._rise() * (1 - Easing.inCubic(this._collapse()));
    state.fade = this.phase === AbilityPhase.TRAVEL ? 0 : saturate(pressure * 1.4);
    state.widthFade = lerp(1, Math.max(0.01, c.jetTaper), this._collapse());
    state.seed = this._seed;
    state.time = Math.max(0, this._runElapsed());

    this.column.sync(c, state, g);
    this.column.visible = state.fade > 0.002 && state.progress > 0.002;

    /* ---------------- the pool ---------------- */
    _pos.copy(_centre);
    _pos.y = c.poolHeight;
    this.pool.setPlacement(_pos, this.direction, _up);

    _liq.sizeX = c.zoneRadius * 2;
    _liq.sizeZ = c.zoneRadius * 2;
    _liq.fill = this._fill();
    _liq.round = c.round;
    _liq.edgeSoft = c.edgeSoft;
    _liq.edgeNoise = c.edgeNoise;
    _liq.edgeScale = c.edgeScale;
    _liq.seed = this._seed;
    _liq.opacity = c.poolOpacity * g.opacity;
    _liq.contactFade = c.contactFade;

    _liq.waveAmpA = c.waveAmpA;
    _liq.waveAmpB = c.waveAmpB;
    _liq.waveAmpC = c.waveAmpC;
    _liq.waveAmpD = c.waveAmpD;
    _liq.waveLengthA = c.waveLengthA;
    _liq.waveLengthB = c.waveLengthB;
    _liq.waveLengthC = c.waveLengthC;
    _liq.waveLengthD = c.waveLengthD;
    _liq.waveSpeedA = c.waveSpeedA;
    _liq.waveSpeedB = c.waveSpeedB;
    _liq.waveSpeedC = c.waveSpeedC;
    _liq.waveSpeedD = c.waveSpeedD;
    _liq.waveAngleA = c.waveAngleA;
    _liq.waveAngleB = c.waveAngleB;
    _liq.waveAngleC = c.waveAngleC;
    _liq.waveAngleD = c.waveAngleD;
    _liq.steepness = c.steepness;

    _liq.chop = c.chop;
    _liq.chopScale = c.chopScale * g.noiseFrequency;
    _liq.chopSpeed = c.chopSpeed * g.noiseSpeed;
    _liq.detail = c.detail;
    _liq.detailScale = c.detailScale * g.noiseFrequency;
    _liq.detailSpeed = c.detailSpeed * g.noiseSpeed;

    _liq.rippleAmp = c.rippleAmp;
    _liq.rippleSpeed = c.rippleSpeed;
    _liq.rippleLength = c.rippleLength;
    _liq.rippleWidth = c.rippleWidth;
    _liq.rippleDecay = c.rippleDecay;
    _liq.rippleSpread = c.rippleSpread;

    _liq.flowAngle = c.flowAngle;
    _liq.flowSpeed = c.flowSpeed;
    // The boil is the vent's own outflow, so it lives and dies with the
    // pressure rather than running for the whole cast.
    _liq.flowRadial = c.flowRadial * (0.25 + 0.75 * pressure);
    _liq.flowRadialFall = c.flowRadialFall;
    _liq.flowEddy = c.flowEddy;
    _liq.flowEddyScale = c.flowEddyScale * g.noiseFrequency;
    _liq.flowEddySpeed = c.flowEddySpeed * g.noiseSpeed;
    _liq.flowGravity = c.flowGravity;

    _liq.foam = c.foam;
    _liq.foamScale = c.foamScale * g.noiseFrequency;
    _liq.foamSharp = c.foamSharp;
    _liq.foamCrest = c.foamCrest;
    _liq.foamSpeed = c.foamSpeed;

    _liq.poolDepth = c.poolDepth;
    _liq.depthTint = c.depthTint;
    _liq.translucency = c.translucency;
    _liq.ambient = c.ambient;
    _liq.specular = c.specular;
    _liq.shininess = c.shininess;
    _liq.fresnel = c.fresnel * g.fresnel;
    _liq.envIntensity = c.envIntensity;
    _liq.skyIntensity = c.skyIntensity;
    _liq.glow = c.poolGlow * g.glow;
    _liq.normalEps = c.normalEps;

    _liq.colorDeep = c.colorDeep;
    _liq.colorShallow = c.colorShallow;
    _liq.colorFoam = c.colorFoam;
    _liq.colorSpec = c.colorSpec;
    _liq.colorSky = c.colorSky;

    this.pool.update(this.age, _liq);
    this.pool.visible = _liq.fill > 0.001 && _liq.opacity > 0.001;

    /* ---------------- the rain ---------------- */
    this._syncRain();

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
    this.spray.uniforms.uGlow.value = c.poolGlow * 0.7 * g.glow;
    this.spray.uniforms.uTurbulence.value = c.sprayTurbulence * g.turbulence;

    this.steam.setGradient(
      getColor(c.colorSteamA),
      getColor(c.colorSteamB),
      getColor(c.colorSteamC),
      getColor(c.colorSteamD)
    );
    this.steam.uniforms.uGravity.value.set(0, c.steamRise, 0);
    this.steam.uniforms.uSizeScale.value = c.steamSize * g.particleSize;
    this.steam.uniforms.uLifeScale.value = c.steamLifetime * 0.5 * g.particleLifetime;
    this.steam.uniforms.uSpeedScale.value = c.steamSpeed * g.particleSpeed;
    this.steam.uniforms.uOpacity.value = c.steamOpacity * g.opacity;
    this.steam.uniforms.uTurbulence.value = 0.4 * g.turbulence;

    this.grit.setGradient(
      getColor(c.colorGritA),
      getColor(c.colorGritB),
      getColor(c.colorGritC),
      getColor(c.colorGritD)
    );
    this.grit.uniforms.uGravity.value.set(0, c.gritGravity, 0);
    this.grit.uniforms.uSizeScale.value = c.gritSize * g.particleSize * 7;
    this.grit.uniforms.uLifeScale.value = c.gritLifetime * 0.5 * g.particleLifetime;
    this.grit.uniforms.uSpeedScale.value = g.particleSpeed;
    this.grit.uniforms.uOpacity.value = g.opacity;

    /* ---------------- the light ---------------- */
    if (this.phase === AbilityPhase.TRAVEL) {
      this.pointAt(this.u, this.position);
      this.position.y = c.poolHeight;
    } else {
      this.column.pointAt(saturate(c.lightRide), this.position);
      this.position.y += c.lightHeight;
    }
  }

  /**
   * The whole flight, derived from the column.
   *
   * Nothing in here is authored twice: the launch geometry is `pointAt()` and
   * `radiusAt()`, and the ballistics are the inherited velocity against
   * `gravity`. See the table in the class comment.
   */
  _syncRain() {
    const c = settings.geyser;
    const g = settings.global;

    const gravity = Math.max(0.05, c.gravity);
    const seedAt = saturate(c.seedAt);

    // Where the water tears off, and how wide the column is there.
    //
    // `radiusAt()` already carries this frame's collapse taper (`widthFade`),
    // and letting that into the ballistics would haul drops that are *already
    // in the air* back toward the axis as the column died — every landing point
    // is re-derived every frame, so a shrinking profile drags all of them at
    // once. Divide it back out: the rain left a column that was still at full
    // width, and that is the column it has to be flying off.
    this.column.pointAt(seedAt, _pos);
    const headY = _pos.y;
    const seedRadius = this.column.radiusAt(seedAt) / Math.max(this._state.widthFade, 1e-3);

    // What it is doing at that moment: up, and around.
    const rise = Math.max(0, c.columnSpeed * this._blowPressure());
    const apex = (rise * rise) / (2 * gravity);
    const drop = Math.max(0.05, headY - c.poolHeight + apex);
    const flight = Math.max(0.05, rise / gravity + Math.sqrt((2 * drop) / gravity));
    const swirl = TAU * Math.abs(c.jetSpin) * seedRadius * c.swirlCarry;

    _proj.mode = FlightMode.FALL;
    _proj.stagger = Stagger.HASH;
    _proj.count = this._blown ? Math.min(MAX_DROPS, Math.round(c.droplets)) : 0;
    _proj.radius = c.dropRadius;
    _proj.sizeJitter = c.dropSizeJitter * g.randomness;
    _proj.stretch = c.dropStretch;
    _proj.align = c.dropAlign;
    _proj.spin = c.dropSpin;
    _proj.flash = c.dropFlash;

    // FALL's launch is `origin − direction × skyBack ± scatter`, at `skyHeight`.
    // Zero the setback: this plume is standing over the vent, not thrown in
    // from behind the caster the way a meteor shower is.
    _proj.skyBack = 0;
    _proj.skyHeight = headY;
    _proj.skyScatter = seedRadius;

    _proj.landHeight = c.poolHeight;
    _proj.landInZone = true;
    // The ring. Water on the axis falls nearly straight down and water on the
    // rim is thrown outward for the whole flight, so the landing is
    // rim-crowded rather than uniform — that crowding is `dropRingBias`.
    _proj.zoneRadius = seedRadius + (swirl + c.spreadSpeed) * flight;
    _proj.zoneBias = Math.max(0.05, c.dropRingBias);

    _proj.pathCurve = c.dropPathCurve;
    _proj.apex = apex;
    _proj.apexCurve = c.dropApexCurve;
    // A ballistic drop does not weave. Zeroed rather than left to the module's
    // defaults, which are tuned for homing bolts.
    _proj.weaveSide = 0;
    _proj.weaveUp = 0;

    _proj.flightTime = flight;
    _proj.speedJitter = c.dropSpeedJitter;
    _proj.lead = c.dropLead;
    _proj.window = c.dropWindow;
    _proj.fillBias = c.dropFillBias;
    _proj.fillScatter = c.dropFillScatter;
    _proj.hashCell = c.dropHashCell;
    _proj.linger = c.dropLinger;
    _proj.sink = c.dropSink;

    _proj.trailSpan = c.trailSpan;
    _proj.trailBurn = c.trailBurn;
    _proj.trailWidth = c.trailWidth;
    _proj.trailTaper = c.trailTaper;
    _proj.trailLift = c.trailLift;
    _proj.trailOpacity = c.trailOpacity * g.opacity;
    _proj.trailGlow = c.trailGlow * g.glow;
    _proj.trailCore = c.trailCore;
    _proj.trailHeadBias = c.trailHeadBias;
    _proj.trailNoise = c.trailNoise * g.turbulence;
    _proj.trailNoiseScale = c.trailNoiseScale * g.noiseFrequency;
    _proj.trailNoiseSpeed = c.trailNoiseSpeed * g.noiseSpeed;
    _proj.trailSoftFade = c.trailSoftFade;

    setDropColors(this.dropMaterial, c.colorDropClear, c.colorDropFroth, c.colorDropSpot, c.colorDropRim);
    const d = this.dropMaterial.uniforms;
    d.uIor.value = Math.max(1.001, c.dropIor);
    d.uSpot.value = c.dropSpot;
    d.uSpotPower.value = c.dropSpotPower;
    d.uRim.value = c.dropRim * g.fresnel;
    d.uRimPower.value = c.dropRimPower;
    d.uFroth.value = c.dropFroth;
    d.uFrothFade.value = c.dropFrothFade;
    d.uAmbient.value = c.dropAmbient;
    d.uShade.value = c.dropShade;
    d.uFlashGain.value = c.dropFlashGain;
    d.uGlow.value = c.dropGlow * g.glow;
    d.uOpacity.value = c.dropOpacity * g.opacity;
    d.uSoftFade.value = c.dropSoftFade;

    this.drops.setTrailColors(
      getColor(c.colorTrailA),
      getColor(c.colorTrailB),
      getColor(c.colorTrailC),
      getColor(c.colorTrailD)
    );

    this._shape.facets = c.dropFacets;
    this._shape.rings = c.dropRings;
    this._shape.taper = c.dropTaper;
    this._shape.pinch = c.dropPinch;
    this.drops.syncGeometry();

    _pos.copy(_centre);
    _pos.y = c.poolHeight;
    // A metre of basis length would put the landing disc a metre downrange of
    // the vent; a centimetre is below the resolution of anything on screen and
    // keeps the disc centred on the water it came out of.
    this.drops.setBasis(_pos, this.direction, this.side, 0.01);
    // Drop time starts when the pressure fails, not when the cast left the
    // hand: `dropWindow` is authored against the tear, and offsetting it by the
    // travel time would make it mean different things at different ranges.
    this.drops.update(this._blown ? Math.max(0, this.age - this._blowAt) : 0, _proj);
    this._live = this.drops.count;

    /* --- the arrivals, straight after update() as the module says --- */
    for (let i = 0; i < this.drops.arrivalCount; i++) {
      const index = this.drops.arrivals[i];
      this.drops.landPoint(index, _hit);
      this.pool.rippleAtWorld(_hit, c.rippleStrength, this.age);
      this._splashFx(_hit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /** A point on the column's surface at height fraction `t`, world metres. */
  _columnPoint(t, out) {
    const radius = this.column.radiusAt(t);
    const bearing = Math.random() * TAU;
    this.column.pointAt(t, out);
    out.x += Math.cos(bearing) * radius;
    out.z += Math.sin(bearing) * radius;
    return out;
  }

  /** Spray, steam and grit while the vent is running. */
  _ventFx(dt) {
    const c = settings.geyser;
    const g = settings.global;
    const time = frame.uTime.value;
    const gate = this._gate;

    const sprayCount = Math.round(this.sprayEmitter.tick(dt, c.sprayRate * gate) * g.particleCount);
    if (sprayCount > 0) {
      // Off the barrel, anywhere up it, crowded toward the head where the
      // column is widest and slowest — the same `radiusAt()` the rain reads.
      const t = Math.sqrt(Math.random());
      this._columnPoint(t, _pos);
      _emit.position = _pos;
      _emit.radius = this.column.radiusAt(t) * 0.35;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.spraySpeed * lerp(1.2, 0.45, t);
      _emit.speedVariance = 0.8;
      _emit.spread = lerp(0.25, 0.9, t);
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = c.spraySize;
      _emit.sizeVariance = 0.7;
      _emit.life = c.sprayLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.spray.emit(sprayCount, _emit);
    }

    // Steam keeps coming off the pool long after the column has gone, so it is
    // gated on the pool being open rather than on the pressure.
    const steamGate = this._fill();
    const steamCount = Math.round(this.steamEmitter.tick(dt, c.steamRate * steamGate) * g.particleCount);
    if (steamCount > 0) {
      const bearing = Math.random() * TAU;
      const radius = c.zoneRadius * steamGate * Math.sqrt(Math.random());
      _pos.set(_centre.x + Math.cos(bearing) * radius, c.poolHeight, _centre.z + Math.sin(bearing) * radius);
      _emit.position = _pos;
      _emit.radius = c.zoneRadius * 0.3;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.steamSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.95;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = c.steamSize;
      _emit.sizeVariance = 0.5;
      _emit.life = c.steamLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.3;
      _emit.tint = null;
      _emit.time = time;
      this.steam.emit(steamCount, _emit);
    }

    const gritCount = Math.round(this.gritEmitter.tick(dt, c.gritRate * gate) * g.particleCount);
    if (gritCount > 0) {
      this._columnPoint(0.04, _pos);
      _emit.position = _pos;
      _emit.radius = this.column.skirtRadius * 0.6;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.gritSpeed;
      _emit.speedVariance = 0.85;
      _emit.spread = 0.35;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = c.gritSize;
      _emit.sizeVariance = 0.7;
      _emit.life = c.gritLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 9;
      _emit.tint = null;
      _emit.time = time;
      this.grit.emit(gritCount, _emit);
    }
  }

  /** The little crown one drop throws where it goes back in. */
  _splashFx(point) {
    const c = settings.geyser;
    const g = settings.global;
    const count = Math.round(c.splashPerDrop * g.particleCount);
    if (count <= 0) return;

    _emit.position = point;
    _emit.radius = c.dropRadius * 1.6;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.spraySpeed * 0.5;
    _emit.speedVariance = 0.9;
    // Wide and shallow: a splash leaves sideways. Straight up is a fountain.
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = c.spraySize * 0.7;
    _emit.sizeVariance = 0.8;
    _emit.life = c.sprayLifetime * 0.6;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.spray.emit(count, _emit);
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._sync();
    this._ventFx(dt);
  }

  onImpact() {
    const c = settings.geyser;
    const g = settings.global;
    const time = frame.uTime.value;

    // The first of the two timestamps a cast captures.
    this._ventAt = this.age;

    this._ventPoint(_centre);
    _pos.copy(_centre);
    _pos.y = c.poolHeight;

    /* the shell of spray as the vent lets go */
    this.ctx.bursts.spawn(BurstMode.WATER, _pos, {
      radius: c.burstSize * 0.2,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.7,
      intensity: c.burstIntensity,
      opacity: 0.85,
      fresnel: 1.7,
      displace: 0.6,
      squash: 0.6,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    /* the ring across the floor */
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _centre, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.6,
      width: 0.06,
      intensity: 1.0,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    /* wet stone outside the waterline */
    const marks = Math.max(0, Math.round(c.wetMarks));
    for (let i = 0; i < marks; i++) {
      // Evenly spaced with a jittered bearing rather than fully random: a
      // handful of random angles clumps, and a clumped ring reads as a mistake.
      const bearing = ((i + randRange(-0.35, 0.35)) / marks) * TAU;
      const radius = c.zoneRadius * randRange(0.9, 1.3);
      _pos.set(_centre.x + Math.cos(bearing) * radius, 0, _centre.z + Math.sin(bearing) * radius);
      this.ctx.decals.spawn(DecalType.FOAM, _pos, {
        radius: c.wetRadius * randRange(0.7, 1.3),
        life: c.wetLife,
        intensity: c.wetIntensity,
        colorA: getColor(c.colorWet),
        colorB: getColor(c.colorWetEdge),
        height: 0.012
      });
    }

    /* the first throw out of the bore */
    _pos.copy(_centre);
    _pos.y = c.poolHeight;
    _emit.position = _pos;
    _emit.radius = c.zoneRadius * 0.18;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.spraySpeed * 2.2;
    _emit.speedVariance = 0.9;
    _emit.spread = 0.5;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = c.spraySize * 1.2;
    _emit.sizeVariance = 0.8;
    _emit.life = c.sprayLifetime * 1.3;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.spray.emit(Math.round(70 * g.particleCount), _emit);

    _emit.speed = c.gritSpeed * 1.5;
    _emit.spread = 0.6;
    _emit.size = c.gritSize * 1.3;
    _emit.life = c.gritLifetime;
    _emit.spin = 11;
    this.grit.emit(Math.round(40 * g.particleCount), _emit);

    this.ctx.shake.add(
      c.ventShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      20
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.ventFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.9 * g.explosionIntensity;
  }

  /**
   * The pressure fails. One-shot, and all it captures is a timestamp — every
   * number the rain flies on is re-derived from the column every frame after.
   */
  _blow() {
    const c = settings.geyser;
    const g = settings.global;

    this._blown = true;
    this._blowAt = this.age;

    // The head of the column bursting as it stops being held up.
    this.column.pointAt(saturate(c.seedAt), _pos);
    this.ctx.bursts.spawn(BurstMode.WATER, _pos, {
      radius: this.column.radiusAt(saturate(c.seedAt)),
      endRadius: c.burstSize * 1.3 * g.explosionIntensity,
      life: 0.65,
      intensity: c.burstIntensity * 0.8,
      opacity: 0.75,
      fresnel: 1.9,
      displace: 0.7,
      squash: 0.75,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    _emit.position = _pos;
    _emit.radius = this.column.radiusAt(saturate(c.seedAt));
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.spraySpeed * 1.4;
    _emit.speedVariance = 0.9;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = c.spraySize;
    _emit.sizeVariance = 0.8;
    _emit.life = c.sprayLifetime * 1.2;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.spray.emit(Math.round(60 * g.particleCount), _emit);
  }

  /**
   * The impact and fade phases are one beat here, and `t` is deliberately not
   * read: every clock in this ability is measured off `_ventAt` and `_blowAt`,
   * so dragging `lifetime` or `chargeTime` mid-cast moves the beats instead of
   * re-scaling a normalised progress that has already been spent.
   */
  onFade(dt) {
    const c = settings.geyser;
    if (!this._blown && this._runElapsed() >= c.chargeTime + c.holdTime) this._blow();

    this._sync();
    this._ventFx(dt);

    // The ground shakes while the column is standing on it and stops when the
    // pressure does — `_gate` is the same number the emitters are using.
    this.ctx.shake.rumble(c.rumble * this._gate * settings.global.cameraShake, dt);
  }

  onDestroy() {
    this._live = 0;
    this._gate = 0;
    this._blown = false;
    this._ventAt = -1;
    this._blowAt = -1;
    this.drops.reset();
    this.pool.reset();
    this.pool.visible = false;
    this.column.visible = false;
  }

  dispose() {
    this.pool.dispose();
    this.column.dispose();
    this.drops.dispose();
    this.dropMaterial.dispose();
    super.dispose();
  }
}
