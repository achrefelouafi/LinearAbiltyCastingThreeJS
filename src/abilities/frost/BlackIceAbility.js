import { Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { Mirror, mirrorBudget } from '../../vfx/Mirror.js';
import { GroundField, GroundMode } from '../../vfx/GroundField.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { DecalType } from '../../effects/GroundDecals.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, randRange } from '../../utils/math.js';

const TAU = Math.PI * 2;

/** World up. The sheet's normal, and it never changes. */
const UP = new Vector3(0, 1, 0);

/* Module-scope scratch. Nothing in the frame path allocates — invariant I3. */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();

/**
 * BLACK ICE — a sheet of meltwater that freezes into a mirror.
 *
 * **The trick: it is a real reflection, and it sharpens as it freezes.** This
 * is the sandbox's first and only true reflective surface. A camera mirrored
 * about the sheet's plane renders the `WORLD` layer into a small target and the
 * surface samples that target projectively, with an oblique near plane skewed
 * onto the sheet so nothing behind it can leak in. It is the actual room, the
 * actual character, upside down and sliding under your feet as you orbit.
 *
 * Everything else in this project that looks reflective is a fresnel ramp over
 * the HDR probe, and it was worth finding out why that is not good enough
 * here. An environment map has **no parallax**: the reflection is a function of
 * the view direction alone, so it does not move relative to the surface when
 * the camera translates. Standing still, an env map and a planar reflection are
 * hard to tell apart. Orbit for half a second and the env map reads as a
 * painted-on shine, instantly and irreversibly. That is the entire argument for
 * paying for the pass.
 *
 * ## The freeze is the animation, and it is three numbers
 *
 * The reflection lookup is blurred by a jittered disc of radius
 * `roughness × blurRadius`, so the whole ability is a slider going from 1 to 0:
 *
 *  - **`roughWet` → `roughIce`** takes it from a puddle you cannot read the room
 *    in to a black mirror you can;
 *  - **`ripple` × (1 − freeze)** stops the reflection *moving*. This one matters
 *    more than it sounds. An early version froze the roughness and left the
 *    ripple running, and the sheet read as polished wet stone rather than as
 *    ice, because a mirror whose image swims is by definition still liquid. It
 *    is one multiply and it is the difference between the two materials.
 *  - **`reflectWet` → `reflectIce`** is how much of the reflection survives at
 *    all. The `fresnel` term deliberately does *not* animate: water and ice have
 *    similar indices and the grazing falloff is roughly the same for both, so
 *    changing it would be a lie that nobody asked for.
 *
 * The thaw runs the whole thing backwards — `sharp = freeze × (1 − thaw)` — so
 * the sheet un-resolves into slush before it goes. Watching a black mirror lose
 * focus is a better exit than watching it fade out, and it costs one term.
 *
 * ## Respecting the budget
 *
 * A reflection is one extra full traversal of the world layer, and
 * `vfx/Mirror.js` caps the whole frame at two of them. Two things are this
 * ability's responsibility rather than the module's:
 *
 *  - **the sheet is only `visible` when it is actually going to be seen.** The
 *    module renders from the mesh's own `onBeforeRender`, so an invisible
 *    mirror costs nothing at all — there is no pass to skip, because there is
 *    no pass. So `visible` is gated on the resolved opacity every frame, and it
 *    is false for the whole travel phase, false once the thaw has taken the
 *    sheet below a fiftieth of an alpha, and false the instant the cast is
 *    destroyed. The alternative — leaving it visible for the cast's whole life
 *    and letting the alpha do the work — costs a scene render a frame for a
 *    surface nobody can see.
 *  - **`mirrorPriority` is a slider, and `mirrorBudget.max` is not touched.**
 *    The cap is global state that belongs to whoever is composing the frame; an
 *    ability that raises it to get its own reflection back has taken the
 *    decision away from the app. Priority is the polite way to ask.
 *
 * ## The sandwich
 *
 * Three quads, in this order off the floor: a `GroundField(POOL)` of meltwater
 * with a meniscus rim, the `Mirror`, and a `GroundField(PLATE)` crust of ice
 * plates at a third of an alpha. The crust is the reason the mirror does not
 * read as a hole in the floor: a perfect reflection with no surface *on* it has
 * no thickness and no material, and the eye files it as a gap. Thirty per cent
 * of plate seams over the top is enough to say "there is something here", and
 * little enough to see the room through.
 *
 * The pool's surface motion (`poolSpeed`, `poolFlow`) is scaled by `1 − freeze`
 * on the same term the ripple is, so all three layers stop being liquid
 * together.
 *
 * ## The rule that makes the editor work
 *
 * A cast captures one seed and one timestamp — the moment the front landed,
 * which every beat below is measured from. Every metre, radian and second is
 * resolved against `settings.blackice` in the update loop, on a zero-length
 * frame included. Pause a frozen sheet, drag `roughIce`, and the room in it
 * dissolves.
 *
 * Three draw calls in the group, plus one nested `renderer.render()` while the
 * sheet is visible and wins a slot.
 */
