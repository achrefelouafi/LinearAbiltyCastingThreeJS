import { Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { GroundField, GroundMode, groundFieldParams } from '../../vfx/GroundField.js';
import {
  GhostRig,
  TimeRecorder,
  findCaster,
  ghostLook,
  recorderParams
} from '../../vfx/TimeControl.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, clamp, Easing } from '../../utils/math.js';

/**
 * Hard ceiling on echoes. The `ghosts` slider clamps here.
 *
 * Four, not eight. A ghost is a real clone of the caster's skinned meshes on
 * its own `Skeleton` — one draw call and about seventy `Object3D`s each — and
 * the roster asks for three. Four leaves one slot of headroom for somebody
 * tuning, and stops the slider from quietly costing eight draw calls and eight
 * skeleton updates a frame.
 *
 * The multiplier that makes the ceiling matter is the **pool**: instances are
 * pooled per id up to the manager's four concurrent casts, so this number is
 * really "clones per pooled instance". At four it is sixteen clones in the
 * worst case, which is memory only — a hidden ghost is not traversed, so it
 * costs neither a draw nor a `Skeleton.update()` — but at eight it would be
 * thirty-two, and none of them would be on screen.
 */
const MAX_GHOSTS = 4;

/**
 * Events the rut carries. Each footfall posts one; past this the ring recycles
 * oldest-first, which is exactly right — the floor forgets the far end of the
 * line first.
 */
const TRACK_MARKS = 12;

const _pos = new Vector3();
const _dir = new Vector3();
const _emit = {};

/**
 * ECHO STEP — the caster's own recorded motion, run down the line by three
 * copies of them.
 *
 * **THE TRICK.** Nothing here is a stylised proxy of a person. A `TimeRecorder`
 * watches the real caster's rig and writes the world transform and every bone's
 * *local* pose into a ring buffer at `sampleRate` samples a second; three
 * `GhostRig`s — genuine clones of the character's skinned meshes, each on its
 * own `Skeleton` — are then driven to three different instants of that
 * recording, each further behind the present and each fainter, and walked down
 * the aimed line. They are the character, doing what the character just did,
 * late. That is what makes it unsettling, and it is the one effect in this
 * sandbox that cannot be built out of noise and parametric paths.
 *
 * ### What a cast captures
 *
 * One dice roll (`_seed`, so two casts do not weave identically) and the
 * timestamps in the recorder's ring. Every delay, stride, metre of lift, degree
 * of yaw and step of erosion is re-resolved from `settings.echostep` on every
 * frame, including a zero-length one. Pause with **P** mid-run and drag
 * `ghostDelay`: the three echoes walk backwards and forwards through the
 * recording while the world stands still, because playback is a *function of
 * the delay* and the delay is a slider. That is the loudest possible pass of
 * the pause test, on the one ability whose subject is time.
 *
 * ### Two things that were tried and thrown away
 *
 * **A silhouette proxy.** The first version drew each echo as a capsule-ish
 * hull with a fresnel ramp, on the theory that three skeletons was extravagant.
 * It reads as three coloured blobs jogging, and no amount of tuning gets it
 * back — what makes a person recognisable at ten metres is not the outline, it
 * is the shading across the shoulders and the terminator down the ribcage, and
 * those arrive free from the character's own `MeshStandardMaterial`.
 * `createGhostMaterial()` therefore bleaches the skin *by its own luminance*
 * rather than tinting it, so the map's light and shade survive.
 *
 * **Decals for the footfalls.** The second version dropped a `DecalType` mark
 * where each echo's step landed. `GroundDecals.spawn()` writes `uRadius` once,
 * so a mark already on the floor cannot hear a slider move — on the school
 * whose entire subject is that the past is still live, that is precisely the
 * wrong thing to ship. It is a `GroundField` in `RUT` mode instead: the marks
 * the cast posts are **unitless** (`s` along the track, a strength, a
 * timestamp) and the rut's depth, width, spoil and wander all re-resolve every
 * frame, so dragging `trackDepth` while paused re-cuts a track that was gouged
 * a second ago.
 *
 * ### Draw calls
 *
 * 3 ghosts (1 each, geometry and skin shared with the character) + 1 rut, plus
 * two shared particle systems. Six, against I7's twelve.
 */
export class EchostepAbility extends Ability {
  constructor(context) {
    super('echostep', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /**
     * The caster, found once. `findCaster` is `getObjectByName('Character')` —
     * a full traversal of the scene, and it has no business in a frame path.
     * By the time a chrono slot is warmed on selection the character's FBX is
     * long loaded; `_ensureSource()` covers the case where it is not.
     */
    this._caster = findCaster(this.ctx.scene);

    /**
     * Capacity is a structural ceiling, the way `MAX_STRANDS` is in
     * `ThunderAbility`: a buffer cannot be resized by a slider drag, but how
     * finely it is written (`sampleRate`) and how much of it is kept
     * (`memory`) both can. 150 samples × 96 bones is 400 kB, allocated once
     * for the life of the pool.
     */
    this.recorder = new TimeRecorder({ capacity: 150, bones: 96 });
    this.recorder.attach(this._caster);

    /**
     * `setSource()` is the only allocating call in `GhostRig` and it happens
     * here — never on a cast. Each echo gets its own material because each one
     * needs its own fade and its own erosion; sharing one would give three
     * echoes one opacity and lose the whole read.
     */
    this.ghosts = [];
    for (let i = 0; i < MAX_GHOSTS; i++) {
      const ghost = new GhostRig(this.group, { renderOrder: 4 + i });
      ghost.setSource(this._caster);
      ghost.visible = false;
      this.ghosts.push(ghost);
    }

    /**
     * The floor's memory of the run. `RUT` rather than `POCK` because a line
     * cast wants a strip and not a disc: the quad is `length` long and only a
     * couple of metres across, where `POCK` would have stood a twenty-metre
     * square of fill over the arena to hold marks that only ever land on one
     * axis.
     */
    this.track = new GroundField(this.group, {
      mode: GroundMode.RUT,
      marks: TRACK_MARKS,
      additive: false,
      name: 'echostep.track'
    });

    /* --- scratch, allocated once (I3) --- */
    this._look = ghostLook();
    this._rec = recorderParams();
    this._ground = groundFieldParams();
    this._ground.centre = new Vector3();
    /** Which step slot each echo last printed. `-1` is "has not stepped yet". */
    this._stepIndex = new Int32Array(MAX_GHOSTS).fill(-1);
    /** Where each echo is along the line, 0..1. Written every frame, read by the emitters. */
    this._ghostS = new Float32Array(MAX_GHOSTS);
    /** Per-cast dice. */
    this._seed = 0;
    /** Echoes currently drawn — the HUD's instance readout. */
    this._live = 0;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // The amber that comes off an echo. Additive and slow: this school is
    // quiet, and a bright spark would make it a storm ability with the colours
    // changed.
    this.motes = particles.get('echostep.motes', {
      capacity: 1600,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.5
    });
    this.motes.uniforms.uDrag.value = 1.9;
    this.motes.uniforms.uEndSize.value = 0.18;
    this.motes.uniforms.uSizeIn.value = 0.09;
    this.motes.uniforms.uFadeIn.value = 0.12;
    this.motes.uniforms.uFadeOut.value = 0.45;

    // Floor dust kicked by a footfall. Non-additive so it genuinely sits in
    // front of the rut rather than lighting it.
    this.dust = particles.get('echostep.dust', {
      capacity: 1200,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 0.9
    });
    this.dust.uniforms.uDrag.value = 2.4;
    this.dust.uniforms.uEndSize.value = 2.2;
    this.dust.uniforms.uSizeIn.value = 0.14;
    this.dust.uniforms.uFadeIn.value = 0.18;
    this.dust.uniforms.uFadeOut.value = 0.35;

    this.moteEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this._live;
  }

  /** The echoes hold at the far end before they are let go. */
  get impactDuration() {
    return Math.max(0.05, settings.echostep.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.echostep.fadeTime);
  }

  /**
   * A slow swell rather than a flicker.
   *
   * Storm gutters, ice glints; a memory *breathes*. Two beats an octave apart
   * so the period is not obviously one sine.
   */
  lightShimmer() {
    const c = settings.echostep;
    const t = this.age * c.lightPulseSpeed;
    return 1 - c.lightPulse * (0.5 - 0.5 * Math.cos(t) * Math.cos(t * 0.37));
  }

  /* ------------------------------------------------------------------ */
  /* The run                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Re-attach to the caster if it was not in the scene when the pool was built.
   *
   * `setSource()` is idempotent — it returns immediately once the source
   * matches — so this costs a pointer compare on every cast after the first,
   * and buys the case where a chrono slot is cast before the character's
   * asynchronous FBX has landed. Without it that pool is ghostless for the rest
   * of the session.
   */
  _ensureSource() {
    if (this._caster) return;
    this._caster = findCaster(this.ctx.scene);
    if (!this._caster) return;
    this.recorder.attach(this._caster);
    for (const ghost of this.ghosts) ghost.setSource(this._caster);
  }

  /** How far behind the front echo `i` runs, metres, before the catch-up. */
  _strideOf(i) {
    const c = settings.echostep;
    return c.ghostStride * (i + 1) * Math.pow(c.strideGrowth, i);
  }

  /** Which instant echo `i` is replaying, in the recorder's own clock. */
  _instantOf(i, now) {
    const c = settings.echostep;
    return now - c.ghostDelay * (i + 1) * Math.pow(c.delayGrowth, i);
  }

  /**
   * Place, pose and dress every echo.
   *
   * @param {number} dt      seconds; 0 on a paused frame, and the gate on
   *                         everything irreversible below
   * @param {number} fade    1 while the run holds, ramping to 0 on the blow-out
   * @param {number} catchUp 0..1 — how far the echoes have closed on the far end
   */
  _syncGhosts(dt, fade, catchUp) {
    const c = settings.echostep;
    const g = settings.global;
    const now = frame.uTime.value;
    const count = clamp(Math.round(c.ghosts), 1, MAX_GHOSTS);
    this._live = 0;

    /* --- write the recording --- */
    // `sample()` refuses a frame that has not advanced far enough for the live
    // rate, so a paused frame writes nothing and the track stops growing while
    // the ghosts keep reading from it. That asymmetry is the pause test.
    this._rec.rate = c.sampleRate;
    this._rec.window = c.memory;
    this.recorder.sample(now, this._rec);
    this.recorder.trim(now, this._rec);

    const lead = this.u * this.length;
    // The character model faces its own +Z, so the cast's heading is the yaw
    // that takes +Z onto `direction`.
    const yaw = Math.atan2(this.direction.x, this.direction.z);
    const look = this._look;

    look.tint = c.colorGhost;
    look.deep = c.colorGhostDeep;
    look.rimColor = c.colorRim;
    look.bleach = c.bleach;
    look.facing = c.facing;
    look.rimPower = c.rimPower;
    look.bandScale = c.bandScale;
    look.bandSpeed = c.bandSpeed;
    look.erodeScale = c.erodeScale;
    look.edge = c.erodeEdge;
    look.edgeGlow = c.edgeGlow;

    for (let i = 0; i < MAX_GHOSTS; i++) {
      const ghost = this.ghosts[i];
      if (i >= count) {
        ghost.visible = false;
        continue;
      }

      /* --- where --- */
      const stride = this._strideOf(i) * (1 - catchUp);
      const s = saturate((lead - stride) / this.length);
      this._ghostS[i] = s;

      this.pointAt(s, _pos);
      // A weave, so three echoes on one line are not one echo drawn three
      // times. Sampled on `s` rather than on the clock: an echo's wander is a
      // property of where on the line it is, so the whole train slides along a
      // fixed serpentine instead of shimmying on the spot.
      const wob = Math.sin((s * c.weaveWaves + this._seed + i * 0.37) * Math.PI * 2);
      _pos.addScaledVector(this.side, wob * c.weave * (i + 1));
      _pos.y = c.ghostLift - c.ghostSink * i;

      // Older echoes are turned a little further off the line of travel. The
      // fan is centred, so the newest is not the only one standing straight.
      ghost.place(_pos, yaw + c.ghostYaw * (i - (count - 1) * 0.5));
      ghost.setScale(Math.max(0.02, c.ghostScale * (1 - c.scaleDecay * i)));

      /* --- when --- */
      const inTrack = this.recorder.poseAt(this._instantOf(i, now), ghost);

      /* --- how it looks --- */
      const dim = Math.pow(c.opacityDecay, i);
      look.fade = saturate(c.ghostOpacity * dim * fade * g.opacity);
      look.rim = c.rim * dim;
      look.glow = c.bandGlow * dim;
      look.erode = saturate(c.erode + c.erodeStep * i + (1 - fade) * c.erodeOut);
      look.seed = this._seed + i * 3.7;
      ghost.sync(look);

      // An echo with no recording behind it is not a faint echo, it is a
      // rendering bug: the recorder clamps to the nearest sample rather than
      // returning NaN, so the ghost would stand in the caster's *current* pose
      // and read as a duplicate rather than a memory. It waits instead.
      ghost.visible = inTrack && look.fade > 0.002;
      if (ghost.visible) this._live++;

      /* --- the footfall --- */
      // Gated on a real frame: a footfall is an event, and a zero-length frame
      // has no events in it. Without the gate, dragging `steps` while paused
      // would print a line of steps under the cursor.
      if (dt > 0) this._footfall(i, s, now);
    }
  }

  /**
   * Post a contact force into the rut when echo `i` crosses a step boundary.
   *
   * The step *pattern* is unitless — `floor(s × steps + stagger)` — so the
   * prints re-place themselves down the track when `range` or `steps` moves,
   * and the mark itself carries nothing but a fraction, a weight and a
   * timestamp.
   */
  _footfall(i, s, now) {
    const c = settings.echostep;
    const steps = Math.max(1, Math.round(c.steps));
    const slot = Math.floor(s * steps + i * c.stepStagger);
    if (slot === this._stepIndex[i]) return;
    const first = this._stepIndex[i] < 0;
    this._stepIndex[i] = slot;
    if (first || s <= 0.0001) return;

    const weight = saturate(c.stepWeight * Math.pow(c.weightDecay, i));
    this.track.mark(0, s, now, weight);

    /* --- and the dust it lifts --- */
    const g = settings.global;
    const count = Math.round(c.dustPerStep * weight * g.particleCount);
    if (count <= 0) return;

    this.pointAt(s, _pos);
    _pos.y = c.dustHeight;
    _emit.position = _pos;
    _emit.radius = c.dustSpread;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(-0.35).setY(1).normalize();
    _emit.speed = c.dustSpeed;
    _emit.speedVariance = 0.7;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.5;
    _emit.sizeVariance = 0.6;
    _emit.life = c.dustLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0.3;
    _emit.tint = null;
    _emit.time = now;
    this.dust.emit(count, _emit);
  }

  /** The rut, re-cut from live settings every frame. */
  _syncTrack(fade) {
    const c = settings.echostep;
    const g = settings.global;
    const p = this._ground;

    // Anchored at the *start* of the track — RUT slides its own quad downrange
    // by half the length — so this is the caster's feet, not the mid-span.
    p.centre.copy(this.origin);
    p.yaw = Math.atan2(this.direction.x, this.direction.z);
    p.height = c.trackHeight;
    p.length = this.length;
    // For RUT the radius only sets how wide the canvas is; the track's own
    // half-width is `width`. Keeping it a small multiple of the width is what
    // stops a twenty-metre cast from standing a twenty-metre square of fill.
    p.radius = c.trackWidth * c.trackCanvas;
    p.progress = this.phase === AbilityPhase.TRAVEL ? this.u : 1;
    p.fade = fade;
    p.seed = this._seed;

    p.edge = c.trackEdge;
    p.width = c.trackWidth;
    p.depth = c.trackDepth;
    p.lift = c.trackSpoil;
    p.thickness = c.trackSpoilWidth;
    p.sharp = c.trackSharp;
    p.detail = c.trackChatterDepth;
    p.cell = c.trackChatter;
    p.swirl = c.trackWander;
    p.raggedScale = c.trackWanderScale;
    p.seam = c.stepBlur;

    p.relief = c.trackRelief;
    p.normalStep = c.trackNormalStep;
    p.ambient = c.trackAmbient;
    p.wrap = c.trackWrap;
    p.specular = c.trackSpecular;
    p.gloss = c.trackGloss;
    p.parallax = c.trackParallax;

    p.emissive = c.trackEmissive * g.glow;
    p.opacity = c.trackOpacity * fade * g.opacity;
    p.depthFade = c.trackDepthFade;
    p.colorBase = c.colorTrack;
    p.colorEdge = c.colorTrackEdge;
    p.colorGlow = c.colorTrackGlow;
    p.colorDeep = c.colorTrackDeep;

    p.noiseStrength = g.turbulence;
    p.noiseFrequency = 1;
    p.noiseSpeed = 1;
    p.opacityScale = 1;

    this.track.update(p);
  }

  /** Amber shed by the echoes themselves. */
  _syncMotes(dt, fade) {
    const c = settings.echostep;
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
    this.motes.uniforms.uOpacity.value = c.moteOpacity * g.opacity;
    this.motes.uniforms.uGlow.value = c.moteGlow * g.glow;
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
    this.dust.uniforms.uSpeedScale.value = g.particleSpeed;
    this.dust.uniforms.uOpacity.value = c.dustOpacity * g.opacity;
    this.dust.uniforms.uTurbulence.value = c.dustTurbulence * g.turbulence;

    if (dt <= 0 || this._live <= 0) return;
    const total = Math.round(this.moteEmitter.tick(dt, c.moteRate * fade) * g.particleCount);
    if (total <= 0) return;

    const per = Math.max(1, Math.round(total / this._live));
    const now = frame.uTime.value;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.moteSpeed;
    _emit.speedVariance = 0.85;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.1;
    _emit.sizeVariance = 0.7;
    _emit.life = c.moteLifetime;
    _emit.lifeVariance = 0.55;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = now;

    for (let i = 0; i < MAX_GHOSTS; i++) {
      if (!this.ghosts[i].visible) continue;
      this.pointAt(this._ghostS[i], _pos);
      _pos.y = c.moteHeight;
      _emit.position = _pos;
      _emit.radius = c.moteSpread;
      this.motes.emit(per, _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this._ensureSource();
    this.recorder.clear();
    this.track.clearMarks();
    this.moteEmitter.reset();
    this._stepIndex.fill(-1);
    this._live = 0;

    // The one thing the cast keeps. Unitless.
    this._seed = Math.random() * 10;

    this._syncGhosts(0, 1, 0);
    this._syncTrack(1);
    this._syncMotes(0, 1);

    const c = settings.echostep;
    this.lightBoost = c.lightIntensity * 0.4 * settings.global.explosionIntensity;
  }

  onTravel(dt) {
    this._syncGhosts(dt, 1, 0);
    this._syncTrack(1);
    this._syncMotes(dt, 1);

    // The light rides the newest echo's chest, not the floor under the front —
    // this is a figure running, and lighting the ground would read as a
    // projector following it.
    this.pointAt(this._ghostS[0], this.position);
    this.position.y = settings.echostep.lightHeight;
  }

  onImpact() {
    const c = settings.echostep;
    const g = settings.global;

    this.pointAt(1, _pos);
    _pos.y = c.arrivalHeight;

    // A thin pressure shell, not a detonation. The whole school is quiet, and
    // the arrival's job is only to say "this is where the run ended".
    this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
      radius: c.arrivalSize * 0.25,
      endRadius: c.arrivalSize * g.explosionIntensity,
      life: 0.75,
      intensity: c.arrivalIntensity,
      opacity: 0.55,
      fresnel: 2.2,
      displace: 0.25,
      squash: 0.85,
      colorA: getColor(c.colorArrivalA),
      colorB: getColor(c.colorArrivalB),
      colorC: getColor(c.colorArrivalC)
    });

    this.ctx.shake.add(
      c.arrivalShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      18
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.arrivalFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.8 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.echostep;
    // `t` is 0..1 while the echoes hold at the far end, then 1..2 as they go.
    const fade = t <= 1 ? 1 : 1 - Easing.inCubic(saturate(t - 1));

    // The catch-up. Once the run is over the echoes close on the arrival point
    // — the past catching up with the present is the beat the whole ability is
    // built to pay off, and it is a closed form of `t`, so dragging `catchUp`
    // with the clock stopped slides all three of them along the line at once.
    const closing = Math.pow(saturate(t * 0.5), Math.max(0.05, c.catchCurve));
    const catchUp = saturate(c.catchUp * closing);

    this._syncGhosts(dt, fade, catchUp);
    this._syncTrack(fade);
    this._syncMotes(dt, fade * 0.55);

    this.pointAt(this._ghostS[0], this.position);
    this.position.y = c.lightHeight;
  }

  onDestroy() {
    // The base class hides the whole group, so nothing here needs to hide the
    // rut — but a pooled instance must come back empty: a second cast that
    // inherited the first one's footfalls would draw a track it never walked.
    for (const ghost of this.ghosts) ghost.visible = false;
    this.track.clearMarks();
    this.recorder.clear();
    this._stepIndex.fill(-1);
    this._live = 0;
  }

  dispose() {
    for (const ghost of this.ghosts) ghost.dispose();
    this.ghosts.length = 0;
    this.track.dispose();
    this.recorder.detach();
    super.dispose();
  }
}
