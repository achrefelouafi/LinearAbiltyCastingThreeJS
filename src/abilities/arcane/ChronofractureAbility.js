import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  NormalBlending,
  Object3D,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  Vector3
} from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import { ShatterField, ShatterLayout, shatterParams } from '../../vfx/ShatterField.js';
import { GroundField, GroundMode, groundFieldParams } from '../../vfx/GroundField.js';
import { DistortionField, DistortionMode } from '../../vfx/Distortion.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame, sharedUniforms } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, clamp, lerp, hash11 } from '../../utils/math.js';
import { noiseGLSL } from '../../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../../shaders/lib/common.glsl.js';

/**
 * Hard ceiling on panes. Twenty-eight is where the circle stops reading as
 * "several sheets hanging in the air" and starts reading as a hedge; the
 * editor's `paneCount` clamps here.
 */
const MAX_PANES = 28;
/** Fragment shapes in the break. Two InstancedMeshes, so two draw calls. */
const SHARD_VARIANTS = 2;
/** Ring-allocated fragment slots. `paneCount × shardsPerPane` clamps into this. */
const SHARD_CAPACITY = 224;
const TAU = Math.PI * 2;

/* --- module-scope scratch: nothing in an update path allocates (I3) --- */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _centre = new Vector3();
/** Held by `_shatter.origin` across the frame, so nothing else may borrow it. */
const _shatterOrigin = new Vector3();
const _normal = new Vector3();
const _right = new Vector3();
const _lift = new Vector3();
const _corner = new Vector3();
const _up = new Vector3(0, 1, 0);
const _dummy = new Object3D();
const _tilt = new Quaternion();
const _basis = new Matrix4();
const _shatter = shatterParams();
const _ground = groundFieldParams();
const _refract = {};
const _look = {
  colorA: new Color(),
  colorB: new Color(),
  colorEdge: new Color(),
  colorScene: new Color(),
  opacity: 1,
  glow: 1,
  rim: 1,
  rimPower: 2,
  shade: 1,
  ambient: 0.4,
  fadeStart: 0.6,
  soft: 0.2,
  sceneMix: 0.7,
  refract: 0.05,
  saturation: 0.25
};

/* ---------------------------------------------------------------------- */
/* The pane                                                                */
/* ---------------------------------------------------------------------- */

/**
 * One sheet of stopped time.
 *
 * The whole pane is measured in **metres from its own centre**, which is the
 * same decision `GroundField` makes and for the same reason: a pane twice as
 * wide should carry twice as much frost, not the same frost at twice the size.
 * The metres are read back out of the instance matrix's columns, so there is no
 * second attribute to keep in step with the transform.
 */
