import { Mesh, Color, Vector3 } from 'three';
import { Ability } from '../Ability.js';
import { createDaystarMaterial } from '../../materials/DaystarMaterial.js';
import { uprightQuad } from '../../vfx/quads.js';
import { sceneHooks, Hook } from '../../vfx/SceneHooks.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, Easing, randRange } from '../../utils/math.js';

/**
 * How many points one frame's dust is split between.
 *
 * The circle is metres across and a frame's worth of motes is single digits, so
 * firing them all from one spot makes each batch read as a little puff that
 * pops somewhere random. Three arcs is enough to turn that into air.
 */
const DUST_BATCHES = 3;

/* --- module-scope scratch. Nothing below allocates during a cast (I3) --- */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _base = new Vector3();
const _want = new Vector3();
const _tint = new Color();

/**
 * DAWNBREAK — the ability moves the sun.
 *
 * **The trick is that nothing here draws a shadow.** Dawnbreak takes hold of the
 * scene's one directional light through `Hook.KEY_LIGHT` and swings it from just
 * above the horizon, up over the top of the stage and back down the far side, so
 * *every object in the world* — the character, the crystals of a Frost Lance
 * still standing on the floor, the floor's own relief — throws a **real** shadow
 * that sweeps across the ground. It is the same light three was already building
 * its shadow camera from, so there is nothing to fake and nothing to match: the
 * world does the work, and the ability's job is to move one direction vector
 * honestly and give it back afterwards.
 *
 * The whole ability is therefore two draw calls: the daystar
 * (`materials/DaystarMaterial.js`) and a dust system. The dust exists because
 * grazing light is only visible if there is something in the air to catch it;
 * the daystar exists because without a visible source the sweep reads as the
 * lighting glitching rather than as a sunrise. Everything else you see happens
 * to the rest of the scene.
 *
 * ### Three beats
 *
 *  1. **reach** (travel) — the hook blends in on `u^reachCurve` while the arc
 *     sits at `elevLow`, so the stage's own light rakes *down* to the horizon as
 *     the cast goes out. This is the anticipation, and it is free: the same
 *     blend that will later carry the sweep.
 *  2. **the sweep** (impact) — `d` runs 0 → 1 over `sweepTime`. Elevation is
 *     `lerp(elevLow, elevHigh, sin(πd)^elevCurve)` and the bearing turns
 *     through `azSweep`, so the sun rises, crosses and sets on one clock.
 *  3. **settle** (fade) — the weight rolls back to 0 and the sun slides home.
 *
 * ### Two things that were wrong first
 *
 * **The disc and the shadows disagreed.** `SceneHooks#_applyKeyLight` does not
 * snap the light to the ability's angles: it lerps from the direction
 * `settings.environment` asks for toward the ability's, by `weight`. The first
 * version drew the daystar at the ability's *raw* aim, so at `sunWeight = 0.4`
 * the disc sat at full dawn on the horizon while every shadow on the floor was
 * still mostly the stage's own — and the disc read as a sprite pasted over the
 * scene. `_sunDirection()` below is a deliberate mirror of the hook's blend,
 * including the normalised lerp and the degenerate-length guard, and the two
 * now move as one thing.
 *
 * **The sun went orange while the stage stayed noon-white.** The disc's colour
 * and the key light's colour were driven from two curves. They are now driven
 * from the *same* number, `warm` — 0 on the horizon, 1 at the top — which is
 * the elevation curve itself. One number, two consumers, no way to desynchronise
 * them.
 *
 * ### The rule that makes the editor work
 *
 * A cast captures exactly one number: `_seed`, so two dawns do not mottle
 * identically. Every radian, metre and second is resolved against
 * `settings.dawnbreak` inside the update loop, on a zero-length frame included —
 * the hook holds nothing across a frame boundary either, by construction, so
 * pausing with **P** mid-sweep and dragging `elevHigh` re-aims a sun that is
 * already up and every shadow on the stage moves with it. `azSweep`, `discSize`
 * and the whole dust bank do the same.
 *
 * The hook is borrowed through `this.borrow(...)`, so it comes back however the
 * cast ends — normally, by **C**, by a fifth cast pushing this one off the
 * concurrency cap, or by teardown. The restore is exact rather than
 * approximate: `Environment.update()` re-authors the key light from settings
 * every frame before the abilities run, and `apply()` blends from those
 * settings and never from the live light.
 *
 * (`sceneHooks.observe()` is deliberately *not* called here. It parks the
 * disrupt/gravity/age blocks where the harness's pause probe looks, and this
 * ability drives none of them — the daystar's own uniforms carry every number
 * the sweep is made of, which is both what the probe needs and what a debugger
 * wants to see.)
 */
