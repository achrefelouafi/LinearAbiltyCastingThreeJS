import { Vector3 } from 'three';
import { Ability } from '../Ability.js';
import { FilamentPaths, filamentLook, MAX_CHAIN_NODES } from '../../vfx/FilamentPaths.js';
import { ArcNetwork, arcNetworkParams } from '../../vfx/ArcNetwork.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, clamp, lerp, Easing, randRange, hash11 } from '../../utils/math.js';

/**
 * Samples along one filament. Ninety-six rather than the bolt's seventy-two
 * because a polyline has **corners**, and a corner that lands between two
 * samples rounds itself off — which is the one thing a chain must not do. The
 * first pass at this ran at 72 and the hops read as a wobbly bolt; the fix was
 * not more kink, it was more samples.
 */
const SAMPLES = 96;

/**
 * Filament ceiling across all three roles. Chain (3) + spike (2) + crawl (7) is
 * the shipped total; the headroom is there so every one of those can be wound
 * up in the editor without a role silently truncating.
 */
const CAPACITY = 40;

/* Role slots on the shared strip. Structural roles first — `FilamentPaths`
 * hands out the capacity in role order, so the chain can never be starved by a
 * crawl somebody wound up to sixteen. */
const ROLE_CHAIN = 0;
const ROLE_SPIKE = 1;
const ROLE_CRAWL = 2;

/* Module-scope scratch. Nothing in the frame path allocates — invariant I3. */
const _target = new Vector3();
const _from = new Vector3();
const _to = new Vector3();
const _pole = new Vector3();
const _pos = new Vector3();
const _dir = new Vector3();
const _emit = {};

/**
 * CHAIN ARC — a discharge that hops down the aimed line instead of travelling it.
 *
 * **The trick is graph pathing.** Every other line cast in the sandbox moves a
 * front at metres per second and draws the effect behind it. This one does not
 * travel at all: five to nine nodes are scattered off the line, and the
 * discharge is at the first, and then at the second, and the space in between
 * was never crossed so much as *skipped*. One segment is lit at a time, with a
 * configurable hold and a guttering overlap so the passed hops linger dim
 * behind the front, and a burst, a spark spray and a small floor burn fire at
 * each node as it is reached. The last node gets the full impact treatment.
 *
 * **Re-rolling the scatter re-routes a chain that is already in the air.** That
 * is the roster's actual ask, and it falls straight out of obeying I1: the
 * graph is stored as unitless fractions and `ArcNetwork` resolves them against
 * live `scatter` / `lift` / `nodes` every frame, so dragging any of those bends
 * a standing discharge. `route` goes further — it re-rolls the fractions
 * outright via `reseed()`, which leaves the hop clock alone, so the chain takes
 * a different path from where it currently is rather than starting over.
 *
 * **Three roles, one strip, two draw calls.** `ArcNetwork` is constructed with
 * `{ paths, role }` against a `FilamentPaths` this class owns, so the chain
 * (`CHAIN`), the earthing spike (`LINE`) and the crawl that opens at the last
 * node (`MEANDER`) all come out of the same instanced ribbon — drawn once as a
 * halo and once as a core. Six draw calls became two, and the halo stays
 * attached to every kink because it is real ribbon rather than bloom.
 *
 * Two things about the earthing spike are worth writing down, because both were
 * wrong first. It uses a single `LINE` role, so only one node earths at a time
 * — the first version tried to give every node its own spike and there is no
 * way to do that in one role, and four roles is the uniform budget. And whether
 * the current node earths is decided *per frame*, by testing a per-node dice
 * roll against the live `earthChance`, not once when the node fires: winding
 * the slider up with the clock stopped has to make the spike appear, or it is
 * not a slider.
 *
 * The ground marks follow the same logic as the hop: **a burn under each node,
 * not a continuous line.** The bolt was never between the nodes and the floor
 * should not claim it was. Laying a burn per metre of front travel, the way
 * Storm Lance does, drew a dotted line down the aim arrow and threw the whole
 * read away.
 *
 * What a cast captures: one seed, and three timestamps (the node that last lit,
 * and the moment the last node arrived). Everything with a unit is re-resolved
 * from `settings.chainarc` each frame, on a zero-length frame included.
 */