const PANE_VERTEX = /* glsl */ `
  attribute float aSeed;
  attribute float aOpen;

  varying float vSeed;
  varying float vOpen;
  varying vec2  vLocal;
  varying vec2  vHalf;
  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying float vViewZ;

  void main() {
    vSeed = aSeed;
    vOpen = aOpen;

    mat4 im = mat4(1.0);
    #ifdef USE_INSTANCING
      im = instanceMatrix;
    #endif

    // The pane's size lives in the instance matrix and nowhere else, so its
    // column lengths are where the metres are. Recovering them here is what
    // lets every measurement below be a real centimetre count.
    vHalf = vec2(length(im[0].xyz), length(im[1].xyz)) * 0.5;
    vLocal = position.xy * vHalf * 2.0;

    vec4 world = modelMatrix * im * vec4(position, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * mat3(im) * normal);
    vViewDir = cameraPosition - world.xyz;

    vec4 mv = viewMatrix * world;
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const PANE_FRAGMENT = /* glsl */ `
  uniform vec3  uColorGlass;
  uniform vec3  uColorGhost;
  uniform vec3  uColorRim;
  uniform vec3  uColorSeam;
  uniform vec3  uColorCrack;

  uniform float uOpacity;
  uniform float uGlow;
  uniform float uFrost;
  uniform float uFrostScale;
  uniform float uGrain;
  uniform float uFringe;
  uniform float uFringeOffset;
  uniform float uRim;
  uniform float uRimPower;
  uniform float uBorder;
  uniform float uStill;
  uniform float uStillSpeed;
  uniform float uSoft;
  uniform float uSeamWidth;
  uniform float uSeamGlow;
  uniform float uCrack;
  uniform float uCrackArms;
  uniform float uCrackRings;
  uniform float uCrackWidth;
  uniform float uCrackGlow;
  uniform float uFade;

  uniform float     uTime;
  uniform vec2      uResolution;
  uniform sampler2D uSceneDepth;
  uniform float     uCameraNear;
  uniform float     uCameraFar;
  uniform float     uGlobalGlow;
  uniform float     uShaderIntensity;

  varying float vSeed;
  varying float vOpen;
  varying vec2  vLocal;
  varying vec2  vHalf;
  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    /* ---- the slit: a pane opens outward from its own centre line ---- */
    float openX = vOpen * vHalf.x;
    float dx = abs(vLocal.x);
    if (dx > openX) discard;

    // The hot edge of the opening has to die as vOpen reaches 1, or every pane
    // keeps a bright vertical bar down each side for the whole hold. The first
    // version did not, and twenty of them read as a rack of fluorescent tubes.
    float seam = smoothstep(max(uSeamWidth, 1e-4), 0.0, openX - dx)
               * (1.0 - smoothstep(0.985, 1.0, vOpen));

    /* ---- the frozen image ---------------------------------------- */
    // There is no scene colour buffer in this build (frame.uSceneColor does not
    // exist yet), so there is nothing behind the pane to resample and age. What
    // gets aged instead is the pane's own grain: one fbm field in the pane's
    // metres, with the red and blue taps pulled uFringeOffset metres apart.
    //
    // That is deliberately the *shape* of the three-tap scene sample this
    // becomes the day somebody adds a colour copy to FrameUniforms — swap the
    // fbm for a texture2D and the look is already authored. Written as a flat
    // tint instead, it would have had to be thrown away.
    //
    // What is faked here and honestly cannot be: the blur. A blur needs
    // neighbours, neighbours need a texture, and a fake blur with no texture is
    // a wash of flat colour that reads as exactly that. The desaturation is
    // real, though — the cold wash is alpha-blended over the frame, so it drags
    // whatever is behind the pane toward uColorGlass, which is what "colder"
    // means when you cannot touch the pixels.
    float drift = uTime * uStillSpeed * uStill;
    vec3 np = vec3(vLocal * uFrostScale, vSeed + drift);
    vec3 tap = vec3(uFringeOffset * uFrostScale, 0.0, 0.0);
    float g0 = fbm3(np);
    float gr = fbm3(np + tap);
    float gb = fbm3(np - tap);
    vec3 ghost = mix(vec3(g0), vec3(gr, g0, gb), clamp(uFringe, 0.0, 2.0)) * 0.5 + 0.5;

    float dust = snoise(vec3(vLocal * uFrostScale * 9.0, vSeed * 3.1)) * 0.5 + 0.5;
    ghost *= mix(1.0, dust, clamp(uGrain, 0.0, 1.0));

    /* ---- the perimeter hairline ---------------------------------- */
    float border = smoothstep(max(uBorder, 1e-4), 0.0, min(vHalf.x - dx, vHalf.y - abs(vLocal.y)));

    /* ---- the fractures ------------------------------------------- */
    // Glass does not craze on a lattice, it fails from one stress point:
    // radial arms out of it, and a ring or two around it. This is the single
    // deliberately angular sample in the file. The house warning about
    // atan(y, x) handing every radius along a bearing the same value and
    // drawing dead-straight spokes is, here, a description of the thing we
    // want — a fracture star genuinely is spokes.
    vec2 stress = (hash21(vSeed * 17.3) - 0.5) * vHalf * 1.2;
    vec2 rel = vLocal - stress;
    float rd = length(rel);
    float arms = max(uCrackArms, 1.0);
    float spoke = abs(fract(atan(rel.y, rel.x) / 6.283185 * arms + hash11(vSeed * 5.7)) - 0.5)
                * 6.283185 / arms * rd;
    float ring = abs(fract(rd * uCrackRings + hash11(vSeed * 9.1)) - 0.5) / max(uCrackRings, 1e-3);
    float crack = smoothstep(max(uCrackWidth, 1e-4), 0.0, min(spoke, ring))
                * clamp(uCrack, 0.0, 1.0)
                * smoothstep(0.0, max(vHalf.x * 0.15, 1e-3), rd);

    /* ---- assemble ------------------------------------------------- */
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(vViewDir);
    float fres = pow(1.0 - clamp(abs(dot(N, V)), 0.0, 1.0), uRimPower);

    // The wash is *not* scaled by the glow: it is the thing that makes the
    // scene behind colder, and a cold wash that blooms is a lamp.
    vec3 emit = uColorGhost * ghost * clamp(uFrost, 0.0, 2.0)
              + uColorRim * fres * uRim
              + uColorSeam * (seam * uSeamGlow + border)
              + uColorCrack * crack * uCrackGlow;
    vec3 color = uColorGlass + emit * uGlow * uGlobalGlow * mix(0.75, 1.0, uShaderIntensity);

    float alpha = uOpacity
                + ghost.g * clamp(uFrost, 0.0, 2.0) * 0.16
                + seam * 0.9
                + border * 0.7
                + crack * 0.8;
    alpha = clamp(alpha, 0.0, 1.0) * uFade;

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoft);

    if (alpha < 0.004) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * One fragment shape, in unit space, for the break.
 *
 * Flat polygons rather than solids, because a pane breaks into flakes and a
 * chunky shard reads as rock. Deterministic — the vertices come off `hash11`,
 * not `Math.random`, so two runs of the harness build the identical buffer and
 * a diff in the geometry checksum means something actually changed.
 */
