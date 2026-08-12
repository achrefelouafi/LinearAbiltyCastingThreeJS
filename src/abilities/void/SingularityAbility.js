import { Mesh, PlaneGeometry, Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { createInfallMaterial, createHorizonMaterial } from '../../materials/SingularityMaterial.js';
import { createBoltRibbonGeometry } from '../../assets/ProceduralGeometry.js';
import { DistortionField, DistortionMode, DistortionFacing } from '../../vfx/Distortion.js';
import { GroundField, GroundMode, groundFieldParams } from '../../vfx/GroundField.js';
import { Swarm, Silhouette, LeadPath, swarmParams } from '../../vfx/Swarm.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, Easing, randRange } from '../../utils/math.js';

/** Hard ceiling on infall streams. The editor's `streams` slider clamps here. */
const MAX_STREAMS = 160;
/**
 * Samples along one stream's tail. The tail is a *time* window, so near the
 * horizon it covers a long arc and this is the ceiling on how smoothly that arc
 * bends: below about sixteen the last turn visibly polygonises.
 */
const TRAIL_NODES = 22;
/** Hard ceiling on dust motes. Sized to the lattice in the settings block. */
const MAX_MOTES = 288;

const TAU = Math.PI * 2;

/* Module-scope scratch. Nothing in the frame path allocates — invariant I3. */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _floor = new Vector3();
const _lens = {};
const _ground = groundFieldParams();
const _flock = swarmParams();

/**
 * SINGULARITY — a gravity well opened over the aimed circle.
 *
 * Three beats: it **forms** as a seed thrown downrange, it **pulls** for a long
 * couple of seconds while everything nearby winds inward, and then it
 * **inverts** — the lens flips sign for a sixth of a second and the whole thing
 * is thrown back out.
 *
 * ## THE TRICK — the lens *is* the ability
 *
 * `LAYER.DISTORTION` and its half-resolution offset buffer have existed since
 * the first build with nothing writing to them; the README has carried "the
 * distortion pass runs with nothing writing to it" as a known rough edge for as
 * long. This is the ability that earns it back. A `DistortionField` in `LENS`
 * mode writes a radial screen-space displacement whose magnitude goes as 1/r²
 * inside a falloff, so the floor grid, the character, the aim indicator and
 * every particle *behind* the well bend around it. Nothing else in the project
 * is a real screen-space effect: this is not a shell with a fresnel on it, it
 * is the composed frame being resampled.
 *
 * Two details are the whole difference between a lens and a smudge.
 *
 * **`lensDepthReject` ships at 0, and it is the first thing to check if the
 * floor stops bending.** The emitter's occlusion term rejects fragments that
 * opaque geometry sits in front of. The lens is a billboard standing at the
 * well's own height, so the floor in the lower half of that billboard is
 * *nearer the camera than the emitter plane* and the depth test throws it away
 * — the first version warped the sky and left the ground flat, which is exactly
 * the shape of the bug that makes people think the pass is not reaching them.
 * A gravity well bends the ground it is standing over. The slider is kept
 * because a well behind a pillar should not warp the pillar, and that is the
 * case the term was written for.
 *
 * **The centre is clamped and the image is not inverted.** `lensCore` clamps
 * the 1/r² denominator so the middle is a finite, very hard smear instead of a
 * NaN; `lensFold` at 0 stops the sample point ever crossing the centre and
 * flipping the picture. Both are sliders, because both are also a *look* — but
 * neither happens by accident. The one place the sign genuinely flips is the
 * collapse, and that is authored (`lensFlips`) rather than emergent.
 *
 * ## What falls in
 *
 * `materials/SingularityMaterial.js` draws the accretion streams on a real
 * angular-momentum orbit — `r²·dθ/dt` conserved, `r` closing linearly on the
 * horizon, `θ` in closed form so the inside genuinely laps the outside — and
 * the event horizon disc, which is the only object in the project darker than
 * what it covers. `vfx/Swarm.js` supplies the dust as `MOTE` agents on a
 * lattice that contracts as the pull tightens; `vfx/GroundField.js` in `FUNNEL`
 * mode opens the floor under it.
 *
 * ## The rule that makes the editor work
 *
 * A cast captures exactly two things: `_seed`, so two wells do not draw the
 * same disc, and `_inverted`, the flag that says the collapse one-shot has
 * already fired. Both are events. Every metre, radian and second — the orbit
 * radii, the fall time, the horizon, the lens falloff, the mote spacing, the
 * depth of the hole — is resolved from `settings.singularity` inside the update
 * loop, on a zero-length frame included. Pause with **P** mid-pull and drag
 * `orbitRate`: the streams re-phase along their orbits, because θ is a function
 * of the slider rather than something that was integrated while you were
 * watching.
 */
export class SingularityAbility extends Ability {
  constructor(context) {
    super('singularity', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /* --- the infall: one instanced ribbon, one draw call --- */
    this.streamGeometry = createBoltRibbonGeometry(TRAIL_NODES, MAX_STREAMS);
    this.streamMaterial = createInfallMaterial();
    this.streamMesh = new Mesh(this.streamGeometry, this.streamMaterial);
    this.streamMesh.frustumCulled = false;
    this.streamMesh.matrixAutoUpdate = false;
    this.streamMesh.layers.set(LAYER.VFX);
    this.streamMesh.renderOrder = 11;
    this.group.add(this.streamMesh);

    /* --- the horizon, drawn *over* the streams so they end at it --- */
    this.horizonGeometry = new PlaneGeometry(1, 1, 1, 1);
    this.horizonMaterial = createHorizonMaterial();
    this.horizonMesh = new Mesh(this.horizonGeometry, this.horizonMaterial);
    this.horizonMesh.frustumCulled = false;
    this.horizonMesh.matrixAutoUpdate = false;
    this.horizonMesh.layers.set(LAYER.VFX);
    this.horizonMesh.renderOrder = 13;
    this.group.add(this.horizonMesh);

    /* --- the lens. The ability. --- */
    this.lens = new DistortionField({
      mode: DistortionMode.LENS,
      facing: DistortionFacing.BILLBOARD,
      name: 'Singularity:lens'
    });
    this.group.add(this.lens.object3D);

    /* --- the floor being drawn into it --- */
    this.funnel = new GroundField(this.group, {
      mode: GroundMode.FUNNEL,
      additive: false,
      name: 'Singularity:funnel'
    });
    this.funnel.setVisible(false);

    /* --- the dust --- */
    this.motes = new Swarm(this.group, {
      capacity: MAX_MOTES,
      silhouette: Silhouette.MOTE,
      additive: true,
      renderOrder: 12
    });

    /** Re-rolled per cast so no two wells draw the same disc. */
    this._seed = 0;
    /** Has the collapse one-shot fired yet? An event, not a dimension. */
    this._inverted = false;
    this._streamCount = 1;

    /**
     * The cast's beats, all unitless, refilled every frame. One object, reused.
     *
     *   open  0..1  how much of the well exists
     *   pull  0..1  how far through the long haul it is
     *   flip  1..0  the collapse impulse, decaying over `invertTime`
     *   blow  0..1  the outward throw
     *   fade  1..0  master opacity
     */
    this._b = { open: 0, pull: 0, flip: 0, blow: 0, fade: 1 };

    /** Scratch state handed to both bespoke materials. */
    this._state = {
      centre: new Vector3(),
      age: 0,
      seed: 0,
      open: 0,
      pull: 0,
      blow: 0,
      fade: 1
    };
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Dust: the one system in the project that uses the particle shader's
    // SWIRL path, and it is here because a well needs matter *orbiting* it
    // rather than drifting past. The trick is that `uSwirlExpand` is negative:
    // the offset from the anchor contracts over the particle's life, so each
    // mote runs a slow inward spiral about the well without a single line of
    // simulation. Emitted with zero speed so the anchor does not drift.
    this.dust = particles.get('singularity.dust', {
      capacity: 2400,
      shape: ParticleShape.SOFT,
      additive: true,
      swirl: true,
      softFade: 0.4
    });
    this.dust.uniforms.uDrag.value = 1.2;
    this.dust.uniforms.uEndSize.value = 0.35;
    this.dust.uniforms.uSizeIn.value = 0.1;
    this.dust.uniforms.uFadeIn.value = 0.12;
    this.dust.uniforms.uFadeOut.value = 0.45;

    // Chips torn off the floor. Lit rather than additive: the debris around a
    // black hole should be silhouetted against the glow, not part of it.
    this.shards = particles.get('singularity.shards', {
      capacity: 1200,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.shards.uniforms.uDrag.value = 0.4;
    this.shards.uniforms.uEndSize.value = 0.7;
    this.shards.uniforms.uFadeOut.value = 0.6;

    // What the collapse spits back out.
    this.sparks = particles.get('singularity.sparks', {
      capacity: 1600,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.25
    });
    this.sparks.uniforms.uDrag.value = 1.1;
    this.sparks.uniforms.uEndSize.value = 0.2;
    this.sparks.uniforms.uSizeIn.value = 0.02;
    this.sparks.uniforms.uFadeIn.value = 0.03;
    this.sparks.uniforms.uFadeOut.value = 0.4;

    this.dustEmitter = new RateEmitter();
    this.shardEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this._streamCount + this.motes.count;
  }

  /** Form and pull share the impact phase; the collapse owns the fade. */
  get impactDuration() {
    const c = settings.singularity;
    return Math.max(0.05, (c.formTime + c.pullTime) * settings.global.lifetime);
  }

  get fadeDuration() {
    const c = settings.singularity;
    return Math.max(0.05, c.invertTime + c.throwTime);
  }

  /**
   * A well does not gutter. It breathes, slowly, on the same clock the accretion
   * disc turns on — and the light is the only thing that can say "this is
   * getting worse" while the geometry stays the same size.
   */
  lightShimmer() {
    const c = settings.singularity;
    return 1 - c.lightBreathe * (0.5 - 0.5 * Math.cos(this.age * c.lightBreatheRate));
  }

  /* ------------------------------------------------------------------ */
  /* Geometry of the well — every metre resolved from live settings       */
  /* ------------------------------------------------------------------ */

  /**
   * Where the well hangs, in world space.
   *
   * While the front is still travelling the well is a *seed* riding it, low and
   * moving; once it lands it sits at `wellHeight` over the aimed circle. Both
   * ends of that lerp are sliders, so dragging `wellHeight` while paused lifts
   * a well that is already standing.
   */
  _wellPoint(out) {
    const c = settings.singularity;
    const s = this.phase === AbilityPhase.TRAVEL ? this.u : 1;
    this.pointAt(s, out);
    out.y = lerp(c.launchHeight, c.wellHeight, Easing.outQuad(s));
    return out;
  }

  /** The floor point under the well. */
  _floorPoint(out) {
    const s = this.phase === AbilityPhase.TRAVEL ? this.u : 1;
    return this.pointAt(s, out);
  }

  /**
   * Refill `this._b` from the phase clock. Fractions only — the beats decide
   * *how far through* something is, and the settings block decides how big it
   * is in metres.
   *
   * The two splits are worked out as fractions of their own phase rather than
   * in seconds, so `global.lifetime` stretches the pull without sliding the
   * form out from under it.
   *
   * @param {number} t 0..1 through the impact phase, then 1..2 through the fade
   */
  _resolveBeats(t) {
    const c = settings.singularity;
    const b = this._b;

    if (this.phase === AbilityPhase.TRAVEL) {
      b.open = c.seedOpen * Easing.outQuad(this.u);
      b.pull = 0;
      b.flip = 0;
      b.blow = 0;
      b.fade = 1;
      return;
    }

    if (t <= 1) {
      const formFrac = saturate(c.formTime / Math.max(c.formTime + c.pullTime, 1e-3));
      const f = saturate(t / Math.max(formFrac, 1e-3));
      b.open = lerp(c.seedOpen, 1, Easing.outCubic(f));
      b.pull = saturate((t - formFrac) / Math.max(1 - formFrac, 1e-3));
      b.flip = 0;
      b.blow = 0;
      b.fade = 1;
      return;
    }

    const flipFrac = saturate(c.invertTime / Math.max(c.invertTime + c.throwTime, 1e-3));
    const s = saturate(t - 1);
    // The impulse: 1 on the frame the well lets go, gone `invertTime` later.
    b.flip = 1 - saturate(s / Math.max(flipFrac, 1e-3));
    b.blow = Easing.outCubic(s);
    b.open = 1;
    b.pull = 1;
    // The well holds through the whole flip and *then* dies, so the frame the
    // lens is at its most violent is a frame at full opacity.
    b.fade = 1 - Easing.inCubic(saturate((s - flipFrac) / Math.max(1 - flipFrac, 1e-3)));
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.dustEmitter.reset();
    this.shardEmitter.reset();
    this._inverted = false;

    // The one thing a cast captures, besides the fired-yet flag.
    this._seed = Math.random() * 100;
    this.motes.roll(this._seed);

    this.lens.visible = true;
    this.funnel.setVisible(true);
    this.funnel.clearMarks();

    this._resolveBeats(0);
    this._sync();
    this._castFx();
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the current beats into everything that draws.
   *
   * Order matters in one place only: `_wellPoint` is resolved first and every
   * consumer is handed the same vector, so the lens, the horizon, the disc and
   * the light cannot disagree about where the hole is by a frame.
   */
  _sync() {
    const c = settings.singularity;
    const b = this._b;
    const state = this._state;

    this._wellPoint(state.centre);
    state.age = this.age;
    state.seed = this._seed;
    state.open = b.open;
    state.pull = b.pull;
    state.blow = b.blow;
    state.fade = b.fade;

    /* --- the infall --- */
    this._streamCount = Math.max(1, Math.min(MAX_STREAMS, Math.round(c.streams)));
    this.streamGeometry.instanceCount = this._streamCount;
    this.streamMaterial.userData.sync(state);

    /* --- the horizon --- */
    this.horizonMaterial.userData.sync(state);

    this._syncLens();
    this._syncFunnel();
    this._syncMotes();
    this._syncParticles();

    // The light lives on the well, not on the floor line the base class walks.
    this.position.copy(state.centre);
  }

  /**
   * The lens.
   *
   * Magnitudes here are **screen fractions**, not metres — the pass multiplies
   * by `post.distortion × global.distortion` exactly once, so nothing in this
   * method may touch either of them. `strength` is what a fragment at the
   * falloff edge displaces by; the 1/r² inside the emitter does the rest.
   */
  _syncLens() {
    const c = settings.singularity;
    const b = this._b;

    // The falloff is measured in metres in the emitter's own plane, so it keeps
    // its physical size as the camera moves — and the quad has to be exactly
    // twice it or the window is cut off square at the corners.
    const radius = c.lensRadius * c.zoneRadius * lerp(c.lensSeed, 1, b.open);
    _lens.width = radius * 2;
    _lens.height = radius * 2;
    _lens.radius = radius;
    _lens.window = c.lensWindow;
    _lens.core = c.lensCore;
    _lens.maxOffset = c.lensMax;

    // Ramps through the pull, then spikes on the flip. `Math.pow` on the open
    // beat rather than a lerp: a lens that fades in linearly reads as a
    // dissolve, and the whole point is that it *deepens*.
    const ramp = Math.pow(saturate(b.open), Math.max(0.05, c.lensCurve));
    _lens.strength =
      c.lensStrength * ramp * (1 + c.lensPull * b.pull) * (1 + c.lensBurst * b.flip) * b.fade;
    _lens.swirl = c.lensSwirl * (1 + c.lensSwirlPull * b.pull);

    // The sign flip. Sampling inward magnifies instead of compressing, which is
    // the frame everything is thrown out on; `lensFold` still refuses to let
    // the sample cross the centre unless somebody has asked it to.
    const flipping = c.lensFlips && b.flip > 0.001;
    _lens.invert = flipping || c.lensInverted ? 1 : 0;
    _lens.fold = c.lensFold;

    // See the class doc: 0 is deliberate, and 1 is why the floor stops bending.
    _lens.depthReject = c.lensDepthReject;
    _lens.depthFade = c.lensDepthFade;
    _lens.perspective = c.lensPerspective;
    _lens.perspectiveRef = c.lensPerspectiveRef;
    _lens.opacity = c.lensOpacity * b.fade;
    _lens.seed = this._seed;

    this.lens.setAnchor(this._state.centre);
    this.lens.update(_lens);
  }

  /** The hole the well is pulling the floor into. */
  _syncFunnel() {
    const c = settings.singularity;
    const b = this._b;

    _ground.centre = this._floorPoint(_floor);
    _ground.yaw = 0;
    _ground.height = c.funnelHeight;
    _ground.radius = c.funnelRadius * c.zoneRadius * lerp(c.funnelSeed, 1, b.open);
    _ground.grow = Easing.outCubic(saturate(b.open));
    _ground.recede = Easing.inQuad(saturate(1 - b.fade));
    _ground.fade = b.fade;
    _ground.seed = this._seed;

    _ground.edge = c.funnelEdge;
    _ground.ragged = c.funnelRagged;
    _ground.raggedScale = c.funnelRaggedScale;
    _ground.warp = c.funnelWarp;

    _ground.relief = c.funnelRelief;
    _ground.parallax = c.funnelParallax;
    _ground.cell = c.funnelCell;
    _ground.cellJitter = c.funnelCellJitter;
    _ground.seam = c.funnelSeam;
    _ground.thickness = c.funnelThickness;
    _ground.lift = c.funnelLift;
    // The pit deepens as the pull tightens — the one place the floor gets to
    // say how bad this is getting without moving a vertex.
    _ground.depth = c.funnelDepth * lerp(1, c.funnelDeepen, b.pull);
    _ground.sharp = c.funnelSharp;
    _ground.detail = c.funnelDetail;

    _ground.additive = false;
    _ground.emissive = c.funnelEmissive;
    _ground.opacity = c.funnelOpacity;
    _ground.depthFade = c.funnelDepthFade;
    _ground.colorBase = c.colorFunnelBase;
    _ground.colorEdge = c.colorFunnelEdge;
    _ground.colorGlow = c.colorFunnelGlow;
    _ground.colorDeep = c.colorFunnelDeep;

    const g = settings.global;
    _ground.noiseStrength = g.noiseStrength;
    _ground.noiseFrequency = g.noiseFrequency;
    _ground.noiseSpeed = g.noiseSpeed;
    _ground.opacityScale = g.opacity;

    this.funnel.update(_ground);
  }

  /**
   * The dust.
   *
   * `Swarm`'s formation is a lattice in the plane of the cast's side vector and
   * world up, centred on the lead point — which for `LeadPath.POINT` is the far
   * end of the cast line, i.e. exactly the well. Contracting the cell spacing
   * as the pull tightens is what winds the cloud in.
   *
   * `churn` is deliberately *not* ramped. It is a rate the shader multiplies by
   * the shared clock, so raising it mid-cast slews the whole formation by
   * `t · Δω` — with `t` being seconds since the app booted, that is hundreds of
   * radians in one frame. The angular acceleration in this ability lives in the
   * infall streams, where θ is closed form and can be re-evaluated at will.
   */
  _syncMotes() {
    const c = settings.singularity;
    const g = settings.global;
    const b = this._b;
    const p = _flock;

    p.count = Math.round(c.moteCount * g.particleCount);
    p.leadMode = LeadPath.POINT;
    p.endHeight = c.wellHeight;

    p.latticeX = c.moteLatticeX;
    p.latticeY = c.moteLatticeY;
    p.latticeZ = c.moteLatticeZ;

    // Contract on the pull, then thrown out on the collapse. One expression,
    // both beats, every metre from the block.
    const squeeze = lerp(1, c.moteCollapse, Easing.inOutCubic(b.pull));
    const eject = 1 + c.moteEject * b.blow;
    p.spacingSide = c.moteSpacing * squeeze * eject;
    p.spacingUp = c.moteSpacingUp * squeeze * eject;
    p.jitter = c.moteJitter * squeeze * g.randomness;
    p.lag = c.moteLag;
    p.churn = c.moteChurn;
    p.breathe = c.moteBreathe;
    p.breatheRate = c.moteBreatheRate;
    p.wander = c.moteWander * g.turbulence;
    p.wanderScale = c.moteWanderScale * g.noiseFrequency;
    p.wanderSpeed = c.moteWanderSpeed * g.noiseSpeed;
    p.gather = c.moteGather;

    p.size = c.moteSize * g.particleSize;
    p.aspect = c.moteAspect;
    p.sizeJitter = c.moteSizeJitter * g.randomness;
    p.billboard = 1;
    p.bank = 0;
    p.bankMax = 0;
    p.dihedral = 0;
    p.flapRate = 0;
    p.curl = 0;
    p.edgeStretch = c.moteEdgeStretch;
    p.reveal = saturate(b.open);
    p.revealSpread = c.moteRevealSpread;

    p.silhouette = Silhouette.MOTE;
    p.edgeGain = 1;
    p.lit = 0;
    p.tint = c.moteTint;
    p.tintJitter = c.moteTintJitter;
    p.tintAlong = c.moteTintAlong;
    p.opacity = c.moteOpacity * g.opacity * b.fade;
    p.glow = c.moteGlow * g.glow;
    p.softFade = c.moteSoftFade;

    this.motes.setColors(c.colorMoteA, c.colorMoteB, c.colorMoteC, c.colorMoteD);
    this.motes.setBasis(this.origin, this.direction, this.side, this.length);
    this.motes.update(this.age, p);
  }

  /** The three particle systems, re-coloured and re-scaled every frame. */
  _syncParticles() {
    const c = settings.singularity;
    const g = settings.global;

    this.dust.setGradient(
      getColor(c.colorDustA),
      getColor(c.colorDustB),
      getColor(c.colorDustC),
      getColor(c.colorDustD)
    );
    this.dust.uniforms.uGravity.value.set(0, c.dustRise, 0);
    this.dust.uniforms.uSizeScale.value = c.dustSize * g.particleSize * 7;
    this.dust.uniforms.uLifeScale.value = c.dustLifetime * 0.5 * g.particleLifetime;
    this.dust.uniforms.uSpeedScale.value = g.particleSpeed;
    this.dust.uniforms.uOpacity.value = c.dustOpacity * g.opacity;
    this.dust.uniforms.uGlow.value = c.dustGlow * g.glow;
    this.dust.uniforms.uTurbulence.value = c.dustTurbulence * g.turbulence;
    // The swirl pair: radians/second about the well, and a *negative* expansion
    // so the offset closes on the anchor instead of opening away from it.
    this.dust.uniforms.uSwirl.value = c.dustSwirl * (1 + c.dustSwirlPull * this._b.pull);
    this.dust.uniforms.uSwirlExpand.value = c.dustContract;

    this.shards.setGradient(
      getColor(c.colorShardA),
      getColor(c.colorShardB),
      getColor(c.colorShardC),
      getColor(c.colorShardD)
    );
    this.shards.uniforms.uGravity.value.set(0, c.shardGravity, 0);
    this.shards.uniforms.uSizeScale.value = c.shardSize * g.particleSize * 7;
    this.shards.uniforms.uLifeScale.value = c.shardLifetime * 0.5 * g.particleLifetime;
    this.shards.uniforms.uSpeedScale.value = g.particleSpeed;
    this.shards.uniforms.uOpacity.value = g.opacity;

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
    this.sparks.uniforms.uGlow.value = c.sparkGlow * g.glow;
    this.sparks.uniforms.uStretch.value = c.sparkStretch;
  }

  /** The seed leaving the caster's hand. */
  _castFx() {
    const c = settings.singularity;
    const g = settings.global;

    this._wellPoint(_pos);

    this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
      radius: c.castBurstSize * 0.9,
      endRadius: c.castBurstSize * 0.15,
      life: 0.35,
      intensity: c.castBurstIntensity,
      opacity: 0.85,
      fresnel: 2.2,
      displace: 0.35,
      colorA: getColor(c.colorCastA),
      colorB: getColor(c.colorCastB),
      colorC: getColor(c.colorCastC)
    });

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.4 * g.explosionIntensity;
  }

  /**
   * Dust drawn off the floor and chips torn out of it.
   *
   * Both are seeded on a ring at the *disc's outer radius*, resolved from the
   * same numbers the streams use, so the particles arrive on the same circle
   * the ribbons are riding rather than near it.
   *
   * @param {number} scale 0..1, thinned once the well is only holding
   */
  _wellFx(dt, scale) {
    const c = settings.singularity;
    const g = settings.global;
    const time = frame.uTime.value;
    const b = this._b;
    const rim = c.discOuter * c.zoneRadius * lerp(c.discSeed, 1, b.open);

    const dustCount = Math.round(this.dustEmitter.tick(dt, c.dustRate * scale) * g.particleCount);
    if (dustCount > 0) {
      const bearing = Math.random() * TAU;
      const r = rim * randRange(c.dustRing, 1.15);
      _pos.copy(this._state.centre);
      _pos.x += Math.cos(bearing) * r;
      _pos.z += Math.sin(bearing) * r;
      _pos.y += randRange(-1, 1) * c.dustSpread;

      _emit.position = _pos;
      _emit.radius = c.dustSpread;
      // The anchor is the well itself: the swirl path rotates the particle's
      // offset from *this* point, which is what makes the orbit an orbit.
      _emit.anchor = this._state.centre;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = 0;
      _emit.speedVariance = 0;
      _emit.spread = 1;
      _emit.inherit = null;
      _emit.size = 0.1;
      _emit.sizeVariance = 0.7;
      _emit.life = c.dustLifetime;
      _emit.lifeVariance = 0.35;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.dust.emit(dustCount, _emit);
    }

    const shardCount = Math.round(this.shardEmitter.tick(dt, c.shardRate * scale) * g.particleCount);
    if (shardCount > 0) {
      const bearing = Math.random() * TAU;
      const r = rim * randRange(0.5, 1.3);
      this._floorPoint(_pos);
      _pos.x += Math.cos(bearing) * r;
      _pos.z += Math.sin(bearing) * r;
      _pos.y += 0.08;

      // Thrown *at* the well rather than away from it: the direction is the
      // vector to the centre, which is the only place in this ability a
      // particle system gets to look like it is being pulled.
      _dir.copy(this._state.centre).sub(_pos).normalize();

      _emit.position = _pos;
      _emit.radius = c.shardSpread;
      _emit.anchor = null;
      _emit.direction = _dir;
      _emit.speed = c.shardSpeed;
      _emit.speedVariance = 0.5;
      _emit.spread = 0.35;
      _emit.inherit = null;
      _emit.size = 0.12;
      _emit.sizeVariance = 0.65;
      _emit.life = c.shardLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 9;
      _emit.tint = null;
      _emit.time = time;
      this.shards.emit(shardCount, _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._resolveBeats(0);
    this._sync();
    this._wellFx(dt, settings.singularity.travelEmission);
    this.ctx.shake.rumble(settings.singularity.rumble * settings.global.cameraShake, dt);
  }

  /** The well opens. */
  onImpact() {
    const c = settings.singularity;
    const g = settings.global;

    this._resolveBeats(0);
    this._wellPoint(_pos);

    this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
      radius: c.formBurstSize * g.explosionIntensity,
      endRadius: c.formBurstSize * 0.12,
      life: 0.55,
      intensity: c.formBurstIntensity,
      opacity: 0.9,
      fresnel: 2.4,
      displace: 0.4,
      squash: 0.85,
      colorA: getColor(c.colorFormA),
      colorB: getColor(c.colorFormB),
      colorC: getColor(c.colorFormC)
    });

    // A ring that runs *inward* is not something the decal system draws, so the
    // shockwave here is the honest one: the ground snapping as the well seats.
    this._floorPoint(_pos);
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _pos, {
      radius: c.formRingRadius * g.explosionIntensity,
      life: 0.55,
      width: 0.07,
      intensity: c.formRingIntensity,
      colorA: getColor(c.colorRingA),
      colorB: getColor(c.colorRingB)
    });

    this.ctx.shake.add(
      c.formShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      22
    );
    this.ctx.flash.trigger(getColor(c.colorFormFlash), c.formFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.7 * g.explosionIntensity;
  }

  onFade(dt, t) {
    // The collapse one-shot fires on the first frame of the fade phase, which
    // is the frame the lens changes sign. A flag, not a timestamp: the beats
    // below already know where in the phase we are.
    if (t > 1 && !this._inverted) {
      this._inverted = true;
      this._invertFx();
    }

    this._resolveBeats(t);
    this._sync();

    const b = this._b;
    // Dust keeps being drawn in right up to the flip, and then stops dead —
    // there is nothing left to fall in once the well has turned inside out.
    this._wellFx(dt, t <= 1 ? lerp(1, settings.singularity.holdEmission, b.pull) : 0);

    if (t <= 1) {
      this.ctx.shake.rumble(
        settings.singularity.rumble * (1 + b.pull * settings.singularity.rumblePull) *
          settings.global.cameraShake,
        dt
      );
    }
  }

  /** INVERT — the well lets go and throws everything back out. */
  _invertFx() {
    const c = settings.singularity;
    const g = settings.global;
    const time = frame.uTime.value;

    this._wellPoint(_pos);

    this.ctx.bursts.spawn(BurstMode.STORM, _pos, {
      radius: c.collapseSize * 0.15,
      endRadius: c.collapseSize * g.explosionIntensity,
      life: 0.8,
      intensity: c.collapseIntensity,
      opacity: 0.95,
      fresnel: 1.5,
      displace: 0.7,
      colorA: getColor(c.colorCollapseA),
      colorB: getColor(c.colorCollapseB),
      colorC: getColor(c.colorCollapseC)
    });

    _emit.position = _pos;
    _emit.radius = c.horizonRadius * 1.5;
    _emit.anchor = null;
    _emit.direction = _dir.set(0, 0.25, 0);
    _emit.speed = c.sparkSpeed;
    _emit.speedVariance = 0.8;
    _emit.spread = 1;
    _emit.inherit = null;
    _emit.size = 0.2;
    _emit.sizeVariance = 0.75;
    _emit.life = c.sparkLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.sparks.emit(Math.round(c.collapseSparks * g.particleCount), _emit);

    this._floorPoint(_pos);
    _emit.position = _pos;
    _emit.radius = c.discOuter * c.zoneRadius * 0.7;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.shardSpeed * c.collapseThrow;
    _emit.speedVariance = 0.7;
    _emit.spread = 0.9;
    _emit.size = 0.15;
    _emit.life = c.shardLifetime * 1.4;
    _emit.spin = 12;
    this.shards.emit(Math.round(c.collapseShards * g.particleCount), _emit);

    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _pos, {
      radius: c.collapseRingRadius * g.explosionIntensity,
      life: 0.7,
      width: 0.05,
      intensity: c.collapseRingIntensity,
      colorA: getColor(c.colorRingA),
      colorB: getColor(c.colorRingB)
    });
    this.ctx.decals.spawn(DecalType.CRACK, _pos, {
      radius: c.crackRadius,
      life: c.crackLife,
      width: c.crackBranches,
      intensity: c.crackIntensity,
      colorA: getColor(c.colorCrackA),
      colorB: getColor(c.colorCrackB)
    });

    this.ctx.shake.add(
      c.collapseShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      30
    );
    this.ctx.flash.trigger(getColor(c.colorCollapseFlash), c.collapseFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 2 * g.explosionIntensity;
  }

  onDestroy() {
    // Release the distortion writer. Hiding the group instead leaks it for the
    // session and the pass runs every frame with nothing in it.
    this.lens.visible = false;
    this.funnel.setVisible(false);
    this.funnel.clearMarks();
    this.motes.reset();
    this._inverted = false;
    this._streamCount = 1;
    this.streamGeometry.instanceCount = 1;
    this.streamMaterial.uniforms.uFade.value = 0;
    this.streamMaterial.uniforms.uOpen.value = 0;
    this.horizonMaterial.uniforms.uFade.value = 0;
  }

  dispose() {
    this.streamGeometry.dispose();
    this.streamMaterial.dispose();
    this.horizonGeometry.dispose();
    this.horizonMaterial.dispose();
    this.lens.dispose();
    this.funnel.dispose();
    this.motes.dispose();
    super.dispose();
  }
}