export class DawnbreakAbility extends Ability {
  constructor(context) {
    super('dawnbreak', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /**
     * The daystar. One shared upright quad, billboarded in the vertex shader
     * around a world-space centre uniform — so the mesh itself never moves and
     * the group's `matrixAutoUpdate = false` costs nothing. `uprightQuad()` is
     * module-lifetime and is never disposed; see `vfx/quads.js`.
     */
    this.material = createDaystarMaterial();
    this.disc = new Mesh(uprightQuad(), this.material);
    this.disc.frustumCulled = false;
    this.disc.matrixAutoUpdate = false;
    this.disc.layers.set(LAYER.VFX);
    // Behind the rest of the VFX vocabulary: it is seventy metres away and
    // anything an ability draws near the caster is in front of it.
    this.disc.renderOrder = 8;
    this.disc.name = 'Daystar';
    this.group.add(this.disc);

    /** The borrowed sun. Null until `onSpawn()`, and again after `destroy()`. */
    this.sun = null;

    /** The one thing a cast captures: a dice roll for the granulation. */
    this._seed = 0;

    /**
     * How high the sun is right now, 0..1. Recomputed from settings every
     * frame; `lightShimmer()` reads it back on the same frame `_sync()` wrote
     * it, which is the only reason it is stored at all.
     */
    this._warm = 0;

    /** Where the circle is. Rewritten every frame from the live cast. */
    this._centre = new Vector3();
  }

  createParticles() {
    // Dust. Soft and additive, with curl turbulence, because the point of it is
    // to be a volume the light passes through rather than a set of specks.
    this.motes = this.ctx.particles.get('dawnbreak.motes', {
      capacity: 1400,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.5
    });
    this.motes.uniforms.uDrag.value = 1.8;
    this.motes.uniforms.uEndSize.value = 0.5;
    this.motes.uniforms.uSizeIn.value = 0.1;
    this.motes.uniforms.uFadeIn.value = 0.18;
    this.motes.uniforms.uFadeOut.value = 0.45;

    this.moteEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  /** The impact phase *is* the sweep. Re-derived, never stored. */
  get impactDuration() {
    return Math.max(0.05, settings.dawnbreak.sweepTime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.dawnbreak.settleTime);
  }

  /** One quad. The rest of the ability is other people's geometry. */
  get instanceCount() {
    return 1;
  }

  /**
   * The dynamic light brightens as the sun climbs.
   *
   * Not a shimmer at all, which is why the default is overridden: a sun does not
   * flicker, and the base class's slow sine made the one honest cue in the light
   * — that noon is brighter than dawn — read as a wobble.
   */
  lightShimmer() {
    return lerp(1, Math.max(0.01, settings.dawnbreak.lightNoon), this._warm);
  }

  /* ------------------------------------------------------------------ */
  /* The arc — every radian resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  /** Where the circle is: the far end of the aimed line, on the floor. */
  _centrePoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /**
   * The direction the light *travels*, blended exactly the way the hook blends
   * it — see the class comment. `elevation` is measured up from the horizon and
   * the y component is negative, matching `Environment#_computeLightDirection`.
   */
  _lightDirection(out, azimuth, elevation) {
    const cosE = Math.cos(elevation);
    out.set(-Math.cos(azimuth) * cosE, -Math.sin(elevation), -Math.sin(azimuth) * cosE);
    return out.normalize();
  }

  /**
   * The blended travel direction of the key light this frame.
   *
   * @param {Vector3} out
   * @param {number} azimuth   radians, the ability's aim
   * @param {number} elevation radians, the ability's aim
   * @param {number} weight    0..1 blend against `settings.environment`
   */
  _sunDirection(out, azimuth, elevation, weight) {
    const e = settings.environment;
    this._lightDirection(_base, e.sunAzimuth, e.sunElevation);
    this._lightDirection(_want, azimuth, elevation);
    out.copy(_base).lerp(_want, saturate(weight));
    // A normalised lerp rather than a slerp: over the arc a sun sweep covers the
    // two are within a degree, and this one cannot produce a NaN when the
    // endpoints are antipodal. Same guard, same reason, as the hook.
    if (out.lengthSq() < 1e-8) out.copy(_want);
    return out.normalize();
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.moteEmitter.reset();
    this._seed = Math.random() * 100;
    this._warm = 0;

    // The sun. `acquire()` never returns null — there is no pool to run out of,
    // because the world has exactly one key light and sharing it is a question
    // of ordering rather than of availability. Borrowed, so it comes back
    // however this cast ends.
    this.sun = this.borrow(sceneHooks.acquire(Hook.KEY_LIGHT, this));

    this._sync(0, 0, 1);
  }

  /* ------------------------------------------------------------------ */
  /* The one frame update                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Resolve the arc, write it to the hook and to the daystar, and re-push every
   * particle uniform.
   *
   * @param {number} d      0..1 through the sweep — the ability's clock
   * @param {number} weight 0..1 how much of the sun the cast has taken
   * @param {number} fade   1 while the daystar is lit, 0 as it lets go
   */
  _sync(d, weight, fade) {
    const c = settings.dawnbreak;
    const g = settings.global;
    const u = this.material.uniforms;

    /* ---------------- the arc ---------------- */
    const along = saturate(d);
    // sin(πd) is the arc; the exponent is what decides whether the sun lingers
    // near the top (a long noon) or near the horizon (a long raking dawn).
    const climb = Math.pow(Math.sin(Math.PI * along), Math.max(0.05, c.elevCurve));
    const elevation = lerp(c.elevLow, c.elevHigh, climb);
    const azimuth = c.azStart + c.azSweep * along;
    const w = saturate(weight * c.sunWeight);

    // 0 on the horizon, 1 at the top. The key light's colour, the key light's
    // intensity, the daystar's colour and the dust's emission rate all read
    // this one number, which is what stops them drifting apart.
    this._warm = saturate(climb);
    _tint.copy(getColor(c.colorHorizon)).lerp(getColor(c.colorZenith), this._warm);

    if (this.sun) {
      this.sun
        .aim(azimuth, elevation)
        .tint(_tint)
        .brightness(lerp(c.intensityLow, c.intensityHigh, this._warm))
        .blend(w);
    }

    /* ---------------- the daystar ---------------- */
    this._centrePoint(this._centre);
    this._sunDirection(_dir, azimuth, elevation, w);
    // Up-sun from the circle rather than from the shadow camera's focus: the
    // circle is where the player is looking, and at this distance the parallax
    // between the two anchors is a couple of degrees.
    u.uCentre.value.copy(this._centre).addScaledVector(_dir, -c.discDistance);

    u.uSize.value = Math.max(0.01, c.discSize);
    // The quad has to cover whatever the aureole and the streak ask for, or a
    // raised `haloSize` crops against a hard square edge — which looks exactly
    // like a broken sprite and took a while to recognise as a geometry problem.
    u.uSpan.value = Math.max(c.discReach, c.haloSize * (1 + c.flareLength));
    u.uSeed.value = this._seed;
    u.uFade.value = fade * w;
    u.uWarm.value = this._warm;

    u.uSoft.value = c.discSoft;
    u.uLimb.value = c.discLimb;
    u.uHalo.value = c.haloSize;
    u.uHaloFalloff.value = c.haloFalloff;
    u.uFlare.value = c.flare;
    u.uFlareLength.value = c.flareLength;
    u.uFlareWidth.value = c.flareWidth;
    u.uGranule.value = c.granule;
    u.uGranuleScale.value = c.granuleScale * g.noiseFrequency;
    u.uGranuleSpeed.value = c.granuleSpeed * g.noiseSpeed;

    u.uGlow.value = c.discGlow * g.glow;
    u.uOpacity.value = c.discOpacity * g.opacity;
    u.uColorCore.value.copy(getColor(c.colorDisc));
    u.uColorLow.value.copy(getColor(c.colorDiscLow));
    u.uColorHalo.value.copy(getColor(c.colorHalo));

    /* ---------------- the dust ---------------- */
    this.motes.setGradient(
      getColor(c.colorMoteA),
      getColor(c.colorMoteB),
      getColor(c.colorMoteC),
      getColor(c.colorMoteD)
    );
    this.motes.uniforms.uGravity.value.set(0, c.moteRise, 0);
    this.motes.uniforms.uSizeScale.value = c.moteSize * g.particleSize * 7;
    this.motes.uniforms.uLifeScale.value = c.moteLifetime * 0.5 * g.particleLifetime;
    this.motes.uniforms.uSpeedScale.value = c.moteSpeed * g.particleSpeed;
    this.motes.uniforms.uOpacity.value = g.opacity;
    this.motes.uniforms.uGlow.value = c.discGlow * 0.35 * g.glow;
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;

    /* ---------------- the local light ---------------- */
    this._centrePoint(this.position);
    this.position.y = c.lightHeight;
  }

  /**
   * Dust lifted into the column of air over the circle.
   *
   * @param {number} dt
   * @param {number} scale 0..1 — thinned as the cast lets go
   */
  _dustFx(dt, scale) {
    const c = settings.dawnbreak;
    const g = settings.global;

    // Grazing light picks dust out of the air and overhead light does not, so
    // the rate falls as the sun climbs. Nothing is keyframed: it is the same
    // `_warm` the colour ramp uses, read the other way round.
    const graze = lerp(Math.max(0.01, c.moteGraze), 1, this._warm);
    let count = Math.round(this.moteEmitter.tick(dt, c.moteRate * graze * scale) * g.particleCount);
    if (count <= 0) return;

    const spread = Math.max(0.1, c.zoneRadius * c.moteSpread);

    _emit.radius = c.moteJitter;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.moteSpeed;
    _emit.speedVariance = 0.85;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.09;
    _emit.sizeVariance = 0.7;
    _emit.life = c.moteLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;

    const batches = Math.min(count, DUST_BATCHES);
    const per = Math.ceil(count / batches);
    while (count > 0) {
      // A point in the disc: sqrt of the radial roll, or the middle fills up.
      const angle = randRange(0, Math.PI * 2);
      const radius = spread * Math.sqrt(Math.random());
      _pos.copy(this._centre);
      _pos.x += Math.cos(angle) * radius;
      _pos.z += Math.sin(angle) * radius;
      _pos.y = randRange(0.05, Math.max(0.06, c.moteHeight));
      _emit.position = _pos;
      this.motes.emit(Math.min(per, count), _emit);
      count -= per;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = settings.dawnbreak;
    // The hook blends in as the cast reaches out, with the arc parked at the
    // horizon — so the stage's own light rakes down before anything rises.
    const reach = Math.pow(saturate(this.u), Math.max(0.05, c.reachCurve));
    this._sync(0, reach, 1);
    this._dustFx(dt, 0.6);
  }

  onImpact() {
    const c = settings.dawnbreak;
    const g = settings.global;
    this._sync(0, 1, 1);
    // The moment the sun leaves the horizon. A short warm flash, not a bang:
    // this ability has no impact, it has a sunrise.
    this.ctx.flash.trigger(getColor(c.colorFlash), c.crestFlash * g.explosionIntensity);
  }

  onFade(dt, t) {
    // `t` is 0..1 across the sweep, then 1..2 as the sun slides home.
    const along = saturate(t);
    const letGo = t <= 1 ? 1 : 1 - Easing.inOutQuad(saturate(t - 1));
    this._sync(along, letGo, letGo);
    this._dustFx(dt, letGo);
  }

  onDestroy() {
    // Explicit as well as borrowed: `destroy()` would reclaim it anyway, and
    // both releases are idempotent, but the sun is the one thing in this project
    // that stays visibly wrong for the rest of the session if it is missed.
    this.sun?.release();
    this.sun = null;
    this._warm = 0;
    this.material.uniforms.uFade.value = 0;
  }

  dispose() {
    // The quad is `vfx/quads.js`'s module-lifetime upright unit plane and is
    // deliberately not disposed here — it is shared with every other billboard
    // in the project.
    this.material.dispose();
    super.dispose();
  }
}