function createShardGeometry(variant) {
  const sides = 3 + variant; // a sliver, then a chip
  const positions = new Float32Array(sides * 3);
  const normals = new Float32Array(sides * 3);
  const indices = new Uint16Array((sides - 2) * 3);

  for (let i = 0; i < sides; i++) {
    const angle = (i / sides) * TAU + variant * 0.73;
    const radius = 0.34 + 0.66 * hash11(i * 3.71 + variant * 11.13);
    positions[i * 3 + 0] = Math.cos(angle) * radius;
    positions[i * 3 + 1] = Math.sin(angle) * radius;
    positions[i * 3 + 2] = (hash11(i * 7.19 + variant * 5.31) - 0.5) * 0.12;
    normals[i * 3 + 2] = 1;
  }
  for (let i = 1; i < sides - 1; i++) {
    indices[(i - 1) * 3 + 0] = 0;
    indices[(i - 1) * 3 + 1] = i;
    indices[(i - 1) * 3 + 2] = i + 1;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  return geometry;
}

/* ---------------------------------------------------------------------- */
/* The ability                                                             */
/* ---------------------------------------------------------------------- */

/**
 * CHRONOFRACTURE — panes of frozen time hung over the circle.
 *
 * **The trick is stillness.** Everything else in this sandbox moves: the bolt
 * gutters, the crystal glints, the snare's field crawls, the fire boils. This
 * ability builds a thing out of nothing over half a second and then *stops*,
 * completely, for a second and a half — no drift, no shimmer, no rotation, no
 * scroll — and it is the only slot in the fifty that does. A dead-still object
 * in a scene full of motion does not read as "cheap", it reads as *wrong*, and
 * wrong in exactly the way a pocket of stopped time should.
 *
 * That is a surprisingly hostile thing to build, because almost every tool in
 * the library has a clock in it. The three that had to be argued with:
 *
 *  - `GroundField(RUNE)` rotates its rings by `uTime × spin`. Easing `spin`
 *    toward zero does not decelerate them, it teleports them — the rotation is
 *    absolute, not integrated, so the whole seal snaps back through however
 *    many seconds of wall clock have accumulated. `sealSpin` is therefore a
 *    constant for the life of a cast and it ships at **0**.
 *  - `DistortionField(REFRACT)` scrolls its ripple at `uRippleSpeed`.
 *    `refractRippleSpeed` ships at **0**; the ripple is still there, it just
 *    stands still, which is what a solid pane of glass does.
 *  - The pane's own grain would obviously animate. `stillness` is the slider
 *    that lets it, and it ships at **0** with the label "kills it", because
 *    the first build had it at 0.3 and the panes immediately became curtains.
 *
 * The one deliberate exception is `crackLead`: for the last fifth of a second
 * hairline fractures ink themselves across every pane. A break with no tell
 * reads as a cut in the edit rather than as a thing failing. Set it to 0 and
 * the panes go from perfect to gone.
 *
 * **What is actually on screen.** Four systems, five draw calls:
 *
 *  1. one `InstancedMesh` of up to 28 panes, each with a bespoke shader that
 *     measures its frost, its hairline and its fractures in metres recovered
 *     from its own instance matrix;
 *  2. one `DistortionField` in `REFRACT` **hull** mode, whose geometry is the
 *     same 28 quads rewritten in world space every frame — so all of the
 *     panes refract for a single draw call instead of one emitter each, which
 *     is the whole reason the hull path exists;
 *  3. one `ShatterField` (2 variants) that is completely empty until the
 *     break, at which point every pane throws `shardsPerPane` flakes from its
 *     own footprint;
 *  4. one `GroundField(RUNE)` seal, inked while the panes assemble and then,
 *     like everything else, frozen.
 *
 * **Why the panes are not the ShatterField.** They were, in the first build.
 * `ShatterField`'s flight is a closed-form function of `now − born` — which is
 * the right design, and the reason a paused slider can re-fly a fragment — but
 * it means a fragment that has been hanging motionless with `speed = 0` cannot
 * be told to start falling: raising gravity re-flies it from birth and the
 * whole field teleports to where it *would* have been after two seconds of
 * falling. So the panes are their own mesh, they hold, and the `ShatterField`
 * is born at the instant of the break with `now = age`. The two agree on where
 * a pane was because the burst passes that pane's own `along` / `lateral`
 * dice, mapped through a LINE layout laid across the circle.
 *
 * The one thing that does not agree is height: `ShatterField` carries a single
 * `spawnHeight` per burst, so a flake's *height* is the band's centre plus its
 * own scatter rather than its pane's exact height. At the speed the break
 * happens nobody has ever picked it out, and the alternative was 28 bursts
 * with 28 params objects.
 *
 * **What a cast captures.** Per pane: a bearing, a radial fraction, four ±1
 * rolls and a delay fraction — nine unitless dice. Plus one seed and two
 * timestamps (the moment the last pane locked, the moment they broke). Not one
 * metre, radian, second or colour. Pause with **P** mid-hold and drag
 * `paneWidth`, `paneHeight`, `zoneRadius`, `frostScale` or `fringeOffset`: the
 * standing wall of glass re-forms around the new numbers without a frame
 * passing.
 */
export class ChronofractureAbility extends Ability {
  constructor(context) {
    super('chronofracture', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /* --- the panes ------------------------------------------------- */
    this.paneGeometry = new PlaneGeometry(1, 1);
    this.paneOpen = new InstancedBufferAttribute(new Float32Array(MAX_PANES), 1);
    this.paneSeed = new InstancedBufferAttribute(new Float32Array(MAX_PANES), 1);
    this.paneGeometry.setAttribute('aOpen', this.paneOpen);
    this.paneGeometry.setAttribute('aSeed', this.paneSeed);

    this.paneMaterial = new ShaderMaterial({
      name: 'Chronofracture:pane',
      transparent: true,
      // Normal blending, not additive: the wash has to be able to make the
      // frame *darker and greyer* behind it. An additive pane can only ever
      // add light, and a pane of frozen time that brightens the room is a
      // window into somewhere hotter.
      blending: NormalBlending,
      depthWrite: false,
      depthTest: true,
      // Two-sided, because a pane is a plane and you spend half the orbit
      // looking at its back. Twenty of them in one InstancedMesh means the
      // instances are not depth-sorted against each other — three sorts
      // objects, not instances — but at a wash alpha of a third the stacking
      // order is not something the eye can pick out, and the alternative was
      // twenty draw calls to buy an artefact nobody can see.
      side: DoubleSide,
      toneMapped: false,
      uniforms: sharedUniforms({
        uColorGlass: { value: new Color() },
        uColorGhost: { value: new Color() },
        uColorRim: { value: new Color() },
        uColorSeam: { value: new Color() },
        uColorCrack: { value: new Color() },
        uOpacity: { value: 0.34 },
        uGlow: { value: 1.2 },
        uFrost: { value: 0.6 },
        uFrostScale: { value: 1.4 },
        uGrain: { value: 0.3 },
        uFringe: { value: 0.7 },
        uFringeOffset: { value: 0.05 },
        uRim: { value: 1.1 },
        uRimPower: { value: 2.6 },
        uBorder: { value: 0.045 },
        uStill: { value: 0 },
        uStillSpeed: { value: 0.35 },
        uSoft: { value: 0.35 },
        uSeamWidth: { value: 0.09 },
        uSeamGlow: { value: 3.4 },
        uCrack: { value: 0 },
        uCrackArms: { value: 7 },
        uCrackRings: { value: 1.6 },
        uCrackWidth: { value: 0.012 },
        uCrackGlow: { value: 2.2 },
        uFade: { value: 1 }
      }),
      vertexShader: PANE_VERTEX,
      fragmentShader: PANE_FRAGMENT
    });

    this.panes = new InstancedMesh(this.paneGeometry, this.paneMaterial, MAX_PANES);
    this.panes.name = 'Chronofracture:panes';
    this.panes.count = 0;
    this.panes.frustumCulled = false;
    this.panes.layers.set(LAYER.VFX);
    this.panes.renderOrder = 9;
    this.group.add(this.panes);

    /* --- the refraction hull -------------------------------------- */
    // Twenty-eight quads in one buffer, rewritten in world space every frame.
    // A DistortionField per pane would be twenty-eight draw calls into the
    // offset buffer; this is one, and the hull path gives it real per-pane
    // normals so the REFRACT rim term bends hardest at each pane's silhouette.
    this.hullGeometry = new BufferGeometry();
    this.hullPositions = new Float32Array(MAX_PANES * 4 * 3);
    this.hullNormals = new Float32Array(MAX_PANES * 4 * 3);
    const hullIndices = new Uint16Array(MAX_PANES * 6);
    for (let i = 0; i < MAX_PANES; i++) {
      const base = i * 4;
      const o = i * 6;
      hullIndices[o + 0] = base;
      hullIndices[o + 1] = base + 1;
      hullIndices[o + 2] = base + 2;
      hullIndices[o + 3] = base + 2;
      hullIndices[o + 4] = base + 1;
      hullIndices[o + 5] = base + 3;
    }
    this.hullPositionAttribute = new BufferAttribute(this.hullPositions, 3);
    this.hullNormalAttribute = new BufferAttribute(this.hullNormals, 3);
    this.hullGeometry.setAttribute('position', this.hullPositionAttribute);
    this.hullGeometry.setAttribute('normal', this.hullNormalAttribute);
    this.hullGeometry.setIndex(new BufferAttribute(hullIndices, 1));
    this.hullGeometry.setDrawRange(0, 0);

    this.hull = new DistortionField({
      mode: DistortionMode.REFRACT,
      geometry: this.hullGeometry,
      renderOrder: 4,
      name: 'chronofracture.panes'
    });
    // Hull emitters default to FrontSide, which would drop every pane whose
    // normal points away from the eye — and half of them always do, because
    // they face radially outward. The REFRACT fragment already flips its
    // normal on `gl_FrontFacing`, so two-sided is correct and costs nothing.
    this.hull.material.side = DoubleSide;
    this.group.add(this.hull.object3D);

    /* --- the break ------------------------------------------------- */
    this.shatter = new ShatterField(this.group, {
      geometry: createShardGeometry,
      variants: SHARD_VARIANTS,
      capacity: SHARD_CAPACITY,
      additive: false,
      depthWrite: false,
      renderOrder: 10
    });

    /* --- the seal -------------------------------------------------- */
    this.seal = new GroundField(this.group, {
      mode: GroundMode.RUNE,
      additive: false,
      renderOrder: 7,
      name: 'Chronofracture:seal'
    });

    /* --- per-cast state: dice and timestamps, nothing with a unit --- */
    this._seed = 0;
    this._lockedAt = -1;
    this._shatterAt = -1;
    this._panes = [];
    for (let i = 0; i < MAX_PANES; i++) {
      this._panes.push({
        angle: 0, // 0..1 of a turn about the circle
        radial: 0, // 0..1, sqrt-uniform so the band fills evenly
        heightRoll: 0, // -1..1
        yawRoll: 0, // -1..1
        tiltRoll: 0, // -1..1
        sizeRoll: 0, // -1..1
        delayRoll: 0, // 0..1 of the stagger
        seed: 0 // 0..10, mirrored into aSeed
      });
    }
    this._liveCount = 0;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Dust that stopped when time did. Emitted almost without speed, so it
    // hangs — the only particles in the project that are meant to look static.
    this.motes = particles.get('chronofracture.motes', {
      capacity: 1400,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.5
    });
    this.motes.uniforms.uDrag.value = 3.2;
    this.motes.uniforms.uEndSize.value = 0.6;
    this.motes.uniforms.uSizeIn.value = 0.25;
    this.motes.uniforms.uFadeIn.value = 0.3;
    this.motes.uniforms.uFadeOut.value = 0.45;

    // The sparks a pane throws as it locks, and the glitter of the break.
    this.glints = particles.get('chronofracture.glints', {
      capacity: 2200,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.25
    });
    this.glints.uniforms.uDrag.value = 1.6;
    this.glints.uniforms.uEndSize.value = 0.2;
    this.glints.uniforms.uSizeIn.value = 0.03;
    this.glints.uniforms.uFadeIn.value = 0.04;
    this.glints.uniforms.uFadeOut.value = 0.5;

    // The heavy debris. Lit rather than additive: falling glass is a solid.
    this.chips = particles.get('chronofracture.chips', {
      capacity: 1200,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.chips.uniforms.uDrag.value = 0.3;
    this.chips.uniforms.uEndSize.value = 0.7;
    this.chips.uniforms.uFadeOut.value = 0.65;

    this.moteEmitter = new RateEmitter();
    this.glintEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  /** Panes drawn plus fragments in the air. HUD readout only. */
  get instanceCount() {
    return this._liveCount + this.shatter.count;
  }

  /** Assembly then hold. The break is the boundary into the fade. */
  get impactDuration() {
    const c = settings.chronofracture;
    return Math.max(0.05, (c.assembleTime + c.holdTime) * settings.global.lifetime);
  }

  /** How long the fragments have to fall. */
  get fadeDuration() {
    return Math.max(0.05, settings.chronofracture.fadeTime);
  }

  /**
   * Seconds the panes take to open, resolved live.
   *
   * Scaled by `global.lifetime` for the same reason `impactDuration` is: the
   * two clocks have to agree or the panes finish opening halfway through a
   * hold that has already ended.
   */
  get _assembleSpan() {
    return Math.max(0.02, settings.chronofracture.assembleTime * settings.global.lifetime);
  }

  /**
   * The light does not gutter — nothing here does. It sits at full while the
   * panes are opening and drops to `lightHold` once they are still, which is a
   * step, not a flicker, and it happens on the same frame the last pane locks.
   */
  lightShimmer() {
    const c = settings.chronofracture;
    if (this.phase === AbilityPhase.TRAVEL) return 1;
    if (this._shatterAt >= 0) return c.lightHold;
    return this.impactTime >= this._assembleSpan ? c.lightHold : 1;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.moteEmitter.reset();
    this.glintEmitter.reset();
    this.shatter.clear();

    this._seed = Math.random() * 100;
    this._lockedAt = -1;
    this._shatterAt = -1;
    this._liveCount = 0;

    // Nine unitless dice per pane. Every metre they eventually stand at is
    // resolved from `settings.chronofracture` in `_placePanes`, every frame.
    for (let i = 0; i < MAX_PANES; i++) {
      const pane = this._panes[i];
      pane.angle = Math.random();
      pane.radial = Math.sqrt(Math.random());
      pane.heightRoll = Math.random() * 2 - 1;
      pane.yawRoll = Math.random() * 2 - 1;
      pane.tiltRoll = Math.random() * 2 - 1;
      pane.sizeRoll = Math.random() * 2 - 1;
      pane.delayRoll = Math.random();
      pane.seed = Math.random() * 10;
      this.paneSeed.array[i] = pane.seed;
    }
    this.paneSeed.needsUpdate = true;

    this._syncPaneLook(0, 1);
    this._syncSeal(0, 0, 1);
    this._syncShatterLook();
  }

  /* ------------------------------------------------------------------ */
  /* Live geometry — every dimension re-resolved, every frame            */
  /* ------------------------------------------------------------------ */

  /** The centre of the circle, on the floor. */
  _zoneCentre(out) {
    return this.pointAt(1, out);
  }

  /**
   * Place every pane and rewrite the refraction hull to match.
   *
   * @param {number} age seconds since the panes started opening (< 0 before)
   * @returns {number} panes drawn
   */
  _placePanes(age) {
    const c = settings.chronofracture;
    const count = clamp(Math.round(c.paneCount), 0, MAX_PANES);
    if (count <= 0 || age < 0) {
      this.panes.count = 0;
      this.hullGeometry.setDrawRange(0, 0);
      // Release the pass's writer while there is nothing to refract. An
      // emitter left visible with an empty draw range still costs the clear,
      // the draw and the resample of a half-resolution buffer every frame, and
      // `core/Layers.js` counts *visible* meshes, not drawn triangles.
      this.hull.visible = false;
      return 0;
    }
    this.hull.visible = true;

    this._zoneCentre(_centre);

    const span = this._assembleSpan;
    const stagger = clamp(c.assembleStagger, 0, 0.98);
    const openSpan = Math.max(0.02, span * (1 - stagger));
    const curve = Math.max(0.05, c.assembleCurve);
    const jitter = settings.global.randomness;

    for (let i = 0; i < count; i++) {
      const pane = this._panes[i];

      /* --- how far open it is ----------------------------------- */
      // Ease-in, so a pane creeps apart and then snaps the last of the way.
      // Ease-out looked like a curtain being drawn; the point is that the pane
      // was always there and is only now becoming visible.
      const raw = saturate((age - pane.delayRoll * stagger * span) / openSpan);
      const open = Math.pow(raw, curve);
      this.paneOpen.array[i] = open;

      /* --- where it hangs ---------------------------------------- */
      const bearing = pane.angle * TAU;
      const cos = Math.cos(bearing);
      const sin = Math.sin(bearing);
      const radius = c.zoneRadius * lerp(c.paneInner, c.paneReach, pane.radial);

      _pos
        .copy(_centre)
        .addScaledVector(this.direction, cos * radius)
        .addScaledVector(this.side, sin * radius);
      _pos.y = c.paneHeight + pane.heightRoll * c.paneRise * jitter;

      /* --- which way it faces ------------------------------------ */
      // Radially outward blended toward the cast heading. All-outward reads as
      // a cylinder wall; all-downrange reads as a stack of slides. The blend is
      // the slider, because which one is right depends entirely on how wide
      // `zoneRadius` is.
      _normal
        .copy(this.direction)
        .multiplyScalar(cos)
        .addScaledVector(this.side, sin);
      if (_normal.lengthSq() < 1e-8) _normal.copy(this.direction);
      _normal.normalize().lerp(this.direction, 1 - saturate(c.paneFaceOut));
      if (_normal.lengthSq() < 1e-8) _normal.copy(this.direction);
      _normal.normalize();
      _normal.applyAxisAngle(_up, pane.yawRoll * c.paneYaw * jitter);

      _right.crossVectors(_up, _normal);
      if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0);
      _right.normalize();

      _tilt.setFromAxisAngle(_right, pane.tiltRoll * c.paneTilt * jitter);
      _normal.applyQuaternion(_tilt).normalize();
      _lift.crossVectors(_normal, _right).normalize();

      _basis.makeBasis(_right, _lift, _normal);
      _dummy.quaternion.setFromRotationMatrix(_basis);
      _dummy.position.copy(_pos);

      const scale = 1 + pane.sizeRoll * c.paneSizeJitter * jitter;
      const width = Math.max(0.02, c.paneWidth * scale);
      const height = Math.max(0.02, width * c.paneAspect);
      _dummy.scale.set(width, height, 1);
      _dummy.updateMatrix();
      this.panes.setMatrixAt(i, _dummy.matrix);

      /* --- the same quad, in the refraction hull ----------------- */
      // Only the *open* part refracts, so the warp grows with the pane rather
      // than snapping on at full width the moment the slit appears.
      const halfW = width * 0.5 * open;
      const halfH = height * 0.5;
      for (let corner = 0; corner < 4; corner++) {
        const sx = corner & 1 ? 1 : -1;
        const sy = corner & 2 ? 1 : -1;
        _corner
          .copy(_pos)
          .addScaledVector(_right, sx * halfW)
          .addScaledVector(_lift, sy * halfH);
        const v = (i * 4 + corner) * 3;
        this.hullPositions[v + 0] = _corner.x;
        this.hullPositions[v + 1] = _corner.y;
        this.hullPositions[v + 2] = _corner.z;
        this.hullNormals[v + 0] = _normal.x;
        this.hullNormals[v + 1] = _normal.y;
        this.hullNormals[v + 2] = _normal.z;
      }
    }

    this.panes.count = count;
    this.panes.instanceMatrix.needsUpdate = true;
    this.paneOpen.needsUpdate = true;
    this.hullPositionAttribute.needsUpdate = true;
    this.hullNormalAttribute.needsUpdate = true;
    this.hullGeometry.setDrawRange(0, count * 6);
    return count;
  }

  /** Push the pane look. Every field, every frame — including a dead one. */
  _syncPaneLook(crack, fade) {
    const c = settings.chronofracture;
    const g = settings.global;
    const u = this.paneMaterial.uniforms;

    u.uColorGlass.value.copy(getColor(c.colorGlass));
    u.uColorGhost.value.copy(getColor(c.colorGhost));
    u.uColorRim.value.copy(getColor(c.colorRim));
    u.uColorSeam.value.copy(getColor(c.colorSeam));
    u.uColorCrack.value.copy(getColor(c.colorCrack));

    u.uOpacity.value = c.paneOpacity * g.opacity;
    u.uGlow.value = c.paneGlow * g.glow;
    u.uFrost.value = c.frost * g.noiseStrength;
    u.uFrostScale.value = c.frostScale * g.noiseFrequency;
    u.uGrain.value = c.grain;
    u.uFringe.value = c.fringe;
    u.uFringeOffset.value = c.fringeOffset;
    u.uRim.value = c.rim * g.fresnel;
    u.uRimPower.value = c.rimPower;
    u.uBorder.value = c.border;
    u.uStill.value = c.stillness;
    u.uStillSpeed.value = c.stillSpeed * g.noiseSpeed;
    u.uSoft.value = c.paneSoft;
    u.uSeamWidth.value = c.seamWidth;
    u.uSeamGlow.value = c.seamGlow;
    u.uCrack.value = crack;
    u.uCrackArms.value = Math.max(1, Math.round(c.crackArms));
    u.uCrackRings.value = c.crackRings;
    u.uCrackWidth.value = c.crackWidth;
    u.uCrackGlow.value = c.crackGlow;
    u.uFade.value = fade;

    /* --- the refraction hull rides the same beats --------------- */
    // NB: `global.distortion` and `post.distortion` are deliberately absent
    // here. The pass applies both, once; folding them in would apply them
    // twice for this ability and not at all for the next one.
    _refract.strength = c.refractStrength * fade;
    _refract.power = c.refractPower;
    _refract.opacity = c.refractOpacity;
    _refract.ripple = c.refractRipple;
    _refract.rippleScale = c.refractRippleScale;
    _refract.rippleSpeed = c.refractRippleSpeed;
    _refract.depthReject = c.refractDepthReject;
    _refract.depthFade = c.refractDepthFade;
    _refract.seed = this._seed;
    this.hull.update(_refract);
  }

  /**
   * The seal on the floor.
   *
   * @param {number} grow     0..1 the front spreading out to `sealScale`
   * @param {number} inscribe 0..1 how much of the script has been inked
   * @param {number} fade     0..1 master fade
   */
  _syncSeal(grow, inscribe, fade) {
    const c = settings.chronofracture;
    const g = settings.global;

    this._zoneCentre(_centre);
    _ground.centre = _centre;
    _ground.yaw = Math.atan2(this.direction.x, this.direction.z);
    _ground.height = c.sealHeight;
    _ground.radius = Math.max(0.1, c.zoneRadius * c.sealScale);

    _ground.grow = grow;
    _ground.recede = 0;
    _ground.inscribe = inscribe;
    // Ignition trails the inking, so the innermost ring is already alight while
    // the outer one is still being written.
    _ground.ignite = saturate(inscribe * 1.35 - 0.35);
    _ground.fade = fade;
    _ground.seed = this._seed;

    _ground.edge = c.sealEdge;
    _ground.ragged = c.sealRagged;
    _ground.raggedScale = c.sealRaggedScale;
    _ground.warp = c.sealWarp;

    _ground.relief = c.sealRelief;
    _ground.normalStep = c.sealNormalStep;
    _ground.ambient = c.sealAmbient;
    _ground.wrap = c.sealWrap;
    _ground.specular = c.sealSpecular;
    _ground.gloss = c.sealGloss;
    _ground.parallax = c.sealParallax;

    _ground.cell = c.sealCell;
    _ground.detail = c.sealDetail;
    _ground.thickness = c.sealThickness;
    _ground.depth = c.sealDepth;

    _ground.rings = Math.round(c.sealRings);
    _ground.ringInner = c.sealRingInner;
    _ground.glyphSize = c.sealGlyphSize;
    _ground.glyphStroke = c.sealGlyphStroke;
    _ground.glyphGap = c.sealGlyphGap;
    _ground.spin = c.sealSpin;
    _ground.spinFalloff = c.sealSpinFalloff;
    _ground.rule = c.sealRule;

    _ground.additive = false;
    _ground.emissive = c.sealEmissive;
    _ground.opacity = c.sealOpacity;
    _ground.depthFade = c.sealDepthFade;
    _ground.colorBase = c.colorSealBase;
    _ground.colorEdge = c.colorSealEdge;
    _ground.colorGlow = c.colorSealGlow;
    _ground.colorDeep = c.colorSealDeep;

    _ground.noiseStrength = g.noiseStrength;
    _ground.noiseFrequency = g.noiseFrequency;
    _ground.noiseSpeed = g.noiseSpeed;
    _ground.opacityScale = g.opacity;

    this.seal.update(_ground);
  }

  /** Colours and shading for the fragments. Pushed every frame, live. */
  _syncShatterLook() {
    const c = settings.chronofracture;
    const g = settings.global;

    _look.colorA.copy(getColor(c.colorShardA));
    _look.colorB.copy(getColor(c.colorShardB));
    _look.colorEdge.copy(getColor(c.colorShardEdge));
    _look.colorScene.copy(getColor(c.colorShardScene));
    _look.opacity = c.shardOpacity * g.opacity;
    _look.glow = c.shardGlow * g.glow;
    _look.rim = c.shardRim * g.fresnel;
    _look.rimPower = c.shardRimPower;
    _look.shade = c.shardShade;
    _look.ambient = c.shardAmbient;
    _look.fadeStart = c.shardFadeStart;
    _look.soft = c.shardSoft;
    _look.sceneMix = c.shardSceneMix;
    _look.refract = c.shardRefract;
    _look.saturation = c.shardSaturation;
    this.shatter.sync(_look);
  }

  /**
   * The fragments' basis and flight, live.
   *
   * A LINE layout laid *across* the circle rather than a ZONE one, because
   * `burst()` only lets the caller aim a fragment with `along` and `lateral` —
   * a ZONE burst rolls its own bearing, and a pane that broke on the left has
   * to leave its glass on the left.
   */
  _syncShatterFlight() {
    const c = settings.chronofracture;
    const g = settings.global;
    const reach = Math.max(0.01, Math.max(c.paneInner, c.paneReach));
    const half = c.zoneRadius * reach;

    this._zoneCentre(_centre);
    _shatter.layout = ShatterLayout.LINE;
    _shatter.origin = _shatterOrigin.copy(_centre).addScaledVector(this.direction, -half);
    _shatter.direction = this.direction;
    _shatter.side = this.side;
    _shatter.length = half * 2;
    _shatter.width = half;
    _shatter.centre = null;
    _shatter.radius = half;

    _shatter.spawnHeight = c.paneHeight;
    _shatter.spawnRadius = c.shardScatter;

    _shatter.speed = c.shardSpeed;
    _shatter.speedJitter = c.shardSpeedJitter;
    _shatter.spread = c.shardSpread;
    _shatter.upBias = c.shardUp;
    _shatter.inherit = null;
    _shatter.inheritScale = 1;

    _shatter.gravity = c.shardGravity;
    _shatter.drag = c.shardDrag;

    _shatter.size = c.shardSize;
    _shatter.sizeJitter = c.shardSizeJitter;
    _shatter.shrink = c.shardShrink;
    _shatter.shrinkPower = c.shardShrinkPower;
    _shatter.spin = c.shardSpin;
    _shatter.spinJitter = c.shardSpinJitter;

    _shatter.lifetime = c.shardLifetime;
    _shatter.floor = c.shardFloor;
    _shatter.floorSpin = c.shardFloorSpin;
    _shatter.randomness = g.randomness;

    this.shatter.update(this.age, _shatter);
  }

  /* ------------------------------------------------------------------ */
  /* Particles                                                           */
  /* ------------------------------------------------------------------ */

  /** A random point inside the band the panes hang in. Emitters only. */
  _bandPoint(out) {
    const c = settings.chronofracture;
    const bearing = Math.random() * TAU;
    const radius = c.zoneRadius * lerp(c.paneInner, c.paneReach, Math.sqrt(Math.random()));
    this._zoneCentre(out);
    out.addScaledVector(this.direction, Math.cos(bearing) * radius);
    out.addScaledVector(this.side, Math.sin(bearing) * radius);
    out.y = c.paneHeight + (Math.random() * 2 - 1) * c.paneRise;
    return out;
  }

  /**
   * Motes and glints.
   *
   * @param {number} scale 0..1 — hard down during the hold, because dust that
   *   is visibly streaming is dust that has not stopped
   */
  _airFx(dt, scale) {
    const c = settings.chronofracture;
    const g = settings.global;
    const time = frame.uTime.value;

    const moteCount = Math.round(this.moteEmitter.tick(dt, c.moteRate * scale) * g.particleCount);
    if (moteCount > 0) {
      this._bandPoint(_pos);
      _emit.position = _pos;
      _emit.radius = c.zoneRadius * 0.12;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.9;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.1;
      _emit.sizeVariance = 0.6;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.motes.emit(moteCount, _emit);
    }

    const glintCount = Math.round(this.glintEmitter.tick(dt, c.glintRate * scale) * g.particleCount);
    if (glintCount > 0) {
      this._bandPoint(_pos);
      _emit.position = _pos;
      _emit.radius = c.paneWidth * 0.6;
      _emit.direction = _dir.set(0, -1, 0);
      _emit.speed = c.glintSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.18;
      _emit.sizeVariance = 0.7;
      _emit.life = c.glintLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.glints.emit(glintCount, _emit);
    }
  }

  /** Particle gradients and scales. Pushed every frame so the pickers are live. */
  _syncParticles() {
    const c = settings.chronofracture;
    const g = settings.global;

    this.motes.setGradient(
      getColor(c.colorMoteA),
      getColor(c.colorMoteB),
      getColor(c.colorMoteC),
      getColor(c.colorMoteD)
    );
    this.motes.uniforms.uGravity.value.set(0, c.moteDrift, 0);
    this.motes.uniforms.uSizeScale.value = c.moteSize * g.particleSize * 7;
    this.motes.uniforms.uLifeScale.value = c.moteLifetime * 0.5 * g.particleLifetime;
    this.motes.uniforms.uSpeedScale.value = g.particleSpeed;
    this.motes.uniforms.uOpacity.value = g.opacity;
    this.motes.uniforms.uGlow.value = 0.85 * g.glow;
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;

    this.glints.setGradient(
      getColor(c.colorGlintA),
      getColor(c.colorGlintB),
      getColor(c.colorGlintC),
      getColor(c.colorGlintD)
    );
    this.glints.uniforms.uGravity.value.set(0, c.glintGravity, 0);
    this.glints.uniforms.uSizeScale.value = c.glintSize * g.particleSize * 7;
    this.glints.uniforms.uLifeScale.value = c.glintLifetime * 0.5 * g.particleLifetime;
    this.glints.uniforms.uSpeedScale.value = g.particleSpeed;
    this.glints.uniforms.uOpacity.value = g.opacity;
    this.glints.uniforms.uGlow.value = 1.1 * g.glow;
    this.glints.uniforms.uStretch.value = c.glintStretch;

    this.chips.setGradient(
      getColor(c.colorChipA),
      getColor(c.colorChipB),
      getColor(c.colorChipC),
      getColor(c.colorChipD)
    );
    this.chips.uniforms.uGravity.value.set(0, c.chipGravity, 0);
    this.chips.uniforms.uSizeScale.value = c.chipSize * g.particleSize * 7;
    this.chips.uniforms.uLifeScale.value = c.chipLifetime * 0.5 * g.particleLifetime;
    this.chips.uniforms.uSpeedScale.value = g.particleSpeed;
    this.chips.uniforms.uOpacity.value = g.opacity;
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = settings.chronofracture;

    this._syncParticles();
    // The seal is inked ahead of the panes: by the time the front lands, the
    // script is already most of the way round.
    this._syncSeal(this.u, saturate(this.u * 0.8), 1);
    this._syncPaneLook(0, 1);
    this._syncShatterLook();
    this._syncShatterFlight();
    this._liveCount = this._placePanes(-1);

    // The light rides the front out and then sits in the middle of the band.
    this.position.y = lerp(0.2, c.paneHeight, saturate(this.u));
  }

  onImpact() {
    // Nothing one-shot happens here: the impact *is* the assembly, and the two
    // events worth marking (the last pane locking, the break) both fall inside
    // the phase rather than at its boundaries.
    this.ctx.shake.add(
      settings.chronofracture.breakShake * 0.25 * settings.global.cameraShake,
      4,
      18
    );
  }

  onFade(dt, t) {
    const c = settings.chronofracture;

    this._syncParticles();
    this._syncShatterLook();

    if (t <= 1) {
      /* ---- assembly, then the hold ------------------------------ */
      const age = this.impactTime;
      const span = this._assembleSpan;
      const remaining = Math.max(0, this.impactDuration - age);
      const assembling = age < span;

      // The one moving thing in the hold, and it lasts `crackLead` seconds.
      const crack = c.crackLead > 1e-4 ? saturate(1 - remaining / c.crackLead) : 0;

      this._syncPaneLook(crack, 1);
      this._syncSeal(1, saturate(0.8 + age / Math.max(span, 1e-3) * 0.2), 1);
      this._liveCount = this._placePanes(age);
      this._syncShatterFlight();

      if (!assembling && this._lockedAt < 0) {
        this._lockedAt = this.age;
        this.ctx.flash.trigger(
          getColor(c.colorFreezeFlash),
          c.freezeFlash * settings.global.explosionIntensity
        );
      }

      // Emission collapses to almost nothing once the panes are still. Dust
      // that is visibly streaming is dust that did not stop.
      this._airFx(dt, assembling ? 1 : 0.12);

      this._zoneCentre(this.position);
      this.position.y = c.paneHeight;
      return;
    }

    /* ---- the break, and the fall ------------------------------- */
    if (this._shatterAt < 0) this._break();

    const fall = saturate(t - 1);
    this._syncPaneLook(1, 0);
    this._liveCount = this._placePanes(-1);
    this._syncSeal(1, 1, 1 - fall * fall);
    this._syncShatterFlight();
    this._airFx(dt, 0.25 * (1 - fall));

    this._zoneCentre(this.position);
    this.position.y = c.paneHeight * (1 - fall * 0.7);
  }

  /**
   * All at once. Every pane throws its glass from its own footprint on the
   * same frame, because a staggered break is a collapse and this is a failure.
   */
  _break() {
    const c = settings.chronofracture;
    const g = settings.global;
    const time = frame.uTime.value;

    this._shatterAt = this.age;

    /* --- the fragments, pane by pane ---------------------------- */
    const count = clamp(Math.round(c.paneCount), 0, MAX_PANES);
    const per = Math.max(0, Math.round(c.shardsPerPane));
    const reach = Math.max(0.01, Math.max(c.paneInner, c.paneReach));
    for (let i = 0; i < count; i++) {
      const pane = this._panes[i];
      const bearing = pane.angle * TAU;
      const fraction = lerp(c.paneInner, c.paneReach, pane.radial) / reach;
      // `along` is saturated by the field, so the circle is mapped onto 0..1
      // with its centre at 0.5; `lateral` is signed and is not.
      this.shatter.burst(this.age, per, 0.5 + 0.5 * Math.cos(bearing) * fraction, Math.sin(bearing) * fraction);
    }

    /* --- the shell of released time ----------------------------- */
    this._zoneCentre(_pos);
    _pos.y = c.paneHeight;
    this.ctx.bursts.spawn(BurstMode.FROST, _pos, {
      radius: c.breakBurst * 0.25,
      endRadius: c.breakBurst * g.explosionIntensity,
      life: 0.6,
      intensity: c.breakBurstIntensity,
      opacity: 0.85,
      fresnel: 1.7,
      displace: 0.4,
      squash: 0.9,
      colorA: getColor(c.colorBreakA),
      colorB: getColor(c.colorBreakB),
      colorC: getColor(c.colorBreakC)
    });

    /* --- glitter and heavy debris ------------------------------- */
    _emit.position = _pos;
    _emit.radius = c.zoneRadius * 0.85;
    _emit.direction = _dir.set(0, -0.35, 0).normalize();
    _emit.speed = c.glintSpeed * 2.4;
    _emit.speedVariance = 0.9;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.24;
    _emit.sizeVariance = 0.8;
    _emit.life = c.glintLifetime * 1.6;
    _emit.lifeVariance = 0.6;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.glints.emit(Math.round(c.glintBurst * g.particleCount), _emit);

    _emit.speed = c.chipSpeed;
    _emit.size = 0.16;
    _emit.life = c.chipLifetime;
    _emit.spin = 9;
    this.chips.emit(Math.round(c.chipBurst * g.particleCount), _emit);

    /* --- the room notices --------------------------------------- */
    this.ctx.shake.add(
      c.breakShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.05, c.breakShakeDuration),
      24
    );
    this.ctx.flash.trigger(getColor(c.colorBreakFlash), c.breakFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * c.lightBreak * 0.1 * g.explosionIntensity;
  }

  onDestroy() {
    this.shatter.clear();
    this.panes.count = 0;
    this._liveCount = 0;
    this.hullGeometry.setDrawRange(0, 0);
    this.hull.visible = false;
    this.paneMaterial.uniforms.uFade.value = 0;
  }

  dispose() {
    this.paneGeometry.dispose();
    this.paneMaterial.dispose();
    this.hullGeometry.dispose();
    this.hull.dispose();
    this.shatter.dispose();
    this.seal.dispose();
    super.dispose();
  }
}
