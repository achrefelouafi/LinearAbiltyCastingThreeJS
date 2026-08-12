import { Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { GhostRig, TimeRecorder, findCaster } from '../../vfx/TimeControl.js';
import { createMirageSkinMaterial } from '../../materials/MirageSkinMaterial.js';
import { LAYER, retainDistortion, releaseDistortion } from '../../core/Layers.js';
import { settings } from '../../config/settings.js';
import { saturate, Easing } from '../../utils/math.js';

/* ------------------------------------------------------------------ */
/* Module-scope scratch — I3. Nothing below allocates in a frame.      */
/* ------------------------------------------------------------------ */

const _place = new Vector3();

/**
 * MIRAGE — the caster, made of nothing but refraction.
 *
 * **THE TRICK: the silhouette is the scene, bent.** The double is not on
 * `LAYER.VFX`. There is no emissive surface, no particle, no decal, no shell
 * and no light anywhere in this ability; the one mesh it owns writes a
 * screen-space offset into the half-resolution distortion target and nothing
 * else. What you see is the floor, the caster and every mote behind the figure
 * bending around a body-shaped solid. Switch the distortion pass off and the
 * cast is an empty frame with a slight camera rumble.
 *
 * ### It is the caster, not an impression of him
 *
 * The first version built the figure out of ten `DistortionField(REFRACT)`
 * capsules — head, torso, two upper arms, two forearms, two thighs, two shins
 * — posed by a hand-written gait solver with sliders for stride, knee flex and
 * elbow swing. It was a great deal of machinery for a poor answer. A capsule
 * figure is a *mannequin*: its silhouette is smooth in all the places a
 * person's is not, two spheres cannot make a shoulder, and a sine-driven arm
 * carries none of the weight-shift a real stride does. The eye reads the miss
 * immediately and cannot name it, which is the worst way for an effect to be
 * wrong.
 *
 * So the double is the **caster's own skinned mesh**, cloned by `GhostRig` and
 * posed from a `TimeRecorder` track — the same machinery Echo Step runs on.
 * Every fold of the coat and every swing of the arms is the real animation,
 * because it *is* the real animation, and `materials/MirageSkinMaterial.js`
 * skins it through the skeleton so the refraction follows the body rather than
 * a bind pose. Two hundred lines of gait solver went in the bin and the effect
 * got better, which is usually how that trade goes.
 *
 * ### An adjusted ghost, not a copy
 *
 * A double that mirrors the caster frame-for-frame reads as a rendering fault
 * — the eye pairs the two and sees double-vision, not a second figure. Three
 * adjustments break the pairing, and all three are sliders:
 *
 *  - **`poseDelay`** — the double replays the caster's pose from that many
 *    seconds ago, so when the caster is mid-throw the double is still winding
 *    up. This is the one that does most of the work.
 *  - **`figureScale`** — a per cent or two off life size is below the
 *    threshold of "that is a smaller person" and above the threshold of "those
 *    are the same person".
 *  - **the line itself** — the double leaves on the aimed heading and the
 *    caster does not follow it.
 *
 * ### And you lose it the moment it stops
 *
 * That is the second half of the trick and it is what stops this being "a
 * ghost". Visibility is `motion^stopPower`, where `motion` is how fast the
 * double is actually travelling — legible at a sprint, marginal at a jog, and
 * *gone* while it is still coasting to a halt. It never arrives anywhere.
 * There is no impact beat, no flash and no shake: the last thing you saw was
 * already not there, and if you were tracking it you spend a second looking at
 * the spot where it should have finished.
 *
 * The halt is one curve used twice, which is the only reason it does not slide
 * its feet. Speed decays as `(1 − x)²` over `haltTime`; the distance that
 * curve covers is its own integral, `1 − (1 − x)³`, which is `Easing.outCubic`
 * — so `haltCoast` metres is *exactly* how far the double carries past the
 * target. The pose is playback rather than a distance-driven gait, so the feet
 * cannot skate no matter what the run does.
 *
 * ### Invariants
 *
 * A cast captures nothing but the clock. The clone is built once, on the first
 * cast that finds a character in the scene (the FBX loads asynchronously, so
 * construction is too early to look), and reused by every cast after it —
 * `GhostRig#setSource` is the one allocating call in this file and it is not on
 * the per-cast path. Every metre, radian and second is resolved from
 * `settings.mirage` inside `_sync()`, which runs on a zero-length frame too:
 * pause with **P** mid-run and drag `poseDelay`, and the standing double
 * re-poses without the clock moving.
 */
export class MirageAbility extends Ability {
  constructor(context) {
    super('mirage', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /**
     * One material, one clone, one draw call per skinned mesh in the rig.
     *
     * `LAYER.DISTORTION` rather than `LAYER.VFX`: this never reaches the
     * beauty pass, so there is no colour to grade and no bloom to guard
     * against. `renderOrder` 0 because it is the only thing in the buffer.
     */
    this.skin = createMirageSkinMaterial();
    this.rig = new GhostRig(this.group, {
      material: this.skin,
      layer: LAYER.DISTORTION,
      renderOrder: 0
    });

    /**
     * The pose track. Attached to the caster the first time one is found and
     * left attached: it records whenever a cast is live and is trimmed to
     * `poseWindow`, so a long session does not grow it.
     */
    this.recorder = new TimeRecorder();

    /** True once the clone exists. The FBX may not have loaded yet. */
    this._bound = false;
    /** True while this ability is counted against the distortion pass. */
    this._writing = false;
  }

  createParticles() {
    /**
     * None. Deliberately, and it is the single most important line in the
     * file: the moment this ability emits one mote it stops being a silhouette
     * made of refraction and becomes a ghost with a dust trail, which is a
     * different — and much more ordinary — slot.
     */
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  /** The halt. Long enough that you watch the double *fail* to arrive. */
  get impactDuration() {
    return Math.max(0.05, settings.mirage.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.mirage.fadeTime);
  }

  /**
   * One draw call per skinned mesh in the caster's rig, and nothing instanced.
   * The honest HUD readout for that is zero.
   */
  get instanceCount() {
    return 0;
  }

  /* ------------------------------------------------------------------ */
  /* The run — every metre resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  /**
   * Metres of ground the double has covered.
   *
   * During the run this is the base class's front. After it, the halt curve's
   * own integral carries it exactly `haltCoast` metres further and stops — see
   * the class comment for why the two curves have to be each other's integral.
   */
  _travelled() {
    const c = settings.mirage;
    if (this.phase === AbilityPhase.TRAVEL) return this.front;
    const x = saturate(this._sinceArrival() / Math.max(0.02, c.haltTime));
    return this.length + c.haltCoast * Easing.outCubic(x);
  }

  /** Seconds since the double drew level with the target. */
  _sinceArrival() {
    if (this.phase === AbilityPhase.IMPACT) return this.impactTime;
    if (this.phase === AbilityPhase.FADE) return this.impactDuration + this.fadeTime;
    return 0;
  }

  /** 0..1 of running speed. The whole visibility of the ability hangs off it. */
  _motion() {
    const c = settings.mirage;
    if (this.phase === AbilityPhase.TRAVEL) return 1;
    const x = saturate(this._sinceArrival() / Math.max(0.02, c.haltTime));
    const remaining = 1 - x;
    return remaining * remaining;
  }

  /**
   * Count this ability against the distortion pass exactly once while it is up.
   *
   * `core/Layers.js#distortionWriters` is a "does anything need this pass"
   * counter, not a mesh census, so one retain per live cast is the right
   * granularity — and it must be balanced, or `PostProcessing` clears and
   * resamples a half-resolution buffer over nothing for the rest of the
   * session.
   */
  _setWriting(on) {
    if (on === this._writing) return;
    this._writing = on;
    this.rig.visible = on;
    if (on) retainDistortion();
    else releaseDistortion();
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    // Build the clone on the first cast that finds a character. The rig is
    // loaded asynchronously, so `createShaders` is too early to look, and an
    // ability pooled before the FBX resolved would otherwise never see it.
    if (!this._bound) {
      const caster = findCaster(this.ctx?.scene ?? null);
      if (caster && this.rig.setSource(caster)) {
        this.recorder.attach(caster);
        this._bound = true;
      }
    }

    // A cast starts with an empty track: the double's first frames should be
    // the caster's *first* frames, not the tail of the previous cast.
    this.recorder.clear();

    this._setWriting(this._bound);
    // Sync once before the first frame is drawn, or the double stands for one
    // frame at last cast's end of the line.
    this._sync(0);
  }

  /* ------------------------------------------------------------------ */
  /* The one sync                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Record the caster, pose the double, place it, and push the live refraction
   * settings. Everything with a unit is read here and nowhere else.
   */
  _sync(dt) {
    const c = settings.mirage;
    const g = settings.global;
    const now = this.age;

    // The track and the pose need a rig; the placement and the refraction
    // settings do not, and are resolved either way. Gating the whole function
    // on `_bound` would leave every slider in the block dead in a scene with
    // no character in it — including the headless harness, which is exactly
    // where a dead slider should be caught.
    if (this._bound) {
      /* --- the track --- */
      // Sampling is rate-limited inside the recorder, so calling it every
      // frame costs one comparison on the frames it does not want. A
      // zero-length frame writes nothing and reads the same instant, which is
      // what keeps the paused editor honest.
      if (dt > 0) {
        this.recorder.sample(now, c);
        this.recorder.trim(now, c);
      }

      /* --- the pose: the caster, `poseDelay` seconds ago --- */
      // Clamped at zero rather than allowed to go negative: before the delay
      // has elapsed there is no history to read, and `poseAt` holds the oldest
      // sample, which is the caster standing as he was when the cast began.
      this.recorder.poseAt(Math.max(0, now - c.poseDelay), this.rig);
    }

    /* --- where it is --- */
    const along = this._travelled();
    _place
      .copy(this.origin)
      .addScaledVector(this.direction, c.figureLead + along)
      .addScaledVector(this.side, c.figureSide);
    _place.y = 0;
    // Yaw from the cast's own heading, so the double runs the line it was
    // aimed down rather than the way the caster happens to be facing.
    this.rig.place(_place, Math.atan2(this.direction.x, this.direction.z));
    this.rig.setScale(Math.max(0.05, c.figureScale));

    /* --- how much of it you get --- */
    const motion = this._motion();
    // The ability, in one line. `stillness` is the escape hatch and it ships
    // at zero: at a dead stop there is nothing there at all.
    const seen = c.stillness + (1 - c.stillness) * Math.pow(motion, Math.max(0.05, c.stopPower));

    this.skin.userData.sync(seen);
    // The two global multipliers the material's own sync cannot see, applied
    // here so an emitter never folds a master gain into its authored strength
    // twice. `post.distortion` is applied in the pass and nowhere else.
    const u = this.skin.userData.uniforms;
    u.uRippleScale.value = c.refractRippleScale * g.noiseFrequency;
    u.uRippleSpeed.value = c.refractRippleSpeed * g.noiseSpeed;

    // The light — such as it is — rides the double's chest rather than the
    // floor line the base class puts it on.
    this.position.copy(_place);
    this.position.y = c.figureScale * 1.35;
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._sync(dt);
    this.ctx.shake.rumble(settings.mirage.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    // Nothing. There is no impact: the double does not arrive, it stops being
    // visible while it is still moving and then stops. Every other slot in the
    // sandbox spends its budget here; this one spends it on the absence.
  }

  onFade(dt, _t) {
    this._sync(dt);
    // The rumble goes with the speed, so it dies on the same curve the
    // silhouette does — you stop feeling it at about the moment you stop
    // seeing it.
    this.ctx.shake.rumble(settings.mirage.rumble * this._motion() * settings.global.cameraShake, dt);
  }

  onDestroy() {
    // Releases this ability's one writer against the distortion pass's counter.
    // Hiding the group instead would leave it retained for the session.
    this._setWriting(false);
    this.recorder.clear();
  }

  dispose() {
    this._setWriting(false);
    this.rig.dispose();
    this.recorder.attach(null);
    super.dispose();
  }
}
