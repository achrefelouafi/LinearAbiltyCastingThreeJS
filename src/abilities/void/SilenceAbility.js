import { Color, Mesh, ShaderMaterial, Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { Hook, sceneHooks } from '../../vfx/SceneHooks.js';
import { uprightQuad } from '../../vfx/quads.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { frame, sharedUniforms } from '../../core/FrameUniforms.js';
import { LAYER } from '../../core/Layers.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, lerp, Easing } from '../../utils/math.js';

const TAU = Math.PI * 2;

/* Module-scope scratch. Nothing in the frame path allocates — invariant I3. */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _hub = new Vector3();

/* ---------------------------------------------------------------------- */
/* The rim                                                                 */
/* ---------------------------------------------------------------------- */
/**
 * One billboarded annulus, and it is the entire visible half of this ability.
 *
 * ## Why a billboard and not a ring on the floor
 *
 * The hole is a *sphere*, so its boundary is a screen-space circle at the
 * sphere's silhouette — not a circle on the ground. A ground ring only agrees
 * with the void where the two happen to meet and disagrees with it everywhere
 * else, which reads as a decal lying near a hole rather than as the edge of
 * one. A quad turned to face the camera in the vertex shader, centred on the
 * anchor and scaled to the radius, *is* that silhouette, to within the
 * perspective term — hence `rimSwell`, which nudges the ring a per cent or two
 * outward so the band centre never lands exactly on the proxy's own depth.
 *
 * ## The half of the ring you never see, and why that is the good part
 *
 * `depthTest` is **on**. The band is drawn at the depth of the hole's centre,
 * so every fragment of it that falls inside the silhouette is behind the depth
 * proxy's front surface and is discarded by the same test that erased the
 * world there. The rim erases its own inner half. Nothing in this file asks for
 * that and there is no code for it: it is the one mechanism, applied twice.
 *
 * ## Why it is nearly black
 *
 * The hole is punched in the *scene* pass, so `UnrealBloomPass` runs after it
 * and anything bright beside the void bleeds across the rim — `SceneHooks`
 * states that caveat plainly and it is not fixable from here. So the rim is a
 * dark band with one lit term (`lipGain`) on its outer edge, rolled off by a
 * Reinhard curve that asymptotes at `lipCeiling` and therefore provably cannot
 * reach `post.bloomThreshold`. The first version had a hot cyan rim; it looked
 * superb standing still and put a glowing halo *over* the absence the instant
 * anybody raised the bloom, which is the one failure this ability cannot
 * survive.
 *
 * ## The `atan` in here is not the trap
 *
 * The README's warning is about sampling a *field* on `atan(y, x)`: every
 * radius along a bearing gets the same value and you draw spokes. This samples
 * the bearing to modulate the ring's **radius**, which is the one thing an
 * angular coordinate is actually for — it makes the circle breathe instead of
 * sitting there like a UI element.
 */
function createRimMaterial() {
  const uniforms = sharedUniforms({
    uAnchor: { value: new Vector3() },
    /** Metres — half the billboard's width. Re-resolved every frame. */
    uExtent: { value: 1 },
    /** The hole's own vertical squash, applied to the offset in world Y. */
    uSquash: { value: 1 },
    /** Ring radius as a fraction of the half-extent. */
    uRingAt: { value: 0.77 },
    /** Band half-width and wander, as fractions of the half-extent. */
    uRimWidth: { value: 0.07 },
    uWaver: { value: 0.03 },
    uWaverSpeed: { value: 0.5 },
    /** Per-cast phase offset, so two concurrent voids do not breathe in step. */
    uSeed: { value: 0 },
    uRimOpacity: { value: 0.9 },
    uInnerBias: { value: 0.6 },
    uLipGain: { value: 0.5 },
    uLipCeiling: { value: 0.6 },
    uFade: { value: 0 },
    uColorRim: { value: new Color() },
    uColorLip: { value: new Color() }
  });

  const material = new ShaderMaterial({
    name: 'SilenceRim',
    transparent: true,
    // Normal blending, never additive: see the doc comment. An additive rim on
    // a hole punched before the bloom pass is the one way to break this.
    depthWrite: false,
    depthTest: true,
    toneMapped: true,
    uniforms,
    vertexShader: /* glsl */ `
      uniform vec3  uAnchor;
      uniform float uExtent;
      uniform float uSquash;
      varying vec2  vRimUv;

      void main() {
        // Camera right and up, straight off the view matrix — no camera object
        // is needed on the CPU and the quad never has a matrix to update.
        vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 up    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);

        vec2 q = position.xy;          // the shared upright quad, -0.5 .. 0.5
        vRimUv = q * 2.0;              // -1 .. 1, so length() is the radius

        vec3 offset = (right * q.x + up * q.y) * (uExtent * 2.0);
        // The hole is squashed in WORLD y, so the ring is too. Squashing the
        // billboard's own up-vector instead only agreed with the void when the
        // camera happened to be level.
        offset.y *= uSquash;
        gl_Position = projectionMatrix * viewMatrix * vec4(uAnchor + offset, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uRingAt;
      uniform float uRimWidth;
      uniform float uWaver;
      uniform float uWaverSpeed;
      uniform float uSeed;
      uniform float uRimOpacity;
      uniform float uInnerBias;
      uniform float uLipGain;
      uniform float uLipCeiling;
      uniform float uFade;
      uniform vec3  uColorRim;
      uniform vec3  uColorLip;
      varying vec2  vRimUv;

      void main() {
        if (uFade <= 0.001) discard;

        float r = length(vRimUv);
        float bearing = atan(vRimUv.y, vRimUv.x);

        // Two incommensurate harmonics on the RADIUS. One alone reads as an
        // ellipse; three or more reads as a wobbling blob and the boundary
        // stops being a boundary.
        float wander = (sin(bearing * 3.0 + uSeed + uTime * uWaverSpeed) * 0.6 +
                        sin(bearing * 5.0 - uSeed - uTime * uWaverSpeed * 0.7) * 0.4) * uWaver;
        float ring = uRingAt + wander;

        float w = max(uRimWidth, 1e-4);
        float signed = r - ring;
        float band = 1.0 - smoothstep(0.0, w, abs(signed));
        if (band <= 0.002) discard;

        // The one lit term, and only on the OUTSIDE half. Light on the inside
        // half would be light inside the absence, which is the whole mistake.
        float lip = band * smoothstep(0.0, w * 0.9, signed) * uLipGain;
        lip = lip / (1.0 + lip / max(uLipCeiling, 1e-3));

        // The inside half is denser instead. A boundary should shade toward
        // what it is bounding.
        float inner = 1.0 - smoothstep(-w, 0.0, signed);

        vec3 colour = uColorRim + uColorLip * lip;
        float alpha = band * uRimOpacity * uFade * (1.0 + uInnerBias * inner);
        gl_FragColor = vec4(colour, clamp(alpha, 0.0, 1.0));
      }
    `
  });

  material.userData.uniforms = uniforms;
  return material;
}

/* ---------------------------------------------------------------------- */
/* The ability                                                             */
/* ---------------------------------------------------------------------- */

/**
 * SILENCE — a sphere of the world stops being rendered.
 *
 * One beat. A front runs to the circle, the void snaps open over `openTime`,
 * stands for `holdTime`, and closes.
 *
 * **THE TRICK — a hole in the frame, and it is achieved by drawing less than
 * anything else in the sandbox.** This ability borrows `Hook.HOLE` from
 * `vfx/SceneHooks.js` and writes a centre, a radius and a squash into it every
 * frame. That is the whole of it. The hook parks one invisible sphere with
 * `colorWrite` off at `renderOrder: -1000` on `LAYER.WORLD`, so it lands in the
 * depth buffer — and in the depth *prepass* — before any opaque in the frame
 * has shaded a pixel. Everything further away than its front surface fails the
 * depth test and is never shaded at all. What is left in those pixels is the
 * clear colour: the same flat void the floor already fades into at the edges of
 * the stage.
 *
 * The distinction the roster line insists on is real and it is worth being
 * precise about. A black disc drawn in front of the world is a *thing*: it has
 * an order, it can be behind the character, it can be bloomed, it can be
 * fogged. This is not a thing. The character walking between the camera and the
 * zone is nearer than the proxy, passes the test, and is drawn over the void
 * with correct occlusion; walk them behind it and they are gone mid-stride. A
 * `ShatterField` shard flying through the volume disappears while it is inside
 * and is back the instant it clears the front surface. **Nothing in the project
 * had to be told the hole exists**, and no shader in this file knows about it
 * either.
 *
 * **Two consequences the ability is built to show off.** The dust falls inward
 * and is erased at the boundary with no code asking it to — particles depth
 * test, and the proxy is in the prepass, so each mote also *soft-fades* into
 * the surface rather than clipping at it. And the rim erases its own inner
 * half, because the annulus is drawn at the anchor's depth and half of it is
 * inside the silhouette. Both of those are the same one mechanism showing up
 * twice, which is why the ability needs so little of its own.
 *
 * **What is deliberately absent.** No shell, no volume, no ground mark, no
 * distortion, no additive anything, and a dynamic light turned nearly off. The
 * brief for this slot was to keep the rim minimal and it is one draw call of
 * nearly-black annulus; the hook's depth proxy costs two more (the prepass and
 * the main pass, both counted). Four with the dust system. Adding a glow at the
 * boundary is the one change that would break it — see `createRimMaterial`.
 *
 * **The rule that makes the editor work.** Nothing is captured but `_seed` and
 * the phase machine's timestamps. `SceneHooks` holds no dimension across a
 * frame boundary by design — every value in the hook arrives through a token
 * setter this class calls each frame from `settings.silence` — so pausing with
 * **P** and dragging `zoneRadius` re-sizes a standing void, and dragging
 * `holeLift` slides the bite it has taken out of the floor.
 *
 * **The borrow.** `this.borrow(sceneHooks.acquire(Hook.HOLE, this))`, and
 * `sceneHooks.reclaim(this)` in `onDestroy`. Both, belt and braces: a leaked
 * `HOLE` leaves a sphere of the world unrendered for the rest of the session
 * and there is no way for a player to work out why.
 */
export class SilenceAbility extends Ability {
  constructor(context) {
    super('silence', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    this.rimMaterial = createRimMaterial();
    // The shared upright quad — 1 × 1 in XY. It is not ours and is never
    // disposed; the vertex shader does all the placement, so the mesh keeps an
    // identity matrix for its whole life and there is nothing to update.
    this.rim = new Mesh(uprightQuad(), this.rimMaterial);
    this.rim.name = 'SilenceRim';
    this.rim.frustumCulled = false;
    this.rim.matrixAutoUpdate = false;
    this.rim.layers.set(LAYER.VFX);
    this.rim.renderOrder = 14;
    this.rim.visible = false;
    this.group.add(this.rim);

    /** The borrowed hook, or null between casts. */
    this.hole = null;
    /** A dice roll, so two casts do not spawn their dust identically. */
    this._seed = 0;
  }

  createParticles() {
    // One system, and it is here to *demonstrate* the hole rather than to
    // decorate it: these motes are erased at the boundary by the depth test,
    // which is the trick made visible on something small and moving.
    this.dust = this.ctx.particles.get('silence.dust', {
      capacity: 1200,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.5
    });
    this.dust.uniforms.uDrag.value = 0.6;
    this.dust.uniforms.uEndSize.value = 0.3;
    this.dust.uniforms.uSizeIn.value = 0.08;
    this.dust.uniforms.uFadeIn.value = 0.12;
    this.dust.uniforms.uFadeOut.value = 0.45;

    this.dustEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    // One annulus, plus the hook's depth proxy while it is held. The proxy is
    // not in this ability's group and never will be — it belongs to the world.
    return (this.rim.visible ? 1 : 0) + (this.hole ? 1 : 0);
  }

  /** It opens, then it stands open. */
  get impactDuration() {
    const c = settings.silence;
    return Math.max(0.1, (c.openTime + c.holdTime) * settings.global.lifetime);
  }

  /** Then it closes, and the rim lets go. */
  get fadeDuration() {
    const c = settings.silence;
    return Math.max(0.1, c.closeTime + c.settleTime);
  }

  /** An absence does not flicker. */
  lightShimmer() {
    return 1;
  }

  /** Centre of the footprint: the far end of the aimed line. */
  _hubPoint(out) {
    return this.pointAt(1, out).setY(settings.silence.holeLift);
  }

  /* ------------------------------------------------------------------ */
  /* The beats — unitless, resolved against live durations                */
  /* ------------------------------------------------------------------ */

  /**
   * The hole's radius in metres, right now.
   *
   * A pure function of the phase clocks against the *live* times and
   * `zoneRadius`, so all four of `openTime`, `holdTime`, `closeTime` and the
   * radius itself can be dragged on a void that is already standing.
   *
   * The bounce is a half-sine added on top of an `outCubic`, not an `outBack`:
   * `outBack` undershoots on the way in, and a hole that starts by getting
   * *smaller than nothing* is a hole that pops.
   */
  _radius() {
    const c = settings.silence;
    const full = Math.max(0.01, c.zoneRadius);

    if (this.phase === AbilityPhase.TRAVEL) return 0;

    if (this.phase === AbilityPhase.FADE) {
      const k = saturate(this.fadeTime / Math.max(0.02, c.closeTime));
      return full * (1 - Easing.inCubic(k));
    }

    const k = saturate(this.impactTime / Math.max(0.02, c.openTime));
    return full * Easing.outCubic(k) * (1 + c.openBounce * Math.sin(Math.PI * k));
  }

  /** 0..1 on the rim's own opacity. It arrives before the hole and outlives it. */
  _rimFade() {
    const c = settings.silence;
    if (this.phase === AbilityPhase.TRAVEL) return c.rimTravel * saturate(this.u);
    if (this.phase !== AbilityPhase.FADE) return 1;
    return 1 - saturate((this.fadeTime - c.closeTime) / Math.max(0.02, c.settleTime));
  }

  /**
   * Ring radius in metres.
   *
   * While the front is still travelling there is no hole to bound, so the ring
   * stands at `gatherRadius` of the footprint and closes onto it — the one
   * piece of anticipation the ability allows itself, and the reason the void
   * does not simply appear out of an empty floor.
   */
  _ringRadius() {
    const c = settings.silence;
    if (this.phase === AbilityPhase.TRAVEL) {
      const full = Math.max(0.01, c.zoneRadius);
      return full * lerp(c.gatherRadius, c.rimSwell, Easing.outQuad(saturate(this.u)));
    }
    return Math.max(0.01, this._radius() * c.rimSwell);
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Write the hook and the rim from live settings.
   *
   * Every setter on the token also renews its lease, so there is no separate
   * `hold()` to remember: a frame that writes is a frame that keeps the hook.
   */
  _sync() {
    const c = settings.silence;
    const g = settings.global;

    this._hubPoint(_hub);
    const radius = this._radius();

    // I6 in spirit: `acquire()` on a real hook never returns null, but a typo'd
    // hook id does, and an ability that assumes otherwise takes the frame loop
    // down with it.
    if (this.hole) {
      this.hole
        .atPoint(_hub)
        .size(radius, c.holeSquash)
        .blend(saturate(c.holeWeight));
    }

    /* --- the rim --- */
    const u = this.rimMaterial.uniforms;
    const ring = this._ringRadius();
    const extent = Math.max(0.02, ring * Math.max(1.02, c.rimPad));
    const fade = this._rimFade();

    u.uAnchor.value.copy(_hub);
    u.uExtent.value = extent;
    u.uSquash.value = c.holeSquash;
    // The ring, the band and the wander are all authored in metres and divided
    // by the extent here, so a rim stays 9 cm wide whatever the hole is doing.
    u.uRingAt.value = ring / extent;
    u.uRimWidth.value = c.rimWidth / extent;
    u.uWaver.value = c.rimWaver / extent;
    u.uWaverSpeed.value = c.rimWaverSpeed * g.noiseSpeed;
    u.uSeed.value = this._seed;
    u.uRimOpacity.value = c.rimOpacity * g.opacity;
    u.uInnerBias.value = c.rimInnerBias;
    u.uLipGain.value = c.lipGain * g.glow;
    u.uLipCeiling.value = c.lipCeiling;
    u.uFade.value = fade;
    u.uColorRim.value.copy(getColor(c.colorRim));
    u.uColorLip.value.copy(getColor(c.colorLip));

    this.rim.visible = fade > 0.001;

    /* --- the dust --- */
    this.dust.setGradient(
      getColor(c.colorDustA),
      getColor(c.colorDustB),
      getColor(c.colorDustC),
      getColor(c.colorDustD)
    );
    this.dust.uniforms.uGravity.value.set(0, c.dustRise, 0);
    this.dust.uniforms.uSizeScale.value = c.dustSize * g.particleSize * 7;
    this.dust.uniforms.uLifeScale.value = c.dustLifetime * 0.5 * g.particleLifetime;
    this.dust.uniforms.uSpeedScale.value = g.particleSpeed;
    this.dust.uniforms.uOpacity.value = c.dustOpacity * g.opacity;
    this.dust.uniforms.uTurbulence.value = c.dustTurbulence * g.turbulence;
  }

  /**
   * Motes released on a shell around the void, travelling inward.
   *
   * The bearing is the only random number here and the metres are all live: the
   * shell sits at `dustSpawn` × the *current* radius, so while the hole is
   * opening the dust is released further out every frame and the whole fall
   * widens with it.
   */
  _dustFx(dt, scale) {
    const c = settings.silence;
    const g = settings.global;
    const count = Math.round(this.dustEmitter.tick(dt, c.dustRate * scale) * g.particleCount);
    if (count <= 0) return;

    const radius = Math.max(0.05, this._radius() || c.zoneRadius * 0.6);
    const bearing = Math.random() * TAU;
    const shell = radius * Math.max(1.05, c.dustSpawn);

    this._hubPoint(_hub);
    _dir.set(Math.cos(bearing), 0, Math.sin(bearing));
    _pos.copy(_hub).addScaledVector(_dir, shell);
    // Released across the height of the void rather than on a flat ring: a ring
    // of dust round a sphere reads as a planet with an accretion disc, which is
    // the wrong ability entirely.
    _pos.y = _hub.y + (Math.random() - 0.5) * radius * 1.4;

    _emit.position = _pos;
    _emit.radius = radius * 0.25;
    // Inward. The hole eats them; nothing tells them to stop.
    _emit.direction = _dir.multiplyScalar(-1);
    _emit.speed = c.dustSpeed;
    _emit.speedVariance = 0.5;
    _emit.spread = 0.35;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = c.dustSize;
    _emit.sizeVariance = 0.6;
    _emit.life = c.dustLifetime;
    _emit.lifeVariance = 0.45;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.dust.emit(count, _emit);
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.dustEmitter.reset();
    this._seed = Math.random() * 100;

    // Borrowed, not taken. `Ability#destroy()` returns it however the cast ends
    // — including the player pressing C mid-cast and a fifth cast pushing this
    // one off the concurrency cap, which are the two paths that used to leave
    // the world broken until reload.
    this.hole = this.borrow(sceneHooks.acquire(Hook.HOLE, this));

    this._sync();
  }

  onTravel(dt) {
    // The hole has no radius yet and the rim is barely there. Syncing anyway is
    // not waste: it keeps every value resolved from live settings on every
    // frame, paused ones included, and it renews the hook's lease.
    this._sync();
    this.pointAt(this.u, this.position);
    this.position.y = settings.silence.holeLift * 0.5;

    this.ctx.shake.rumble(settings.silence.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.silence;
    const g = settings.global;

    // A *negative* flash: `GradeShader` mixes the frame toward this colour, so a
    // near-black one dims the screen instead of blowing it out. It is the only
    // punctuation this ability gets, and the Nightfall precedent for it.
    this.ctx.flash.trigger(getColor(c.colorDim), c.castDim * g.explosionIntensity);

    this.ctx.shake.add(
      c.openShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      11
    );
  }

  /**
   * Both the open hold and the close run through here — the base class calls it
   * for `IMPACT` (`t` 0..1) and `FADE` (`t` 1..2). Nothing reads `t`: every beat
   * is a function of `impactTime` / `fadeTime` against the live durations, which
   * is what lets all four of them be dragged mid-cast.
   */
  onFade(dt, _t) {
    this._sync();

    this._hubPoint(this.position);
    // The dust falls hardest while the void is at its widest and stops the
    // moment there is nothing left to fall into.
    const open = saturate(this._radius() / Math.max(0.01, settings.silence.zoneRadius));
    this._dustFx(dt, open);
  }

  onDestroy() {
    // Belt and braces. `destroy()` already releases everything `borrow()` was
    // handed; this is the line the README asks for and it is idempotent.
    sceneHooks.reclaim(this);
    this.hole = null;
    this.rim.visible = false;
    this.rimMaterial.uniforms.uFade.value = 0;
  }

  dispose() {
    // `uprightQuad()` is module-lifetime and shared — never disposed here.
    this.rimMaterial.dispose();
    super.dispose();
  }
}
