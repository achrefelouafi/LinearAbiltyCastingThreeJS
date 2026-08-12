import {
  InstancedMesh,
  InstancedBufferAttribute,
  Object3D,
  Vector3,
  Quaternion
} from 'three';
import { Ability, AbilityPhase } from './Ability.js';
import { createIceMaterial } from '../materials/IceMaterial.js';
import { createCrystalGeometry } from '../assets/ProceduralGeometry.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { BurstMode } from '../effects/BurstSphere.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, lerp, smoothstep, Easing, randRange } from '../utils/math.js';

/** Hard ceiling on crystals per cast. The editor's count slider clamps to this. */
const MAX_SPIKES = 288;
/**
 * Distinct crystal shapes in the field. Each is its own InstancedMesh — three
 * draw calls buys real silhouette variety that per-instance scaling alone
 * cannot, because the *facets* differ, not just the proportions.
 */
const VARIANTS = 3;
const SLOTS = Math.ceil(MAX_SPIKES / VARIANTS);
const TAU = Math.PI * 2;

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _lean = new Vector3();
const _axis = new Vector3();
const _up = new Vector3(0, 1, 0);
const _dummy = new Object3D();
const _spin = new Quaternion();
const _tilt = new Quaternion();

/**
 * ICE — a glacial eruption along the aimed line.
 *
 * One beat, drawn out: a fracture front races away from the caster at `speed`,
 * and a field of crystal spikes tears out of the floor behind it — dense and
 * ankle-high at the caster, opening into a wall of blades at the far end, with a
 * final cluster thrown up around the impact point. Rime spreads on the ground,
 * fog rolls off the base and a plume of glitter drifts up out of the wreckage.
 *
 * Everything is generated: the crystals are procedural geometry, their shading
 * is a patched standard material (so they take the stage's shadows and probe),
 * the rime is a shader on a quad and the mist, chips and glitter are GPU
 * particles. Nothing is loaded from disk.
 *
 * **The rule that makes the editor work.** A spike record stores only what the
 * dice decided — a position *fraction* along the line, a signed lateral
 * *fraction*, and a handful of unitless jitters. Not one metre, radian or second
 * is captured at spawn time; all of them are resolved against `settings.ice`
 * inside the update loop. Dragging `height` therefore re-grows a field that is
 * already standing, and it does so with the clock paused, which is when the
 * silhouette is actually worth tuning.
 *
 * The only values a record *does* capture are timestamps — the moment its own
 * eruption was triggered. Those are events, not dimensions.
 */
