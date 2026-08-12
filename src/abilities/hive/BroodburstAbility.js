import { BufferGeometry, BufferAttribute, Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { GrowthField, GrowthLayout, GrowthEmerge, growthParams } from '../../vfx/GrowthField.js';
import { ColonySwarm, ColonyShape, colonySwarmParams } from '../../vfx/Colony.js';
import { LeadPath } from '../../vfx/Swarm.js';
import { GroundField, GroundMode, groundFieldParams } from '../../vfx/GroundField.js';
import { createBroodEggMaterial } from '../../materials/BroodEggMaterial.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, clamp, lerp, Easing } from '../../utils/math.js';

const TAU = Math.PI * 2;

/** Hard ceiling on eggs per cast. The editor's `eggs` slider clamps here. */
const MAX_EGGS = 72;
/** Hard ceiling on crawlers. The editor's `crawlers` slider clamps here. */
const MAX_CRAWLERS = 256;
/**
 * Distinct shell silhouettes. Three, for the reason `GrowthField` documents —
 * scaling one mesh forty ways reads as a repeated prop the moment the camera
 * moves. Here the variants differ in where their **seam** wanders, which is the
 * one feature of an egg the eye actually tracks, and in nothing else.
 */
const VARIANTS = 3;

/* Module-scope scratch. Nothing in the frame path allocates — invariant I3. */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _centre = new Vector3();
const _hand = new Vector3();

/**
 * The half-width of a half-shell at height `v`, in radians.
 *
 * Both halves ask this question with the same arguments and get the same
 * answer, which is the entire reason the closed egg has no gap in it. The two
 * seam edges wander independently — `edge = 0` is the one at bearing +π/2,
 * `edge = 1` the one at −π/2 — so the tear is not symmetric and the shell does
 * not read as a machined clamshell.
 *
 * Two sines rather than one: a single wave gives a smooth S-curve down the side
 * of the egg, which looks *cut*. Beating two incommensurable frequencies gives a
 * line that changes its mind, which looks torn.
 */
function seamBearing(v, tear, variant, edge) {
  const k = variant * 3.77 + edge * 11.3;
  const w =
    Math.sin(v * 9.1 + k) * 0.62 + Math.sin(v * 17.7 + k * 1.7) * 0.38;
  return (edge === 0 ? Math.PI * 0.5 : -Math.PI * 0.5) + tear * w;
}

/**
 * One egg, in `GrowthField`'s unit space: footprint inside a circle of radius
 * 0.5 on `y = 0`, tip at `y = 1`.
 *
 * Built as **two separate half-shells** that meet along a torn seam, because
 * that is the only way the split can be a rigid motion rather than a stretch.
 * The halves are separate vertex blocks with duplicated vertices along the seam,
 * so the closed egg shows no join and the open one has two real edges.
 *
 * Each half is closed at the bottom with a fan cap. Without it, the moment the
 * halves swing outward you look straight up through the floor into a shell with
 * no bottom, and the illusion of a thing that had *contained* something goes
 * with it. There is no cap at the top: the profile already collapses to the axis
 * at `v = 1`.
 *
 * The profile is `sin(π·(0.12 + 0.88·v))^0.7` tapered toward the crown, sampled
 * from 0.12 rather than 0 so the base is a disc rather than a point — an egg
 * bedded into the ground, which is what `eggSink` then pushes into it.
 */
function createEggGeometry(variant, shape) {
  const rings = Math.max(6, Math.min(28, Math.round(shape.rings)));
  const sides = Math.max(5, Math.min(24, Math.round(shape.sides)));
  const tear = Math.max(0, Math.min(0.6, shape.tear));

  // Per half: (rings + 1) × (sides + 1) shell vertices plus one cap centre.
  const perHalf = (rings + 1) * (sides + 1) + 1;
  const total = perHalf * 2;
  // Per half: rings × sides quads, plus a fan of `sides` triangles at the base.
  const triangles = (rings * sides * 2 + sides) * 2;

  const position = new Float32Array(total * 3);
  const shell = new Float32Array(total * 4);
  const shellSide = new Float32Array(total);
  const index = new Uint16Array(triangles * 3);

  let vtx = 0;
  let tri = 0;

  for (let h = 0; h < 2; h++) {
    const sign = h === 0 ? 1 : -1;
    const base = vtx;

    for (let j = 0; j <= rings; j++) {
      const v = j / rings;
      const profile =
        Math.pow(Math.max(0, Math.sin(Math.PI * (0.12 + 0.88 * v))), 0.7) * (1 - 0.28 * v);
      const r = 0.5 * profile;

      // Half A sweeps from the −π/2 seam up through 0 to the +π/2 seam; half B
      // takes the rest of the turn. Both read the same two boundaries.
      const a0 = h === 0 ? seamBearing(v, tear, variant, 1) : seamBearing(v, tear, variant, 0);
      const a1 =
        h === 0 ? seamBearing(v, tear, variant, 0) : seamBearing(v, tear, variant, 1) + TAU;

      for (let k = 0; k <= sides; k++) {
        const f = k / sides;
        const bearing = a0 + (a1 - a0) * f;
        position[vtx * 3] = Math.cos(bearing) * r;
        position[vtx * 3 + 1] = v;
        position[vtx * 3 + 2] = Math.sin(bearing) * r;
        // (cos, sin) rather than the bearing itself: an angle wraps from 1 back
        // to 0 across one quad and every egg grows a bright seam down a side
        // that has nothing to do with the real one. Same reasoning, same fix, as
        // `VineBarkMaterial`'s ring coordinate.
        shell[vtx * 4] = v;
        shell[vtx * 4 + 1] = Math.cos(bearing);
        shell[vtx * 4 + 2] = Math.sin(bearing);
        // 1 exactly on the torn edge, 0 by the middle of the half.
        shell[vtx * 4 + 3] = Math.abs(f * 2 - 1);
        shellSide[vtx] = sign;
        vtx++;
      }
    }

    const capCentre = vtx;
    position[capCentre * 3] = 0;
    position[capCentre * 3 + 1] = 0;
    position[capCentre * 3 + 2] = 0;
    shell[capCentre * 4] = 0;
    shell[capCentre * 4 + 1] = 1;
    shell[capCentre * 4 + 2] = 0;
    shell[capCentre * 4 + 3] = 0;
    shellSide[capCentre] = sign;
    vtx++;

    const stride = sides + 1;
    for (let j = 0; j < rings; j++) {
      for (let k = 0; k < sides; k++) {
        const n0 = base + j * stride + k;
        const n1 = n0 + 1;
        const n2 = n0 + stride;
        const n3 = n2 + 1;
        index[tri++] = n0;
        index[tri++] = n2;
        index[tri++] = n1;
        index[tri++] = n1;
        index[tri++] = n2;
        index[tri++] = n3;
      }
    }
    for (let k = 0; k < sides; k++) {
      index[tri++] = base + k;
      index[tri++] = base + k + 1;
      index[tri++] = capCentre;
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(position, 3));
  geometry.setAttribute('aShell', new BufferAttribute(shell, 4));
  geometry.setAttribute('aSide', new BufferAttribute(shellSide, 1));
  geometry.setIndex(new BufferAttribute(index, 1));
  // `flatShading` recomputes the normal from screen derivatives, so these are
  // only ever read by the depth material three generates for the shadow pass.
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * BROODBURST — a clutch that swells, splits, and lets something out.
 *
 * Four beats:
 *
 *   1. **travel** — the clutch is carried out along the aimed line to the
 *      circle, trailing spore haze.
 *   2. **lay & swell** — the first part of the impact phase. Eggs accrete in
 *      place on a wave that runs from the middle of the circle outward, and each
 *      one immediately starts its **own** clock: it inflates, the shell thins
 *      until the thing inside is visible through it, and then the seam gives.
 *   3. **crawl** — as each egg splits it lets its crawlers out. They pin to the
 *      floor, mill about the husks, and close into a ring that keeps widening.
 *   4. **scatter** — the fade. The husks sink, the ring lets go, and the
 *      crawlers wink out one by one in the order they arrived.
 *
 * **THE TRICK, part one — every egg has its own timer, and the timer is the
 * shell.** `GrowthField` writes one per-instance number, `aBirth`, counting 1 to
 * 0 over its live `birthFade`; this ability hands `birthFade` the sum of its
 * rise and its swell, so `1 - aBirth` is a complete per-egg hatch ramp that the
 * field re-resolves every frame. `BroodEggMaterial` puts every beat of the
 * hatch on thresholds of that one number — `swellAt`, `splitAt`, `splitSpan`,
 * `huskAt` — so inflation, translucency and the split are three sliders over a
 * clutch that is already standing. Because the eggs are laid on a *radial* wave
 * and each carries a random stagger, the middle of the circle is hatching while
 * the rim is still swelling, and nothing anywhere is synchronised.
 *
 * The first version drove the swell off the ability's own clock and multiplied
 * it into the material as one uniform. Forty eggs pulsed and split on the same
 * frame, which does not read as forty eggs; it reads as one mesh drawn forty
 * times, which is exactly what it is and exactly what must not show.
 *
 * **THE TRICK, part two — the crawlers follow the floor.** `ColonySwarm`'s
 * `cling` is applied *after* the flock and after the shape blend, in the same
 * function that carries the density wave, so an agent's y is overwritten with
 * `floorY + crawlHeight` at the very end and the finite difference that drives
 * its bank is taken from the clung position. The result is a swarm whose
 * separation lattice, cohesion lag and banking all still work but which is
 * physically unable to leave the ground. Every other swarm in the sandbox is a
 * cloud in the air; this one is a carpet, and the difference is one slider.
 *
 * `crawlHeight` is authored in centimetres for that reason. Take it past about
 * 0.3 m and they are flying again, and the ability quietly becomes Emberflight
 * with worse colours.
 *
 * **The hatch ledger.** The CPU has to know when an egg splits, because that is
 * when it throws goo, sheds shell fragments and releases its crawlers. It does
 * *not* keep a timer for it: `GrowthField.records[i].eruptTime` is a timestamp,
 * the split offset is `(riseTime + swellTime) · splitAt` resolved live, and the
 * comparison is redone every frame. Drag `splitAt` backwards on a paused frame
 * and eggs that had hatched un-hatch — the ledger clears their flag and they
 * hatch again when the clock passes them. That is not a bug being tolerated; it
 * is what "no dimensions on the CPU" costs and it is cheaper than the
 * alternative, which is an accumulator that goes stale the moment a slider
 * moves.
 *
 * A cast captures the field's dice, the swarm's seed, and one byte per egg
 * saying whether it has already been given its burst. Nothing else. Five draw
 * calls: three egg variants, the crawlers, and the slick.
 */
export class BroodburstAbility extends Ability {
  constructor(context) {
    super('broodburst', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    const c = settings.broodburst;

    this.material = createBroodEggMaterial(this.ctx.environment);

    /** Live params, allocated once. Refilled from settings every frame — I1. */
    this.growth = growthParams();
    this.growth.layout = GrowthLayout.ZONE;
    // SCALE, not PUSH. An egg is *laid*, it does not erupt: PUSH slides it up
    // out of the floor from underneath, which reads as the ground giving birth
    // rather than as something having been put there.
    this.growth.emerge = GrowthEmerge.SCALE;
    this.growth.centre = new Vector3();

    /** The three numbers that cannot be a uniform, so they rebuild the mesh. */
    this.shape = { rings: c.eggRings, sides: c.eggSides, tear: c.seamTear };

    this.field = new GrowthField(this.group, {
      geometry: createEggGeometry,
      material: this.material,
      shape: this.shape,
      variants: VARIANTS,
      capacity: MAX_EGGS,
      layer: LAYER.WORLD,
      renderOrder: 2,
      // The depth material three generates for the shadow pass is not patched,
      // so it would cast the shadow of the *closed* egg over an open husk. A
      // wrong shadow is louder than no shadow — the same call `BloomburstAbility`
      // makes, for the same reason.
      castShadow: false,
      receiveShadow: true
    });

    /** The crawlers. One draw call, however many of them there are. */
    this.crawlers = new ColonySwarm(this.group, {
      capacity: MAX_CRAWLERS,
      // The silhouette is a compile-time choice in `Swarm`'s vertex shader only
      // in the sense that it branches on a uniform; `crawlShape` moves it live.
      additive: false,
      renderOrder: 12
    });
    /** Live swarm params, allocated once. */
    this.flock = colonySwarmParams();

    /**
     * The wet the clutch is bedded in. WET rather than POOL because a slick is
     * darkened, reflective stone that dries from the edges in — it stays *floor*
     * — where POOL is standing liquid with a body and a meniscus, and crawlers
     * scuttling across the surface of a pond is a different ability.
     */
    this.slick = new GroundField(this.group, {
      mode: GroundMode.WET,
      additive: false,
      renderOrder: 6,
      name: 'BroodSlick'
    });
    this.slickParams = groundFieldParams();
    this.slickParams.centre = new Vector3();

    /** Re-rolled per cast so no two clutches lay the same ring. */
    this._seed = 0;
    /**
     * One byte per egg: has this one already been given its burst?
     *
     * A ledger of events, not of dimensions. Cleared on spawn, and cleared per
     * egg whenever the live clock runs back behind that egg's split.
     */
    this._hatched = new Uint8Array(MAX_EGGS);
    /** How many of them are set. Recomputed from the ledger, never accumulated. */
    this._hatchedCount = 0;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Brood fluid. Lit and non-additive: it is wet matter being thrown, and an
    // additive version read as sparks coming off a firework.
    this.goo = particles.get('broodburst.goo', {
      capacity: 2000,
      shape: ParticleShape.SOFT,
      additive: false,
      lit: true,
      softFade: 0.3
    });
    this.goo.uniforms.uDrag.value = 1.1;
    this.goo.uniforms.uEndSize.value = 0.35;
    this.goo.uniforms.uSizeIn.value = 0.05;
    this.goo.uniforms.uFadeIn.value = 0.05;
    this.goo.uniforms.uFadeOut.value = 0.5;

    // Shell fragments.
    this.chips = particles.get('broodburst.chips', {
      capacity: 1200,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.chips.uniforms.uDrag.value = 0.35;
    this.chips.uniforms.uEndSize.value = 0.6;
    this.chips.uniforms.uFadeOut.value = 0.6;

    // Spore haze over the clutch.
    this.haze = particles.get('broodburst.haze', {
      capacity: 1400,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.0
    });
    this.haze.uniforms.uDrag.value = 2.0;
    this.haze.uniforms.uEndSize.value = 2.4;
    this.haze.uniforms.uSizeIn.value = 0.14;
    this.haze.uniforms.uFadeIn.value = 0.2;
    this.haze.uniforms.uFadeOut.value = 0.34;

    this.gooEmitter = new RateEmitter();
    this.hazeEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing — every second resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this.field.count + this.crawlers.count;
  }

  /** The live footprint, metres. What the indicator measured out. */
  get radius() {
    return Math.max(0.05, settings.broodburst.zoneRadius);
  }

  /**
   * Seconds one egg spends between being laid and its seam giving.
   *
   * This is the number `birthFade` is fed, which makes it the denominator of
   * every threshold in `BroodEggMaterial`. It has to cover the rise as well as
   * the swell, because the ramp starts the instant the record is triggered and
   * an egg is not allowed to start inflating before it has finished arriving.
   */
  _eggRamp() {
    const c = settings.broodburst;
    return Math.max(0.05, c.riseTime + c.swellTime);
  }

  /** Seconds from the clutch landing to the first egg splitting. */
  _firstSplit() {
    return this._eggRamp() * saturate(settings.broodburst.splitAt);
  }

  /** Lay the clutch, let it hatch, let them run. */
  get impactDuration() {
    const c = settings.broodburst;
    return Math.max(
      0.2,
      (c.layTime + c.layStagger + this._eggRamp() + c.crawlTime) * settings.global.lifetime
    );
  }

  get fadeDuration() {
    return Math.max(0.2, settings.broodburst.scatterTime);
  }

  /** Seconds since the clutch landed. Assembled from the base phase clocks. */
  _clutchAge() {
    if (this.phase === AbilityPhase.TRAVEL) return 0;
    if (this.phase === AbilityPhase.IMPACT) return this.impactTime;
    return this.impactDuration + this.fadeTime;
  }

  /** How far the laying wave has crossed the circle, 0..1. */
  _layFront() {
    const c = settings.broodburst;
    return Easing.outCubic(saturate(this._clutchAge() / Math.max(0.02, c.layTime)));
  }

  /**
   * 0..1 — how far into the crawling beat we are.
   *
   * Measured from the *first* split rather than from the landing, so the ring
   * does not start widening before anything has come out of anything.
   */
  _crawlBeat() {
    const c = settings.broodburst;
    const start = c.layTime + this._firstSplit();
    return saturate((this._clutchAge() - start) / Math.max(0.05, c.crawlTime));
  }

  /** 0..1 — how far the husks have sunk and the crawlers have let go. */
  _scatter() {
    if (this.phase !== AbilityPhase.FADE) return 0;
    const c = settings.broodburst;
    return saturate(this.fadeTime / Math.max(0.05, c.scatterTime));
  }

  /** The middle of the circle — the far end of the aimed line. */
  _centrePoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /** Where the cast leaves the caster, in world space. */
  _handPoint(out) {
    const c = settings.broodburst;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /** The brood light breathes rather than glints. */
  lightShimmer() {
    const c = settings.broodburst;
    return 1 - saturate(c.lightPulse) * 0.5 * (1 - Math.cos(this.age * c.lightPulseRate));
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    const c = settings.broodburst;

    this.gooEmitter.reset();
    this.hazeEmitter.reset();
    this._hatched.fill(0);
    this._hatchedCount = 0;

    // The one thing a cast captures beyond the field's own dice.
    this._seed = Math.random() * 100;

    this.field.plant(Math.min(MAX_EGGS, Math.round(c.eggs)), c.clusterShare);
    this.crawlers.roll(this._seed);

    this._sync(1);
    this._muzzleFx();
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Refill the growth params from live settings.
   *
   * Every number here is re-read on every call, including on a zero-length
   * frame. Nothing is cached and nothing is captured at spawn — that is the
   * whole of I1 for the clutch.
   */
  _fillGrowth() {
    const c = settings.broodburst;
    const g = settings.global;
    const p = this.growth;
    const R = this.radius;

    this._centrePoint(p.centre);
    p.origin = this.origin;
    p.direction = this.direction;
    p.side = this.side;
    p.length = this.length;

    p.radius = R;
    p.innerRadius = R * saturate(c.innerFrac);
    p.radialCurve = c.radialCurve;
    p.radialJitter = c.radialJitter;
    p.angleJitter = c.angleJitter;

    p.heightNear = c.eggHeight;
    p.height = c.eggHeightRim;
    p.heightCurve = c.heightCurve;
    p.heightJitter = c.heightJitter;
    p.radiusNear = c.eggRadius;
    p.radius2 = c.eggRadiusRim;
    p.radiusCurve = c.radiusCurve;
    p.radiusJitter = c.radiusJitter;

    // No lean: an egg tips, it does not lean away from the caster. `tilt` is a
    // random tip on any bearing, which is exactly what a laid clutch has.
    p.lean = 0;
    p.tilt = c.eggTilt;
    // A full turn of yaw, so each egg's seam faces somewhere different. This is
    // the only per-egg variation in *where the split happens* and without it a
    // clutch splits like a row of hinges.
    p.twist = 1;

    p.riseTime = c.riseTime;
    p.riseOvershoot = c.riseOvershoot;
    p.settle = c.settleTime;
    p.springRate = c.springRate;
    p.emergeSink = c.eggSink;
    p.birthScale = c.birthScale;
    p.sinkDepth = c.sinkDepth;
    // The coupling the whole ability hangs off: `GrowthField`'s birth ramp *is*
    // Broodburst's hatch clock. See `_eggRamp()`.
    p.birthFade = this._eggRamp();
    // Breach is not used for feedback here — the hatch ledger is — so it is
    // parked past the end of the ramp rather than firing a second event nobody
    // consumes.
    p.breachAt = 2;

    p.randomness = g.randomness;
  }

  /** Refill the crawlers' params, including the two that are the trick. */
  _fillFlock(scatter) {
    const c = settings.broodburst;
    const g = settings.global;
    const p = this.flock;
    const R = this.radius;
    const beat = this._crawlBeat();
    const hatched = this.field.count > 0 ? this._hatchedCount / this.field.count : 0;

    p.count = clamp(Math.round(c.crawlers * g.particleCount), 0, MAX_CRAWLERS);

    /* --- the lead: a slow circuit of the clutch --- */
    p.leadMode = LeadPath.ORBIT;
    p.leadS = 0;
    p.leadRate = c.crawlLeadRate;
    p.orbitRadius = c.crawlOrbitRadius;
    p.orbitHeight = 0;
    p.orbitTurns = c.crawlOrbitTurns;
    p.endHeight = c.crawlHeight;
    p.handForward = c.handForward;
    p.handSide = c.handSide;
    p.handHeight = c.handHeight;
    p.leadRise = 0;

    /* --- the formation --- */
    p.latticeX = c.crawlLatticeX;
    p.latticeY = c.crawlLatticeY;
    p.latticeZ = c.crawlLatticeZ;
    p.spacingSide = c.crawlSpacing;
    p.spacingUp = c.crawlSpacingUp;
    p.lag = c.crawlLag;
    p.jitter = c.crawlJitter * g.randomness;
    p.churn = c.crawlChurn;
    p.breathe = c.crawlBreathe;
    p.breatheRate = c.crawlBreatheRate;
    p.wander = c.crawlWander;
    p.wanderScale = c.crawlWanderScale * g.noiseFrequency;
    p.wanderSpeed = c.crawlWanderSpeed * g.noiseSpeed;
    p.gather = c.crawlGather;

    /* --- the body --- */
    p.size = c.crawlSize;
    p.aspect = c.crawlAspect;
    p.sizeJitter = c.crawlSizeJitter * g.randomness;
    p.billboard = 0;
    p.bank = c.crawlBank;
    p.bankMax = c.crawlBankMax;
    p.dihedral = c.crawlDihedral;
    p.flapRate = c.crawlScuttle;
    p.silhouette = clamp(Math.round(c.crawlShape), 0, 4);
    p.sweep = c.crawlSweep;
    p.edgeGain = c.crawlEdgeGain;
    p.lit = c.crawlLit;

    // The reveal *is* the hatch. An agent appears when the wave passes its own
    // dice, and the wave is the fraction of the clutch that has actually split —
    // so the swarm grows egg by egg without anything counting agents.
    p.reveal = saturate(hatched * (1 - scatter) - scatter * 0.15);
    p.revealSpread = c.crawlRevealSpread;

    /* --- colour --- */
    p.tint = c.crawlTint;
    p.tintJitter = c.crawlTintJitter * g.randomness;
    p.tintAlong = c.crawlTintAlong;
    p.opacity = c.crawlOpacity * g.opacity;
    p.glow = c.crawlGlow * g.glow;
    p.softFade = c.crawlSoftFade;

    /* --- the ring they close into, and the floor they are stuck to --- */
    p.shapeA = ColonyShape.RING;
    p.shapeB = ColonyShape.RING;
    p.shapeBlend = 0;
    // They hold the ring hardest in the middle of the crawl beat and let go of
    // it at both ends: arriving as a loose mass and dispersing as one is what
    // the module's one rule asks for.
    p.condense = c.crawlCondense * Easing.outQuad(saturate(beat * 3)) * (1 - scatter);
    const ring = R * (c.crawlRing + c.crawlRingGrow * beat);
    p.shapeWidth = ring;
    p.shapeDepth = ring;
    p.shapeHeight = R * c.crawlRingThick;
    // The ring is centred on the *lead*, which is on a slow circuit of the
    // clutch, so the ring's centre circles with it. That is deliberate and it is
    // stated here rather than worked around: the CPU mirror of the lead is not
    // the live one — the shader advances `leadS` by its own frame time — so any
    // attempt to cancel the orbit would be a frame behind and would read as
    // jitter. At `crawlOrbitRadius` well under `zoneRadius` the wander is a mass
    // of insects surging round the husks, which is what a colony does anyway.
    // The vertical offset is exact, because `orbitHeight` is zero and the lead
    // already sits at `crawlHeight`.
    p.shapeForward = 0;
    p.shapeSide = 0;
    p.shapeUp = 0;
    p.shapeSpin = c.crawlSpin;
    p.shapeFill = c.crawlFill;
    p.shapeSteps = clamp(Math.round(c.crawlSteps), 1, 4);
    p.shapeSlack = c.crawlSlack;
    p.shapeRough = c.crawlRough;

    p.waveAmp = 0;
    // THE floor. Applied last in the shader, after the flock and after the
    // shape, so nothing downstream can lift them off it.
    p.cling = 1;
    p.floorY = 0;
    p.crawlHeight = c.crawlHeight;
  }

  /** Refill the slick's params. */
  _fillSlick(scatter) {
    const c = settings.broodburst;
    const g = settings.global;
    const p = this.slickParams;
    const R = this.radius * c.slickRadius;

    this._centrePoint(p.centre);
    p.radius = R;
    p.height = c.slickHeight;
    p.seed = this._seed;
    p.grow = this._layFront();
    // It dries from the edges in, which is what WET is for, and it only starts
    // once the cast is letting go.
    p.recede = saturate(c.slickDry) * scatter;
    p.fade = 1;

    p.edge = c.slickEdge;
    p.ragged = c.slickRagged;
    p.raggedScale = c.slickRaggedScale;
    p.warp = c.slickWarp;

    p.relief = c.slickRelief;
    p.ambient = c.slickAmbient;
    p.specular = c.slickSpecular;
    p.gloss = c.slickGloss;

    p.cell = c.slickCell;
    p.lift = c.slickLift;
    p.depth = c.slickDepth;
    p.detail = c.slickDetail;
    p.sharp = c.slickSharp;
    p.flow = c.slickFlow;
    p.speed = c.slickSpeed;

    p.additive = false;
    p.emissive = c.slickEmissive * g.shaderIntensity;
    p.opacity = c.slickOpacity;
    p.depthFade = c.slickDepthFade;
    p.colorBase = c.colorSlickBase;
    p.colorEdge = c.colorSlickEdge;
    p.colorGlow = c.colorSlickGlow;
    p.colorDeep = c.colorSlickDeep;

    p.noiseStrength = g.noiseStrength;
    p.noiseFrequency = g.noiseFrequency;
    p.noiseSpeed = g.noiseSpeed;
    p.opacityScale = g.opacity;
  }

  /**
   * Push the live settings into the shell material, the clutch, the crawlers,
   * the slick and the three particle systems.
   *
   * @param {number} fade 1 while the clutch stands, ramping to 0 as it dies
   */
  _sync(fade) {
    const c = settings.broodburst;
    const g = settings.global;
    const scatter = this._scatter();

    /* --- the clutch --- */
    this.shape.rings = c.eggRings;
    this.shape.sides = c.eggSides;
    this.shape.tear = c.seamTear;
    this.field.syncGeometry(this.shape);

    this.material.userData.sync(fade);
    this._fillGrowth();
    this.field.update(this.age, this.growth, scatter);

    /* --- the crawlers --- */
    this._fillFlock(scatter);
    this.crawlers.setBasis(this.origin, this.direction, this.side, this.length);
    // Strings, not resolved Colors: `Swarm#setColors` memoises on what it is
    // handed, and `getColor` returns a shared instance whose contents change
    // under it — the memo would then be comparing an object with itself.
    this.crawlers.setColors(c.colorCrawlA, c.colorCrawlB, c.colorCrawlC, c.colorCrawlD);
    this.crawlers.update(this.age, this.flock);

    /* --- the slick --- */
    this._fillSlick(scatter);
    this.slick.setVisible(this.slickParams.grow > 0);
    this.slick.update(this.slickParams);

    /* --- the three particle systems --- */
    this.goo.setGradient(
      getColor(c.colorGooA),
      getColor(c.colorGooB),
      getColor(c.colorGooC),
      getColor(c.colorGooD)
    );
    this.goo.uniforms.uGravity.value.set(0, c.gooGravity, 0);
    this.goo.uniforms.uSizeScale.value = c.gooSize * g.particleSize * 7;
    this.goo.uniforms.uLifeScale.value = c.gooLifetime * 0.5 * g.particleLifetime;
    this.goo.uniforms.uSpeedScale.value = g.particleSpeed;
    this.goo.uniforms.uOpacity.value = g.opacity;
    this.goo.uniforms.uGlow.value = c.gooGlow * g.glow;

    this.chips.setGradient(
      getColor(c.colorChipA),
      getColor(c.colorChipB),
      getColor(c.colorChipC),
      getColor(c.colorChipD)
    );
    this.chips.uniforms.uGravity.value.set(0, c.chipGravity, 0);
    this.chips.uniforms.uSizeScale.value = c.chipSize * g.particleSize * 7;
    this.chips.uniforms.uLifeScale.value = c.chipLifetime * 0.5 * g.particleLifetime;
    this.chips.uniforms.uSpeedScale.value = g.particleSpeed;
    this.chips.uniforms.uOpacity.value = g.opacity;

    this.haze.setGradient(
      getColor(c.colorHazeA),
      getColor(c.colorHazeB),
      getColor(c.colorHazeC),
      getColor(c.colorHazeD)
    );
    this.haze.uniforms.uGravity.value.set(0, c.hazeRise, 0);
    this.haze.uniforms.uSizeScale.value = c.hazeSize * g.particleSize;
    this.haze.uniforms.uLifeScale.value = c.hazeLifetime * 0.5 * g.particleLifetime;
    this.haze.uniforms.uSpeedScale.value = c.hazeSpeed * g.particleSpeed;
    this.haze.uniforms.uOpacity.value = c.hazeOpacity * g.opacity;
    this.haze.uniforms.uTurbulence.value = 0.4 * g.turbulence;
  }

  /**
   * Walk the hatch ledger.
   *
   * Nothing is accumulated. For every planted egg the split time is
   * `eruptTime + eggRamp · splitAt`, recomputed from live settings, and the flag
   * is set or cleared to match. Running a slider backwards therefore un-hatches
   * eggs, and they hatch again — see the class header for why that is the right
   * trade rather than a defect.
   */
  _walkHatches() {
    const c = settings.broodburst;
    const now = this.age;
    const delay = this._eggRamp() * saturate(c.splitAt);
    const count = this.field.count;
    let hatched = 0;

    for (let i = 0; i < count; i++) {
      const erupt = this.field.records[i].eruptTime;
      const due = erupt >= 0 && now >= erupt + delay;
      if (due) {
        hatched++;
        if (!this._hatched[i]) {
          this._hatched[i] = 1;
          this._hatchFx(i);
        }
      } else if (this._hatched[i]) {
        this._hatched[i] = 0;
      }
    }
    this._hatchedCount = hatched;
  }

  /** The puff at the caster's hand as the clutch leaves it. */
  _muzzleFx() {
    const c = settings.broodburst;
    const g = settings.global;

    this._handPoint(_hand);

    this.ctx.bursts.spawn(BurstMode.EARTH, _hand, {
      radius: c.muzzleSize * 0.25,
      endRadius: c.muzzleSize * g.explosionIntensity,
      life: 0.4,
      intensity: c.muzzleIntensity,
      opacity: 0.6,
      fresnel: 1.3,
      displace: 0.5,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    _emit.position = _hand;
    _emit.radius = 0.16;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.7).setY(0.4).normalize();
    _emit.speed = c.gooSpeed * 1.2;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.85;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.08;
    _emit.sizeVariance = 0.7;
    _emit.life = c.gooLifetime * 0.7;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.goo.emit(Math.round(18 * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.4 * g.explosionIntensity;
  }

  /** Haze dragged along under the clutch while it is carried out. */
  _carryFx(dt) {
    const c = settings.broodburst;
    const g = settings.global;

    const count = Math.round(this.hazeEmitter.tick(dt, c.hazeRate * 0.5) * g.particleCount);
    if (count <= 0) return;

    _emit.position = _pos.copy(this.position).setY(0.12);
    _emit.radius = 0.45;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.hazeSpeed;
    _emit.speedVariance = 0.7;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.55;
    _emit.sizeVariance = 0.5;
    _emit.life = c.hazeLifetime * 0.7;
    _emit.lifeVariance = 0.4;
    _emit.spin = 0.4;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.haze.emit(count, _emit);
  }

  /**
   * One egg's seam giving: goo out of the gape, fragments off the lip.
   *
   * The emitter reads the field's live placement rather than a remembered
   * position, so the burst comes off the egg that is actually standing there and
   * moves with it when `zoneRadius` or `eggHeight` is dragged.
   */
  _hatchFx(index) {
    const c = settings.broodburst;
    const g = settings.global;
    const time = frame.uTime.value;

    this.field.positionOf(index, this.growth, _pos);
    const height = this.field.heightOf(index, this.growth);
    const radius = this.field.radiusOf(index, this.growth);
    _pos.y += height * 0.55;

    const goo = Math.round(c.gooBurst * g.particleCount);
    if (goo > 0) {
      _emit.position = _pos;
      _emit.radius = radius * 0.6;
      // Up and out, not spherical: what leaves a split egg leaves through the
      // gape, and the gape faces the sky.
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.gooSpeed;
      _emit.speedVariance = 0.85;
      _emit.spread = 0.8;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.09;
      _emit.sizeVariance = 0.8;
      _emit.life = c.gooLifetime;
      _emit.lifeVariance = 0.55;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.goo.emit(goo, _emit);
    }

    const chips = Math.round(c.chipBurst * g.particleCount);
    if (chips > 0) {
      _emit.position = _pos;
      _emit.radius = radius * 0.9;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.chipSpeed;
      _emit.speedVariance = 0.9;
      _emit.spread = 1.0;
      _emit.size = 0.08;
      _emit.sizeVariance = 0.7;
      _emit.life = c.chipLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = c.chipSpin;
      _emit.time = time;
      this.chips.emit(chips, _emit);
    }
  }

  /**
   * Goo dripping off the standing clutch, and haze over it.
   *
   * @param {number} scale 0..1 — thinned out as the clutch dies
   */
  _clutchFx(dt, scale) {
    const c = settings.broodburst;
    const g = settings.global;
    const time = frame.uTime.value;
    const count = this.field.count;
    if (count <= 0) return;

    this._centrePoint(_centre);

    const goo = Math.round(this.gooEmitter.tick(dt, c.gooRate * scale) * g.particleCount);
    if (goo > 0) {
      const index = Math.min(count - 1, (Math.random() * count) | 0);
      // Only an egg that has actually split is leaking.
      if (this._hatched[index]) {
        this.field.positionOf(index, this.growth, _pos);
        _pos.y += this.field.heightOf(index, this.growth) * 0.4;
        _emit.position = _pos;
        _emit.radius = this.field.radiusOf(index, this.growth) * 0.8;
        _emit.direction = _dir.set(0, 1, 0);
        _emit.speed = c.gooSpeed * 0.35;
        _emit.speedVariance = 0.8;
        _emit.spread = 1.0;
        _emit.inherit = null;
        _emit.anchor = null;
        _emit.size = 0.07;
        _emit.sizeVariance = 0.7;
        _emit.life = c.gooLifetime;
        _emit.lifeVariance = 0.5;
        _emit.spin = 0;
        _emit.tint = null;
        _emit.time = time;
        this.goo.emit(goo, _emit);
      }
    }

    const haze = Math.round(this.hazeEmitter.tick(dt, c.hazeRate * scale) * g.particleCount);
    if (haze > 0) {
      const bearing = Math.random() * TAU;
      const r = this.radius * Math.sqrt(Math.random());
      _pos.set(_centre.x + Math.cos(bearing) * r, 0.14, _centre.z + Math.sin(bearing) * r);
      _emit.position = _pos;
      _emit.radius = this.radius * 0.14;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.hazeSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.95;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.65;
      _emit.sizeVariance = 0.5;
      _emit.life = c.hazeLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.35;
      _emit.tint = null;
      _emit.time = time;
      this.haze.emit(haze, _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._sync(1);
    this.position.y = 0.3;
    this._carryFx(dt);
    this.ctx.shake.rumble(settings.broodburst.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.broodburst;
    const g = settings.global;
    const time = frame.uTime.value;

    this._centrePoint(_centre);
    _pos.copy(_centre).setY(c.eggHeight * 0.4);

    this.ctx.bursts.spawn(BurstMode.EARTH, _pos, {
      radius: c.burstSize * 0.25,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.7,
      intensity: c.burstIntensity,
      opacity: 0.5,
      fresnel: 1.4,
      displace: 0.5,
      squash: 0.6,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    this.ctx.decals.spawn(DecalType.FOAM, _centre, {
      radius: this.radius * c.slickDecalRadius,
      life: c.slickDecalLife,
      intensity: c.slickDecalIntensity,
      colorA: getColor(c.colorMat),
      colorB: getColor(c.colorMatEdge)
    });

    this.ctx.decals.spawn(DecalType.DUSTRING, _centre, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.8,
      width: 0.05,
      intensity: 0.6,
      colorA: getColor(c.colorMatEdge),
      colorB: getColor(c.colorMat)
    });

    _emit.position = _pos;
    _emit.radius = this.radius * 0.4;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.gooSpeed * 1.6;
    _emit.speedVariance = 0.85;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.09;
    _emit.sizeVariance = 0.8;
    _emit.life = c.gooLifetime * 1.2;
    _emit.lifeVariance = 0.55;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.goo.emit(Math.round(c.burstGoo * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      16
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.8 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.broodburst;
    const scatter = this._scatter();

    // The laying wave. `triggerRadial` fills from the middle outward, and the
    // per-record stagger inside `layStagger` is what keeps neighbours from
    // going on the same frame.
    const front = t <= 1 ? this._layFront() : 1;
    this.field.triggerRadial(this.age, front, c.layStagger, false, front >= 0.999);

    // The husks fade only once the crawlers are out and running; before that a
    // master fade would take the eggs with the beat they are still playing.
    const fade = 1 - Easing.inQuad(scatter);
    // Growth first, ledger second, everything else third. `_walkHatches()` asks
    // the field where each egg is standing, and `_fillFlock()` asks the ledger
    // how many have gone — put them the other way round and the crawlers are a
    // frame behind the eggs, which is invisible running and obvious paused.
    this._fillGrowth();
    this._walkHatches();
    this._sync(fade);

    // The light sits low over the clutch and follows the crawler ring outward,
    // which is the only reason the ring reads at all once the eggs have gone.
    this._centrePoint(this.position);
    this.position.y = lerp(c.eggHeight * 0.6, c.lightHeight, this._crawlBeat());

    this._clutchFx(dt, t <= 1 ? 1 : 1 - scatter);
  }

  onDestroy() {
    this.field.clear();
    this.crawlers.reset();
    this.slick.setVisible(false);
    this.material.userData.sync(1);
    this._hatched.fill(0);
    this._hatchedCount = 0;
  }

  dispose() {
    this.field.dispose();
    this.material.dispose();
    this.crawlers.dispose();
    this.slick.dispose();
    super.dispose();
  }
}
