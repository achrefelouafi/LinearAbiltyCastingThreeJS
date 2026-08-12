import { Mesh, Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { Mirror, mirrorParams } from '../../vfx/Mirror.js';
import {
  createCascadeBeamGeometry,
  createCascadeBeamMaterial,
  MAX_BEAM_SEGMENTS
} from '../../materials/CascadeBeamMaterial.js';
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
const WORLD_UP = new Vector3(0, 1, 0);

/**
 * Panes the cascade may hang. Four, because five extra `WORLD` renders a frame
 * is not a cast, and because the beam carries `MAX_BEAM_SEGMENTS` legs — one
 * per pane plus the run to the floor.
 */
const MAX_PANES = MAX_BEAM_SEGMENTS - 1;
/** Samples along one leg. The ceiling on how smoothly a leg's profile bows. */
const BEAM_NODES = 24;
/** Facets around a leg. Below about fourteen the silhouette polygonises. */
const BEAM_SIDES = 18;

/* Module-scope scratch. Nothing in the frame path allocates — invariant I3. */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _in = new Vector3();
const _out = new Vector3();
const _normal = new Vector3();
const _along = new Vector3();
const _floor = new Vector3();
const _mirror = mirrorParams();
const _beamState = { progress: 1, fade: 1, seed: 0 };

/**
 * REFRACTION CASCADE — a shot that gets to the far end by bouncing.
 *
 * Three or four panes of glass hang in a zig-zag down the aimed line. The shot
 * leaves the hand, strikes the first, comes off it at the reflected angle,
 * crosses to the next, and finally lands on the floor at the end of the cast,
 * losing a slice of its width and its light at every bounce.
 *
 * ## THE TRICK — the panes reflect the actual scene
 *
 * Each pane is a `vfx/Mirror.js`: a camera mirrored about its own plane renders
 * the `WORLD` layer into a small target and the surface samples that target
 * projectively. What is in the glass is the room *behind the camera* — the
 * character, the floor's relief, a Frost Lance still standing from the last
 * cast — and it **slides across the pane as you orbit**. That parallax is the
 * entire feature. An environment map costs a tenth as much and the brain files
 * a reflection that does not move as painted-on shine within about half a
 * second, which is the difference between glass and chrome the roster line is
 * blunt about.
 *
 * The bill is not a draw call. Five draw calls draw this — four panes and one
 * beam — but every pane that *renders* is another full traversal of the world:
 * a scene walk, a render list, a sort, and every opaque draw again. The module
 * caps that at two a frame and hands the slots out on `priority × apparent size
 * × (1 + frames waited)`, so on four panes the two nearest and largest are
 * always current and the others are showing a 30–50 ms old reflection. That is
 * the right trade and it is why `paneCount` stops at four.
 *
 * ## The reflection law is the layout, backwards
 *
 * The obvious way round is to place the panes, aim them, and trace the beam
 * off them. The first version did that and it is miserable: two sliders on a
 * pane's rotation and the beam wanders off into the room, so the panes have to
 * be aimed by hand for every value of every other slider, and nothing can be
 * dragged while a cast is standing.
 *
 * So it is inverted. The **path** is authored — a zig-zag whose nodes are
 * `paneOffset`, `paneAltitude` and the rest, resolved fresh each frame — and
 * each pane's normal is then *derived* as the bisector of the two legs meeting
 * on it: for an incoming heading `d` and an outgoing `r`, the plane that turns
 * one into the other has normal `normalize(r − d)`, which already faces the
 * incoming beam because `(r − d)·d ≤ 0` for two unit vectors. There is no
 * aiming logic and no correction term anywhere in this file, and a pane cannot
 * be wrong. Pause mid-flight, drag `paneOffset`, and the whole zig-zag opens
 * out with every pane re-aiming itself to keep the reflection legal.
 *
 * ## One draw call for the legs
 *
 * `vfx/Tube.js` is three draw calls for one tube and does not instance; four
 * legs would be twelve, which is the whole budget for one line of light.
 * `materials/CascadeBeamMaterial.js` is the same parameter-space grid,
 * instanced by leg, with each instance looking its own endpoints out of a
 * uniform array by the unrolled-loop compare `FilamentPaths` uses — the direct
 * `uFrom[int(aSegment)]` does not compile on ANGLE. One draw call, whatever
 * `paneCount` says.
 *
 * The front crosses the *cast line* at `speed`; the beam's progress is that
 * same fraction mapped onto the polyline, which is longer. The light therefore
 * appears to travel faster than `speed` in proportion to how far the zig-zag
 * detours, and that is deliberate: the alternative is a shot that visibly slows
 * down every time somebody widens `paneOffset`.
 *
 * ## What a cast captures
 *
 * A seed and a four-entry flag array saying which panes have been struck. Both
 * are events. Every metre — where a pane hangs, how big it is, how wide the
 * beam is, how much it loses at a bounce — is resolved from
 * `settings.refractcascade` inside the update loop, on a zero-length frame
 * included. The bounce itself is polled against the live geometry rather than
 * scheduled off a timestamp taken at spawn, so moving a pane moves the moment
 * it is hit.
 */
export class RefractCascadeAbility extends Ability {
  constructor(context) {
    super('refractcascade', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /* --- the panes: one draw call each, plus a nested world render --- */
    this.panes = [];
    for (let i = 0; i < MAX_PANES; i++) {
      const pane = new Mirror({
        resolution: 320,
        doubleSided: true,
        renderOrder: 4,
        name: `RefractCascade:pane${i}`
      });
      pane.visible = false;
      this.group.add(pane.object3D);
      this.panes.push(pane);
    }

    /* --- the beam: every leg, one draw call --- */
    this.beamGeometry = createCascadeBeamGeometry(BEAM_NODES, BEAM_SIDES, MAX_BEAM_SEGMENTS);
    this.beamMaterial = createCascadeBeamMaterial();
    this.beamMesh = new Mesh(this.beamGeometry, this.beamMaterial);
    this.beamMesh.frustumCulled = false;
    this.beamMesh.matrixAutoUpdate = false;
    this.beamMesh.layers.set(LAYER.VFX);
    this.beamMesh.renderOrder = 12;
    this.group.add(this.beamMesh);

    /**
     * The polyline: muzzle, then every pane in order, then the floor. Allocated
     * once, rewritten in place every frame — nothing here survives a frame.
     */
    this._nodes = [];
    for (let i = 0; i < MAX_BEAM_SEGMENTS + 1; i++) this._nodes.push(new Vector3());
    /** Each pane's arrival, as a fraction of the whole path. Re-derived too. */
    this._arrive = new Float32Array(MAX_PANES);
    /** Which panes have been struck this cast. Events, not dimensions. */
    this._struck = new Uint8Array(MAX_PANES);

    /** The one dice roll a cast makes. */
    this._seed = 0;
    /** Legs live this frame — `paneCount + 1`. */
    this._legs = 2;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Sparks off the bounces and along the beam. Velocity-stretched streaks.
    this.sparks = particles.get('refractcascade.sparks', {
      capacity: 2000,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.25
    });
    this.sparks.uniforms.uDrag.value = 1.6;
    this.sparks.uniforms.uEndSize.value = 0.24;
    this.sparks.uniforms.uSizeIn.value = 0.02;
    this.sparks.uniforms.uFadeIn.value = 0.04;
    this.sparks.uniforms.uFadeOut.value = 0.45;

    // Glass dust hanging around the panes: the thing that says there is a solid
    // object there, and the only reason a pane reads as suspended rather than
    // as a hole in the frame.
    this.motes = particles.get('refractcascade.motes', {
      capacity: 1400,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.motes.uniforms.uDrag.value = 1.6;
    this.motes.uniforms.uEndSize.value = 0.2;
    this.motes.uniforms.uSizeIn.value = 0.07;
    this.motes.uniforms.uFadeIn.value = 0.1;
    this.motes.uniforms.uFadeOut.value = 0.42;

    // Dust off the floor at the far end. Non-additive so it occludes.
    this.dust = particles.get('refractcascade.dust', {
      capacity: 1000,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.1
    });
    this.dust.uniforms.uDrag.value = 1.8;
    this.dust.uniforms.uEndSize.value = 2.6;
    this.dust.uniforms.uSizeIn.value = 0.12;
    this.dust.uniforms.uFadeIn.value = 0.16;
    this.dust.uniforms.uFadeOut.value = 0.32;

    this.sparkEmitter = new RateEmitter();
    this.moteEmitter = new RateEmitter();
    this.dustEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this._legs + this._paneCount;
  }

  get impactDuration() {
    return Math.max(0.05, settings.refractcascade.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.refractcascade.fadeTime);
  }

  /**
   * Glass rings; it does not gutter. A quantised stutter here would read as the
   * Storm Lance, and this is the opposite of electric.
   */
  lightShimmer() {
    const c = settings.refractcascade;
    return 1 - c.lightPulse * (0.5 - 0.5 * Math.cos(this.age * c.lightPulseSpeed * TAU));
  }

  /** Panes hanging this cast, 1..4. */
  get _paneCount() {
    return clamp(Math.round(settings.refractcascade.paneCount), 1, MAX_PANES);
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                  */
  /* ------------------------------------------------------------------ */

  /** Where the shot leaves the caster, world space. */
  _handPoint(out) {
    const c = settings.refractcascade;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /** Where pane `i` hangs, world space. */
  _panePoint(i, count, out) {
    const c = settings.refractcascade;
    const share = count <= 1 ? 0.5 : i / (count - 1);
    const at = clamp(lerp(c.paneFirst, c.paneLast, share), 0.02, 0.99);
    // Alternating sides, tapering: the zig-zag closes up downrange because a
    // constant throw reads as a corridor rather than as a cascade.
    const sign = (i % 2 === 0 ? 1 : -1) * (c.paneSide < 0 ? -1 : 1);
    const throw_ = c.paneOffset * Math.pow(Math.max(0.01, c.paneOffsetTaper), i) * sign;

    this.pointAt(at, out);
    out.addScaledVector(this.side, throw_);
    // A live sine rather than an integrated drift, so dragging `paneBob` with
    // the sandbox paused moves the pane instead of changing where it will
    // drift to next.
    out.y = c.paneAltitude + c.paneRise * i + c.paneBob * Math.sin(this.age * c.paneBobSpeed * TAU + i * 1.7 + this._seed);
    return out;
  }

  /**
   * Rewrite the polyline from live settings, and with it each pane's arrival
   * fraction. Called at the top of every sync — nothing it writes survives a
   * frame.
   *
   * @returns {number} legs live this frame
   */
  _resolveNodes() {
    const c = settings.refractcascade;
    const count = this._paneCount;

    this._handPoint(this._nodes[0]);
    for (let i = 0; i < count; i++) this._panePoint(i, count, this._nodes[i + 1]);
    this.pointAt(1, this._nodes[count + 1]);
    this._nodes[count + 1].y = c.endHeight;

    // Arrival fractions, off the same nodes: the front has to reach a pane when
    // it reaches the *pane*, not when a timer says so.
    let total = 0;
    for (let i = 0; i <= count; i++) total += this._nodes[i].distanceTo(this._nodes[i + 1]);
    total = Math.max(total, 1e-4);
    let cursor = 0;
    for (let i = 0; i < count; i++) {
      cursor += this._nodes[i].distanceTo(this._nodes[i + 1]);
      this._arrive[i] = cursor / total;
    }
    for (let i = count; i < MAX_PANES; i++) this._arrive[i] = 2; // never reached

    this._legs = count + 1;
    return this._legs;
  }

  /**
   * A point on the *drawn* path at `s`, 0..1 of the whole polyline.
   *
   * The dynamic light and the shed sparks are placed against this rather than
   * against `pointAt()`, or they sit under the cascade in a straight line while
   * the light is visibly somewhere else.
   */
  _pathPoint(s, out) {
    const legs = this._legs;
    let total = 0;
    for (let i = 0; i < legs; i++) total += this._nodes[i].distanceTo(this._nodes[i + 1]);
    total = Math.max(total, 1e-4);

    const want = saturate(s) * total;
    let cursor = 0;
    for (let i = 0; i < legs; i++) {
      const length = this._nodes[i].distanceTo(this._nodes[i + 1]);
      if (want <= cursor + length || i === legs - 1) {
        const local = length <= 1e-5 ? 0 : saturate((want - cursor) / length);
        return out.copy(this._nodes[i]).lerp(this._nodes[i + 1], local);
      }
      cursor += length;
    }
    return out.copy(this._nodes[legs]);
  }

  /** How far the light has got along the whole polyline, 0..1. */
  get _progress() {
    return this.phase === AbilityPhase.TRAVEL ? this.u : 1;
  }

  /**
   * How far pane `i` has faded in, 0..1.
   *
   * The panes are not there at the start of the cast and do not all arrive at
   * once: each one comes up over `paneStagger` of the span *before* the beam
   * gets to it, so the eye has time to register a piece of glass standing in
   * the air before the light hits it.
   */
  _paneGrow(i) {
    const c = settings.refractcascade;
    if (this.phase !== AbilityPhase.TRAVEL) return 1;
    const lead = Math.max(0.01, c.paneStagger);
    return saturate((this.u - (this._arrive[i] - lead)) / lead);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.sparkEmitter.reset();
    this.moteEmitter.reset();
    this.dustEmitter.reset();
    this._struck.fill(0);

    // The one thing a cast captures. Everything else is resolved per frame.
    this._seed = Math.random() * 100;

    this._syncUniforms(1);
    this._muzzleFx();
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and this frame's polyline into the panes and the
   * beam.
   *
   * @param {number} fade 1 while the cascade is lit, ramping to 0 as it dies
   */
  _syncUniforms(fade) {
    const c = settings.refractcascade;
    const g = settings.global;
    const count = this._resolveNodes();
    const panes = count - 1;

    /* --- the panes ------------------------------------------------------ */
    for (let i = 0; i < MAX_PANES; i++) {
      const pane = this.panes[i];
      if (i >= panes) {
        pane.visible = false;
        continue;
      }

      const grow = this._paneGrow(i) * fade;
      if (grow <= 0.01) {
        pane.visible = false;
        continue;
      }

      /* the normal is the bisector — see the class comment */
      _in.subVectors(this._nodes[i + 1], this._nodes[i]).normalize();
      _out.subVectors(this._nodes[i + 2], this._nodes[i + 1]).normalize();
      _normal.subVectors(_out, _in);
      if (_normal.lengthSq() < 1e-8) {
        // The two legs are collinear: the pane is not turning the beam at all,
        // so face it squarely at the incoming light rather than dividing by
        // nothing.
        _normal.copy(_in).multiplyScalar(-1);
      }
      _normal.normalize();

      // An in-plane axis that keeps the pane standing up: the horizontal
      // component first, world up as the fallback when the pane is lying flat.
      _along.crossVectors(WORLD_UP, _normal);
      if (_along.lengthSq() < 1e-8) _along.copy(this.side);
      _along.normalize();
      // Rolling about the normal is the one rotation that cannot break the
      // reflection, which is why it is the one the editor gets.
      const roll = c.paneRoll + c.paneRollStep * i;
      _along.applyAxisAngle(_normal, roll).normalize();

      pane.visible = true;
      pane.setPlacement(this._nodes[i + 1], _normal, _along);

      const scale = lerp(c.paneGrowScale, 1, Easing.outCubic(grow));
      const m = _mirror;
      m.width = Math.max(0.05, c.paneWidth * scale);
      m.height = Math.max(0.05, c.paneTall * scale);
      m.opacity = c.paneOpacity * g.opacity * grow;
      m.edgeFade = c.paneEdgeFade;
      m.corner = c.paneCorner;
      m.seed = this._seed + i * 3.7;
      m.resolution = c.paneResolution;
      m.reflectivity = c.paneReflectivity;
      m.fresnel = c.paneFresnel * g.fresnel;
      m.fresnelPower = c.paneFresnelPower;
      m.roughness = c.paneRoughness;
      m.blurRadius = c.paneBlurRadius;
      m.blurTaps = c.paneBlurTaps;
      m.roughStretch = c.paneRoughStretch;
      m.ripple = c.paneRipple * g.noiseStrength;
      m.rippleScale = c.paneRippleScale * g.noiseFrequency;
      m.rippleSpeed = c.paneRippleSpeed * g.noiseSpeed;
      // Nearer panes are struck first and are the ones the eye is on, so they
      // get the budget's slots first. The starvation term in the module stops
      // this from freezing the far ones out forever.
      m.priority = c.panePriority * (1 + (panes - i) * 0.15);
      m.colorTint = c.colorPaneTint;
      m.colorBase = c.colorPaneBase;
      pane.update(m);
    }

    /* --- the beam ------------------------------------------------------- */
    const state = _beamState;
    state.progress = this._progress;
    state.fade = fade;
    state.seed = this._seed;
    this.beamGeometry.instanceCount = count;
    this.beamMaterial.userData.sync(this._nodes, count, state);

    /* --- the three particle systems ------------------------------------- */
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
    this.sparks.uniforms.uGlow.value = c.beamGlow * 0.4 * g.glow;
    this.sparks.uniforms.uStretch.value = c.sparkStretch;
    this.sparks.uniforms.uTurbulence.value = 0.25 * g.turbulence;

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
    this.dust.uniforms.uTurbulence.value = 0.3 * g.turbulence;
  }

  /** The flash at the caster's hand as the shot leaves it. */
  _muzzleFx() {
    const c = settings.refractcascade;
    const g = settings.global;

    this._handPoint(_pos);
    this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
      radius: c.muzzleSize * 0.2,
      endRadius: c.muzzleSize * g.explosionIntensity,
      life: 0.3,
      intensity: c.muzzleIntensity,
      opacity: 0.85,
      fresnel: 1.6,
      displace: 0.4,
      colorA: getColor(c.colorMuzzleA),
      colorB: getColor(c.colorMuzzleB),
      colorC: getColor(c.colorMuzzleC)
    });

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.5 * g.explosionIntensity;
  }

  /**
   * One bounce.
   *
   * Fired on the frame the front crosses the pane's own arrival fraction, which
   * is recomputed from the live node positions every frame — move a pane and
   * the moment it is struck moves with it, in both directions.
   */
  _bounceFx(index) {
    const c = settings.refractcascade;
    const g = settings.global;

    _pos.copy(this._nodes[index + 1]);

    this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
      radius: c.bounceSize * 0.2,
      endRadius: c.bounceSize * g.explosionIntensity,
      life: 0.36,
      intensity: c.bounceIntensity,
      opacity: 0.8,
      fresnel: 1.8,
      displace: 0.3,
      squash: 0.75,
      colorA: getColor(c.colorBounceA),
      colorB: getColor(c.colorBounceB),
      colorC: getColor(c.colorBounceC)
    });

    // Sparks leave along the *outgoing* leg, not radially: light that has just
    // been turned by a mirror is going somewhere, and a radial puff at a pane
    // reads as the pane breaking.
    _out.subVectors(this._nodes[index + 2], this._nodes[index + 1]).normalize();
    _emit.position = _pos;
    _emit.radius = 0.14;
    _emit.direction = _dir.copy(_out);
    _emit.speed = c.sparkSpeed * 1.6;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.5;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.15;
    _emit.sizeVariance = 0.7;
    _emit.life = c.sparkLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.sparks.emit(Math.round(c.bounceSparks * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorBounceC), c.bounceFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.55 * g.explosionIntensity;
  }

  /**
   * Sparks shed along the drawn part of the cascade, and dust around the panes.
   * @param {number} scale 0..1 — thinned out once the beam is only holding
   */
  _shedFx(dt, scale) {
    const c = settings.refractcascade;
    const g = settings.global;
    const time = frame.uTime.value;
    const reach = Math.max(0.02, this._progress);

    const sparkCount = Math.round(this.sparkEmitter.tick(dt, c.sparkRate * scale) * g.particleCount);
    if (sparkCount > 0) {
      this._pathPoint(randRange(0.02, 1) * reach, _pos);
      _emit.position = _pos;
      _emit.radius = c.beamRadiusNear * 2.2;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.sparkSpeed;
      _emit.speedVariance = 0.85;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.12;
      _emit.sizeVariance = 0.7;
      _emit.life = c.sparkLifetime;
      _emit.lifeVariance = 0.55;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.sparks.emit(sparkCount, _emit);
    }

    const moteCount = Math.round(this.moteEmitter.tick(dt, c.moteRate * scale) * g.particleCount);
    if (moteCount > 0) {
      // Around a pane the beam has already reached — dust nobody has disturbed
      // yet is not interesting.
      const panes = this._legs - 1;
      let pick = 0;
      for (let i = panes - 1; i >= 0; i--) {
        if (this._arrive[i] <= reach) {
          pick = i;
          break;
        }
      }
      _pos.copy(this._nodes[pick + 1]);
      _emit.position = _pos;
      _emit.radius = c.moteScatter;
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

    // Dust only once the last leg is standing on the floor. There is nothing to
    // lift before that, and a plume that starts with the cast gives away that
    // the landing point was known in advance.
    if (this._progress < 0.999) return;
    const dustCount = Math.round(this.dustEmitter.tick(dt, c.dustRate * scale) * g.particleCount);
    if (dustCount > 0) {
      this.pointAt(1, _pos).setY(0.1);
      _emit.position = _pos;
      _emit.radius = c.scorchRadius * 2.2;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.dustSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.85;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.75;
      _emit.sizeVariance = 0.5;
      _emit.life = c.dustLifetime;
      _emit.lifeVariance = 0.45;
      _emit.spin = 0.35;
      _emit.tint = null;
      _emit.time = time;
      this.dust.emit(dustCount, _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = settings.refractcascade;
    this._syncUniforms(1);

    // Polled against the live geometry, never scheduled.
    const panes = this._legs - 1;
    for (let i = 0; i < panes; i++) {
      if (!this._struck[i] && this.u >= this._arrive[i]) {
        this._struck[i] = 1;
        this._bounceFx(i);
      }
    }

    // The light rides the head of the beam along the *drawn* path, so it turns
    // every corner instead of sliding down the floor.
    this._pathPoint(this.u, this.position);

    this._shedFx(dt, 1);
    this.ctx.shake.rumble(c.rumble * 0.5 * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.refractcascade;
    const g = settings.global;
    const time = frame.uTime.value;

    this._syncUniforms(1);
    // Any pane the front skipped past inside one long frame still gets its
    // bounce, or a low frame rate silently swallows the middle of the cascade.
    const panes = this._legs - 1;
    for (let i = 0; i < panes; i++) {
      if (!this._struck[i]) {
        this._struck[i] = 1;
        this._bounceFx(i);
      }
    }

    _pos.copy(this._nodes[this._legs]);
    // The last node is `endHeight` above the floor; the decals want the floor
    // itself. Its own scratch rather than borrowing the emit direction's, which
    // is the sort of reuse that survives review and then breaks the day
    // somebody reorders two lines.
    this.pointAt(1, _floor);

    /* the shell where the last leg lands */
    this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
      radius: c.burstSize * 0.2,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.6,
      intensity: c.burstIntensity,
      opacity: 0.9,
      fresnel: 1.7,
      displace: 0.5,
      squash: 0.85,
      colorA: getColor(c.colorBounceA),
      colorB: getColor(c.colorBounceB),
      colorC: getColor(c.colorBounceC)
    });

    /* the ring and the burn on the floor under it */
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _floor, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.55,
      width: 0.045,
      intensity: 1.0,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });
    this.ctx.decals.spawn(DecalType.SCORCH, _floor, {
      radius: c.scorchRadius * randRange(1.5, 2.3),
      life: c.scorchLife,
      intensity: c.scorchIntensity,
      colorA: getColor(c.colorScorch),
      colorB: getColor(c.colorEmber),
      height: 0.015
    });

    /* sparks out of the landing, dust off the floor under it */
    _emit.position = _pos;
    _emit.radius = 0.24;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.4).setY(0.7).normalize();
    _emit.speed = c.sparkSpeed * 2.1;
    _emit.speedVariance = 0.85;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.18;
    _emit.sizeVariance = 0.8;
    _emit.life = c.sparkLifetime * 1.4;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.sparks.emit(Math.round(c.burstSparks * g.particleCount), _emit);

    this.pointAt(1, _pos);
    _emit.position = _pos;
    _emit.radius = c.scorchRadius * 2;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.dustSpeed * 2.0;
    _emit.spread = 1.0;
    _emit.size = 1.2;
    _emit.life = c.dustLifetime * 1.2;
    _emit.spin = 0.4;
    this.dust.emit(Math.round(c.burstDust * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      22
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.2 * g.explosionIntensity;
  }

  onFade(dt, t) {
    // `t` runs 0..1 while the cascade holds, then 1..2 while it lets go. Cubic
    // on the way out: light does not dim, it stops.
    const fade = t <= 1 ? 1 : 1 - Easing.inCubic(saturate(t - 1));
    this._syncUniforms(fade);
    this._pathPoint(1, this.position);
    this._shedFx(dt, fade * (t <= 1 ? 0.55 : 0.2));
    this.ctx.shake.rumble(settings.refractcascade.rumble * fade * settings.global.cameraShake, dt);
  }

  onDestroy() {
    // A visible mirror is registered against the two-reflections-a-frame
    // budget, so a pooled cast that goes back to the pool still visible would
    // hold a slot the next cast needs. Hiding is the release.
    for (const pane of this.panes) pane.visible = false;
    this._struck.fill(0);
    this._legs = 2;
    this.beamGeometry.instanceCount = 1;
    this.beamMaterial.uniforms.uFade.value = 0;
  }

  dispose() {
    for (const pane of this.panes) pane.dispose();
    this.beamGeometry.dispose();
    this.beamMaterial.dispose();
    super.dispose();
  }
}
