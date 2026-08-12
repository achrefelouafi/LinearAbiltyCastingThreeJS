import { Mesh, Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import {
  createFirewalkPlacement,
  createPrintAttributes,
  createSoleGeometry,
  createPillarGeometry,
  createSoleMaterial,
  createPillarMaterial,
  setPillarGradient
} from '../../materials/FirewalkMaterial.js';
import { VolumeHull, HullShape, Medium } from '../../vfx/VolumeHull.js';
import { GroundField, GroundMode, groundFieldParams } from '../../vfx/GroundField.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, clamp, Easing } from '../../utils/math.js';

/**
 * Hard ceiling on footfalls in one cast. At the default `stepLength` of 1.15 m
 * this covers thirty metres, which is past the longest cast the block allows;
 * a shorter step runs out of prints before it runs out of line, and stopping
 * early is the right failure — the trail just does not reach the end.
 */
const MAX_PRINTS = 26;

/* Module-scope scratch. A burning trail allocates nothing — I3. */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _print = new Vector3();
/** The lane's params bag, filled from settings every frame and reused. */
const _lane = groundFieldParams();

/**
 * FIREWALK — a trail of burning footprints.
 *
 * A line cast. Something unseen walks the aimed line at `speed`, and each
 * footfall ignites where it lands: a sole burnt into the floor heel-first,
 * throwing a short pillar of flame as it lights. The prints hold, gutter, and
 * burn down to scars.
 *
 * ## THE TRICK — a silhouette, in the school that has none
 *
 * Flame is fifty per cent of the sandbox's raymarched volume and none of its
 * recognisable shapes. Every other slot in this school is a cloud, a jet or a
 * front: the medium erodes itself into whatever it erodes into, and the
 * silhouette is an accident of the noise on that frame. This one puts a
 * **signed distance field of an actual foot** on the floor — heel, medial arch,
 * ball, five separate toes — and lights them in sequence down the line,
 * alternating left and right about the centre line by `stride`.
 *
 * Three things had to be true before it read as a foot rather than as a scorch
 * blot, and all three cost a rewrite:
 *
 *  1. **The arch is an absence, not a pinch.** The first sole narrowed its waist
 *     symmetrically, which draws a dumbbell. A foot's waist is narrowed *and
 *     shifted laterally* — the arch is missing from the medial side only — and
 *     `archCut` is the slider that does it. Below about 0.25 the mark is a bean.
 *     Above it, it snaps into being a foot. There is no gradual middle.
 *  2. **The toes are separate.** They union with a hard `min` while everything
 *     else unions smoothly. Merge them into the ball and you have drawn a
 *     mitten, which at trail scale reads as a paw.
 *  3. **The alternation is the gait.** A single line of prints down the middle
 *     is a dotted line, whatever shape the dots are. Two lines taken in turn is
 *     a body. `stride` is a slider so you can watch that happen and un-happen.
 *
 * The ignition then runs **heel to toe** over `rollTime` inside each print,
 * because a footfall is a roll and not a stamp. It is the detail that makes a
 * still frame of the trail look walked rather than stencilled.
 *
 * ## What a cast captures
 *
 * Per print: two dice rolls (`aSeed`, `aWander`) and the timestamp the front
 * crossed it. Per cast: one more dice roll for the lane and the volume. Nothing
 * else. Every print's *position* is `origin + forward·(start + i·step) +
 * side·(±stride)` evaluated in the vertex shader from live uniforms, so dragging
 * `stepLength` on a paused trail re-spaces prints that are already burning and
 * takes their pillars, their pyre and their light with them.
 *
 * ## Cost
 *
 * Five drawables: the soles (one instanced quad, every print), the pillars (one
 * instanced billboard, every print), the pyre volume, the scorched lane, and
 * three shared particle systems. One dynamic light, riding the newest print.
 */
export class FirewalkAbility extends Ability {
  constructor(context) {
    super('firewalk', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /**
     * One uniform box, two materials. The sole and the pillar resolve the same
     * `printCentre()` from the same numbers, so a pillar cannot stand off its
     * own footprint however the two are updated. See `FirewalkMaterial`.
     */
    this.placement = createFirewalkPlacement();
    this.attributes = createPrintAttributes(MAX_PRINTS);

    this.soleGeometry = createSoleGeometry(this.attributes);
    this.soleMaterial = createSoleMaterial(this.placement);
    this.soleMesh = new Mesh(this.soleGeometry, this.soleMaterial);
    this.soleMesh.frustumCulled = false;
    this.soleMesh.matrixAutoUpdate = false;
    this.soleMesh.layers.set(LAYER.VFX);
    // Under the pillars, over the lane.
    this.soleMesh.renderOrder = 7;
    this.group.add(this.soleMesh);

    this.pillarGeometry = createPillarGeometry(this.attributes);
    this.pillarMaterial = createPillarMaterial(this.placement);
    this.pillarMesh = new Mesh(this.pillarGeometry, this.pillarMaterial);
    this.pillarMesh.frustumCulled = false;
    this.pillarMesh.matrixAutoUpdate = false;
    this.pillarMesh.layers.set(LAYER.VFX);
    this.pillarMesh.renderOrder = 12;
    this.group.add(this.pillarMesh);

    /**
     * The volume rides the print that just lit rather than covering the lane.
     * Coverage is what a raymarch costs, and a box over twenty metres of floor
     * spends its whole step budget crossing vacuum — see `VolumeHull`'s one
     * rule. A column half a metre across at twenty-six steps is nearly free,
     * and putting it on the newest print means the volumetric fire *walks*,
     * which is the beat the ability is selling.
     */
    this.pyre = new VolumeHull({
      hull: HullShape.CYLINDER,
      medium: Medium.FLAME,
      prefix: 'pyre',
      maxSteps: 40,
      renderOrder: 13
    });
    this.group.add(this.pyre.mesh);

    /**
     * The scorched lane. `RUT` because a walk gouges a track down the line and
     * each footfall is a contact sample on it: the burn is deeper and hotter
     * under a print than between two, which is `gfForce()` doing exactly the
     * job it was written for. A decal would have captured its length the frame
     * it spawned.
     */
    this.lane = new GroundField(this.group, {
      mode: GroundMode.RUT,
      marks: MAX_PRINTS,
      additive: false,
      name: 'Firewalk:lane'
    });
    this.lane.setVisible(false);

    /** Prints currently placed on the line — a count, re-derived every frame. */
    this._live = 0;
    /** The most recent print to have been stepped on, or -1. */
    this._newest = -1;
    /** One dice roll per cast, for the lane and the volume. */
    this._seed = 0;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // The embers lifting off a burning print. Additive and curled — these are
    // hot and they are going up.
    this.motes = particles.get('firewalk.motes', {
      capacity: 2200,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.35
    });
    this.motes.uniforms.uDrag.value = 1.3;
    this.motes.uniforms.uEndSize.value = 0.18;
    this.motes.uniforms.uSizeIn.value = 0.05;
    this.motes.uniforms.uFadeIn.value = 0.07;
    this.motes.uniforms.uFadeOut.value = 0.4;

    // The haze off the lane. Non-additive so it genuinely occludes: smoke that
    // adds light to the scene is a fog machine.
    this.smoke = particles.get('firewalk.smoke', {
      capacity: 1600,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.1
    });
    this.smoke.uniforms.uDrag.value = 1.8;
    this.smoke.uniforms.uEndSize.value = 3.0;
    this.smoke.uniforms.uSizeIn.value = 0.12;
    this.smoke.uniforms.uFadeIn.value = 0.18;
    this.smoke.uniforms.uFadeOut.value = 0.32;

    // Sparks kicked out sideways by the impact of a footfall. Velocity-stretched
    // streaks under gravity, thrown once per print rather than at a rate — a
    // step is an event.
    this.sparks = particles.get('firewalk.sparks', {
      capacity: 2000,
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

    this.moteEmitter = new RateEmitter();
    this.smokeEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  /** Two instanced meshes over the same prints. */
  get instanceCount() {
    return this._live * 2;
  }

  /** The trail burns after the last footfall... */
  get impactDuration() {
    return Math.max(0.05, settings.firewalk.lifetime * settings.global.lifetime);
  }

  /** ...and then burns down to a scar. */
  get fadeDuration() {
    return Math.max(0.05, settings.firewalk.fadeTime);
  }

  /** Fire gutters. A hard, quantised stutter on its own clock. */
  lightShimmer() {
    const c = settings.firewalk;
    const step = Math.floor(this.age * Math.max(1, c.lightFlickerSpeed));
    const noise = Math.abs(Math.sin(step * 91.7) * 43758.5453) % 1;
    return 1 - saturate(c.lightFlicker) * noise;
  }

  /* ------------------------------------------------------------------ */
  /* The gait — every metre resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  /** Metres between footfalls, floored so a zeroed slider cannot divide by it. */
  _stepLength() {
    return Math.max(0.05, settings.firewalk.stepLength);
  }

  /** How many prints fit on this cast, right now. */
  _printCount() {
    const c = settings.firewalk;
    const reach = this.length - c.startOffset;
    if (reach < 0) return 0;
    return clamp(Math.floor(reach / this._stepLength()) + 1, 0, MAX_PRINTS);
  }

  /** Metres down the line print `index` lands at. */
  _printDistance(index) {
    return settings.firewalk.startOffset + index * this._stepLength();
  }

  /**
   * Where print `index` is, in world space.
   *
   * This mirrors `printCentre()` in the vertex shader exactly — the same
   * alternation, the same stride, the same dice roll out of the same attribute
   * — so the sparks, the light and the pyre stand *on* the print the GPU drew
   * rather than near it. The dice roll is an attribute and not a hash of the
   * seed precisely so that this function can read it.
   */
  _printPoint(index, out) {
    const c = settings.firewalk;
    const side = index % 2 === 0 ? -1 : 1;
    const wander = this.attributes.aWander.array[index] ?? 0;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, this._printDistance(index))
      .addScaledVector(this.side, side * c.stride + wander * c.wander);
    out.y = c.printLift;
    return out;
  }

  /** Yaw of the cast, radians — the frame the lane's grain is authored in. */
  _yaw() {
    return Math.atan2(this.direction.x, this.direction.z);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.moteEmitter.reset();
    this.smokeEmitter.reset();
    this.lane.clearMarks();

    this._newest = -1;
    this._seed = Math.random() * 100;

    // Re-roll the per-print dice and blank every birth. Dice rolls and
    // timestamps: the only two things a cast is allowed to write down.
    const seed = this.attributes.aSeed.array;
    const wander = this.attributes.aWander.array;
    const birth = this.attributes.aBirth.array;
    for (let i = 0; i < MAX_PRINTS; i++) {
      seed[i] = Math.random() * 100;
      wander[i] = Math.random() * 2 - 1;
      birth[i] = -1;
    }
    this.attributes.aSeed.needsUpdate = true;
    this.attributes.aWander.needsUpdate = true;
    this.attributes.aBirth.needsUpdate = true;

    this._sync(1);
    this._castFx();
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the current beat into everything that draws.
   *
   * @param {number} fade 1 while the trail burns, ramping to 0 as it dies
   */
  _sync(fade) {
    this._live = this._printCount();
    this.soleGeometry.instanceCount = this._live;
    this.pillarGeometry.instanceCount = this._live;

    this._syncPlacement();
    this._syncSole(fade);
    this._syncPillars(fade);
    this._syncPyre(fade);
    this._syncLane(fade);
    this._syncParticles();
  }

  /** The nine numbers both meshes place themselves from. Shared by identity. */
  _syncPlacement() {
    const c = settings.firewalk;
    const p = this.placement;
    p.uOrigin.value.copy(this.origin);
    p.uForward.value.copy(this.direction);
    p.uSide.value.copy(this.side);
    p.uStart.value = c.startOffset;
    p.uStep.value = this._stepLength();
    p.uStride.value = c.stride;
    p.uWander.value = c.wander;
    p.uLift.value = c.printLift;
    p.uNow.value = this.age;
  }

  _syncSole(fade) {
    const c = settings.firewalk;
    const g = settings.global;
    const u = this.soleMaterial.uniforms;

    u.uFootLength.value = c.footLength;
    u.uFootWidth.value = c.footWidth;
    u.uPad.value = c.solePad;
    u.uToeOut.value = c.toeOut;

    u.uHeelWidth.value = c.heelWidth;
    u.uBallWidth.value = c.ballWidth;
    u.uArchCut.value = saturate(c.archCut);
    u.uSoleRound.value = c.soleRound;
    u.uToeSize.value = c.toeSize;
    u.uToeSpread.value = c.toeSpread;
    u.uToeGap.value = c.toeGap;

    u.uRim.value = c.soleRim;
    u.uHalo.value = c.soleHalo;
    u.uEdge.value = c.soleEdge;
    u.uRollTime.value = c.rollTime;
    u.uFlashTime.value = c.flashTime;
    // The global lifetime multiplier belongs on anything that decides how long
    // a thing is visible, and this is the sole's whole life.
    u.uCoolTime.value = c.coolTime * g.particleLifetime;
    u.uCharTime.value = c.charTime;
    u.uGrain.value = c.soleGrain * g.noiseFrequency;
    u.uVein.value = c.soleVein;
    u.uRagged.value = c.soleRagged * g.noiseStrength;
    u.uOpacity.value = c.soleOpacity * g.opacity;
    u.uGlow.value = c.soleGlow * g.glow;
    u.uFade.value = fade;
    u.uSoftFade.value = c.soleSoftFade;

    u.uColorFlash.value.copy(getColor(c.colorFlash));
    u.uColorEmber.value.copy(getColor(c.colorEmber));
    u.uColorChar.value.copy(getColor(c.colorChar));
    u.uColorAsh.value.copy(getColor(c.colorAsh));
    u.uColorHalo.value.copy(getColor(c.colorHalo));
  }

  _syncPillars(fade) {
    const c = settings.firewalk;
    const g = settings.global;
    const u = this.pillarMaterial.uniforms;

    u.uHeight.value = c.pillarHeight;
    u.uWidth.value = c.pillarWidth;
    u.uRiseTime.value = c.pillarRise;
    u.uFallTime.value = c.pillarFall * g.lifetime;
    u.uLean.value = c.pillarLean;
    u.uWaver.value = c.pillarWaver;
    u.uWaverRate.value = c.pillarWaverRate;

    u.uTaper.value = c.pillarTaper;
    u.uBulge.value = c.pillarBulge;
    u.uNoiseScale.value = c.pillarNoiseScale * g.noiseFrequency;
    u.uNoiseSpeed.value = c.pillarNoiseSpeed * g.noiseSpeed;
    u.uErosion.value = c.pillarErosion * g.noiseStrength;
    u.uOpacity.value = c.pillarOpacity * g.opacity;
    u.uGlow.value = c.pillarGlow * g.glow;
    u.uFade.value = fade;
    u.uSoftFade.value = c.pillarSoftFade;

    setPillarGradient(
      this.pillarMaterial,
      c.colorPillarA,
      c.colorPillarB,
      c.colorPillarC,
      c.colorPillarD
    );
  }

  /** The volume, standing on whichever print lit most recently. */
  _syncPyre(fade) {
    const c = settings.firewalk;
    const g = settings.global;

    if (this._newest < 0) {
      this.pyre.setFade(0).sync(c, g);
      return;
    }

    this._printPoint(this._newest, _print);
    const since = this.age - this.attributes.aBirth.array[this._newest];
    // It burns down on the print it is standing on, and jumps to the next when
    // that one lights. `linger` is live, so a paused pyre re-times.
    const heat = Math.exp(-Math.max(since, 0) / Math.max(0.05, c.pyreLinger));

    // Margin holds the flame that fraction of the way inside the proxy, so the
    // hull has to be bigger than the fire you want by exactly that much or the
    // volume is sliced along a straight line at the wall. `pyreSlack` is the
    // extra on top for the erosion to spill into.
    const k = Math.max(1, c.pyreSlack) / Math.max(0.2, 1 - c.pyreMargin);
    this.pyre
      .place(_print)
      .setSize(c.pyreWidth * k, c.pyreHeight * k, c.pyreWidth * k)
      .setFade(heat * fade)
      .sync(c, g);
  }

  /** The scorched lane, drawn by the walk's own progress down the line. */
  _syncLane(fade) {
    const c = settings.firewalk;
    const g = settings.global;

    _lane.centre = this.origin;
    _lane.yaw = this._yaw();
    _lane.height = c.laneHeight;
    _lane.radius = c.laneReach;
    _lane.length = this.length;

    // RUT ignores `grow` and draws everything behind `progress`, with a hot lip
    // at the front — which is the walker, so it is `u` while travelling and
    // pinned at the far end after.
    _lane.grow = 1;
    _lane.recede = 0;
    _lane.progress = this.phase === AbilityPhase.TRAVEL ? saturate(this.u) : 1;
    _lane.fade = fade;
    _lane.seed = this._seed;

    _lane.edge = c.laneEdge;
    _lane.ragged = c.laneRagged;
    _lane.raggedScale = c.laneRaggedScale;
    _lane.warp = c.laneWarp;

    _lane.relief = c.laneRelief;
    _lane.normalStep = c.laneNormalStep;
    _lane.ambient = c.laneAmbient;
    _lane.wrap = c.laneWrap;
    _lane.specular = c.laneSpecular;
    _lane.gloss = c.laneGloss;
    _lane.parallax = c.laneParallax;

    _lane.cell = c.laneCell;
    _lane.seam = c.laneSeam;
    _lane.thickness = c.laneThickness;
    _lane.width = c.laneWidth;
    _lane.depth = c.laneDepth;
    _lane.lift = c.laneLift;
    _lane.sharp = c.laneSharp;
    _lane.detail = c.laneDetail;
    _lane.swirl = c.laneSwirl;

    _lane.markLife = c.laneMarkLife;
    _lane.markRadius = c.laneMarkRadius;

    _lane.additive = false;
    _lane.emissive = c.laneEmissive;
    _lane.opacity = c.laneOpacity;
    _lane.depthFade = c.laneDepthFade;
    _lane.colorBase = c.colorLaneBase;
    _lane.colorEdge = c.colorLaneEdge;
    _lane.colorGlow = c.colorLaneGlow;
    _lane.colorDeep = c.colorLaneDeep;

    _lane.noiseStrength = g.noiseStrength;
    _lane.noiseFrequency = g.noiseFrequency;
    _lane.noiseSpeed = g.noiseSpeed;
    _lane.opacityScale = g.opacity;

    this.lane.update(_lane);
    this.lane.setVisible(fade > 0.004);
  }

  _syncParticles() {
    const c = settings.firewalk;
    const g = settings.global;

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
    this.motes.uniforms.uGlow.value = c.moteGlow * g.glow;
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;

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
    this.smoke.uniforms.uTurbulence.value = 0.3 * g.turbulence;

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
    this.sparks.uniforms.uGlow.value = c.soleGlow * 0.5 * g.glow;
    this.sparks.uniforms.uStretch.value = c.sparkStretch;
  }

  /* ------------------------------------------------------------------ */
  /* Events                                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Light every print the front has now passed.
   *
   * Gated to the travel phase on purpose. Re-spacing the trail with
   * `stepLength` mid-burn moves the prints that are already lit — which is I1
   * working — but it must not *ignite* new ones, or a paused editor session
   * would keep firing footfalls at whatever point the slider happens to cross.
   */
  _igniteReached() {
    const count = this._printCount();
    const birth = this.attributes.aBirth.array;
    for (let i = 0; i < count; i++) {
      if (birth[i] >= 0) continue;
      if (this._printDistance(i) > this.front) break;
      birth[i] = this.age;
      this.attributes.aBirth.needsUpdate = true;
      this._newest = i;
      this._footfall(i);
    }
  }

  /**
   * One footfall: sparks kicked sideways, a contact sample posted to the lane,
   * a small kick in the camera and a punch of light.
   */
  _footfall(index) {
    const c = settings.firewalk;
    const g = settings.global;

    this._printPoint(index, _print);

    // The lane's contact sample. Unitless: a fraction along the track, a
    // fraction of the radius across it, a timestamp and a strength — so the
    // burn re-places itself when the lane's radius or the cast's length moves.
    const across = ((index % 2 === 0 ? -1 : 1) * c.stride) / Math.max(0.05, c.laneReach);
    this.lane.mark(
      clamp(across, -1, 1),
      saturate(this._printDistance(index) / this.length),
      frame.uTime.value,
      1
    );

    const sparks = Math.round(c.sparkStamp * g.particleCount);
    if (sparks > 0) {
      _emit.position = _pos.copy(_print).setY(c.printLift + 0.02);
      _emit.radius = c.footWidth * 0.5;
      // Kicked forward and out, the way grit goes when a boot lands on it.
      _emit.direction = _dir.copy(this.direction).multiplyScalar(0.55).setY(0.8).normalize();
      _emit.speed = c.sparkSpeed;
      _emit.speedVariance = 0.85;
      _emit.spread = 0.95;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.12;
      _emit.sizeVariance = 0.7;
      _emit.life = c.sparkLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = frame.uTime.value;
      this.sparks.emit(sparks, _emit);
    }

    this.ctx.shake.add(
      c.stampShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      20
    );
    this.lightBoost = c.lightIntensity * 0.35 * g.explosionIntensity;
  }

  /** The flare as the first step is taken. */
  _castFx() {
    const c = settings.firewalk;
    const g = settings.global;

    this._printPoint(0, _pos);
    this.ctx.bursts.spawn(BurstMode.FIRE, _pos, {
      radius: c.footLength * 0.4,
      endRadius: c.footLength * 2.2 * g.explosionIntensity,
      life: 0.45,
      intensity: 1.4,
      opacity: 0.7,
      fresnel: 1.5,
      displace: 0.6,
      squash: 0.55,
      colorA: getColor(c.colorPillarC),
      colorB: getColor(c.colorPillarB),
      colorC: getColor(c.colorFlash)
    });

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.5 * g.explosionIntensity;
  }

  /**
   * What the burning trail sheds: embers off the prints, haze off the lane.
   *
   * @param {number} scale 0..1 — thinned out as the trail dies
   */
  _trailFx(dt, scale) {
    const c = settings.firewalk;
    const g = settings.global;
    const time = frame.uTime.value;
    const lit = this._newest + 1;
    if (lit <= 0) return;

    const moteCount = Math.round(this.moteEmitter.tick(dt, c.moteRate * scale) * g.particleCount);
    if (moteCount > 0) {
      // Off a print chosen at random from the ones that are lit, weighted to
      // the newest by squaring the roll: the front of the trail is the part
      // that is really burning.
      const pick = Math.min(lit - 1, Math.floor((1 - Math.random() * Math.random()) * lit));
      this._printPoint(pick, _pos);
      _emit.position = _pos;
      _emit.radius = c.footLength * 0.45;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.85;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.07;
      _emit.sizeVariance = 0.7;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.motes.emit(moteCount, _emit);
    }

    const smokeCount = Math.round(this.smokeEmitter.tick(dt, c.smokeRate * scale) * g.particleCount);
    if (smokeCount > 0) {
      // Smoke comes off the *lane*, not off a print: it is the floor burning.
      const pick = Math.min(lit - 1, Math.floor(Math.random() * lit));
      this._printPoint(pick, _pos).setY(0.12);
      _emit.position = _pos;
      _emit.radius = c.laneWidth * 1.4;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.smokeSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.9;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.7;
      _emit.sizeVariance = 0.5;
      _emit.life = c.smokeLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.35;
      _emit.tint = null;
      _emit.time = time;
      this.smoke.emit(smokeCount, _emit);
    }
  }

  /** Park the light on the newest print, at the height the settings ask for. */
  _placeLight() {
    const c = settings.firewalk;
    if (this._newest < 0) {
      this.position.copy(this.origin);
      this.position.y = c.lightHeight;
      return;
    }
    this._printPoint(this._newest, this.position);
    this.position.y = c.printLift + c.lightHeight;
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._igniteReached();
    this._sync(1);
    this._placeLight();
    this._trailFx(dt, 1);
    this.ctx.shake.rumble(settings.firewalk.rumble * settings.global.cameraShake, dt);
  }

  /** The walk reaches the end: light anything the front skipped past. */
  onImpact() {
    const count = this._printCount();
    const birth = this.attributes.aBirth.array;
    for (let i = 0; i < count; i++) {
      if (birth[i] >= 0) continue;
      birth[i] = this.age;
      this.attributes.aBirth.needsUpdate = true;
      this._newest = i;
      this._footfall(i);
    }
  }

  onFade(dt, t) {
    // `t` runs 0..1 while the trail burns, then 1..2 while it burns down. Cubic
    // on the way out so the prints hang on as scars and then let go, rather
    // than dimming evenly from the moment the walk finishes.
    const fade = t <= 1 ? 1 : 1 - Easing.inCubic(saturate(t - 1));
    this._sync(fade);
    this._placeLight();
    this._trailFx(dt, fade * (t <= 1 ? 0.7 : 0.3));
    this.ctx.shake.rumble(settings.firewalk.rumble * 0.4 * fade * settings.global.cameraShake, dt);
  }

  onDestroy() {
    this._newest = -1;
    this._live = 0;
    this.soleGeometry.instanceCount = 0;
    this.pillarGeometry.instanceCount = 0;
    this.soleMaterial.uniforms.uFade.value = 0;
    this.pillarMaterial.uniforms.uFade.value = 0;
    this.pyre.setFade(0);
    this.lane.setVisible(false);
    this.lane.clearMarks();
  }

  dispose() {
    this.soleGeometry.dispose();
    this.pillarGeometry.dispose();
    this.soleMaterial.dispose();
    this.pillarMaterial.dispose();
    this.pyre.dispose();
    this.lane.dispose();
    super.dispose();
  }
}