export class BlackIceAbility extends Ability {
  constructor(context) {
    super('blackice', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    // Bottom of the sandwich: the meltwater.
    this.pool = new GroundField(this.group, {
      mode: GroundMode.POOL,
      additive: false,
      renderOrder: 2,
      name: 'BlackIce:pool'
    });

    this.sheet = new Mirror({
      resolution: 384,
      layer: LAYER.VFX,
      // The real scene and nothing else. Reflecting the VFX layer would let a
      // mirror see a mirror, which `vfx/Mirror.js` refuses rather than resolves.
      reflectLayer: LAYER.WORLD,
      renderOrder: 4,
      // A floor sheet is never seen from underneath, and the single-sided path
      // buys a free rejection in `_wantsRender`.
      doubleSided: false,
      depthWrite: false,
      name: 'BlackIce:sheet'
    });
    this.group.add(this.sheet.object3D);

    // Top of the sandwich: the plate crust, at a third of an alpha.
    this.crust = new GroundField(this.group, {
      mode: GroundMode.PLATE,
      additive: false,
      renderOrder: 6,
      name: 'BlackIce:crust'
    });

    /* --- scratch parameter blocks, filled from settings every frame --- */
    this._mirror = {};
    this._poolPar = { centre: new Vector3() };
    this._crustPar = { centre: new Vector3() };
    /** The zone centre, refreshed every frame — never captured. */
    this._centre = new Vector3();

    /** Re-rolled per cast so two sheets do not freeze in the same pattern. */
    this._seed = 0;
    /** Timestamp the front landed, or -1. Every beat is measured from it. */
    this._landedAt = -1;
    /** One-shot latch on the crack the thaw opens with. */
    this._cracked = false;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Cold fog crawling out over the sheet. Non-additive so it genuinely
    // occludes: a reflection with additive haze over it is a reflection with
    // the contrast washed out of it, and contrast is all this ability has.
    this.mist = particles.get('blackice.mist', {
      capacity: 2200,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.2
    });
    this.mist.uniforms.uDrag.value = 2.4;
    this.mist.uniforms.uEndSize.value = 3.2;
    this.mist.uniforms.uSizeIn.value = 0.12;
    this.mist.uniforms.uFadeIn.value = 0.2;
    this.mist.uniforms.uFadeOut.value = 0.34;

    // Crystals lighting up along the freeze front.
    this.glints = particles.get('blackice.glints', {
      capacity: 1800,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.glints.uniforms.uDrag.value = 1.6;
    this.glints.uniforms.uEndSize.value = 0.16;
    this.glints.uniforms.uSizeIn.value = 0.05;
    this.glints.uniforms.uFadeIn.value = 0.07;
    this.glints.uniforms.uFadeOut.value = 0.36;

    // Water flecks on the landing, ice flecks on the thaw.
    this.spray = particles.get('blackice.spray', {
      capacity: 1200,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.spray.uniforms.uDrag.value = 0.35;
    this.spray.uniforms.uEndSize.value = 0.6;
    this.spray.uniforms.uFadeOut.value = 0.7;

    this.mistEmitter = new RateEmitter();
    this.glintEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    // Not instanced geometry — but the reflection is the cost worth reading,
    // and the HUD's one number is the honest place to publish it.
    return this.sheet.visible ? mirrorBudget.rendered : 0;
  }

  get impactDuration() {
    return Math.max(0.1, settings.blackice.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.1, settings.blackice.thawTime);
  }

  /** Ice breathes. A slow cosine, never a stutter. */
  lightShimmer() {
    const c = settings.blackice;
    return 1 - c.lightPulse * (0.5 - 0.5 * Math.cos(this.age * c.lightPulseSpeed * TAU));
  }

  /* ------------------------------------------------------------------ */
  /* The beats — all measured from the landing, all resolved live         */
  /* ------------------------------------------------------------------ */

  /** Seconds since the front landed, or -1 while it is still travelling. */
  _since() {
    return this._landedAt < 0 ? -1 : this.age - this._landedAt;
  }

  /** 0..1 — the meltwater spreading to the full circle. */
  _flood() {
    const since = this._since();
    if (since < 0) return 0;
    return saturate(since / Math.max(0.02, settings.blackice.floodTime));
  }

  /** 0..1 — the freeze, from open water to a mirror finish. */
  _freeze() {
    const c = settings.blackice;
    const since = this._since();
    if (since < 0) return 0;
    return saturate((since - c.freezeDelay) / Math.max(0.02, c.freezeTime));
  }

  /** 0..1 — the sheet going back to water and away. */
  _thaw() {
    if (this.phase !== AbilityPhase.FADE) return 0;
    return saturate(this.fadeTime / Math.max(0.05, settings.blackice.thawTime));
  }

  /**
   * 0..1 — how *sharp* the reflection is right now.
   *
   * The single number the whole ability turns on, and the reason the thaw is a
   * multiply rather than a second timeline: `freeze × (1 − thaw)` runs the
   * freeze forwards and then backwards through exactly the same states, so a
   * sheet halfway through thawing looks like a sheet halfway through freezing.
   * Which is correct — it is the same amount of ice.
   */
  _sharpness() {
    return this._freeze() * (1 - this._thaw());
  }

  /** The centre of the footprint, world space. Refreshed, never stored. */
  _zoneCentre(out) {
    return this.pointAt(1, out);
  }

  /* ------------------------------------------------------------------ */
  /* Live parameter blocks                                                */
  /* ------------------------------------------------------------------ */

  /** The mirror. Every metre and every 0..1 comes from here. */
  _fillMirror() {
    const c = settings.blackice;
    const g = settings.global;
    const p = this._mirror;
    const sharp = this._sharpness();
    const thaw = this._thaw();

    const span = c.zoneRadius * c.sheetSpan * 2;
    p.width = span;
    p.height = span;
    // A disc, not a rectangle — the footprint the aim indicator drew.
    p.corner = 1;
    p.edgeFade = c.sheetEdgeFade;
    p.seed = this._seed;

    p.roughness = lerp(c.roughWet, c.roughIce, sharp);
    p.blurRadius = c.blurRadius;
    p.blurTaps = c.blurTaps;
    p.roughStretch = c.roughStretch;

    p.reflectivity = lerp(c.reflectWet, c.reflectIce, sharp);
    p.fresnel = c.fresnel;
    p.fresnelPower = c.fresnelPower;

    // Ice does not ripple. This is the term that decides which material the
    // surface is, and it is why the freeze reads as a phase change.
    p.ripple = c.ripple * (1 - sharp);
    p.rippleScale = c.rippleScale * g.noiseFrequency;
    p.rippleSpeed = c.rippleSpeed * g.noiseSpeed;

    p.opacity = c.sheetOpacity * g.opacity * this._flood() * (1 - thaw * thaw);
    p.resolution = c.resolution;
    p.priority = c.mirrorPriority;
    p.colorTint = c.colorTint;
    p.colorBase = c.colorSheet;
    return p;
  }

  /** The meltwater underneath. */
  _fillPool() {
    const c = settings.blackice;
    const g = settings.global;
    const p = this._poolPar;
    // Liquid while it is liquid: the surface stops moving on the same term the
    // reflection does, or the three layers disagree about what they are made of.
    const wet = 1 - this._sharpness();

    p.centre.copy(this._centre);
    p.yaw = Math.atan2(this.direction.x, this.direction.z);
    p.height = c.poolHeight;
    p.radius = c.zoneRadius * c.poolSpan;
    p.seed = this._seed;

    p.grow = this._flood();
    p.recede = this._thaw();
    p.fade = saturate(this._flood() * 4);

    p.edge = c.poolEdge;
    p.ragged = c.poolRagged;
    p.raggedScale = c.poolRaggedScale;
    p.warp = c.poolWarp;

    p.relief = c.poolRelief;
    p.normalStep = c.poolNormalStep;
    p.ambient = c.poolAmbient;
    p.wrap = c.poolWrap;
    p.specular = c.poolSpecular;
    p.gloss = c.poolGloss;
    p.parallax = c.poolParallax;

    p.cell = c.poolCell;
    p.thickness = c.poolThickness;
    p.lift = c.poolLift * (0.25 + 0.75 * wet);
    p.depth = c.poolDepth;
    p.detail = c.poolDetail;
    p.speed = c.poolSpeed * wet;
    p.flow = c.poolFlow * wet;
    p.windAngle = c.poolWind;

    p.additive = false;
    p.emissive = c.poolEmissive;
    p.opacity = c.poolOpacity;
    p.depthFade = c.poolDepthFade;
    p.colorBase = c.colorPoolBase;
    p.colorEdge = c.colorPoolEdge;
    p.colorGlow = c.colorPoolGlow;
    p.colorDeep = c.colorPoolDeep;

    p.noiseStrength = g.noiseStrength;
    p.noiseFrequency = g.noiseFrequency;
    p.noiseSpeed = g.noiseSpeed;
    p.opacityScale = g.opacity;
    return p;
  }

  /** The plate crust over the top. Its growth front *is* the freeze. */
  _fillCrust() {
    const c = settings.blackice;
    const g = settings.global;
    const p = this._crustPar;

    p.centre.copy(this._centre);
    p.yaw = Math.atan2(this.direction.x, this.direction.z);
    p.height = c.crustHeight;
    p.radius = c.zoneRadius * c.crustSpan;
    p.seed = this._seed;

    p.grow = this._freeze();
    p.recede = this._thaw();
    p.fade = saturate(this._freeze() * 3);

    p.edge = c.crustEdge;
    p.ragged = c.crustRagged;
    p.raggedScale = c.crustRaggedScale;
    p.warp = c.crustWarp;

    p.relief = c.crustRelief;
    p.normalStep = c.crustNormalStep;
    p.ambient = c.crustAmbient;
    p.wrap = c.crustWrap;
    p.specular = c.crustSpecular;
    p.gloss = c.crustGloss;
    p.parallax = c.crustParallax;

    p.cell = c.crustCell;
    p.cellJitter = c.crustCellJitter;
    p.seam = c.crustSeam;
    p.thickness = c.crustThickness;
    p.lift = c.crustLift;
    p.detail = c.crustDetail;
    // 0 because the quad is yawed onto the cast: in its own frame downrange is
    // +Z, so the plates lift their downwind edge the way the cast is pointing.
    p.windAngle = 0;

    p.additive = false;
    p.emissive = c.crustEmissive;
    p.opacity = c.crustOpacity;
    p.depthFade = c.crustDepthFade;
    p.colorBase = c.colorCrustBase;
    p.colorEdge = c.colorCrustEdge;
    p.colorGlow = c.colorCrustGlow;
    p.colorDeep = c.colorCrustDeep;

    p.noiseStrength = g.noiseStrength;
    p.noiseFrequency = g.noiseFrequency;
    p.noiseSpeed = g.noiseSpeed;
    p.opacityScale = g.opacity;
    return p;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.mistEmitter.reset();
    this.glintEmitter.reset();
    this._landedAt = -1;
    this._cracked = false;
    this._seed = Math.random() * 100;

    this.sheet.visible = false;
    this._syncUniforms();
    this._syncFields();
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /** Push the live settings into the three particle systems. */
  _syncUniforms() {
    const c = settings.blackice;
    const g = settings.global;

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

    this.glints.setGradient(
      getColor(c.colorGlintA),
      getColor(c.colorGlintB),
      getColor(c.colorGlintC),
      getColor(c.colorGlintD)
    );
    this.glints.uniforms.uGravity.value.set(0, c.glintRise, 0);
    this.glints.uniforms.uSizeScale.value = c.glintSize * g.particleSize * 7;
    this.glints.uniforms.uLifeScale.value = c.glintLifetime * 0.5 * g.particleLifetime;
    this.glints.uniforms.uSpeedScale.value = c.glintSpeed * g.particleSpeed;
    this.glints.uniforms.uOpacity.value = g.opacity;
    this.glints.uniforms.uGlow.value = 0.85 * g.glow;
    this.glints.uniforms.uTurbulence.value = c.glintTurbulence * g.turbulence;

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
  }

  /**
   * Re-place and re-resolve all three layers of the sandwich.
   *
   * The visibility gate is here rather than in `onFade`, because it has to hold
   * on every frame of every phase — including the ones where the ability is
   * doing nothing else — and because the number it tests is the same resolved
   * opacity the shader is about to use.
   */
  _syncFields() {
    const c = settings.blackice;
    this._zoneCentre(this._centre);

    this.pool.update(this._fillPool());
    this.crust.update(this._fillCrust());

    const mirror = this._fillMirror();
    // `along` is the cast heading: for a floor sheet the module re-orthogonalises
    // it against the normal, so the disc's own axes line up with the cast.
    _pos.copy(this._centre).setY(c.sheetHeight);
    this.sheet.setPlacement(_pos, UP, this.direction);
    this.sheet.update(mirror);
    // No visible mirror, no reflection pass. See the class header.
    this.sheet.visible = mirror.opacity > 0.02;
  }

  /**
   * Fog crawling over the sheet and crystals along the freeze front.
   *
   * The crystals are emitted **on the front itself** — at
   * `freeze × radius` from the centre, in a band `crustEdge` wide — rather than
   * anywhere in the circle. A freeze that sparkles uniformly across its whole
   * area is a freeze with no direction in it, and the front is the only part of
   * this ability that moves.
   *
   * @param {number} scale 0..1 — thinned once the sheet is only holding
   */
  _sheetFx(dt, scale) {
    const c = settings.blackice;
    const g = settings.global;
    const time = frame.uTime.value;
    const radius = c.zoneRadius * c.poolSpan;

    const mistCount = Math.round(this.mistEmitter.tick(dt, c.mistRate * scale) * g.particleCount);
    if (mistCount > 0) {
      _pos.copy(this._centre).setY(0.1);
      _emit.position = _pos;
      _emit.radius = radius * this._flood();
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.mistSpeed;
      _emit.speedVariance = 0.8;
      // Nearly flat: cold fog does not billow, it lies down and creeps.
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.9;
      _emit.sizeVariance = 0.5;
      _emit.life = c.mistLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.25;
      _emit.tint = null;
      _emit.time = time;
      this.mist.emit(mistCount, _emit);
    }

    const glintCount = Math.round(this.glintEmitter.tick(dt, c.glintRate * scale) * g.particleCount);
    if (glintCount > 0) {
      const front = radius * this._freeze();
      const angle = Math.random() * TAU;
      const at = Math.max(0, front + randRange(-c.crustEdge, c.crustEdge));
      _pos.copy(this._centre);
      _pos.x += Math.cos(angle) * at;
      _pos.z += Math.sin(angle) * at;
      _pos.y = 0.08;
      _emit.position = _pos;
      _emit.radius = c.crustEdge * 0.6;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.glintSpeed;
      _emit.speedVariance = 0.85;
      _emit.spread = 0.9;
      _emit.size = 0.06;
      _emit.sizeVariance = 0.6;
      _emit.life = c.glintLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.time = time;
      this.glints.emit(glintCount, _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = settings.blackice;

    this._syncUniforms();
    this._syncFields();
    // The light rides the front on its way out, then sits on the sheet.
    this.position.y = 0.35;

    this.ctx.shake.rumble(c.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.blackice;
    const g = settings.global;
    const time = frame.uTime.value;

    this._landedAt = this.age;
    this._zoneCentre(this._centre);
    _pos.copy(this._centre).setY(0.3);

    /* the shell of freezing air over the landing */
    this.ctx.bursts.spawn(BurstMode.FROST, _pos, {
      radius: c.burstSize * 0.25,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.8,
      intensity: c.burstIntensity,
      opacity: 0.7,
      fresnel: 1.5,
      displace: 0.4,
      squash: 0.45,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    /* the ring that runs out across the stone */
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, this._centre, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.7,
      width: 0.05,
      intensity: 0.75,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    /* water thrown off the landing */
    _emit.position = _pos;
    _emit.radius = c.zoneRadius * 0.4;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.spraySpeed;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.95;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.11;
    _emit.sizeVariance = 0.7;
    _emit.life = c.sprayLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 6;
    _emit.tint = null;
    _emit.time = time;
    this.spray.emit(Math.round(c.impactSpray * g.particleCount), _emit);

    _emit.radius = c.zoneRadius * 0.6;
    _emit.speed = c.mistSpeed * 2.4;
    _emit.spread = 1.0;
    _emit.size = 1.3;
    _emit.life = c.mistLifetime * 1.2;
    _emit.spin = 0.4;
    this.mist.emit(Math.round(c.impactMist * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      16
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.6 * g.explosionIntensity;

    this._syncUniforms();
    this._syncFields();
  }

  onFade(dt, t) {
    const c = settings.blackice;

    // The thaw opens with the sheet cracking: one shot, on the frame the fade
    // starts, so the reflection has something to go *wrong* with rather than
    // simply getting blurry.
    if (this.phase === AbilityPhase.FADE && !this._cracked) {
      this._cracked = true;
      this._crackFx();
    }

    this._syncUniforms();
    this._syncFields();
    this.position.copy(this._centre);
    this.position.y = 0.25;

    // The fog thickens as the ice gives its cold up and thins out with it.
    const boil = t <= 1 ? 0.75 : 1.1 * (1 - this._thaw());
    this._sheetFx(dt, boil);
  }

  /** The sheet letting go: ice flecks off the whole disc. */
  _crackFx() {
    const c = settings.blackice;
    const g = settings.global;

    _pos.copy(this._centre).setY(0.1);
    _emit.position = _pos;
    _emit.radius = c.zoneRadius * c.crustSpan * 0.8;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.spraySpeed * 0.7;
    _emit.speedVariance = 0.85;
    _emit.spread = 0.75;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.12;
    _emit.sizeVariance = 0.8;
    _emit.life = c.sprayLifetime * 1.3;
    _emit.lifeVariance = 0.55;
    _emit.spin = 8;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.spray.emit(Math.round(c.thawSpray * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * 0.5 * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      20
    );
  }

  onDestroy() {
    // The one thing that must happen however the cast ends: an invisible
    // mirror is deregistered from the schedule and costs nothing, and a
    // visible one left behind is a scene render a frame, for ever.
    this.sheet.visible = false;
    this._landedAt = -1;
    this._cracked = false;
    this.pool.update(this._fillPool());
    this.crust.update(this._fillCrust());
  }

  dispose() {
    this.sheet.dispose();
    this.pool.dispose();
    this.crust.dispose();
    super.dispose();
  }
}