export class IceAbility extends Ability {
  constructor(context) {
    super('ice', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    const environment = this.ctx.environment;

    this.material = createIceMaterial(environment);

    /** Signature of the geometry controls, so a rebuild only happens on a change. */
    this._shapeKey = '';

    this.meshes = [];
    this.seedAttributes = [];
    this.birthAttributes = [];

    for (let v = 0; v < VARIANTS; v++) {
      const geometry = this._buildGeometry(v);

      const seeds = new InstancedBufferAttribute(new Float32Array(SLOTS), 1);
      const births = new InstancedBufferAttribute(new Float32Array(SLOTS), 1);
      for (let i = 0; i < SLOTS; i++) seeds.array[i] = Math.random() * 10;
      geometry.setAttribute('aSeed', seeds);
      geometry.setAttribute('aBirth', births);

      const mesh = new InstancedMesh(geometry, this.material, SLOTS);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;
      // Solid world geometry: it belongs in the depth prepass so the mist and
      // the glitter fade softly where they intersect it.
      mesh.layers.set(LAYER.WORLD);
      mesh.renderOrder = 2;
      this.group.add(mesh);

      this.meshes.push(mesh);
      this.seedAttributes.push(seeds);
      this.birthAttributes.push(births);
    }

    /**
     * Fixed-size record pool — a cast allocates nothing.
     *
     * See the class comment: dice only, no dimensions.
     */
    this.records = [];
    for (let i = 0; i < MAX_SPIKES; i++) {
      this.records.push({
        along: 0, // 0..1 down the cast line
        lateral: 0, // -1..1 across the band, before clumping
        scatter: 0, // -1..1 extra lateral jitter
        angle: 0, // impact-cluster bearing, radians
        radial: 0, // impact-cluster distance, 0..1
        impact: false, // held back for the cluster at the far end
        rubble: false, // demoted to ankle-height wreckage
        heightJitter: 0,
        radiusJitter: 0,
        leanJitter: 0,
        pitchJitter: 0,
        yaw: 0,
        stagger: 0, // 0..1 of `riseStagger`
        eruptTime: -1, // absolute age it was triggered at, or -1
        shattered: false
      });
    }

    this._activeCount = 0;
    this._impactStart = MAX_SPIKES;
  }

  /** One crystal shape. Variant index only perturbs the seed. */
  _buildGeometry(variant) {
    const c = settings.ice;
    return createCrystalGeometry({
      seed: 7.3 + variant * 21.7,
      sides: c.facets,
      taper: c.taper,
      roughness: c.roughness,
      bend: c.bend
    });
  }

  /**
   * Regenerate the crystal meshes when a *shape* control moves.
   *
   * Facet count, taper, roughness and bend cannot be expressed as a per-instance
   * transform, so they are baked into the geometry — and a six-sided crystal is
   * 108 triangles, cheap enough to simply rebuild rather than approximate in a
   * vertex shader. That is what keeps them live sliders.
   */
  _syncGeometry() {
    const c = settings.ice;
    const key = `${Math.round(c.facets)}|${c.taper.toFixed(3)}|${c.roughness.toFixed(3)}|${c.bend.toFixed(3)}`;
    if (key === this._shapeKey) return;
    this._shapeKey = key;

    for (let v = 0; v < VARIANTS; v++) {
      const mesh = this.meshes[v];
      const previous = mesh.geometry;
      const geometry = this._buildGeometry(v);
      // The per-instance attributes are state, not shape — carry them over.
      geometry.setAttribute('aSeed', this.seedAttributes[v]);
      geometry.setAttribute('aBirth', this.birthAttributes[v]);
      mesh.geometry = geometry;
      previous.dispose();
    }
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Ground fog rolling off the eruption. Non-additive: it has to *occlude*,
    // which is what gives the field depth in the reference look.
    this.mist = particles.get('ice.mist', {
      capacity: 3200,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.2
    });
    this.mist.uniforms.uDrag.value = 1.9;
    this.mist.uniforms.uEndSize.value = 3.4;
    this.mist.uniforms.uSizeIn.value = 0.1;
    this.mist.uniforms.uFadeIn.value = 0.14;
    this.mist.uniforms.uFadeOut.value = 0.3;

    // Chips torn off the crystals as they punch through the floor.
    this.shards = particles.get('ice.shards', {
      capacity: 2400,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.shards.uniforms.uDrag.value = 0.22;
    this.shards.uniforms.uEndSize.value = 0.85;
    this.shards.uniforms.uFadeOut.value = 0.72;

    // The rising glitter plume — the signature of the reference frame.
    this.glitter = particles.get('ice.glitter', {
      capacity: 2800,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.glitter.uniforms.uDrag.value = 1.1;
    this.glitter.uniforms.uEndSize.value = 0.18;
    this.glitter.uniforms.uSizeIn.value = 0.05;
    this.glitter.uniforms.uFadeIn.value = 0.06;
    this.glitter.uniforms.uFadeOut.value = 0.35;

    this.mistEmitter = new RateEmitter();
    this.glitterEmitter = new RateEmitter();
    this.frostEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this._activeCount;
  }

  /** The field stands for its lifetime, then the fade withdraws it. */
  get impactDuration() {
    return Math.max(0.2, settings.ice.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    const c = settings.ice;
    return Math.max(0.2, c.shatterDelay + c.sinkTime);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    const c = settings.ice;

    this.mistEmitter.reset();
    this.glitterEmitter.reset();
    this.frostEmitter.reset();
    this._frostDistance = 0;

    const wanted = Math.min(MAX_SPIKES, Math.max(1, Math.round(c.spikeCount * c.density)));
    // The last slice is held back for the cluster thrown up at the impact point.
    const impactCount = Math.round(wanted * 0.22);
    this._activeCount = wanted;
    this._impactStart = wanted - impactCount;

    for (let i = 0; i < wanted; i++) {
      const record = this.records[i];
      const impact = i >= this._impactStart;

      record.impact = impact;
      record.eruptTime = -1;
      record.shattered = false;
      record.yaw = Math.random() * TAU;
      record.stagger = Math.random();
      record.heightJitter = randRange(-1, 1);
      record.radiusJitter = randRange(-1, 1);
      record.leanJitter = randRange(-1, 1);
      record.pitchJitter = randRange(-1, 1);
      record.scatter = randRange(-1, 1);
      record.rubble = Math.random() < c.rubble;

      if (impact) {
        record.angle = Math.random() * TAU;
        // sqrt keeps the cluster evenly dense rather than piled in the middle.
        record.radial = Math.sqrt(Math.random());
        record.along = 1;
      } else {
        // `frontBias` < 1 crowds the field toward the impact point.
        record.along = Math.pow((i + Math.random()) / Math.max(1, this._impactStart), c.frontBias);
        record.lateral = randRange(-1, 1);
      }
    }

    for (let i = wanted; i < MAX_SPIKES; i++) this.records[i].eruptTime = -1;
    for (let v = 0; v < VARIANTS; v++) this.meshes[v].count = 0;
  }

  /* ------------------------------------------------------------------ */
  /* Resolving a spike — every metre, radian and second comes from here   */
  /* ------------------------------------------------------------------ */

  /** Half-width of the band at `s` along the line, metres. */
  _halfWidth(s, c) {
    return lerp(c.widthNear, c.width, Math.pow(saturate(s), c.widthCurve));
  }

  /** Signed lateral offset of a record, as a fraction of the local half-width. */
  _lateralNorm(record, c) {
    const raw = record.lateral;
    const clumped = Math.sign(raw) * Math.pow(Math.abs(raw), c.clumping);
    return clumped + record.scatter * c.scatter;
  }

  /** Where a spike currently stands, at the live footprint settings. */
  _spikePosition(record, c, out) {
    if (record.impact) {
      const reach = this._halfWidth(1, c) * 1.25 * record.radial;
      this.pointAt(1, out);
      out.x += Math.cos(record.angle) * reach;
      out.z += Math.sin(record.angle) * reach;
      return out;
    }

    this.pointAt(record.along, out);
    return out.addScaledVector(this.side, this._lateralNorm(record, c) * this._halfWidth(record.along, c));
  }

  /** Full height of a spike, metres. */
  _spikeHeight(record, c, g) {
    let h = lerp(c.heightNear, c.height, Math.pow(saturate(record.along), c.heightCurve));

    // The swell at the impact point.
    h *= 1 + (c.peak - 1) * smoothstep(1 - c.peakWidth, 1, record.along);

    // Domed silhouette: the blades on the flanks are shorter than the spine.
    const edge = record.impact ? record.radial : saturate(Math.abs(this._lateralNorm(record, c)));
    h *= lerp(1, 1 - saturate(c.crown), Math.pow(edge, 1.4));

    h *= 1 + record.heightJitter * c.heightJitter * g.randomness;
    if (record.rubble) h *= c.rubbleScale;

    return Math.max(0.02, h);
  }

  /** Base radius of a spike, metres. */
  _spikeRadius(record, c, g) {
    const grow = lerp(0.72, 1.15, Math.pow(saturate(record.along), 0.6));
    const jitter = 1 + record.radiusJitter * c.radiusJitter * g.randomness;
    return Math.max(0.01, c.radius * grow * jitter * (record.rubble ? 1.25 : 1));
  }

  /* ------------------------------------------------------------------ */
  /* The eruption                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Trigger every spike the fracture front has now reached.
   * `limit` is how far down the line the front has got, 0..1.
   */
  _triggerUpTo(limit, includeImpact) {
    const c = settings.ice;
    for (let i = 0; i < this._activeCount; i++) {
      const record = this.records[i];
      if (record.eruptTime >= 0) continue;
      if (record.impact && !includeImpact) continue;
      if (!record.impact && record.along > limit) continue;
      record.eruptTime = this.age + record.stagger * c.riseStagger;
    }
  }

  /**
   * How far out of the ground a spike is, 0 → 1 with a springy overshoot past 1.
   * Returns a negative number while it is still buried and waiting.
   */
  _emergence(record, c) {
    if (record.eruptTime < 0) return -1;
    const elapsed = this.age - record.eruptTime;
    if (elapsed < 0) return -1;

    const riseTime = Math.max(0.02, c.riseTime);
    const rise = Easing.outQuint(saturate(elapsed / riseTime));
    if (elapsed <= riseTime) return rise;

    // The punch-through carries past full height and settles back.
    const after = elapsed - riseTime;
    const spring = Math.sin(after * 14) * Math.exp(-after / Math.max(0.05, c.settle));
    return 1 + c.riseOvershoot * spring;
  }

  /**
   * Rebuild every instance matrix from the live settings.
   * @param {number} retract 0..1 — the whole field withdrawing into the floor.
   */
  _updateSpikes(dt, retract) {
    const c = settings.ice;
    const g = settings.global;
    const birthFade = Math.max(0.02, c.birthFade);
    const used = [0, 0, 0];

    for (let i = 0; i < this._activeCount; i++) {
      const record = this.records[i];
      const variant = i % VARIANTS;
      const slot = (i / VARIANTS) | 0;
      const emerge = this._emergence(record, c);

      if (emerge < 0) {
        // Still buried. Park it outside the view rather than drawing a degenerate
        // matrix at the origin.
        _dummy.position.set(0, -999, 0);
        _dummy.quaternion.identity();
        _dummy.scale.setScalar(0.0001);
        _dummy.updateMatrix();
        this.meshes[variant].setMatrixAt(slot, _dummy.matrix);
        this.birthAttributes[variant].array[slot] = 0;
        used[variant] = Math.max(used[variant], slot + 1);
        continue;
      }

      const height = this._spikeHeight(record, c, g);
      const radius = this._spikeRadius(record, c, g);

      /* --- chips at the moment it breaks the surface --- */
      if (!record.shattered && emerge > 0.25) {
        record.shattered = true;
        this._breachFx(record, c, g, radius);
      }

      /* --- lean: away from the caster, and outward across the band --- */
      const outward = record.impact
        ? Math.sign(Math.cos(record.angle)) * record.radial
        : this._lateralNorm(record, c);
      _lean
        .copy(this.direction)
        .multiplyScalar(0.75)
        .addScaledVector(this.side, outward * 0.85);
      if (_lean.lengthSq() < 1e-6) _lean.copy(this.direction);
      _lean.normalize();

      const leanAngle =
        c.lean *
        (0.35 + 0.65 * record.along) *
        (1 + record.leanJitter * c.leanJitter * g.randomness);

      // Rotating about (up × lean) tips the crystal's own +Y toward `lean`.
      _axis.crossVectors(_up, _lean).normalize();
      _tilt.setFromAxisAngle(_axis, leanAngle);
      _spin.setFromAxisAngle(_up, record.yaw * c.twist);
      _tilt.multiply(_spin);

      /* --- slide it up out of the floor --- */
      const settled = Math.min(1, emerge);
      this._spikePosition(record, c, _dummy.position);
      _dummy.position.y = (emerge - 1) * height * 0.85;

      if (retract > 0) {
        const sink = Easing.inCubic(retract);
        _dummy.position.y -= sink * (height + radius + 0.4);
      }

      _dummy.quaternion.copy(_tilt);
      _dummy.scale.set(radius, height, radius).multiplyScalar(lerp(0.86, 1, settled));
      _dummy.updateMatrix();

      this.meshes[variant].setMatrixAt(slot, _dummy.matrix);
      this.birthAttributes[variant].array[slot] =
        saturate(1 - (this.age - record.eruptTime) / birthFade);
      used[variant] = Math.max(used[variant], slot + 1);
    }

    for (let v = 0; v < VARIANTS; v++) {
      this.meshes[v].count = used[v];
      this.meshes[v].instanceMatrix.needsUpdate = true;
      this.birthAttributes[v].needsUpdate = true;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  _syncUniforms() {
    const c = settings.ice;
    const g = settings.global;

    this._syncGeometry();
    this.material.userData.sync();

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
    this.mist.uniforms.uTurbulence.value = 0.4 * g.turbulence;

    this.shards.setGradient(
      getColor(c.colorShardA),
      getColor(c.colorShardB),
      getColor(c.colorShardC),
      getColor(c.colorShardD)
    );
    this.shards.uniforms.uGravity.value.set(0, c.shardGravity, 0);
    this.shards.uniforms.uSizeScale.value = c.shardSize * g.particleSize * 7;
    this.shards.uniforms.uLifeScale.value = g.particleLifetime;
    this.shards.uniforms.uSpeedScale.value = g.particleSpeed;
    this.shards.uniforms.uOpacity.value = g.opacity;

    this.glitter.setGradient(
      getColor(c.colorSparkleA),
      getColor(c.colorSparkleB),
      getColor(c.colorSparkleC),
      getColor(c.colorSparkleD)
    );
    this.glitter.uniforms.uGravity.value.set(0, c.sparkleRise, 0);
    this.glitter.uniforms.uSizeScale.value = c.sparkleSize * g.particleSize * 7;
    this.glitter.uniforms.uLifeScale.value = c.sparkleLifetime * 0.5 * g.particleLifetime;
    this.glitter.uniforms.uSpeedScale.value = g.particleSpeed;
    this.glitter.uniforms.uOpacity.value = g.opacity;
    this.glitter.uniforms.uGlow.value = 0.9 * g.glow;
    this.glitter.uniforms.uTurbulence.value = c.sparkleTurbulence * g.turbulence;
  }

  /** Chips and a puff where a crystal breaks the surface. */
  _breachFx(record, c, g, radius) {
    const time = frame.uTime.value;

    this._spikePosition(record, c, _pos).setY(0.08);

    _emit.position = _pos;
    _emit.radius = radius * 0.8;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.35).setY(1).normalize();
    _emit.speed = c.shardSpeed;
    _emit.speedVariance = 0.7;
    _emit.spread = 0.75;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.1;
    _emit.sizeVariance = 0.7;
    _emit.life = c.shardLifetime;
    _emit.lifeVariance = 0.45;
    _emit.spin = 7;
    _emit.tint = null;
    _emit.time = time;
    this.shards.emit(Math.round(c.breachShards * g.particleCount), _emit);

    // Only some spikes puff: a few hundred smoking at once buries the field in
    // haze and hides the silhouette that is the whole point.
    if (Math.random() < 0.4) {
      _emit.speed = 0.7;
      _emit.spread = 1.0;
      _emit.size = 0.6;
      _emit.sizeVariance = 0.5;
      _emit.life = c.mistLifetime * 0.7;
      _emit.spin = 0.5;
      this.mist.emit(Math.round(2 * g.particleCount), _emit);
    }
  }

  /** Fog, glitter and rime shed continuously along the travelling front. */
  _frontFx(dt) {
    const c = settings.ice;
    const g = settings.global;
    const time = frame.uTime.value;
    const halfWidth = this._halfWidth(this.u, c);

    const mistCount = Math.round(this.mistEmitter.tick(dt, c.mistRate) * g.particleCount);
    if (mistCount > 0) {
      _emit.position = _pos.copy(this.position).setY(0.18);
      _emit.radius = halfWidth * 0.9;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.mistSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.9;
      _emit.sizeVariance = 0.5;
      _emit.life = c.mistLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.5;
      _emit.tint = null;
      _emit.time = time;
      this.mist.emit(mistCount, _emit);
    }

    const glitterCount = Math.round(this.glitterEmitter.tick(dt, c.sparkleRate) * g.particleCount);
    if (glitterCount > 0) {
      _emit.position = _pos.copy(this.position).setY(0.5);
      _emit.radius = halfWidth;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.sparkleSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.85;
      _emit.size = 0.09;
      _emit.sizeVariance = 0.6;
      _emit.life = c.sparkleLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.time = time;
      this.glitter.emit(glitterCount, _emit);
    }

    /* rime laid on the floor as the fracture passes over it */
    const step = 1 / Math.max(0.1, c.frostRate);
    while (this.front - this._frostDistance >= step) {
      this._frostDistance += step;
      const s = saturate(this._frostDistance / this.length);
      const width = this._halfWidth(s, c);
      this.pointAt(s, _pos);
      _pos.x += this.side.x * randRange(-0.7, 0.7) * width;
      _pos.z += this.side.z * randRange(-0.7, 0.7) * width;

      this.ctx.decals.spawn(DecalType.FROST, _pos, {
        radius: width * c.frostSpread * randRange(0.6, 1.15),
        life: c.frostLife,
        width: c.frostCrystals,
        intensity: c.frostIntensity,
        colorA: getColor(c.colorFrost),
        colorB: getColor(c.colorFrostEdge)
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._syncUniforms();
    this._triggerUpTo(this.u, false);
    this._updateSpikes(dt, 0);
    this._frontFx(dt);

    this.ctx.shake.rumble(settings.ice.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.ice;
    const g = settings.global;
    const time = frame.uTime.value;

    // Everything still buried goes up now, including the terminal cluster.
    this._triggerUpTo(1, true);

    // One scratch vector for the whole sequence: every consumer below copies
    // what it needs out of it, so it can be re-aimed in place.
    this.pointAt(1, _pos).setY(0.6);

    /* the shell of freezing vapour */
    this.ctx.bursts.spawn(BurstMode.FROST, _pos, {
      radius: c.burstSize * 0.3,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.95,
      intensity: c.burstIntensity,
      opacity: 0.85,
      fresnel: 1.3,
      displace: 0.55,
      squash: 0.72,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    /* the ring that snaps outward across the floor */
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _pos, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.75,
      width: 0.06,
      intensity: 0.9,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    /* a broad rime patch under the cluster */
    this.ctx.decals.spawn(DecalType.FROST, _pos, {
      radius: this._halfWidth(1, c) * c.frostSpread * 2.2,
      life: c.frostLife * 1.3,
      width: c.frostCrystals,
      intensity: c.frostIntensity,
      colorA: getColor(c.colorFrost),
      colorB: getColor(c.colorFrostEdge)
    });

    /* chips, fog and glitter thrown out of the impact */
    _emit.position = _pos.setY(0.4);
    _emit.radius = this._halfWidth(1, c) * 0.8;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.shardSpeed * 1.8;
    _emit.speedVariance = 0.75;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.16;
    _emit.sizeVariance = 0.8;
    _emit.life = c.shardLifetime * 1.4;
    _emit.lifeVariance = 0.5;
    _emit.spin = 9;
    _emit.tint = null;
    _emit.time = time;
    this.shards.emit(Math.round(c.burstShards * g.particleCount), _emit);

    _emit.speed = c.mistSpeed * 2.4;
    _emit.spread = 1.0;
    _emit.size = 1.6;
    _emit.life = c.mistLifetime * 1.5;
    _emit.spin = 0.6;
    this.mist.emit(Math.round(90 * g.particleCount), _emit);

    _emit.speed = c.sparkleSpeed * 1.6;
    _emit.spread = 0.8;
    _emit.size = 0.1;
    _emit.life = c.sparkleLifetime * 1.3;
    _emit.spin = 0;
    this.glitter.emit(Math.round(150 * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      19
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 1.6 * g.explosionIntensity;
  }

  onFade(dt) {
    const c = settings.ice;
    this._syncUniforms();

    let retract = 0;
    if (this.phase === AbilityPhase.FADE) {
      retract = saturate((this.fadeTime - c.shatterDelay) / Math.max(0.05, c.sinkTime));
    }

    this._updateSpikes(dt, retract);

    // The field keeps steaming while it stands, then stops as it withdraws.
    if (retract < 0.6) {
      const g = settings.global;
      const time = frame.uTime.value;
      const count = Math.round(this.glitterEmitter.tick(dt, c.sparkleRate * 0.35) * g.particleCount);
      if (count > 0) {
        this.pointAt(randRange(0.25, 1), _pos).setY(0.35);
        _emit.position = _pos;
        _emit.radius = this._halfWidth(1, c);
        _emit.direction = _dir.set(0, 1, 0);
        _emit.speed = c.sparkleSpeed * 0.7;
        _emit.speedVariance = 0.8;
        _emit.spread = 0.9;
        _emit.inherit = null;
        _emit.anchor = null;
        _emit.size = 0.08;
        _emit.sizeVariance = 0.6;
        _emit.life = c.sparkleLifetime;
        _emit.lifeVariance = 0.5;
        _emit.spin = 0;
        _emit.tint = null;
        _emit.time = time;
        this.glitter.emit(count, _emit);
      }
    }
  }

  onDestroy() {
    this._activeCount = 0;
    for (let v = 0; v < VARIANTS; v++) this.meshes[v].count = 0;
  }

  dispose() {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
    this.material.dispose();
    super.dispose();
  }
}
