import { Color, Vector3, Vector4 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { LightShaft, ShaftLayout, lightShaftParams } from '../../vfx/LightShaft.js';
import { Caustics, CausticSource, CausticShape, causticsParams } from '../../vfx/Caustics.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { replaceChunk } from '../../utils/shaderPatch.js';
import { saturate, lerp, smoothstep, Easing } from '../../utils/math.js';

/**
 * Hard ceiling on shafts in the colonnade. The editor's `shaftCount` slider
 * clamps here, `LightShaft` allocates its dice at this size once, and the dust
 * coupling's uniform array is exactly this long — the three numbers have to
 * agree or the dust lights a rank that is not the one being drawn.
 */
const MAX_SHAFTS = 8;

/* ------------------------------------------------------------------ */
/* Scratch — module scope (I3)                                         */
/* ------------------------------------------------------------------ */

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _anchor = new Vector3();
const _up = new Vector3(0, 1, 0);
const _axis = new Vector3(0, -1, 0);
const _sun = new Vector3(0, 1, 0);
const _probe = new Vector3();
const _tint = new Color();

/** Filled from `settings.godspear` every frame; never held between frames. */
const _shaft = lightShaftParams();
const _net = causticsParams();

/* ------------------------------------------------------------------ */
/* The scene's own dust, joined to the rank                            */
/* ------------------------------------------------------------------ */

/**
 * The GLSL the room's dust cloud gains while a Godspear is standing.
 *
 * This is `LightShaft#irradianceAt()` — the same gaussian across the cone, the
 * same axial curve with its floor at the mouth, the same `exp(-extinct·a)` down
 * the axis — moved onto the GPU and evaluated once per mote.
 *
 * It is a duplicate of that function and I would rather it were not. Two other
 * routes were tried first:
 *
 *  - **Call the CPU mirror per mote and upload the results.** This does not
 *    work, and not for the reason you would guess. It is not the cost (2600
 *    motes × 8 shafts is nothing); it is that a mote's drawn position *does not
 *    exist on the CPU*. `DustMotes` displaces every point by `curlNoise` in its
 *    own vertex shader, so the buffer the CPU holds is where the mote was
 *    seeded, not where it is. Lighting the seed positions puts the bright motes
 *    somewhere between one and two metres from the shaft, which reads as the
 *    shaft having a halo of dust *around* it — the exact opposite of the effect.
 *  - **Emit a second, lit particle system along the rank and turn the room's
 *    dust down.** This is what the brief forbids and it is right to: the giveaway
 *    is that the ambient dust keeps drifting at its own speed on its own curl
 *    field while the "shaft dust" drifts on another, and the two clouds visibly
 *    slide through each other at the shaft's edge.
 *
 * So the ability publishes the *rank* — eight feet and one profile — and the
 * dust evaluates the field itself, in the place where it already knows where it
 * is. One field, two consumers, which is the shape `Caustics#bindSource()` uses
 * for the same problem.
 *
 * `w` on each foot is that shaft's own sweep-window amplitude, so a mote only
 * lights under a shaft that is actually lit.
 */
const DUST_SHAFT_GLSL = /* glsl */ `
  uniform vec4  uShaftFeet[${MAX_SHAFTS}];  // xyz = foot in world metres, w = 0..1 amplitude
  uniform float uShaftCount;
  uniform vec3  uShaftAxis;      // unit, pointing DOWN the shafts
  uniform float uShaftLength;    // metres, mouth to foot
  uniform float uShaftRMouth;    // metres
  uniform float uShaftRFoot;     // metres
  uniform float uShaftSoft;      // widens the gaussian core
  uniform float uShaftCurve;     // axial exponent
  uniform float uShaftMouthMin;  // 0..1 density at the mouth
  uniform float uShaftExtinct;   // 1/metres
  uniform float uShaftSwell;     // extra point size at full irradiance

  varying float vShaftLit;

  /* The strongest shaft's irradiance at a world point, 0..1. Mirrors
     LightShaft#irradianceAt term for term, and leaves the canopy gobo out for
     the same reason it does: a mote crossing a leaf edge at four metres a
     second would strobe. */
  float godspearIrradiance(vec3 wp) {
    if (uShaftCount < 0.5) return 0.0;
    float best = 0.0;
    for (int i = 0; i < ${MAX_SHAFTS}; i++) {
      if (float(i) >= uShaftCount) break;
      vec4 foot = uShaftFeet[i];
      if (foot.w <= 0.0) continue;

      vec3 rel = wp - foot.xyz;
      // The axis points down, so a point above the foot has a negative
      // component along it, and a runs 0 at the mouth to uShaftLength at the
      // foot. Same convention as the CPU mirror.
      float along = dot(rel, uShaftAxis);
      float a = uShaftLength + along;
      if (a < 0.0 || a > uShaftLength) continue;

      float k = a / max(uShaftLength, 1e-3);
      float rad = max(mix(uShaftRMouth, uShaftRFoot, k), 0.01);
      float perp2 = max(dot(rel, rel) - along * along, 0.0);
      float fall = exp(-perp2 / max(rad * rad * uShaftSoft, 1e-6));
      float axial = mix(uShaftMouthMin, 1.0, pow(k, max(uShaftCurve, 0.001)));
      best = max(best, fall * axial * exp(-uShaftExtinct * a) * foot.w);
    }
    return clamp(best, 0.0, 1.0);
  }
`;

/**
 * The ledger that joins `world/DustMotes.js` to whichever Godspear is standing.
 *
 * A module-scope singleton, because the dust cloud is one object in the world
 * and the ability is pooled: four instances of `GodspearAbility` share one patch
 * and one set of uniform boxes. Ownership is last-writer-wins per frame, and a
 * cast only zeroes the field on the way out if it is still the owner — so a
 * second Godspear thrown while the first is standing takes the dust over
 * cleanly instead of switching it off when the first one dies.
 *
 * There is no `sceneHooks` entry for "the room's dust" and this is not the file
 * to add one in: `vfx/SceneHooks.js` is shared and several agents are inside it.
 * The patch is applied once, at ability construction, and is left installed with
 * `uShaftCount` at zero afterwards — which costs the dust shader one float
 * compare per mote for the rest of the session and nothing else.
 */
class DustCoupling {
  constructor() {
    this.material = null;
    this.uniforms = null;
    this.owner = null;
  }

  /**
   * Find the cloud and patch it, once per session.
   *
   * Returns `false` when there is no `DustMotes` in the scene — which is the
   * case in `npm run check`'s mock context, and would be the case in any harness
   * that stands an ability up on a bare `Scene`. Everything downstream guards on
   * it. Finding the cloud by name is the `TimeControl#findCaster()` precedent.
   */
  attach(scene) {
    if (this.uniforms) return true;
    const points = scene?.getObjectByName?.('DustMotes');
    const material = points?.material;
    if (!material || !material.uniforms) return false;

    // Another instance of this ability got here first.
    if (material.userData.godspearDust) {
      this.material = material;
      this.uniforms = material.userData.godspearDust;
      return true;
    }

    const feet = [];
    for (let i = 0; i < MAX_SHAFTS; i++) feet.push(new Vector4(0, 0, 0, 0));

    const added = {
      uShaftFeet: { value: feet },
      uShaftCount: { value: 0 },
      uShaftAxis: { value: new Vector3(0, -1, 0) },
      uShaftLength: { value: 10 },
      uShaftRMouth: { value: 0.5 },
      uShaftRFoot: { value: 1.5 },
      uShaftSoft: { value: 0.5 },
      uShaftCurve: { value: 0.6 },
      uShaftMouthMin: { value: 0.4 },
      uShaftExtinct: { value: 0.05 },
      uShaftSwell: { value: 1.8 },
      uShaftGain: { value: 6 },
      uShaftTint: { value: 0.85 },
      uShaftColor: { value: new Color(1, 0.95, 0.81) }
    };
    Object.assign(material.uniforms, added);

    /* ---- the vertex stage ---- */
    let vs = material.vertexShader;
    vs = replaceChunk(vs, 'void main() {', `${DUST_SHAFT_GLSL}\n        void main() {`);
    // After the curl displacement, so the point being lit is the point being
    // drawn. `modelMatrix` is there because the cloud is translated to follow
    // the character and `position` is therefore local.
    vs = replaceChunk(
      vs,
      'vec4 mv = modelViewMatrix * vec4(p, 1.0);',
      'vShaftLit = godspearIrradiance((modelMatrix * vec4(p, 1.0)).xyz);\n' +
        '          vec4 mv = modelViewMatrix * vec4(p, 1.0);'
    );
    vs = replaceChunk(
      vs,
      'gl_PointSize = uSize * uPixelRatio * (0.35 + aSeed * 0.9) / max(dist, 1.0);',
      'gl_PointSize = uSize * uPixelRatio * (0.35 + aSeed * 0.9) / max(dist, 1.0);\n' +
        '          gl_PointSize *= 1.0 + uShaftSwell * vShaftLit;'
    );
    material.vertexShader = vs;

    /* ---- the fragment stage ---- */
    let fs = material.fragmentShader;
    fs = replaceChunk(
      fs,
      'varying float vSeed;',
      'varying float vSeed;\n        varying float vShaftLit;\n' +
        '        uniform float uShaftGain;\n        uniform float uShaftTint;\n' +
        '        uniform vec3  uShaftColor;'
    );
    fs = replaceChunk(
      fs,
      'vec3 tint = mix(vec3(1.0, 0.93, 0.78), vec3(0.78, 0.9, 1.0), vSeed);',
      'vec3 tint = mix(vec3(1.0, 0.93, 0.78), vec3(0.78, 0.9, 1.0), vSeed);\n' +
        '          tint = mix(tint, uShaftColor, clamp(vShaftLit * uShaftTint, 0.0, 1.0));'
    );
    fs = replaceChunk(
      fs,
      'float a = mask * vAlpha * uAmount * 0.3;',
      'float a = mask * vAlpha * uAmount * 0.3 * (1.0 + uShaftGain * vShaftLit);'
    );
    material.fragmentShader = fs;

    material.needsUpdate = true;
    material.userData.godspearDust = added;

    this.material = material;
    this.uniforms = added;
    return true;
  }

  /** How many feet the array can hold — the ability clamps its rank to this. */
  get slots() {
    return MAX_SHAFTS;
  }

  /** Take the field over. Called every frame by the standing cast. */
  claim(owner) {
    this.owner = owner;
    return this.uniforms;
  }

  /** Hand it back. A cast that is no longer the owner leaves the field alone. */
  release(owner) {
    if (!this.uniforms || this.owner !== owner) return;
    this.owner = null;
    this.uniforms.uShaftCount.value = 0;
    for (const foot of this.uniforms.uShaftFeet.value) foot.w = 0;
  }
}

const dustCoupling = new DustCoupling();

/* ------------------------------------------------------------------ */
/* The ability                                                         */
/* ------------------------------------------------------------------ */

/**
 * GODSPEAR — a colonnade of lit air walked down the aimed line.
 *
 * **THE TRICK IS REAL IN-SCATTERING, AND THE READ IS THE ANISOTROPY.** Every
 * fragment of every shaft solves an integral along the view ray through a cone
 * of lit air, and the result is multiplied by the Henyey–Greenstein phase
 * function of the angle between that ray and the *shaft's own axis*. Seen from
 * the side a shaft is a soft pale cone that half the library could have drawn.
 * Swing the camera round until you are looking up one — which `shaftTilt` makes
 * possible by laying the whole rank over with the scene's key light — and it is
 * roughly eight times brighter. That swing is the ability. `anisotropy` is the
 * slider; at `g = 0` it is off and the effect immediately becomes a translucent
 * traffic cone.
 *
 * Three things fall out of taking that seriously, and each of them is a thing
 * this slot does that no other slot in the sandbox does:
 *
 * 1. **The band on the floor is the same integral.** The view ray terminates on
 *    the depth buffer; if it terminated inside a shaft's footprint and near its
 *    foot plane, the light that landed there is bouncing back, carrying the same
 *    radial gaussian, the same canopy gaps and the same axial extinction the air
 *    above it has. It is not a decal and it must not be one: drag `gobo` with
 *    the clock stopped and the leaf-shadows on the stone move with the gaps in
 *    the air, because they are one field.
 * 2. **The dust in the shaft is the room's dust.** `world/DustMotes.js` — the
 *    2600 motes that were already drifting past before the cast — gains the
 *    rank's irradiance function in its own vertex shader and each mote lights
 *    itself. Nothing is emitted for this and nothing is copied. See
 *    `DustCoupling` above for the two versions of it that did not work and why.
 * 3. **The caustic net is the canopy, landed.** Light through a stirring canopy
 *    folds before it reaches the floor, and the fold is the net. It runs in a
 *    lane down the cast line and its front is locked to the same `sweep` the
 *    shafts are lit by, so the net and the band are the same event seen two
 *    ways rather than two effects that happen to be in the same place.
 *
 * Two draw calls for all of it: one instanced hull for every shaft in the rank,
 * one quad for the net. The only particle system is `godspear.ash` — grit
 * lifted off the stone by the band, tinted per batch by the CPU mirror
 * `LightShaft#irradianceAt()`, which is the same field the motes read on the
 * GPU and the reason ash that drifts up into a shaft brightens and ash that
 * misses it does not.
 *
 * Four beats. **Sweep**: a lit window `sweepWidth` wide runs from the caster's
 * feet to the far end at `speed`, dragging the caustic front with it.
 * **Flood**: on landing the window opens to the whole rank over `floodTime` of
 * the hold and the colonnade stands. **Retract**: over `fadeTime` the window
 * closes back down onto the impact point by `retract`, so the ability leaves the
 * way a light goes out rather than the way a dimmer is turned down. **Out.**
 *
 * **The rule that makes the editor work.** A cast captures one number — `_seed`,
 * so two casts do not scatter their shafts identically — plus the phase clock.
 * Not one metre. Pause with **P** mid-sweep and drag `shaftTilt`: the whole
 * colonnade lies over, the feet stay where they are, the band on the floor
 * stretches into an ellipse, the caustic net's refraction axis follows, and the
 * motes standing in the air re-light against the new geometry. Nothing was
 * cached, so nothing had to be told.
 */
export class GodspearAbility extends Ability {
  constructor(context) {
    super('godspear', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    // LINE, because the cast is a line and the rank *is* the line. `sweep` and
    // `sweepWidth` then give the travelling window for free — which is the
    // module's answer to "a shaft sweeping down the line", and a much better
    // one than moving a single shaft, because a moving shaft has no colonnade
    // behind it and the eye has nothing to measure the movement against.
    this.shafts = new LightShaft(this.group, {
      capacity: MAX_SHAFTS,
      layout: ShaftLayout.LINE,
      sides: 12,
      maxSteps: 48,
      renderOrder: 10,
      name: 'Godspear:Shafts'
    });

    // SCROLL rather than WAVE: there is no `LiquidSurface` here to bind to, and
    // the surface doing the folding is a canopy of stirring air rather than a
    // heightfield anybody can see. LANE because the cast is a line and the net
    // has to run down it with a front.
    this.net = new Caustics(this.group, {
      source: CausticSource.SCROLL,
      shape: CausticShape.LANE,
      additive: true,
      renderOrder: 7,
      name: 'Godspear:Net'
    });

    /** Re-rolled per cast, so two Godspears do not scatter identically. */
    this._seed = 0;
    /** Shafts actually drawn this frame; drives the HUD readout. */
    this._live = 0;
    /** Whether the room's dust cloud was found and patched. Guarded everywhere. */
    this._dust = false;

    // One shot at the cloud, at construction, which is inside `warm()` and
    // therefore off the frame that casts. If the scene has no dust — the check
    // harness's bare `Scene` — every dust path below no-ops and the rest of the
    // ability is unaffected.
    this._dust = dustCoupling.attach(this.ctx.scene);
  }

  createParticles() {
    // One system, and a small one. It is grit off the floor, not the shaft's
    // dust: the shaft's dust is the room's and is not a particle system at all.
    this.ash = this.ctx.particles.get('godspear.ash', {
      capacity: 700,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.5
    });
    this.ash.uniforms.uDrag.value = 1.5;
    this.ash.uniforms.uEndSize.value = 0.55;
    this.ash.uniforms.uSizeIn.value = 0.1;
    this.ash.uniforms.uFadeIn.value = 0.14;
    this.ash.uniforms.uFadeOut.value = 0.45;

    this.ashEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  /** Shafts drawn this frame. One draw call regardless of how many. */
  get instanceCount() {
    return this._live;
  }

  /** The colonnade stands after the sweep lands. */
  get impactDuration() {
    return Math.max(0.05, settings.godspear.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.godspear.fadeTime);
  }

  /**
   * A slow breath, not a flicker.
   *
   * Sunlight through a canopy does not gutter; it swells as the canopy moves.
   * The base class's default beats two sines at 9.3 and 3.7 Hz, which is a
   * glint and belongs to ice. One sine at `lightFlickerSpeed` — well under a
   * hertz — is a room brightening and dimming, and you notice it only when you
   * stop looking at it.
   */
  lightShimmer() {
    const c = settings.godspear;
    return 1 - c.lightFlicker * 0.5 * (1 - Math.cos(this.age * c.lightFlickerSpeed * Math.PI * 2));
  }

  /* ------------------------------------------------------------------ */
  /* The frame of the rank — every metre resolved from live settings      */
  /* ------------------------------------------------------------------ */

  /**
   * The shafts' own up-vector.
   *
   * `shaftTilt` mixes from world +Y toward `frame.uLightDir`, which points
   * **toward** the sun. The library's `setPlacement` takes `up` and derives
   * `axis = -up`, so handing it the direction of the sun makes the light travel
   * away from the sun and down onto the floor — the sign the module's own
   * example gets backwards, and worth checking rather than copying: negate it
   * and the mouths end up under the floor with the shafts pointing at the sky.
   */
  _shaftUp(out) {
    const c = settings.godspear;
    _sun.copy(frame.uLightDir.value);
    if (_sun.lengthSq() < 1e-8) _sun.set(0, 1, 0);
    _sun.normalize();
    out.set(0, 1, 0).lerp(_sun, saturate(c.shaftTilt));
    if (out.lengthSq() < 1e-8) out.set(0, 1, 0);
    return out.normalize();
  }

  /** Where along the line the lit window is, 0..1. The one beat everything reads. */
  _sweep() {
    return this.phase === AbilityPhase.TRAVEL ? saturate(this.u) : 1;
  }

  /**
   * Push the live block into both modules and into the room's dust.
   *
   * @param {number} fade  1 while the colonnade is lit, ramping to 0 on the way out
   * @param {number} width 0..1 of the rank lit at once
   */
  _sync(fade, width) {
    const c = settings.godspear;
    const g = settings.global;
    const sweep = this._sweep();

    /* ---- the rank ---- */
    this._shaftUp(_up);
    _axis.copy(_up).negate();
    // The rank is centred on the middle of the cast, so shaft 0 stands at the
    // caster's feet and the last one stands on the target.
    this.pointAt(0.5, _anchor);
    this.shafts.setPlacement(_anchor, this.direction, _up);

    const count = Math.max(1, Math.min(MAX_SHAFTS, Math.round(c.shaftCount)));
    _shaft.layout = ShaftLayout.LINE;
    _shaft.count = count;
    // Derived from the cast's own length rather than authored in metres, so a
    // short cast gets a short colonnade instead of a rank that overshoots it.
    // `shaftSpan` is the slider that decides how much of the line it covers.
    _shaft.spacing = (this.length * c.shaftSpan) / Math.max(1, count - 1);
    _shaft.ring = 0;
    _shaft.scatter = c.shaftScatter;
    _shaft.seed = this._seed;

    _shaft.length = c.shaftLength;
    _shaft.radiusMouth = c.shaftRadiusMouth;
    _shaft.radiusFoot = c.shaftRadiusFoot;
    _shaft.lengthJitter = c.shaftLengthJitter;
    _shaft.radiusJitter = c.shaftRadiusJitter;
    _shaft.hullPad = c.shaftPad;

    /* ---- the medium ---- */
    _shaft.steps = c.steps;
    _shaft.jitter = c.jitter;
    _shaft.density = c.density;
    _shaft.extinct = c.extinct;
    _shaft.soft = c.soft;
    _shaft.axialCurve = c.axialCurve;
    _shaft.axialMouth = c.axialMouth;
    _shaft.anisotropy = c.anisotropy;
    _shaft.contact = c.contact;

    _shaft.gobo = c.gobo;
    _shaft.goboScale = c.goboScale;
    _shaft.goboBias = c.goboBias;
    _shaft.goboDrift = c.goboDrift;

    // Zero by default, and the header says why: the library's hashed lattice is
    // the *second* dust system, and the room already has the first one.
    _shaft.mote = c.shaftMote;

    _shaft.bounce = c.bounce;
    _shaft.poolSoft = c.poolSoft;
    _shaft.landBand = c.landBand;

    _shaft.fade = fade;
    _shaft.sweep = sweep;
    _shaft.sweepWidth = width;
    _shaft.intensity = c.intensity;

    _shaft.colorMouth = c.colorMouth;
    _shaft.colorFoot = c.colorFoot;
    _shaft.colorMote = c.colorMote;
    _shaft.colorPool = c.colorPool;

    _shaft.noiseStrength = g.noiseStrength;
    _shaft.noiseFrequency = g.noiseFrequency;
    _shaft.noiseSpeed = g.noiseSpeed;
    _shaft.opacityScale = g.opacity;

    this.shafts.update(_shaft);
    this._live = this.shafts.instanceCount;

    this._syncNet(fade, sweep);
    this._syncDust(fade, width, count);
  }

  /**
   * The caustic net, and why its lane is twice as long as the cast.
   *
   * `Caustics(LANE)` puts its front at `front × length` metres from the *quad's
   * centre*, and sizes the quad from `length` plus the two spans. Anchoring the
   * quad on the cast's origin and passing the cast's own length therefore runs
   * the front off the far edge of its own canvas somewhere around the halfway
   * mark — which shows up as the net simply stopping, and took a confused ten
   * minutes to find because everything upstream was correct. Handing it twice
   * the cast length and half the sweep puts the front exactly on the shaft that
   * is lit, all the way to the end, and costs nothing but quad area that is
   * discarded by the lane mask on the first instruction of the fragment.
   */
  _syncNet(fade, sweep) {
    const c = settings.godspear;
    const g = settings.global;

    _net.centre = this.origin;
    _net.lightAxis = _axis;
    // The lane's local +Z is downrange. `atan2(x, z)` and not `atan2(z, x)`:
    // a yaw of zero already points at +Z.
    _net.yaw = Math.atan2(this.direction.x, this.direction.z);
    _net.height = c.netHeight;
    _net.radius = c.netWidth;
    _net.length = this.length * 2;
    _net.front = saturate(sweep * 0.5);
    _net.fade = fade;
    _net.now = this.age;
    _net.seed = this._seed;

    _net.depth = c.netDepth;
    _net.ior = c.netIor;
    _net.dispersion = c.netDispersion;
    _net.sampleStep = c.netStep;
    _net.absorb = c.netAbsorb;

    _net.foldFloor = c.netFoldFloor;
    _net.threshold = c.netThreshold;
    _net.gain = c.netGain;
    _net.sharpness = c.netSharp;
    _net.rolloff = c.netRolloff;

    _net.sourceAmp = c.netAmp;
    _net.cellScale = c.netCellScale;
    _net.cellRatio = c.netCellRatio;
    _net.cellJitter = c.netCellJitter;
    _net.driftAngle = c.netDriftAngle;
    _net.driftSpeed = c.netDriftSpeed;
    _net.boil = c.netBoil;
    _net.ridgeMix = c.netRidgeMix;
    _net.ridgeScale = c.netRidgeScale;
    _net.ridgePower = c.netRidgePower;

    _net.penumbra = c.netPenumbra;
    _net.laneWidth = c.netWidth;
    _net.laneFeather = c.netFeather;
    _net.spanBack = c.netBack;
    _net.spanFront = c.netAhead;

    _net.additive = true;
    _net.emissive = c.netEmissive * g.glow;
    _net.opacity = c.netOpacity;
    _net.wash = c.netWash;
    _net.fringeAt = c.netFringeAt;
    _net.depthFade = c.netDepthFade;
    _net.colorNet = c.colorNet;
    _net.colorFringe = c.colorFringe;
    _net.colorWash = c.colorWash;

    _net.noiseStrength = g.noiseStrength;
    _net.noiseFrequency = g.noiseFrequency;
    _net.noiseSpeed = g.noiseSpeed;
    _net.opacityScale = g.opacity;

    this.net.update(_net);
  }

  /**
   * Publish the rank to the room's dust.
   *
   * Every number here is read straight back out of the live settings block and
   * out of `LightShaft#footPoint()`, which reads the same uniforms the vertex
   * shader reads — so the motes light against the rank that is on screen and
   * not against a copy of it taken at spawn. The per-shaft `w` mirrors the
   * sweep window in `SHAFT_VERTEX` exactly, including the `smoothstep(0.6, 1.0)`
   * shoulder, because a mote that stays bright half a metre after its shaft has
   * gone dark is the tell that the two are not the same thing.
   */
  _syncDust(fade, width, count) {
    if (!this._dust) return;
    const c = settings.godspear;
    const u = dustCoupling.claim(this);
    const sweep = this._sweep();

    u.uShaftCount.value = count;
    u.uShaftAxis.value.copy(_axis);
    u.uShaftLength.value = Math.max(0.05, c.shaftLength);
    u.uShaftRMouth.value = Math.max(0.01, c.shaftRadiusMouth);
    u.uShaftRFoot.value = Math.max(0.01, c.shaftRadiusFoot);
    u.uShaftSoft.value = Math.max(0.02, c.soft);
    u.uShaftCurve.value = Math.max(0.001, c.axialCurve);
    u.uShaftMouthMin.value = saturate(c.axialMouth);
    u.uShaftExtinct.value = Math.max(0, c.extinct);
    u.uShaftSwell.value = Math.max(0, c.dustSwell);
    u.uShaftGain.value = Math.max(0, c.dustGain);
    u.uShaftTint.value = saturate(c.dustTint);
    u.uShaftColor.value.copy(getColor(c.colorDust));

    const feet = u.uShaftFeet.value;
    for (let i = 0; i < MAX_SHAFTS; i++) {
      const foot = feet[i];
      if (i >= count) {
        foot.w = 0;
        continue;
      }
      this.shafts.footPoint(i, _shaft, _pos);
      const slot = count > 1 ? i / (count - 1) : 0.5;
      let window = 1;
      if (width < 0.999) {
        const d = Math.abs(slot - sweep) / Math.max(width, 1e-3);
        // `smoothstep(0.6, 1.0, d)` — the same two numbers and the same curve
        // as `SHAFT_VERTEX`. Written with the shared helper rather than a
        // hand-rolled ease, because an ease that is nearly a smoothstep leaves
        // the motes lit a little longer than their shaft, and "a little" is
        // exactly the size of error that reads as the dust being a separate
        // effect that happens to be in the same place.
        window = 1 - smoothstep(0.6, 1.0, d);
      }
      foot.set(_pos.x, _pos.y, _pos.z, fade * window);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /** Where the band is standing on the floor this frame. */
  _bandPoint(out) {
    return this.pointAt(this._sweep(), out).setY(0);
  }

  /**
   * Ash off the stone under the band.
   *
   * The tint is the point of it. `irradianceAt()` is sampled at the height the
   * grit is born at, and the batch is tinted between `colorAshD` (unlit dust
   * off a dark floor) and `colorAshA` (dust standing in the beam) by what comes
   * back — so the ash the band throws forward into the next shaft brightens as
   * it crosses into it, and the ash behind the sweep does not. It is the CPU
   * mirror of exactly the field the motes are reading on the GPU, which is why
   * the two agree at the shaft's edge instead of nearly agreeing.
   */
  _ashFx(dt, scale) {
    const c = settings.godspear;
    const g = settings.global;
    const count = Math.round(this.ashEmitter.tick(dt, c.ashRate * scale) * g.particleCount);
    if (count <= 0) return;

    this._bandPoint(_pos);
    _pos.y = c.ashSize * 4;

    _probe.copy(_pos);
    _probe.y = Math.max(_probe.y, c.shaftRadiusFoot * 0.5);
    const lit = this.shafts.irradianceAt(_probe, _shaft);
    _tint.copy(getColor(c.colorAshD)).lerp(getColor(c.colorAshA), saturate(lit));

    _emit.position = _pos;
    _emit.radius = c.ashSpread;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.3).setY(1).normalize();
    _emit.speed = c.ashSpeed;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.95;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.1;
    _emit.sizeVariance = 0.7;
    _emit.life = c.ashLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = _tint;
    _emit.time = frame.uTime.value;
    this.ash.emit(count, _emit);
  }

  /** The ash system's own uniforms — metres per second live here, not on emit. */
  _syncAsh() {
    const c = settings.godspear;
    const g = settings.global;
    this.ash.setGradient(
      getColor(c.colorAshA),
      getColor(c.colorAshB),
      getColor(c.colorAshC),
      getColor(c.colorAshD)
    );
    this.ash.uniforms.uGravity.value.set(0, c.ashRise, 0);
    this.ash.uniforms.uSizeScale.value = c.ashSize * g.particleSize * 7;
    this.ash.uniforms.uLifeScale.value = c.ashLifetime * 0.5 * g.particleLifetime;
    this.ash.uniforms.uSpeedScale.value = g.particleSpeed;
    this.ash.uniforms.uOpacity.value = g.opacity;
    this.ash.uniforms.uGlow.value = c.intensity * 0.8 * g.glow;
    this.ash.uniforms.uTurbulence.value = c.ashTurbulence * g.turbulence;
  }

  /** The light rides the band, lifted off the floor so it is not clipped by it. */
  _placeLight() {
    this._bandPoint(this.position);
    this.position.y = settings.godspear.lightHeight;
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    const c = settings.godspear;
    const g = settings.global;

    this.ashEmitter.reset();
    this._seed = Math.random() * 100;

    // `reset()` is the pooling contract: it zeroes the instance count and hides
    // the mesh, so the roll goes after it and the first `update()` turns it back
    // on. Rolling here and nowhere else is the whole of what a cast captures.
    this.shafts.reset();
    this.shafts.roll(this._seed);
    this.net.reset();
    this.net.setVisible(true);

    this._sync(1, c.sweepWidth);
    this._syncAsh();

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this._placeLight();
  }

  onTravel(dt) {
    const c = settings.godspear;
    this._sync(1, c.sweepWidth);
    this._syncAsh();
    this._ashFx(dt, 1);
    this._placeLight();
    this.ctx.shake.rumble(c.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.godspear;
    const g = settings.global;

    this.pointAt(1, _pos);
    _pos.y = c.shaftRadiusFoot;

    // A flare of air where the spear plants, and nothing else. No shockwave
    // decal, no scorch, no debris: the band on the floor is already there and
    // it was produced by the light, which is the point of the school. Stamping
    // a `DecalType.SHOCKWAVE` on top would be admitting the band is not enough.
    this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
      radius: c.burstSize * 0.25,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.55,
      intensity: c.burstIntensity,
      opacity: 0.8,
      fresnel: 2.1,
      displace: 0.3,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      22
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.6 * g.explosionIntensity;
  }

  /**
   * @param {number} dt seconds
   * @param {number} t  0..1 through the flood-and-hold, then 1..2 through the retract
   */
  onFade(dt, t) {
    const c = settings.godspear;
    const held = t <= 1;

    let width;
    let fade;
    if (held) {
      // The window opens from the travelling slit to the whole rank over the
      // first `floodTime` of the hold. Opening it instantly on the impact frame
      // was the first version and it reads as a cut, not as a landing.
      const open = Easing.outCubic(saturate(t / Math.max(0.01, c.floodTime)));
      width = lerp(c.sweepWidth, 1, open);
      fade = 1;
    } else {
      // ...and closes again by `retract`, so the colonnade withdraws into the
      // point it landed on. A rank that just dims looks switched off; a rank
      // that narrows looks like it is leaving.
      const gone = saturate(t - 1);
      width = lerp(1, lerp(1, c.sweepWidth, saturate(c.retract)), Easing.inOutQuad(gone));
      fade = 1 - Easing.inCubic(gone);
    }

    this._sync(fade, width);
    this._syncAsh();
    this._ashFx(dt, fade * (held ? 0.7 : 0.3));
    this._placeLight();
  }

  onDestroy() {
    this._live = 0;
    this.shafts.reset();
    this.net.clearRipples();
    this.net.setVisible(false);
    // Give the room's dust back. Only if we are still the one driving it: a
    // second Godspear thrown over this one has already taken the field, and
    // switching it off here would darken a cast that is still standing.
    dustCoupling.release(this);
  }

  dispose() {
    this.shafts.dispose();
    this.net.dispose();
    super.dispose();
  }
}
