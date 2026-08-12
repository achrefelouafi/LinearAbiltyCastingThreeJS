import { Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { Swarm, Silhouette, LeadPath, swarmParams } from '../../vfx/Swarm.js';
import { GroundField, GroundMode, groundFieldParams } from '../../vfx/GroundField.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, Easing } from '../../utils/math.js';

/**
 * Hard ceiling on cards. Three hundred and eighty-four is a little over the
 * 13 × 8 × 4 lattice the block ships with, which is deliberate: the separation
 * guarantee holds while `cards <= latticeX × latticeY × latticeZ`, and leaving
 * headroom means dragging `cards` up finds the wall rather than the capacity.
 */
const MAX_CARDS = 384;

/* --- module-scope scratch: nothing in an update path allocates (I3) --- */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _lead = new Vector3();
const _swarm = swarmParams();
const _ground = groundFieldParams();

/**
 * GLYPHSTORM — a blizzard of legible marks thrown down the line.
 *
 * **The trick is that the cards keep their own facing.** `Swarm`'s `billboard`
 * blends a card's basis between the agent's own frame and the camera's. At 1 it
 * is a sprite and the storm is a flat wall of symbols that never changes; at 0
 * it is a plate in the world and the storm is a scatter of bright lines with no
 * symbols in it at all. This ships at **0.22** — the card is very nearly its
 * own thing — and the formation's `churn` then rolls every card through its own
 * edge-on angle at its own moment. What you get is neither of the two static
 * reads: it is a storm that *flickers* between them, hundreds of times a
 * second, and the flicker comes free out of the billboard maths.
 *
 * It comes free but it does not survive on its own. A card going edge-on
 * collapses toward a zero-width line, and a zero-width line at twenty metres
 * is under a pixel: it aliases into nothing, and instead of a mark seen
 * side-on you get a hole in the storm. Two sliders fix that and both are
 * load-bearing — `edgeStretch` grows the card as it turns so its line always
 * covers a pixel, and `edgeGain` lifts its emission so the moment it goes thin
 * it also goes *hot*. Set either to its neutral value and the storm stops
 * flickering and starts guttering.
 *
 * **Three beats, and the second one is not a phase.**
 *
 *  1. **Gather.** `gather` starts at `gatherTight`, which collapses every card
 *     onto the lead's own path — a knot of light at the hand — and `reveal`
 *     starts at zero, so the cards are *written* rather than switched on. Both
 *     open over the first third of the flight.
 *  2. **Storm.** The lead runs down the cast line; the formation strings out
 *     behind it because cohesion in this module is a lag, not a force, and
 *     pours round the loft a beat late.
 *  3. **Settle.** Through the impact phase the lead's end height drops to
 *     `settleHeight`, the vertical spacing collapses to `settleSpacing` of
 *     itself, the churn dies, and `reveal` runs *backwards* — so the cards go
 *     out in a wave rather than all at once — while a `GroundField(LATTICE)`
 *     charge crosses the floor underneath. The marks do not land on the
 *     lattice; they become it.
 *
 * **Two draw calls.** One `Swarm`, one `GroundField`. That is the whole
 * ability, and it is worth saying out loud: three hundred separately oriented,
 * separately banking, separately glyphed quads plus a propagating hex circuit
 * cost less than the beam's tube. Nothing about a card exists on the CPU — it
 * carries a seed and an index, and every metre it uses is a uniform re-read
 * from `settings.glyphstorm` in the vertex shader each frame.
 *
 * **On the alphabet.** The roster asks whether `GroundField`'s RUNE letterforms
 * could be shared here. They could not — `GLYPH_ALPHABET` is module-private —
 * and after reading the argument in `src/vfx/README.md` I would not have used
 * them anyway: a seal is a thing you pause and stare at and it earns sixteen
 * authored letterforms; a storm is weather. `CARD`'s six-stroke walk between
 * the points of a 3 × 5 lattice is cheaper *and* better here, because what
 * makes three hundred marks read as writing is shared terminals and shared
 * angles, which the lattice gives you and a legible font does not need.
 *
 * **What a cast captures.** One seed, handed to `Swarm.roll()`, plus the
 * per-agent dice the module rolls behind it. No metre, radian, second or
 * colour. Pause mid-flight with **P** and drag `spacingSide`, `cardSize`,
 * `billboard` or `lag`: the storm re-forms around the new numbers with the
 * clock stopped, because it is a closed-form function of time and always was.
 */
export class GlyphstormAbility extends Ability {
  constructor(context) {
    super('glyphstorm', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    this.swarm = new Swarm(this.group, {
      capacity: MAX_CARDS,
      silhouette: Silhouette.CARD,
      // Additive: a mark is ink that is on fire, not ink on paper, and two
      // overlapping cards should get brighter rather than flatter. It is also
      // what lets the edge-on gain read at all — an alpha-blended card at
      // triple emission just clips to white.
      additive: true,
      renderOrder: 12
    });

    this.burn = new GroundField(this.group, {
      mode: GroundMode.LATTICE,
      // Shaded, not additive: the etch between the traces has to come out
      // *darker* than the floor or the lattice reads as a projection.
      additive: false,
      renderOrder: 7,
      name: 'Glyphstorm:lattice'
    });

    _swarm.leadMode = LeadPath.LINE;
    _swarm.silhouette = Silhouette.CARD;

    /** Timestamp of the frame the lattice took. An event, not a dimension. */
    this._tookAt = -1;
    this._seed = 0;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Ink: the loose marks that never made it onto a card. Curl-driven, so
    // they roll rather than drift, which is what keeps them reading as a
    // medium rather than as dust.
    this.ink = particles.get('glyphstorm.ink', {
      capacity: 1200,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.ink.uniforms.uDrag.value = 1.5;
    this.ink.uniforms.uEndSize.value = 0.3;
    this.ink.uniforms.uSizeIn.value = 0.08;
    this.ink.uniforms.uFadeIn.value = 0.1;
    this.ink.uniforms.uFadeOut.value = 0.45;

    // Sparks struck off a card as it touches the floor.
    this.sparks = particles.get('glyphstorm.sparks', {
      capacity: 1600,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.25
    });
    this.sparks.uniforms.uDrag.value = 1.5;
    this.sparks.uniforms.uEndSize.value = 0.22;
    this.sparks.uniforms.uSizeIn.value = 0.03;
    this.sparks.uniforms.uFadeIn.value = 0.04;
    this.sparks.uniforms.uFadeOut.value = 0.5;

    this.inkEmitter = new RateEmitter();
    this.sparkEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this.swarm.count;
  }

  /** The settle, then the lattice holding. */
  get impactDuration() {
    const c = settings.glyphstorm;
    return Math.max(0.05, (c.settleTime + c.lifetime) * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.glyphstorm.fadeTime);
  }

  /** Seconds the cards take to come down, on the same clock as the phase. */
  get _settleSpan() {
    return Math.max(0.02, settings.glyphstorm.settleTime * settings.global.lifetime);
  }

  /**
   * The light drops to `lightSettle` once the storm is on the floor.
   *
   * A step rather than a flicker, and no shimmer at all: a hundred separately
   * blinking cards already carry every bit of high-frequency brightness this
   * ability can afford, and a guttering key light on top of that reads as a
   * broken monitor.
   */
  lightShimmer() {
    const c = settings.glyphstorm;
    if (this.phase === AbilityPhase.TRAVEL) return 1;
    return this._tookAt >= 0 ? c.lightSettle : 1;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.inkEmitter.reset();
    this.sparkEmitter.reset();

    // The one thing a cast captures: a seed. `Swarm.roll` shifts the whole
    // separation lattice by it, so two casts do not deal the same hand of
    // cards to the same cells.
    this._seed = Math.random() * 100;
    this.swarm.roll(this._seed);
    this._tookAt = -1;

    this._syncParticles();
    this._syncSwarm(0, 0);
    this._syncBurn(0, 0, 1);
    this._muzzleFx();
  }

  /** Where the cards are written out of, in world space. */
  _handPoint(out) {
    const c = settings.glyphstorm;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Live state — every dimension re-resolved, every frame               */
  /* ------------------------------------------------------------------ */

  /**
   * Push the flock.
   *
   * @param {number} s      0..1 down the cast line the lead has reached
   * @param {number} settle 0..1 through the landing
   */
  _syncSwarm(s, settle) {
    const c = settings.glyphstorm;
    const g = settings.global;

    this.swarm.setBasis(this.origin, this.direction, this.side, this.length);
    this.swarm.setColors(c.colorCardA, c.colorCardB, c.colorCardC, c.colorCardD);

    const ease = Easing.outCubic(settle);

    _swarm.count = Math.min(MAX_CARDS, Math.max(0, Math.round(c.cards)));

    /* --- the lead ------------------------------------------------- */
    _swarm.leadMode = LeadPath.LINE;
    _swarm.leadS = s;
    // d(s)/dt, so the shader can rewind the lead by each rank's own lag. Zero
    // once the storm has arrived: a stationary lead with a live rate would keep
    // stringing the formation out behind a point that is not moving.
    _swarm.leadRate =
      this.phase === AbilityPhase.TRAVEL ? (c.speed * g.speed) / Math.max(0.01, this.length) : 0;
    _swarm.leadRise = c.leadRise * (1 - ease);
    _swarm.handForward = c.handForward;
    _swarm.handSide = c.handSide;
    _swarm.handHeight = c.handHeight;
    _swarm.endHeight = lerp(c.flightHeight, c.settleHeight, ease);

    /* --- the formation -------------------------------------------- */
    _swarm.latticeX = c.latticeX;
    _swarm.latticeY = c.latticeY;
    _swarm.latticeZ = c.latticeZ;
    _swarm.spacingSide = c.spacingSide;
    // The formation flattens as it lands rather than shrinking: the cards
    // spread *out* across the floor, they do not pile up on it.
    _swarm.spacingUp = c.spacingUp * lerp(1, c.settleSpacing, ease);
    _swarm.lag = c.lag;
    _swarm.jitter = c.formJitter * g.randomness;
    _swarm.churn = c.churn * lerp(1, c.settleChurn, ease);
    _swarm.breathe = c.breathe;
    _swarm.breatheRate = c.breatheRate;
    _swarm.wander = c.wander;
    _swarm.wanderScale = c.wanderScale * g.noiseFrequency;
    _swarm.wanderSpeed = c.wanderSpeed * g.noiseSpeed;
    _swarm.gather = lerp(
      lerp(c.gatherTight, c.gatherStorm, saturate(s / Math.max(1e-3, c.gatherRamp))),
      c.settleGather,
      ease
    );

    /* --- the body -------------------------------------------------- */
    _swarm.size = c.cardSize;
    _swarm.aspect = c.cardAspect;
    _swarm.sizeJitter = c.cardSizeJitter * g.randomness;
    _swarm.billboard = c.billboard;
    _swarm.bank = c.bank;
    _swarm.bankMax = c.bankMax;
    _swarm.dihedral = c.dihedral;
    _swarm.flapRate = c.flapRate;
    _swarm.curl = c.curl;
    _swarm.edgeStretch = c.edgeStretch;
    _swarm.edgeGain = c.edgeGain;
    // Forward on the way out, backward on the way down: the same wave that
    // wrote the cards in takes them away, so the storm goes out card by card
    // instead of being switched off.
    _swarm.reveal =
      this.phase === AbilityPhase.TRAVEL
        ? saturate(s / Math.max(1e-3, c.revealRamp))
        : 1 - saturate((settle - 0.45) / 0.55);
    _swarm.revealSpread = c.revealSpread;

    /* --- the silhouette -------------------------------------------- */
    _swarm.silhouette = Silhouette.CARD;
    _swarm.glyphWeight = c.glyphWeight;
    _swarm.glyphStrokes = Math.round(c.glyphStrokes);
    _swarm.cardFrame = c.cardFrame;
    _swarm.lit = c.cardLit;

    _swarm.tint = c.tint;
    _swarm.tintJitter = c.tintJitter;
    _swarm.tintAlong = c.tintAlong;
    _swarm.opacity = c.cardOpacity * g.opacity * (1 - c.settleDim * ease);
    _swarm.glow = c.cardGlow * g.glow;
    _swarm.softFade = c.cardSoft;

    this.swarm.update(this.age, _swarm);
  }

  /**
   * Push the lattice.
   *
   * @param {number} grow   0..1 the charge crossing the footprint
   * @param {number} recede 0..1 the outside being eaten back
   * @param {number} fade   0..1 master fade
   */
  _syncBurn(grow, recede, fade) {
    const c = settings.glyphstorm;
    const g = settings.global;

    this.pointAt(1, _pos);
    _ground.centre = _pos;
    _ground.yaw = Math.atan2(this.direction.x, this.direction.z);
    _ground.height = c.burnHeight;
    _ground.radius = Math.max(0.1, c.burnRadius);

    _ground.grow = grow;
    _ground.recede = recede;
    _ground.fade = fade;
    _ground.seed = this._seed;

    _ground.edge = c.burnEdge;
    _ground.ragged = c.burnRagged;
    _ground.raggedScale = c.burnRaggedScale;
    _ground.warp = c.burnWarp;

    _ground.relief = c.burnRelief;
    _ground.normalStep = c.burnNormalStep;
    _ground.ambient = c.burnAmbient;
    _ground.wrap = c.burnWrap;
    _ground.specular = c.burnSpecular;
    _ground.gloss = c.burnGloss;
    _ground.parallax = c.burnParallax;

    _ground.cell = c.burnCell;
    _ground.cellJitter = c.burnCellJitter;
    _ground.seam = c.burnSeam;
    _ground.thickness = c.burnThickness;
    _ground.lift = c.burnLift;
    _ground.depth = c.burnDepth;
    _ground.speed = c.burnSpeed;

    _ground.additive = false;
    _ground.emissive = c.burnEmissive;
    _ground.opacity = c.burnOpacity;
    _ground.depthFade = c.burnDepthFade;
    _ground.colorBase = c.colorBurnBase;
    _ground.colorEdge = c.colorBurnEdge;
    _ground.colorGlow = c.colorBurnGlow;
    _ground.colorDeep = c.colorBurnDeep;

    _ground.noiseStrength = g.noiseStrength;
    _ground.noiseFrequency = g.noiseFrequency;
    _ground.noiseSpeed = g.noiseSpeed;
    _ground.opacityScale = g.opacity;

    this.burn.setVisible(grow > 0.001 && fade > 0.001);
    this.burn.update(_ground);
  }

  /** Gradients and scales. Pushed every frame so every picker stays live. */
  _syncParticles() {
    const c = settings.glyphstorm;
    const g = settings.global;

    this.ink.setGradient(
      getColor(c.colorInkA),
      getColor(c.colorInkB),
      getColor(c.colorInkC),
      getColor(c.colorInkD)
    );
    this.ink.uniforms.uGravity.value.set(0, c.inkRise, 0);
    this.ink.uniforms.uSizeScale.value = c.inkSize * g.particleSize * 7;
    this.ink.uniforms.uLifeScale.value = c.inkLifetime * 0.5 * g.particleLifetime;
    this.ink.uniforms.uSpeedScale.value = g.particleSpeed;
    this.ink.uniforms.uOpacity.value = g.opacity;
    this.ink.uniforms.uGlow.value = 1.0 * g.glow;
    this.ink.uniforms.uTurbulence.value = c.inkTurbulence * g.turbulence;

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
    this.sparks.uniforms.uGlow.value = 1.2 * g.glow;
    this.sparks.uniforms.uStretch.value = c.sparkStretch;
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /** The knot of light the cards are written out of. */
  _muzzleFx() {
    const c = settings.glyphstorm;
    const g = settings.global;

    this._handPoint(_pos);

    this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
      radius: c.muzzleSize * 0.25,
      endRadius: c.muzzleSize * g.explosionIntensity,
      life: 0.35,
      intensity: c.muzzleIntensity,
      opacity: 0.85,
      fresnel: 1.4,
      displace: 0.45,
      colorA: getColor(c.colorMuzzleA),
      colorB: getColor(c.colorMuzzleB),
      colorC: getColor(c.colorMuzzleC)
    });

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.35 * g.explosionIntensity;
  }

  /**
   * Ink shed by the storm, and sparks struck off the landing.
   *
   * @param {number} inkScale   0..1 on the ink rate
   * @param {number} sparkScale 0..1 on the spark rate
   */
  _stormFx(dt, inkScale, sparkScale) {
    const c = settings.glyphstorm;
    const g = settings.global;
    const time = frame.uTime.value;

    const inkCount = Math.round(this.inkEmitter.tick(dt, c.inkRate * inkScale) * g.particleCount);
    if (inkCount > 0) {
      // Off the *lead*, not off the cast line: the storm is strung out behind a
      // point that is ahead of most of it, and shedding from the line would put
      // the ink in front of the cards it came off.
      this.swarm.leadPoint(_lead);
      _emit.position = _lead;
      _emit.radius = c.spacingSide * c.latticeX * 0.5;
      _emit.direction = _dir.copy(this.direction).multiplyScalar(-0.4).setY(0.4).normalize();
      _emit.speed = c.inkSpeed;
      _emit.speedVariance = 0.85;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.12;
      _emit.sizeVariance = 0.7;
      _emit.life = c.inkLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.ink.emit(inkCount, _emit);
    }

    const sparkCount = Math.round(
      this.sparkEmitter.tick(dt, c.sparkRate * sparkScale) * g.particleCount
    );
    if (sparkCount > 0) {
      this.pointAt(1, _pos);
      _pos.y = c.settleHeight;
      _emit.position = _pos;
      _emit.radius = c.burnRadius * 0.7;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.sparkSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.9;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.16;
      _emit.sizeVariance = 0.7;
      _emit.life = c.sparkLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.sparks.emit(sparkCount, _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = settings.glyphstorm;

    this._syncParticles();
    this._syncSwarm(this.u, 0);
    this._syncBurn(0, 0, 1);
    this._stormFx(dt, saturate(this.u / Math.max(1e-3, c.revealRamp)), 0);

    // The camera frames the lead, not the point on the floor under it.
    this.swarm.leadPoint(this.position);
    this.ctx.shake.rumble(c.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    // Nothing one-shot: the arrival is the *start* of the settle, and the beat
    // worth marking — the lattice taking — happens part-way through it.
  }

  onFade(dt, t) {
    const c = settings.glyphstorm;

    this._syncParticles();

    if (t <= 1) {
      /* ---- the cards come down, the lattice takes ---------------- */
      const settle = saturate(this.impactTime / this._settleSpan);
      const started = this.impactTime - this._settleSpan * saturate(c.burnLead);
      const grow = saturate(started / Math.max(0.02, c.burnGrow));

      this._syncSwarm(1, settle);
      this._syncBurn(grow, 0, 1);
      this._stormFx(dt, 1 - settle * 0.8, settle < 1 ? 1 : 0.25);

      if (grow > 0 && this._tookAt < 0) {
        this._tookAt = this.age;
        this.ctx.flash.trigger(
          getColor(c.colorSettleFlash),
          c.settleFlash * settings.global.explosionIntensity
        );
        this._landFx();
      }

      this.pointAt(1, this.position);
      this.position.y = lerp(c.flightHeight, c.settleHeight, Easing.outCubic(settle));
      return;
    }

    /* ---- the lattice burns out --------------------------------- */
    const out = saturate(t - 1);
    // Eaten back from the rim rather than dimmed: a circuit that fades is a
    // light going off, and a circuit that recedes is a charge running out.
    this._syncSwarm(1, 1);
    this._syncBurn(1, Easing.inQuad(out), 1 - Easing.inCubic(out));
    this._stormFx(dt, 0, 0.2 * (1 - out));

    this.pointAt(1, this.position);
    this.position.y = c.settleHeight;
  }

  /** The moment the charge finds the floor. */
  _landFx() {
    const c = settings.glyphstorm;
    const g = settings.global;

    this.pointAt(1, _pos);
    _pos.y = c.settleHeight;

    _emit.position = _pos;
    _emit.radius = c.burnRadius * 0.5;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.sparkSpeed * 2.1;
    _emit.speedVariance = 0.9;
    _emit.spread = 0.95;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.22;
    _emit.sizeVariance = 0.8;
    _emit.life = c.sparkLifetime * 1.5;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.sparks.emit(Math.round(c.sparkBurst * g.particleCount), _emit);

    this.ctx.shake.add(
      c.settleShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.05, c.settleShakeDuration),
      20
    );
    this.lightBoost = c.lightIntensity * 0.5 * g.explosionIntensity;
  }

  onDestroy() {
    this.swarm.reset();
    this.burn.setVisible(false);
    this._tookAt = -1;
  }

  dispose() {
    this.swarm.dispose();
    this.burn.dispose();
    super.dispose();
  }
}