export class ChainArcAbility extends Ability {
  constructor(context) {
    super('chainarc', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    this.paths = new FilamentPaths(this.group, {
      samples: SAMPLES,
      capacity: CAPACITY,
      renderOrder: 11
    });

    // The network draws *through* the strip above rather than building its own.
    // This is the single cheapest saving in the tech library and the reason the
    // whole ability is two draw calls.
    this.net = new ArcNetwork(this.group, { paths: this.paths, role: ROLE_CHAIN });
    this.spikeRole = this.paths.role(ROLE_SPIKE);
    this.crawlRole = this.paths.role(ROLE_CRAWL);

    // Bound once, here. A closure rebuilt per frame is exactly the allocation
    // invariant I3 exists to forbid, and `onNode` is read every frame.
    this.net.onNode = this._nodeFired.bind(this);

    /**
     * One scratch object handed to `ArcNetwork.update()` and, through it,
     * straight to `FilamentPaths.sync()` — the params block doubles as the
     * look, so a chained ability keeps one scratch rather than two. Built once
     * with every key it will ever hold, so the shape never changes under V8.
     */
    this._p = Object.assign(arcNetworkParams(), filamentLook());

    /** Re-rolled per cast so no two chains take the same route. */
    this._seed = 0;
    /** The composite seed currently applied, so `route` only reseeds on change. */
    this._appliedRoute = Number.NaN;
    /** Index of the node that lit most recently, and when. Events, not metres. */
    this._earthNode = -1;
    this._earthAt = -1;
    /** When the last node arrived. −1 until it has. */
    this._impactAt = -1;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Sparks: velocity-stretched streaks under gravity, thrown at every node
    // and shed along the lit hops in between.
    this.sparks = particles.get('chainarc.sparks', {
      capacity: 3200,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.25
    });
    this.sparks.uniforms.uDrag.value = 1.4;
    this.sparks.uniforms.uEndSize.value = 0.25;
    this.sparks.uniforms.uSizeIn.value = 0.02;
    this.sparks.uniforms.uFadeIn.value = 0.03;
    this.sparks.uniforms.uFadeOut.value = 0.45;

    // The slow ionised motes hanging in the air where the chain has been. These
    // are what leaves the *shape* of the route visible after the hop has passed.
    this.motes = particles.get('chainarc.motes', {
      capacity: 2000,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.motes.uniforms.uDrag.value = 1.6;
    this.motes.uniforms.uEndSize.value = 0.15;
    this.motes.uniforms.uSizeIn.value = 0.06;
    this.motes.uniforms.uFadeIn.value = 0.08;
    this.motes.uniforms.uFadeOut.value = 0.4;

    // Haze off the burnt floor. Non-additive so it genuinely occludes.
    this.smoke = particles.get('chainarc.smoke', {
      capacity: 1200,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.1
    });
    this.smoke.uniforms.uDrag.value = 1.8;
    this.smoke.uniforms.uEndSize.value = 3.0;
    this.smoke.uniforms.uSizeIn.value = 0.12;
    this.smoke.uniforms.uFadeIn.value = 0.16;
    this.smoke.uniforms.uFadeOut.value = 0.3;

    // Chips blown off the floor under a node.
    this.debris = particles.get('chainarc.debris', {
      capacity: 1200,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.debris.uniforms.uDrag.value = 0.25;
    this.debris.uniforms.uEndSize.value = 0.8;
    this.debris.uniforms.uFadeOut.value = 0.7;

    this.sparkEmitter = new RateEmitter();
    this.moteEmitter = new RateEmitter();
    this.smokeEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this.paths.liveCount;
  }

  get impactDuration() {
    return Math.max(0.05, settings.chainarc.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.chainarc.fadeTime);
  }

  /** A chain gutters where ice glints — the same hard, quantised stutter the bolt uses. */
  lightShimmer() {
    const c = settings.chainarc;
    const step = Math.floor(this.age * Math.max(1, c.lightFlickerSpeed));
    const noise = Math.abs(Math.sin(step * 127.1) * 43758.5453) % 1;
    return 1 - saturate(c.lightFlicker) * noise;
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  /** Node 0: where the chain leaves the caster's hand, in world space. */
  _handPoint(out) {
    const c = settings.chainarc;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /** The last node: the thing that was aimed at. */
  _impactPoint(out) {
    this.pointAt(1, out);
    out.y = settings.chainarc.endHeight;
    return out;
  }

  /**
   * Where the discharge currently *is* — the node the cursor has most recently
   * reached, re-derived through `nodePoint()` rather than remembered.
   *
   * This is what the dynamic light rides, and it is why the light hops rather
   * than sliding: a chain whose light travels smoothly down the line puts the
   * travel back in and undoes the entire effect.
   */
  _frontPoint(out) {
    const i = clamp(Math.floor(this.net.cursor), 0, this.net.nodeCount - 1);
    return this.net.nodePoint(i, out);
  }

  /**
   * Seconds one hop takes, resolved fresh.
   *
   * Expressed as hop length over `speed` rather than as a `hopTime` slider: see
   * the note in `config/abilities/chainarc.js`. Dropping the node count then
   * lengthens each hop *and* slows it, which is what propagation through a
   * medium actually does, and it keeps the total flight time tracking the cast
   * length instead of the node count.
   */
  _hopTime(c, g) {
    const segments = Math.max(1, clamp(Math.round(c.nodes), 2, MAX_CHAIN_NODES) - 1);
    const speed = Math.max(0.01, c.speed * g.speed);
    return Math.max(1e-4, (this.length / segments / speed) * Math.max(0.05, c.hopStretch));
  }

  /** Does node `i` stab down to the floor? A fixed dice roll against a live threshold. */
  _earths(i, c) {
    if (i < 0) return false;
    return hash11(this._seed * 7.31 + i * 13.71) < saturate(c.earthChance);
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Refill the single params/look scratch from live settings.
   *
   * Every line here is a re-resolution, not a copy of something captured. The
   * five `global.*` multipliers at the bottom are what make the master sliders
   * bite on the ribbon; `FilamentPaths.sync()` folds them into the kinks and the
   * output, once.
   */
  _fillParams() {
    const c = settings.chainarc;
    const g = settings.global;
    const p = this._p;

    /* --- the graph --- */
    p.nodes = c.nodes;
    p.filaments = c.filaments;
    p.scatter = c.scatter;
    p.lift = c.lift;
    p.alongJitter = c.alongJitter;
    p.sag = c.hopSag;
    p.bow = c.hopBow;
    p.floorY = c.floorY;

    /* --- the clock --- */
    p.hopTime = this._hopTime(c, g);
    p.hold = c.hold;
    p.overlap = c.overlap;
    p.tip = c.tip;

    /* --- the chain role's share of the shared look --- */
    p.kink = c.kink;
    p.chainWidth = c.chainWidth;
    p.dim = c.dim;
    p.groundDamp = c.groundDamp;

    /* --- the ribbon, shared by all three roles --- */
    p.width = c.width;
    p.glowWidth = c.glowWidth;
    p.glowOpacity = c.glowOpacity;
    p.jitter = c.jitter;
    p.jitterScale = c.jitterScale;
    p.octaves = c.octaves;
    p.jitterFalloff = c.jitterFalloff;
    p.crawl = c.crawl;
    p.pinch = c.pinch;
    p.restrike = c.restrike;
    p.flicker = c.flicker;
    p.flickerSpeed = c.flickerSpeed;
    p.strandFlash = c.strandFlash;
    p.coreSharp = c.coreSharp;
    p.glowFalloff = c.glowFalloff;
    p.softFade = c.softFade;
    p.opacity = c.opacity;
    p.glow = c.glow;
    p.colorCore = c.colorCore;
    p.colorInner = c.colorInner;
    p.colorOuter = c.colorOuter;
    p.colorHalo = c.colorHalo;

    /* --- the master sliders --- */
    p.randomness = g.randomness;
    p.noiseStrength = g.noiseStrength;
    p.noiseFrequency = g.noiseFrequency;
    p.noiseSpeed = g.noiseSpeed;
    p.opacityScale = g.opacity;
    p.glowScale = g.glow;
  }

  /**
   * One whole frame of the discharge: clock, graph, hooks, the two secondary
   * roles, and the sync.
   *
   * The order matters and is not obvious. `ArcNetwork.update()` ends by calling
   * `FilamentPaths.sync()`, which is where the role counts pass through the
   * capacity clamp and become `geometry.instanceCount`. The spike and the crawl
   * cannot be configured *before* that call because both need node positions the
   * network has not resolved yet, so they are configured after it and the strip
   * is synced a second time. A second `sync()` is a few dozen uniform writes and
   * no allocation; getting it wrong is a role that draws one frame late, which
   * on a 0.3 s cast is visible.
   *
   * @param {number} dt seconds — `ArcNetwork` takes dt, not now
   * @param {number} fade 1 while lit, ramping to 0 as it gutters out
   */
  _step(dt, fade) {
    const c = settings.chainarc;

    this._fillParams();
    this._reroute(c);

    this._handPoint(this.net.from);
    this._impactPoint(this.net.to);
    this.net.update(dt, this._p, fade);

    this._syncSpike(c, fade);
    this._syncCrawl(c, fade);
    this.paths.sync(this._p, fade, this._seed);
  }

  /**
   * The live re-route.
   *
   * `route` is a plain integer dial and the whole of the roster's "re-rolling
   * the node scatter live re-routes a chain already in the air". `reseed()`
   * touches the dice and nothing else — the hop cursor keeps its place — so the
   * discharge changes course from where it currently is rather than restarting.
   * Compared rather than applied unconditionally because reseeding every frame
   * would be twelve pointless hashes a frame for the ninety-nine frames in a
   * hundred where the dial has not moved.
   */
  _reroute(c) {
    const wanted = this._seed + c.route;
    if (wanted === this._appliedRoute) return;
    this.net.reseed(wanted);
    this._appliedRoute = wanted;
  }

  /**
   * The earthing spike: a short `LINE` role from the node currently lit down to
   * the floor beneath it.
   *
   * Retired outright — `count = 0` — on every frame it is not wanted, which is
   * how a role vanishes without costing anything. The node position comes from
   * `nodePoint()`, which mirrors the vertex shader's own arithmetic, so the
   * spike leaves the chain exactly where the chain is rather than near it.
   */
  _syncSpike(c, fade) {
    const role = this.spikeRole;
    if (this._earthNode < 0 || !this._earths(this._earthNode, c)) return void role.retire();

    const k = 1 - saturate((this.age - this._earthAt) / Math.max(0.02, c.spikeLife));
    if (k <= 0) return void role.retire();

    // Clamped against the *live* node count: winding `nodes` down mid-cast can
    // leave the remembered index past the end of the graph, and a spike hanging
    // off a node that no longer exists is a stale position, not a crash.
    this.net.nodePoint(Math.min(this._earthNode, this.net.nodeCount - 1), _from);
    // Guard the degenerate case where a node has sunk to the clamp height: a
    // zero-length LINE gives the shader a null tangent and the ribbon folds.
    _to.set(_from.x, Math.min(c.spikeFloor, _from.y - 0.05), _from.z);

    role.count = Math.max(1, Math.round(c.spikeStrands));
    role.line(
      _from,
      _to,
      c.spikeSag,
      c.spikeNear,
      c.spikeSpread,
      c.spikeCurve,
      c.spikeTwist,
      c.spikeTwistSpeed,
      c.spikeConverge
    );
    role.style(c.spikeKink, c.spikeWidth, c.spikeDim * k * fade, c.spikeGroundDamp);
    role.ends(0, 1, 0, 1);
    role.draw(2, 0.12, c.spikeFloor, c.spikeTipGlow);
  }

  /**
   * The crawl at the last node: a `MEANDER` role running out across the floor.
   *
   * `MEANDER` rather than a radial fan because a discharge that has chosen a
   * direction keeps going that way — the veer is a per-filament constant, not
   * noise — and a fan of straight spokes out of one point reads as a firework.
   * The growth is `draw(progress, …)`, so the tendrils are *drawn* outward
   * rather than scaled, and `crawlGrow` stays a live slider.
   */
  _syncCrawl(c, fade) {
    const role = this.crawlRole;
    if (this._impactAt < 0) return void role.retire();

    const since = this.age - this._impactAt;
    const k = 1 - saturate(since / Math.max(0.05, c.crawlLife));
    if (k <= 0 || c.crawlStrands < 1) return void role.retire();

    this.pointAt(1, _from);
    _from.y = c.crawlFloor;
    _pole.set(_from.x, _from.y + 1, _from.z);

    const grow = saturate(since / Math.max(0.02, c.crawlGrow));

    role.count = Math.round(c.crawlStrands);
    role.meander(
      _from,
      _pole,
      c.crawlInner,
      c.crawlReach,
      c.crawlCurve,
      c.crawlWander,
      c.crawlArch,
      c.crawlHug,
      c.crawlSpin
    );
    role.style(c.crawlKink, c.crawlWidth, c.crawlDim * k * fade, c.crawlGroundDamp);
    role.ends(0, 1, 0, 1);
    role.draw(grow + c.crawlTip, c.crawlTip, c.crawlFloor, c.crawlTipGlow);
  }

  /* ------------------------------------------------------------------ */
  /* The node hook                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Fired exactly once per node, on the frame the cursor reaches it.
   *
   * Node 0 is the caster's hand, so the muzzle flash is not a special case in
   * this ability — it is simply the first node lighting, which is both less code
   * and more honest about what is happening.
   *
   * `position` is `ArcNetwork`'s module scratch. It is read here and never kept.
   *
   * @param {number} index
   * @param {THREE.Vector3} position resolved world position of the node
   * @param {number} count total nodes this frame
   */
  _nodeFired(index, position, count) {
    const c = settings.chainarc;
    const g = settings.global;
    const time = frame.uTime.value;

    this._earthNode = index;
    this._earthAt = this.age;

    /* --- the shell of ionised air --- */
    this.ctx.bursts.spawn(BurstMode.STORM, position, {
      radius: c.nodeBurstSize * 0.2,
      endRadius: c.nodeBurstSize * g.explosionIntensity,
      life: 0.28,
      intensity: c.nodeBurstIntensity,
      opacity: 0.9,
      fresnel: 1.5,
      displace: 0.5,
      colorA: getColor(c.colorNodeA),
      colorB: getColor(c.colorNodeB),
      colorC: getColor(c.colorNodeC)
    });

    /* --- the spark spray, thrown along the heading of the next hop --- */
    _emit.position = position;
    _emit.radius = 0.14;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.4).setY(0.6).normalize();
    _emit.speed = c.sparkSpeed * 1.4;
    _emit.speedVariance = 0.85;
    _emit.spread = 0.95;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.18;
    _emit.sizeVariance = 0.7;
    _emit.life = c.sparkLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.sparks.emit(Math.round(c.nodeSparks * g.particleCount), _emit);

    /* --- the burn under this node, and only under this node --- */
    _pos.set(position.x, 0, position.z);

    this.ctx.decals.spawn(DecalType.ARC, _pos, {
      radius: c.nodeArcRadius * randRange(0.7, 1.2),
      life: c.nodeArcLife,
      width: c.nodeArcBranches,
      intensity: c.nodeArcIntensity,
      colorA: getColor(c.colorEmber),
      colorB: getColor(c.colorArc)
    });
    this.ctx.decals.spawn(DecalType.SCORCH, _pos, {
      radius: c.nodeScorchRadius * randRange(0.7, 1.3),
      life: c.nodeScorchLife,
      intensity: c.nodeScorchIntensity,
      colorA: getColor(c.colorScorch),
      colorB: getColor(c.colorEmber),
      height: 0.015
    });

    /* --- chips off the floor beneath it --- */
    _emit.position = _pos;
    _emit.radius = c.nodeScorchRadius * 1.6;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.debrisSpeed;
    _emit.speedVariance = 0.75;
    _emit.spread = 0.8;
    _emit.size = 0.1;
    _emit.life = c.debrisLifetime;
    _emit.spin = 8;
    this.debris.emit(Math.round(c.nodeDebris * g.particleCount), _emit);

    // A punch per node is what makes the hop read in the lighting as well as in
    // the geometry — the last node gets a bigger one from `onImpact`.
    const last = index >= count - 1;
    this.lightBoost = c.nodeLightPunch * (last ? 1.6 : 1) * g.explosionIntensity;
  }

  /* ------------------------------------------------------------------ */
  /* Shed along the lit chain                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Sparks, motes and smoke shed by the part of the chain that is currently lit.
   *
   * Emission points come from `nodePoint()` on a node the cursor has already
   * passed, jittered by a fraction of the live `scatter`, so the shed material
   * sits on the route rather than on the aim line the route departs from.
   *
   * @param {number} scale 0..1 — thinned once the chain is only holding
   */
  _chainFx(dt, scale) {
    const c = settings.chainarc;
    const g = settings.global;
    const time = frame.uTime.value;
    const lit = clamp(Math.floor(this.net.cursor), 0, this.net.nodeCount - 1);

    let sparkCount = Math.round(this.sparkEmitter.tick(dt, c.sparkRate * scale) * g.particleCount);
    if (sparkCount > 0) {
      _emit.direction = _dir.copy(this.direction).multiplyScalar(0.4).setY(0.55).normalize();
      _emit.speed = c.sparkSpeed;
      _emit.speedVariance = 0.85;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.15;
      _emit.sizeVariance = 0.7;
      _emit.life = c.sparkLifetime;
      _emit.lifeVariance = 0.55;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;

      // Split the frame's sparks over several nodes. Firing them all from one
      // point makes every batch read as a starburst pinned to that node, which
      // is very obviously wrong the moment you look at it — the same lesson the
      // bolt learnt along its length.
      const batches = Math.min(sparkCount, lit + 1);
      const per = Math.ceil(sparkCount / Math.max(1, batches));
      while (sparkCount > 0) {
        const node = Math.floor(Math.random() * (lit + 1));
        this.net.nodePoint(node, _pos);
        _emit.position = _pos;
        _emit.radius = c.scatter * 0.22 + 0.05;
        this.sparks.emit(Math.min(per, sparkCount), _emit);
        sparkCount -= per;
      }
    }

    const moteCount = Math.round(this.moteEmitter.tick(dt, c.moteRate * scale) * g.particleCount);
    if (moteCount > 0) {
      this.net.nodePoint(Math.floor(Math.random() * (lit + 1)), _pos);
      _emit.position = _pos;
      _emit.radius = c.scatter * 0.35 + 0.2;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 1.0;
      _emit.size = 0.08;
      _emit.sizeVariance = 0.6;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.time = time;
      this.motes.emit(moteCount, _emit);
    }

    const smokeCount = Math.round(this.smokeEmitter.tick(dt, c.smokeRate * scale) * g.particleCount);
    if (smokeCount > 0) {
      // Smoke comes off the *floor* under a node, not off the chain — it is the
      // burn smouldering, and there is no burn between the nodes.
      this.net.nodePoint(Math.floor(Math.random() * (lit + 1)), _pos);
      _pos.y = 0.15;
      _emit.position = _pos;
      _emit.radius = c.nodeScorchRadius * 2.2;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.smokeSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.9;
      _emit.size = 0.8;
      _emit.sizeVariance = 0.5;
      _emit.life = c.smokeLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.4;
      _emit.time = time;
      this.smoke.emit(smokeCount, _emit);
    }
  }

  /** Push the live gradients and scales into all four particle systems. */
  _syncParticles() {
    const c = settings.chainarc;
    const g = settings.global;

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
    this.sparks.uniforms.uGlow.value = c.glow * 0.6 * g.glow;
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
    this.smoke.uniforms.uTurbulence.value = 0.35 * g.turbulence;

    this.debris.setGradient(
      getColor(c.colorDebrisA),
      getColor(c.colorDebrisB),
      getColor(c.colorDebrisC),
      getColor(c.colorDebrisD)
    );
    this.debris.uniforms.uGravity.value.set(0, c.debrisGravity, 0);
    this.debris.uniforms.uSizeScale.value = c.debrisSize * g.particleSize * 7;
    this.debris.uniforms.uLifeScale.value = c.debrisLifetime * 0.5 * g.particleLifetime;
    this.debris.uniforms.uSpeedScale.value = g.particleSpeed;
    this.debris.uniforms.uOpacity.value = g.opacity;
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.sparkEmitter.reset();
    this.moteEmitter.reset();
    this.smokeEmitter.reset();

    // The one thing a cast captures. Everything else is a timestamp.
    this._seed = Math.random() * 100;
    this._appliedRoute = Number.NaN;
    this._earthNode = -1;
    this._earthAt = -1;
    this._impactAt = -1;

    this.net.reset(this._seed);
    this._syncParticles();
    // A zero-length first frame, which lights node 0 and therefore fires the
    // hand flash through the ordinary node hook.
    this._step(0, 1);
    this._frontPoint(this.position);

    const c = settings.chainarc;
    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * settings.global.explosionIntensity);
  }

  /**
   * The chain does not travel, so the base class's metres-per-second front is
   * replaced outright.
   *
   * `u` becomes the graph's own progress — hops completed over hops total — and
   * the frame the last node lights is the frame `advance()` reports the end of
   * the line. Everything downstream (the phase machine, the HUD's progress
   * readout, the camera's framing point) then works unchanged, which is the
   * whole reason for expressing it this way rather than overriding `update()`.
   */
  advance(dt) {
    this._step(dt, 1);
    const previous = this.u;
    this.u = this.net.progress;
    this.front = this.u * this.length;
    this._frontPoint(this.position);
    return this.u >= 1 && previous < 1;
  }

  onTravel(dt) {
    // `advance()` has already stepped the network this frame.
    this._syncParticles();
    this._chainFx(dt, 1);
    this.ctx.shake.rumble(settings.chainarc.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.chainarc;
    const g = settings.global;
    const time = frame.uTime.value;

    this._impactAt = this.age;
    this._impactPoint(_target);
    this.pointAt(1, _pos);

    /* the shell at the last node */
    this.ctx.bursts.spawn(BurstMode.STORM, _target, {
      radius: c.burstSize * 0.2,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.7,
      intensity: c.burstIntensity,
      opacity: 0.9,
      fresnel: 1.6,
      displace: 0.6,
      squash: 0.8,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    /* the ring that snaps outward across the floor */
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _pos, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.6,
      width: 0.05,
      intensity: 1.0,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    /* a wide burn where it grounded out — the node burn, scaled up */
    this.ctx.decals.spawn(DecalType.ARC, _pos, {
      radius: c.nodeArcRadius * 2.4,
      life: c.nodeArcLife * 1.6,
      width: c.nodeArcBranches,
      intensity: c.nodeArcIntensity,
      colorA: getColor(c.colorEmber),
      colorB: getColor(c.colorArc)
    });
    this.ctx.decals.spawn(DecalType.SCORCH, _pos, {
      radius: c.nodeScorchRadius * 2.6,
      life: c.nodeScorchLife * 1.4,
      intensity: c.nodeScorchIntensity * 1.3,
      colorA: getColor(c.colorScorch),
      colorB: getColor(c.colorEmber),
      height: 0.015
    });

    /* sparks and chips blown out of the strike */
    _emit.position = _target;
    _emit.radius = 0.3;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.5).setY(0.7).normalize();
    _emit.speed = c.sparkSpeed * 2.2;
    _emit.speedVariance = 0.85;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.22;
    _emit.sizeVariance = 0.8;
    _emit.life = c.sparkLifetime * 1.5;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.sparks.emit(Math.round(c.burstSparks * g.particleCount), _emit);

    _emit.position = _pos;
    _emit.radius = c.nodeScorchRadius * 2;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.debrisSpeed * 1.8;
    _emit.spread = 0.85;
    _emit.size = 0.14;
    _emit.life = c.debrisLifetime * 1.3;
    _emit.spin = 10;
    this.debris.emit(Math.round(c.burstDebris * g.particleCount), _emit);

    _emit.speed = c.smokeSpeed * 2.2;
    _emit.spread = 1.0;
    _emit.size = 1.5;
    _emit.life = c.smokeLifetime * 1.3;
    _emit.spin = 0.5;
    this.smoke.emit(Math.round(40 * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      26
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
  }

  onFade(dt, t) {
    // `t` runs 0..1 while the chain holds, then 1..2 while it gutters out. The
    // blow-out is cubic so it hangs on and then lets go, rather than dimming.
    const fade = t <= 1 ? 1 : 1 - Easing.inCubic(saturate(t - 1));
    this._step(dt, fade);
    this._syncParticles();
    this._frontPoint(this.position);
    // Thinned as it dies. A guttering chain still throws sparks; it just throws
    // fewer of them, and `lerp` here keeps the two rates one number apart.
    this._chainFx(dt, fade * lerp(0.5, 0.25, saturate(t - 1)));
  }

  onDestroy() {
    this.net.clear();
    this.spikeRole.retire();
    this.crawlRole.retire();
    this.paths.clear();
    this._earthNode = -1;
    this._impactAt = -1;
  }

  dispose() {
    // The network does not own the strip, so disposing the strip is enough.
    this.paths.dispose();
    super.dispose();
  }
}
