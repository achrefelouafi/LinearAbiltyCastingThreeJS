import { BufferAttribute, BufferGeometry, Mesh, Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { Tube, TubePath } from '../../vfx/Tube.js';
import { Swarm, Silhouette, LeadPath } from '../../vfx/Swarm.js';
import { createVineBarkMaterial } from '../../materials/VineBarkMaterial.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, Easing, randRange } from '../../utils/math.js';

const TAU = Math.PI * 2;

/**
 * Rings along the bark sweep. Fifty-six is the point where the meander helix
 * stops faceting at the default `vineMeanderTurns`; below about forty the stem
 * develops visible flat spots wherever the curve turns fastest, which on a vine
 * reads as damage rather than as low tessellation.
 */
const BARK_NODES = 56;
/**
 * Facets around the section. Ten, not twenty: a stem eighteen centimetres
 * across never fills enough pixels for the extra ten to be worth the vertex
 * writes, and the slight angularity is *good* on something with bark.
 */
const BARK_SIDES = 10;

/** Hard ceiling on the leaves. `leafCount` clamps here. */
const LEAF_CAPACITY = 224;

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _tan = new Vector3();
const _n1 = new Vector3();
const _n2 = new Vector3();
const _prev = new Vector3();

/**
 * VINELASH — a vine that grows down the line and then snaps back.
 *
 * **The trick is that it grows rather than flies.** Every other line cast in
 * the sandbox draws a whole object and slides it, or draws a whole object and
 * clips it; this one has no far end until it gets there. The stem is a
 * `Tube` on the `VINE` path, where the front *is* the length — `t` is
 * renormalised against `state.grow`, so the radius profile `radius × (1−s)^
 * tipTaper` puts its zero at the growing tip rather than at the target, and the
 * vine genuinely tapers to nothing instead of being cut off. Leaves unfurl
 * behind that front because the leaf flock's lag is resolved as a fraction of
 * the *grown* stem each frame, so the formation always covers exactly [0, grow]
 * however far along the cast is and whatever the sliders say.
 *
 * At full extension it snaps. `state.snapAge` starts a damped cosine —
 * `1 − recoilAmp·e^(−recoilDamp·τ)·cos(2π·recoilFreq·τ)` — that hauls the whole
 * curve back to 58% of its length in one frame and lets it ring past 100% on
 * the way out. A cosine, not an exponential: an exponential-only return is a
 * vine on a lift, and the overshoot is the part that reads as elastic.
 *
 * **The leaves come off because the geometry moves, not because a timer fired.**
 * `Tube#tipSpeed` differentiates the curve with respect to the spring's own
 * clock — so it is correct on a zero-length frame — and the strip rate is
 * `max(0, tipSpeed − stripThreshold) × stripRate`. Pause the sandbox mid-recoil
 * and drag `vineRecoilFreq`: the reported tip speed changes because the shape
 * did, and the vine sheds harder.
 *
 * ### The bark is a swept mesh, and that is deliberate
 *
 * `Tube` draws three additive layers and nothing else, which is right for a
 * beam and wrong for a plant: a vine has to be a solid that the sun lands on.
 * So the body is one `Mesh` — one draw call — whose 560 vertices are rewritten
 * every frame from the tube's own `pointAt()` / `radiusAt()` / `tangentAt()`.
 * Nothing is cached: pause, drag `vineMeander`, and the bark re-sweeps onto the
 * new curve on a zero-length frame, because those three functions are live and
 * the sweep is the only thing between them and the vertex buffer. The tube
 * itself is then only the sap: additive, depth-tested against the bark it sits
 * inside, so it shows as a rim around the silhouette and blazes out of the
 * tapering tip where the bark has run out of radius.
 *
 * The alternative was to run the bark as a `GrowthField` of short segments
 * instanced along the curve. It draws in one call too, but the joints between
 * segments are visible the moment the stem bends — which is all the time, this
 * being a vine — and no amount of overlap hides them on the outside of a turn.
 *
 * A cast captures three things and all three are legal: a seed, the timestamp
 * the snap fired, and the dice the particle systems roll for themselves. Every
 * metre, radian and second is re-read from `settings.vinelash`.
 */
export class VinelashAbility extends Ability {
  constructor(context) {
    super('vinelash', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /* --- the sap column, and the authority on the curve --- */
    this.vine = new Tube({
      path: TubePath.VINE,
      prefix: 'vine',
      nodes: 96,
      sides: 18,
      renderOrder: 11
    });
    this.group.add(this.vine.group);

    /* --- the bark: one mesh, re-swept every frame --- */
    this._buildBark();

    /* --- the leaves --- */
    this.leaves = new Swarm(this.group, {
      capacity: LEAF_CAPACITY,
      silhouette: Silhouette.LEAF,
      // Leaves are lit foliage, not embers. Additive would make the far side of
      // the flock brighter than the near side, which is exactly backwards.
      additive: false,
      renderOrder: 12
    });

    /** Re-rolled per cast so no two vines writhe the same way. */
    this._seed = 0;
    /** `age` at which the snap fired, or −1 while the vine is still growing. */
    this._snapAt = -1;
    /** Metres of growth already paid out in bark chips. */
    this._chipDistance = 0;

    // Scratch handed to the tube each frame. One object, reused.
    this._state = {
      origin: new Vector3(),
      target: new Vector3(),
      side: new Vector3(),
      progress: 1,
      fade: 1,
      widthFade: 1,
      seed: 0,
      time: 0,
      grow: 0,
      snapAge: -1
    };

    // Scratch handed to the flock each frame. `Swarm#_resolve` falls back to
    // `swarmParams()` for every key this does not carry, which is how the
    // BIRD- and CARD-only controls stay out of the settings block.
    this._flock = {
      count: 0,
      leadMode: LeadPath.LINE,
      leadS: 0,
      leadRate: 1,
      leadRise: 0,
      handForward: 0,
      handSide: 0,
      handHeight: 0,
      endHeight: 0,
      latticeX: 5,
      latticeY: 3,
      latticeZ: 12,
      spacingSide: 0.28,
      spacingUp: 0.24,
      lag: 0.5,
      jitter: 0.1,
      churn: 0.5,
      breathe: 0.16,
      breatheRate: 1.9,
      wander: 0.09,
      wanderScale: 0.8,
      wanderSpeed: 0.6,
      gather: 0.9,
      size: 0.29,
      aspect: 0.78,
      sizeJitter: 0.45,
      billboard: 0.25,
      bank: 0.05,
      bankMax: 1.4,
      dihedral: 0.22,
      flapRate: 2.6,
      curl: 0.42,
      edgeStretch: 1.5,
      edgeGain: 1.8,
      reveal: 0,
      revealSpread: 0.3,
      silhouette: Silhouette.LEAF,
      lit: 0.72,
      tint: 0.35,
      tintJitter: 0.32,
      tintAlong: 0.4,
      opacity: 1,
      glow: 0.85,
      softFade: 0.3
    };
  }

  /**
   * The bark mesh.
   *
   * Two attribute sets, and the split is the whole design. `position` and
   * `normal` are rewritten every frame from the live curve. `aBarkRing` — the
   * cosine and sine of each vertex's angle around the section — never changes,
   * because it is a *material* coordinate: it says where on the bark this
   * vertex is, not where in the world. `aBarkAlong` sits between the two: it is
   * metres from the root, which does move when `range` moves, but not when the
   * vine recoils, so the grooves stay painted on the stem while the stem
   * whips. See `materials/VineBarkMaterial.js` for what the shader does with
   * them and why the ring is passed as a cosine and a sine rather than as an
   * angle.
   */
  _buildBark() {
    const vertices = BARK_NODES * BARK_SIDES;

    this._barkPosition = new Float32Array(vertices * 3);
    this._barkNormal = new Float32Array(vertices * 3);
    this._barkAlong = new Float32Array(vertices);
    const ring = new Float32Array(vertices * 2);

    for (let i = 0; i < BARK_NODES; i++) {
      for (let j = 0; j < BARK_SIDES; j++) {
        const k = i * BARK_SIDES + j;
        const angle = (j / BARK_SIDES) * TAU;
        ring[k * 2] = Math.cos(angle);
        ring[k * 2 + 1] = Math.sin(angle);
      }
    }

    // Winding checked by hand rather than by flipping `side` until it looked
    // right: with the outward normal at n1 and the section swept toward n2,
    // (v00, v01, v10) has (v01−v00)×(v10−v00) along +n1, and (v01, v11, v10)
    // likewise. Backwards renders a vine lit from inside that shadows nothing.
    //
    // The vertices are named by their lattice cell rather than a/b/c/d for a
    // duller reason: `scripts/check.mjs` drops the whole `c = settings.vinelash`
    // alias if the letter `c` is ever bound to something else in the file, and
    // it then reports a hundred and seventy live sliders as unread.
    const quads = (BARK_NODES - 1) * BARK_SIDES;
    const index = new Uint16Array(quads * 6);
    let w = 0;
    for (let i = 0; i < BARK_NODES - 1; i++) {
      for (let j = 0; j < BARK_SIDES; j++) {
        const jn = (j + 1) % BARK_SIDES;
        const v00 = i * BARK_SIDES + j;
        const v01 = i * BARK_SIDES + jn;
        const v10 = (i + 1) * BARK_SIDES + j;
        const v11 = (i + 1) * BARK_SIDES + jn;
        index[w++] = v00;
        index[w++] = v01;
        index[w++] = v10;
        index[w++] = v01;
        index[w++] = v11;
        index[w++] = v10;
      }
    }

    this.barkGeometry = new BufferGeometry();
    this.barkGeometry.setAttribute('position', new BufferAttribute(this._barkPosition, 3));
    this.barkGeometry.setAttribute('normal', new BufferAttribute(this._barkNormal, 3));
    this.barkGeometry.setAttribute('aBarkAlong', new BufferAttribute(this._barkAlong, 1));
    this.barkGeometry.setAttribute('aBarkRing', new BufferAttribute(ring, 2));
    this.barkGeometry.setIndex(new BufferAttribute(index, 1));

    this.barkMaterial = createVineBarkMaterial(this.ctx.environment);

    this.bark = new Mesh(this.barkGeometry, this.barkMaterial);
    this.bark.castShadow = true;
    this.bark.receiveShadow = true;
    // The vertices move every frame and the bounds with them; culling against a
    // stale sphere pops the whole vine out on the frame the camera swings.
    this.bark.frustumCulled = false;
    this.bark.matrixAutoUpdate = false;
    this.bark.layers.set(LAYER.WORLD);
    this.bark.renderOrder = 2;
    this.bark.visible = false;
    this.group.add(this.bark);

    /* Per-ring scratch for the sweep. Allocated once — I3. */
    this._ringPoint = new Float32Array(BARK_NODES * 3);
    this._ringTangent = new Float32Array(BARK_NODES * 3);
    this._ringRadius = new Float32Array(BARK_NODES);
    this._ringArc = new Float32Array(BARK_NODES);
  }

  createParticles() {
    const particles = this.ctx.particles;

    // The leaves that come off in the snap. Real particles rather than more
    // flock, because a stripped leaf has to stop obeying the stem — and the
    // flock's whole contract is that every agent is a function of the lead.
    this.torn = particles.get('vinelash.torn', {
      capacity: 1200,
      shape: ParticleShape.LEAF,
      additive: false,
      lit: true,
      softFade: 0.3
    });
    this.torn.uniforms.uDrag.value = 1.9;
    this.torn.uniforms.uEndSize.value = 0.9;
    this.torn.uniforms.uSizeIn.value = 0.05;
    this.torn.uniforms.uFadeIn.value = 0.06;
    this.torn.uniforms.uFadeOut.value = 0.5;

    // Pollen and spore light shaken off the stem as it grows.
    this.pollen = particles.get('vinelash.pollen', {
      capacity: 1400,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.45
    });
    this.pollen.uniforms.uDrag.value = 1.5;
    this.pollen.uniforms.uEndSize.value = 0.2;
    this.pollen.uniforms.uSizeIn.value = 0.08;
    this.pollen.uniforms.uFadeIn.value = 0.1;
    this.pollen.uniforms.uFadeOut.value = 0.45;

    // Bark shed by the stem thickening behind the front.
    this.chips = particles.get('vinelash.chips', {
      capacity: 800,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.chips.uniforms.uDrag.value = 0.5;
    this.chips.uniforms.uEndSize.value = 0.7;
    this.chips.uniforms.uFadeOut.value = 0.6;

    this.tornEmitter = new RateEmitter();
    this.pollenEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this.leaves.count;
  }

  /** The vine holds and rings after the snap, then withers. */
  get impactDuration() {
    return Math.max(0.05, settings.vinelash.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.vinelash.fadeTime);
  }

  /**
   * Sap light does not gutter and it does not glint — it *pulses*, on the same
   * clock the bark's sap wave runs on, so the light and the surface agree about
   * where the bolus of sap is.
   */
  lightShimmer() {
    const c = settings.vinelash;
    return 0.82 + 0.18 * Math.sin(this.age * c.sapPulseSpeed * Math.PI);
  }

  /* ------------------------------------------------------------------ */
  /* Geometry of the cast — every metre resolved from live settings       */
  /* ------------------------------------------------------------------ */

  /** Where the stem sprouts, in world space. */
  _rootPoint(out) {
    const c = settings.vinelash;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /** Where it would reach at full extension. */
  _reachPoint(out) {
    this.pointAt(1, out);
    out.y = settings.vinelash.endHeight;
    return out;
  }

  /** How far the vine has grown, 0..1 of the cast line. */
  get _grow() {
    return this.phase === AbilityPhase.TRAVEL ? Math.max(0.001, this.u) : 1;
  }

  /** Seconds since the recoil was triggered; negative while it is still growing. */
  get _snapAge() {
    return this._snapAt < 0 ? -1 : Math.max(0, this.age - this._snapAt);
  }

  /* ------------------------------------------------------------------ */
  /* Per-frame sync                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Push the cast state and the live block into the sap column.
   *
   * @param {number} fade       1 while the vine is alive, ramping to 0 as it dies
   * @param {number} widthFade  master radius multiplier — the collapse to a thread
   */
  _syncVine(fade, widthFade) {
    const state = this._state;
    this._rootPoint(state.origin);
    this._reachPoint(state.target);
    state.side.copy(this.side);
    state.fade = fade;
    state.widthFade = widthFade;
    state.seed = this._seed;
    state.time = this.age;
    state.grow = this._grow;
    state.snapAge = this._snapAge;
    // `progress` is overridden by `grow` inside Tube for the VINE path; it is
    // set anyway so the state object reads the same as every other tube's.
    state.progress = state.grow;

    this.vine.sync(settings.vinelash, state, settings.global);
  }

  /**
   * Re-sweep the bark onto whatever curve the tube is currently describing.
   *
   * Two passes. The first walks the rings and records centre, tangent, radius
   * and cumulative arc length; the second needs the neighbours' radii to get
   * the normal right, which is why it cannot be folded into the first.
   *
   * The normal is *not* the radial direction. On a stem that tapers to nothing
   * over its last few per cent the radial normal is wrong by nearly ninety
   * degrees at the tip, and the tip then lights as though it were facing the
   * camera whatever the sun is doing. Tilting it back by `dr/ds` costs two
   * subtractions and fixes it.
   */
  _syncBark(fade) {
    const c = settings.vinelash;
    const grow = this._grow;
    const span = this.vine.span;
    const scale = c.barkScale;
    const swell = c.barkSwell;
    const nodeRate = c.barkNodes;

    const position = this._barkPosition;
    const normal = this._barkNormal;
    const along = this._barkAlong;
    const rp = this._ringPoint;
    const rt = this._ringTangent;
    const rr = this._ringRadius;
    const ra = this._ringArc;

    /* --- pass one: the spine --- */
    let arc = 0;
    for (let i = 0; i < BARK_NODES; i++) {
      const t = (i / (BARK_NODES - 1)) * grow;
      this.vine.pointAt(t, _pos);
      this.vine.tangentAt(t, _tan);

      if (i > 0) arc += _pos.distanceTo(_prev);
      _prev.copy(_pos);

      // Node swellings: a vine is thicker where a leaf came out of it. Keyed
      // off metres of stem rather than off `t`, so they keep their physical
      // spacing when the cast is longer.
      const material = t * span;
      const bulge = 1 + swell * (0.5 + 0.5 * Math.sin(material * nodeRate * TAU));

      rp[i * 3] = _pos.x;
      rp[i * 3 + 1] = _pos.y;
      rp[i * 3 + 2] = _pos.z;
      rt[i * 3] = _tan.x;
      rt[i * 3 + 1] = _tan.y;
      rt[i * 3 + 2] = _tan.z;
      rr[i] = this.vine.radiusAt(t) * scale * bulge;
      ra[i] = arc;
    }

    /* --- pass two: the skin --- */
    for (let i = 0; i < BARK_NODES; i++) {
      _tan.set(rt[i * 3], rt[i * 3 + 1], rt[i * 3 + 2]);

      // The section frame, Gram-Schmidted off the cast's own side vector so the
      // seam in the bark stays on the same side of the stem as it bends.
      _n1.copy(this.side).addScaledVector(_tan, -this.side.dot(_tan));
      if (_n1.lengthSq() > 1e-8) _n1.normalize();
      else _n1.set(0, 1, 0).cross(_tan).normalize();
      _n2.crossVectors(_tan, _n1).normalize();

      // dr/ds by central difference on the two neighbours. At the ends the
      // one-sided difference is used; a zero there would leave the root and the
      // tip lit as flat discs.
      const lo = i > 0 ? i - 1 : i;
      const hi = i < BARK_NODES - 1 ? i + 1 : i;
      const ds = ra[hi] - ra[lo];
      const slope = ds > 1e-5 ? (rr[hi] - rr[lo]) / ds : 0;
      const nScale = 1 / Math.sqrt(1 + slope * slope);

      const r = rr[i];
      const t = (i / (BARK_NODES - 1)) * grow;
      const material = t * span;

      for (let j = 0; j < BARK_SIDES; j++) {
        const k = i * BARK_SIDES + j;
        const angle = (j / BARK_SIDES) * TAU;
        const ca = Math.cos(angle);
        const sa = Math.sin(angle);

        const nx = _n1.x * ca + _n2.x * sa;
        const ny = _n1.y * ca + _n2.y * sa;
        const nz = _n1.z * ca + _n2.z * sa;

        position[k * 3] = rp[i * 3] + nx * r;
        position[k * 3 + 1] = rp[i * 3 + 1] + ny * r;
        position[k * 3 + 2] = rp[i * 3 + 2] + nz * r;

        normal[k * 3] = (nx - _tan.x * slope) * nScale;
        normal[k * 3 + 1] = (ny - _tan.y * slope) * nScale;
        normal[k * 3 + 2] = (nz - _tan.z * slope) * nScale;

        along[k] = material;
      }
    }

    this.barkGeometry.attributes.position.needsUpdate = true;
    this.barkGeometry.attributes.normal.needsUpdate = true;
    this.barkGeometry.attributes.aBarkAlong.needsUpdate = true;

    this.barkMaterial.userData.sync();
    this.barkMaterial.opacity = saturate(fade) * settings.global.opacity;
    this.bark.visible = grow > 0.01 && fade > 0.02;
  }

  /**
   * The leaf flock.
   *
   * `lag` is the one derived number in the ability, and the derivation *is* the
   * design: the back rank has to sit at the root and the front rank at the
   * growing tip, whatever the cast length and whatever the growth speed. Ranks
   * are placed at `leadS − lagFraction · lag · leadRate`, so setting
   * `lag = leafSpan · grow / leadRate` puts them at `grow · (1 − lagFraction ·
   * leafSpan)` — the grown stem, exactly, on every frame of the growth.
   *
   * Making `leafSpan` seconds instead was the first attempt. It works for one
   * cast length and one growth speed and is wrong for every other: the flock
   * either bunches at the tip or trails out behind the caster's shoulder.
   *
   * @param {number} strip 0..1 — how far through the stripping we are
   * @param {number} fade  master alpha
   */
  _syncLeaves(strip, fade) {
    const c = settings.vinelash;
    const g = settings.global;
    const p = this._flock;
    const grow = this._grow;

    this.leaves.setBasis(this.origin, this.direction, this.side, this.length);
    this.leaves.setColors(
      getColor(c.colorLeafA),
      getColor(c.colorLeafB),
      getColor(c.colorLeafC),
      getColor(c.colorLeafD)
    );

    const rate = (c.speed * g.speed) / Math.max(0.1, this.length);

    p.count = Math.min(LEAF_CAPACITY, Math.round(c.leafCount * g.particleCount));
    p.leadMode = LeadPath.LINE;
    p.leadS = grow;
    p.leadRate = rate;
    p.leadRise = c.leafLeadRise;
    p.handForward = c.handForward;
    p.handSide = c.handSide;
    p.handHeight = c.handHeight;
    p.endHeight = c.endHeight;

    p.latticeX = c.leafLatticeX;
    p.latticeY = c.leafLatticeY;
    p.latticeZ = c.leafLatticeZ;
    p.spacingSide = c.leafSpacingSide;
    p.spacingUp = c.leafSpacingUp;
    p.lag = (c.leafSpan * grow) / Math.max(0.01, rate);
    p.jitter = c.leafJitter * g.randomness;
    p.churn = c.leafChurn * g.animationSpeed;
    p.breathe = c.leafBreathe;
    p.breatheRate = c.leafBreatheRate * g.animationSpeed;
    p.wander = c.leafWander * g.turbulence;
    p.wanderScale = c.leafWanderScale * g.noiseFrequency;
    p.wanderSpeed = c.leafWanderSpeed * g.noiseSpeed;
    p.gather = c.leafGather;

    p.size = c.leafSize * g.particleSize;
    p.aspect = c.leafAspect;
    p.sizeJitter = c.leafSizeJitter * g.randomness;
    p.billboard = c.leafBillboard;
    p.bank = c.leafBank;
    p.bankMax = c.leafBankMax;
    p.dihedral = c.leafFold;
    p.flapRate = c.leafFlapRate * g.animationSpeed;
    p.curl = c.leafCurl;
    p.edgeStretch = c.leafEdgeStretch;
    p.edgeGain = c.leafEdgeGain;
    // Unfurling and stripping are the same control read from both ends: the
    // wave runs up the dice as the vine grows and back down them as it sheds.
    p.reveal = saturate(grow) * (1 - saturate(strip));
    p.revealSpread = c.leafRevealSpread;

    p.silhouette = Silhouette.LEAF;
    p.lit = c.leafLit;
    p.tint = c.leafTint;
    p.tintJitter = c.leafTintJitter * g.randomness;
    p.tintAlong = c.leafTintAlong;
    p.opacity = c.leafOpacity * fade * g.opacity;
    p.glow = c.leafGlow * g.glow;
    p.softFade = c.leafSoftFade;

    this.leaves.update(this.age, p);
  }

  /** Push the live gradients and scales into the three particle systems. */
  _syncParticles() {
    const c = settings.vinelash;
    const g = settings.global;

    this.torn.setGradient(
      getColor(c.colorTornA),
      getColor(c.colorTornB),
      getColor(c.colorTornC),
      getColor(c.colorTornD)
    );
    this.torn.uniforms.uGravity.value.set(0, c.tornGravity, 0);
    this.torn.uniforms.uSizeScale.value = c.tornSize * g.particleSize * 7;
    this.torn.uniforms.uLifeScale.value = g.particleLifetime;
    this.torn.uniforms.uSpeedScale.value = g.particleSpeed;
    this.torn.uniforms.uOpacity.value = g.opacity;
    this.torn.uniforms.uTurbulence.value = 0.5 * g.turbulence;

    this.pollen.setGradient(
      getColor(c.colorPollenA),
      getColor(c.colorPollenB),
      getColor(c.colorPollenC),
      getColor(c.colorPollenD)
    );
    this.pollen.uniforms.uGravity.value.set(0, c.pollenRise, 0);
    this.pollen.uniforms.uSizeScale.value = c.pollenSize * g.particleSize * 7;
    this.pollen.uniforms.uLifeScale.value = c.pollenLifetime * 0.5 * g.particleLifetime;
    this.pollen.uniforms.uSpeedScale.value = g.particleSpeed;
    this.pollen.uniforms.uOpacity.value = g.opacity;
    this.pollen.uniforms.uGlow.value = 1.1 * g.glow;
    this.pollen.uniforms.uTurbulence.value = c.pollenTurbulence * g.turbulence;

    this.chips.setGradient(
      getColor(c.colorChipA),
      getColor(c.colorChipB),
      getColor(c.colorChipC),
      getColor(c.colorChipD)
    );
    this.chips.uniforms.uGravity.value.set(0, c.chipGravity, 0);
    this.chips.uniforms.uSizeScale.value = c.chipSize * g.particleSize * 7;
    this.chips.uniforms.uLifeScale.value = g.particleLifetime;
    this.chips.uniforms.uSpeedScale.value = g.particleSpeed;
    this.chips.uniforms.uOpacity.value = g.opacity;
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /** Pollen off the length of the stem, and bark chips off the front. */
  _growthFx(dt, scale) {
    const c = settings.vinelash;
    const g = settings.global;
    const time = frame.uTime.value;
    const grow = this._grow;

    const pollenCount = Math.round(this.pollenEmitter.tick(dt, c.pollenRate * scale) * g.particleCount);
    if (pollenCount > 0) {
      const s = Math.random() * grow;
      this.vine.pointAt(s, _pos);
      _emit.position = _pos;
      _emit.radius = this.vine.radiusAt(s) * 2.2 + 0.06;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.pollenSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.1;
      _emit.sizeVariance = 0.6;
      _emit.life = c.pollenLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.pollen.emit(pollenCount, _emit);
    }

    // Chips are paid out per *metre* of front travel rather than per second, so
    // a slow vine does not lay a denser trail than a fast one.
    const step = 1 / Math.max(0.05, c.chipRate);
    let guard = 0;
    while (this.front - this._chipDistance >= step && guard++ < 24) {
      this._chipDistance += step;
      const s = saturate(this._chipDistance / Math.max(0.1, this.length));
      this.vine.pointAt(s, _pos);
      _emit.position = _pos;
      _emit.radius = this.vine.radiusAt(s) * 1.4 + 0.04;
      _emit.direction = _dir.copy(this.direction).multiplyScalar(0.3).setY(-0.5).normalize();
      _emit.speed = c.chipSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.9;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.1;
      _emit.sizeVariance = 0.7;
      _emit.life = c.chipLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 9;
      _emit.tint = null;
      _emit.time = time;
      this.chips.emit(Math.max(1, Math.round(g.particleCount)), _emit);
    }

    this.ctx.shake.rumble(c.rumble * g.cameraShake, dt);
  }

  /**
   * Leaves torn off by the recoil.
   *
   * The rate is a function of the tip's speed, which `Tube` differentiates from
   * the curve rather than from a frame delta. That is the whole point: on the
   * frame the spring is at its fastest the vine sheds hardest, and on a paused
   * frame with `vineRecoilAmp` dragged upward it sheds harder still.
   */
  _stripFx(dt) {
    const c = settings.vinelash;
    const g = settings.global;
    const over = Math.max(0, this.vine.tipSpeed - c.stripThreshold);
    if (over <= 0) {
      this.tornEmitter.tick(dt, 0);
      return;
    }

    const count = Math.round(this.tornEmitter.tick(dt, over * c.stripRate) * g.particleCount);
    if (count <= 0) return;

    const s = randRange(0.15, 1);
    this.vine.pointAt(s, _pos);
    this._tornEmit(_pos, this.vine.radiusAt(s) * 2.5 + 0.1, count, 1);
  }

  /** One batch of torn leaves. Shared by the trickle and the snap's burst. */
  _tornEmit(position, radius, count, force) {
    const c = settings.vinelash;
    _emit.position = position;
    _emit.radius = radius;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(-0.35).setY(0.7).normalize();
    _emit.speed = c.tornSpeed * force;
    _emit.speedVariance = 0.9;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.14;
    _emit.sizeVariance = 0.8;
    _emit.life = c.tornLifetime;
    _emit.lifeVariance = 0.55;
    _emit.spin = c.tornSpin;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.torn.emit(count, _emit);
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.tornEmitter.reset();
    this.pollenEmitter.reset();
    this._chipDistance = 0;
    this._snapAt = -1;

    // The two things a cast is allowed to keep: a unitless dice roll, and (from
    // `onImpact`) the moment an event fired.
    this._seed = Math.random() * 100;
    this.leaves.roll(this._seed);
    this.vine.visible = true;
    this.barkMaterial.userData.uniforms.uWither.value = 0;

    this._syncVine(1, 1);
    this._syncBark(1);
    this._syncLeaves(0, 1);
    this._syncParticles();
  }

  onTravel(dt) {
    this._syncVine(1, 1);
    this._syncBark(1);
    this._syncLeaves(0, 1);
    this._syncParticles();
    this._growthFx(dt, 1);

    // The light rides the growing tip, which is the tube's own tip point rather
    // than the ground line `advance()` left in `position`.
    this.position.copy(this.vine.tipPoint);
  }

  onImpact() {
    const c = settings.vinelash;
    const g = settings.global;

    // The one timestamp. Everything the recoil does is a function of
    // `age − snapAt` against live sliders, so dragging `vineRecoilDamp` with
    // the clock stopped re-rings a spring that has already been struck.
    this._snapAt = this.age;
    this._syncVine(1, 1);

    _pos.copy(this.vine.tipPoint);

    /* the burst of leaf litter where the tip was */
    this.ctx.bursts.spawn(BurstMode.EARTH, _pos, {
      radius: c.burstSize * 0.25,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.6,
      intensity: c.burstIntensity,
      opacity: 0.85,
      fresnel: 1.4,
      displace: 0.7,
      squash: 0.85,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    /* dust kicked off the floor beneath it */
    this.pointAt(1, _dir);
    this.ctx.decals.spawn(DecalType.DUSTRING, _dir, {
      radius: c.dustRadius * g.explosionIntensity,
      life: c.dustLife,
      intensity: c.dustIntensity,
      colorA: getColor(c.colorDust),
      colorB: getColor(c.colorBurstA)
    });

    /* the leaves that leave all at once */
    this.vine.pointAt(0.6, _pos);
    this._tornEmit(_pos, Math.max(0.4, this.length * 0.3), Math.round(c.stripBurst * g.particleCount), 1.6);

    this.ctx.shake.add(
      c.snapShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      22
    );
    this.ctx.flash.trigger(getColor(c.colorSnapFlash), c.snapFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.9 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.vinelash;

    // `t` runs 0..1 while the vine holds and the spring rings out, then 1..2
    // while it withers. The wither collapses the radius as well as the alpha:
    // a dying vine goes thin before it goes away, and a straight opacity ramp
    // reads as somebody turning the ability off.
    const dying = saturate(t - 1);
    const fade = t <= 1 ? 1 : 1 - Easing.inCubic(dying);
    const widthFade = Math.max(0.04, 1 - 0.9 * Easing.outQuad(dying));

    this._syncVine(fade, widthFade);
    this._syncBark(fade);

    const strip = saturate(this._snapAge / Math.max(0.05, c.stripFade));
    this._syncLeaves(strip, fade);
    this._syncParticles();

    this.barkMaterial.userData.uniforms.uWither.value = c.witherDarken * Easing.outQuad(dying);

    this._stripFx(dt);
    this._growthFx(dt, fade * (t <= 1 ? 0.5 : 0.2));

    this.position.copy(this.vine.tipPoint);
  }

  onDestroy() {
    this.leaves.reset();
    this.bark.visible = false;
    this.vine.visible = false;
    this._snapAt = -1;
    this.barkMaterial.userData.uniforms.uWither.value = 0;
  }

  dispose() {
    this.vine.dispose();
    this.leaves.dispose();
    this.barkGeometry.dispose();
    this.barkMaterial.dispose();
    super.dispose();
  }
}
