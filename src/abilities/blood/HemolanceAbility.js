import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  Sphere,
  Vector3,
  DynamicDrawUsage
} from 'three';
import { Ability } from '../Ability.js';
import { FlightMode, Projectile, Stagger, projectileParams } from '../../vfx/Projectile.js';
import { GroundField, GroundMode, groundFieldParams } from '../../vfx/GroundField.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { noiseGLSL } from '../../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../../shaders/lib/common.glsl.js';
import { frame, sharedUniforms } from '../../core/FrameUniforms.js';
import { LAYER } from '../../core/Layers.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, hash11, Easing } from '../../utils/math.js';

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Hard ceiling on lances in one volley. The `needles` slider clamps here. */
const MAX_NEEDLES = 16;
/**
 * Samples along one mist thread.
 *
 * The thread is a straight line in space, so this is not about resolving a
 * curve — it is about resolving the *age gradient* along it, which at the
 * shipped `mistLife` runs the full colour ramp over a couple of metres. Twelve
 * banded visibly. Twenty-eight does not, and a strip of twenty-eight by sixteen
 * instances is 896 vertices, which is nothing.
 */
const MIST_NODES = 28;
/** Facets around a lance. Three: it is 3 cm wide and nobody counts them. */
const NEEDLE_SIDES = 3;
/** How many impacts the floor quad carries. See `StarfallAbility` on the cost. */
const FLOOR_MARKS = 12;

/* ------------------------------------------------------------------ */
/* Scratch — module scope, reused, never allocated in a frame (I3)     */
/* ------------------------------------------------------------------ */

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _launch = new Vector3();
const _land = new Vector3();
const _centre = new Vector3();
const _hand = new Vector3();
const _flight = projectileParams();
const _ground = groundFieldParams();

/* ------------------------------------------------------------------ */
/* The lance                                                           */
/* ------------------------------------------------------------------ */

/**
 * One needle: a three-sided spike in unit space, point at `y = +1`, tail at
 * `y = -1`, circumscribed radius 1 across.
 *
 * `Projectile` scales an instance `(radius, radius × stretch, radius)` and at
 * `align = 1` lays local **+Y** along the heading, so +Y is the point. The
 * widest ring is a third of the way back from the tip and the tail closes to a
 * second, blunter point, which is what stops the lance reading as a cone with a
 * flat disc hanging off the back of it when the volley crosses the camera.
 */
function createNeedleGeometry() {
  const sides = NEEDLE_SIDES;
  const rings = [
    [-1.0, 0.0],
    [-0.62, 0.55],
    [0.34, 1.0],
    [1.0, 0.0]
  ];

  const angles = [];
  for (let i = 0; i < sides; i++) angles.push((i / sides) * Math.PI * 2);

  const ringPoints = rings.map(([y, r]) =>
    angles.map((angle) => [Math.cos(angle) * r, y, Math.sin(angle) * r])
  );

  const positions = [];
  const push = (p) => positions.push(p[0], p[1], p[2]);
  for (let ring = 0; ring < ringPoints.length - 1; ring++) {
    const lower = ringPoints[ring];
    const upper = ringPoints[ring + 1];
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      push(lower[i]); push(lower[j]); push(upper[i]);
      push(lower[j]); push(upper[j]); push(upper[i]);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

const NEEDLE_VERTEX = /* glsl */ `
  attribute float aSeed;
  attribute float aFlight;
  attribute float aFlash;

  varying float vSeed;
  varying float vFlight;
  varying float vFlash;
  varying float vAlong;
  varying vec3  vNormalW;
  varying vec3  vViewDir;

  void main() {
    vSeed = aSeed;
    vFlight = aFlight;
    vFlash = aFlash;
    // 0 at the tail, 1 at the point. The lance is scaled twenty to one, so this
    // is the only coordinate on it worth shading against.
    vAlong = position.y * 0.5 + 0.5;

    mat4 im = mat4(1.0);
    #ifdef USE_INSTANCING
      im = instanceMatrix;
    #endif

    // Anisotropic instance scale — see the same note in StarfallAbility. At
    // twenty to one the error is not subtle: every normal ends up pointing at
    // the tip and the lance lights like a bar of soap.
    mat3 rot = mat3(im);
    vec3 sq = vec3(dot(rot[0], rot[0]), dot(rot[1], rot[1]), dot(rot[2], rot[2]));
    vec3 objectNormal = rot * (normal / max(sq, vec3(1e-6)));

    vec4 world = modelMatrix * im * vec4(position, 1.0);
    vNormalW = normalize(mat3(modelMatrix) * objectNormal);
    vViewDir = cameraPosition - world.xyz;

    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const NEEDLE_FRAGMENT = /* glsl */ `
  uniform vec3  uColorCore;
  uniform vec3  uColorEdge;
  uniform vec3  uColorDeep;
  uniform float uGlow;
  uniform float uOpacity;
  uniform float uRim;
  uniform float uTip;
  uniform float uGlobalGlow;
  uniform float uShaderIntensity;

  varying float vSeed;
  varying float vFlight;
  varying float vFlash;
  varying float vAlong;
  varying vec3  vNormalW;
  varying vec3  vViewDir;

  ${commonGLSL}

  void main() {
    // A needle is three centimetres across at twenty metres. There is no room
    // for surface detail and no point looking for any: the whole read is the
    // silhouette, so the rim term does all the work and the body is a flat
    // gradient behind it. Noise on this would be invisible and would cost a
    // fragment program that has to be compiled.
    float fres = fresnelTerm(vViewDir, vNormalW, uRim, 1.0);
    float tip = uTip * pow(clamp(vAlong, 0.0, 1.0), 3.0);
    float flash = vFlash * 1.5;

    vec3 body = mix(uColorDeep, uColorEdge, clamp(fres * 0.9 + 0.25, 0.0, 1.0));
    vec3 color = mix(body, uColorCore, clamp(tip * 0.4 + flash, 0.0, 1.0));
    color *= uGlow * uGlobalGlow * uShaderIntensity * (1.0 + tip * 0.35 + flash);

    float alpha = clamp(uOpacity * (0.6 + 0.4 * fres), 0.0, 1.0);
    gl_FragColor = vec4(color, alpha);
  }
`;

function createNeedleMaterial() {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: NormalBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uColorCore: { value: getColor('#ff8a92').clone() },
      uColorEdge: { value: getColor('#c01a28').clone() },
      uColorDeep: { value: getColor('#3a0509').clone() },
      uGlow: { value: 1.5 },
      uOpacity: { value: 1 },
      uRim: { value: 3 },
      uTip: { value: 2.2 }
    }),
    vertexShader: NEEDLE_VERTEX,
    fragmentShader: NEEDLE_FRAGMENT
  });
}

/* ------------------------------------------------------------------ */
/* The mist threads — the trick                                        */
/* ------------------------------------------------------------------ */

/**
 * A hairline of mist left hanging on the path a needle already flew.
 *
 * **What it draws.** One instanced camera-facing strip per needle, spanning the
 * part of that needle's flight it has already covered. Sixteen threads, one
 * draw call.
 *
 * **Why it is not a `RibbonTrail`.** A trail built by recording positions is a
 * record of metres, and a record of metres cannot be re-shaped by a slider —
 * which fails I1 outright, and also fails the *look*, because a recorded trail
 * dies by dimming and mist does not die by dimming. It disperses.
 *
 * **The one idea.** A needle's flight is a closed form, so the *time it passed
 * any given point on its own path* is also a closed form. Given the head's path
 * fraction `sHead` and a vertex at fraction `s = v · sHead`, the needle was
 * there at `delay + flight · s^(1/pathCurve)`, and the age of the mist at that
 * vertex is now minus that. Everything else — how wide it is, how far it has
 * drifted, how far it has wandered off the line, what colour it is and whether
 * it is there at all — is a function of that one age. No history, no buffers,
 * nothing captured. The consequence is the thing that makes the volley read:
 * the ribbon *outlives the needle*, because `sHead` saturates at 1 while the
 * ages keep climbing, and it goes by swelling and thinning rather than by
 * fading out.
 *
 * The mirror obligation, stated once: `pathAt` here and `_pathPoint` in
 * `Projectile` describe the same line. This one is only correct while the
 * needles fly straight — no apex, no weave — which is why the ability sets both
 * to zero and says so in its own comment. Give a needle a loft and the mist
 * will hang in a straight line under the arc it actually flew.
 */
const MIST_VERTEX = /* glsl */ `
  uniform float uClock;        // the ability's age, seconds
  uniform float uPathCurve;    // mirrors the projectile's, exactly
  uniform float uLife;         // seconds a point of mist survives
  uniform float uWidth;        // metres, half-width where it is laid
  uniform float uSpread;       // metres it swells by at full age
  uniform float uDrift;        // metres/second it rises
  uniform float uWander;       // metres of lateral wander at full age
  uniform float uWanderScale;  // wander features per metre
  uniform float uWanderSpeed;

  attribute vec3 aLaunch;
  attribute vec3 aLand;
  attribute vec2 aTiming;      // x = launch delay, y = flight time (seconds)
  attribute vec2 aDice;        // x = seed, y = handedness

  varying float vAge;          // 0 just laid, 1 gone
  varying float vSide;
  varying float vSeed;
  varying float vViewZ;

  ${noiseGLSL}

  void main() {
    float v = position.x;             // 0 at the tail of the thread, 1 at the head
    float side = position.y;          // -1 / +1 across the ribbon
    float delay = aTiming.x;
    float flight = max(aTiming.y, 1e-4);
    float curve = max(uPathCurve, 0.05);

    // Where the needle is now, as a fraction of its own path.
    float tauHead = clamp((uClock - delay) / flight, 0.0, 1.0);
    float sHead = pow(tauHead, curve);

    // This vertex, and the moment the needle was standing on it.
    float s = v * sHead;
    float passedAt = delay + flight * pow(max(s, 0.0), 1.0 / curve);
    float age = max(uClock - passedAt, 0.0);
    vAge = clamp(age / max(uLife, 1e-3), 0.0, 1.0);
    vSide = side;
    vSeed = aDice.x;

    vec3 p = mix(aLaunch, aLand, s);

    // Dispersal. All three terms are driven by the age, not by the clock, so a
    // thread laid a second ago is further gone than one laid this frame — which
    // is what makes a ripple of twelve read as twelve and not as a fan.
    p.y += uDrift * age;
    float wob = uWander * vAge;
    float ws = uWanderScale;
    float wt = uClock * uWanderSpeed;
    p.x += snoise(vec3(s * ws, aDice.x * 19.0, wt)) * wob;
    p.y += snoise(vec3(s * ws + 13.0, aDice.x * 19.0, wt)) * wob * 0.6;
    p.z += snoise(vec3(s * ws + 27.0, aDice.x * 19.0, wt)) * wob;

    // Camera-facing ribbon about the thread's own axis. The axis is the
    // launch → land line and nothing else, so it is well defined even at s = 0
    // where a tangent would be.
    vec3 axis = aLand - aLaunch;
    float axisLen = length(axis);
    axis = axisLen > 1e-4 ? axis / axisLen : vec3(0.0, 0.0, 1.0);
    vec3 toCam = normalize(cameraPosition - p);
    vec3 across = cross(axis, toCam);
    float acrossLen = length(across);
    // Dead-on: the thread is pointing at the camera and has no width to give.
    across = acrossLen > 1e-4 ? across / acrossLen : vec3(1.0, 0.0, 0.0);

    float halfWidth = (uWidth + uSpread * vAge) * aDice.y;
    p += across * side * halfWidth;

    vec4 mv = viewMatrix * vec4(p, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const MIST_FRAGMENT = /* glsl */ `
  uniform vec3  uColorA;
  uniform vec3  uColorB;
  uniform vec3  uColorC;
  uniform vec3  uColorD;
  uniform float uOpacity;
  uniform float uCore;
  uniform float uFalloff;
  uniform float uSoftFade;

  uniform vec2      uResolution;
  uniform sampler2D uSceneDepth;
  uniform float     uCameraNear;
  uniform float     uCameraFar;
  uniform float     uShaderIntensity;

  varying float vAge;
  varying float vSide;
  varying float vSeed;
  varying float vViewZ;

  ${commonGLSL}

  void main() {
    float across = abs(vSide);

    // Two profiles across the ribbon, crossfaded by age. Fresh, the thread is
    // all centre line — a hairline, which is what a needle leaves. Old, it is a
    // soft lump with nothing sharp in it at all. Crossfading the *profile*
    // rather than only the width is what stops an old thread reading as a
    // wide wire.
    float hair = pow(max(1.0 - across, 0.0), max(uCore, 0.05));
    float lump = (1.0 - across * across) * 0.55;
    float profile = mix(hair, lump, vAge);

    float alive = pow(max(1.0 - vAge, 0.0), max(uFalloff, 0.05));
    // A little per-thread variation, so twelve ribbons laid a few hundredths of a
    // second apart are not twelve identical objects.
    float alpha = uOpacity * profile * alive * (0.82 + 0.36 * vSeed);
    if (alpha < 0.002) discard;

    vec3 color = gradient4(uColorA, uColorB, uColorC, uColorD, vAge) * uShaderIntensity;

    float soft = softFade(
      uSceneDepth, gl_FragCoord.xy / uResolution, vViewZ, uCameraNear, uCameraFar, uSoftFade
    );

    gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0) * soft);
  }
`;

/**
 * The instanced strip that carries every thread.
 *
 * Parent-first like the library modules it sits next to, and deliberately not
 * *in* the library: nothing else in the roster wants a trail that survives its
 * own projectile, and a shared module written for one caller is a shared module
 * with one caller's assumptions baked into it.
 */
class MistThreads {
  constructor(parent, { capacity = MAX_NEEDLES, nodes = MIST_NODES } = {}) {
    this.capacity = Math.max(1, Math.round(capacity));

    // Parameter space only: (v, side). There is not one metre in the buffer,
    // which is what lets one strip serve sixteen threads of any length.
    const positions = new Float32Array(nodes * 2 * 3);
    for (let i = 0; i < nodes; i++) {
      const v = i / (nodes - 1);
      const o = i * 6;
      positions[o + 0] = v;
      positions[o + 1] = -1;
      positions[o + 3] = v;
      positions[o + 4] = 1;
    }

    const indices = new Uint16Array((nodes - 1) * 6);
    for (let i = 0; i < nodes - 1; i++) {
      const a = i * 2;
      const o = i * 6;
      indices[o + 0] = a;
      indices[o + 1] = a + 1;
      indices[o + 2] = a + 2;
      indices[o + 3] = a + 1;
      indices[o + 4] = a + 3;
      indices[o + 5] = a + 2;
    }

    this.launch = new InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3);
    this.land = new InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3);
    this.timing = new InstancedBufferAttribute(new Float32Array(this.capacity * 2), 2);
    this.dice = new InstancedBufferAttribute(new Float32Array(this.capacity * 2), 2);
    for (const attribute of [this.launch, this.land, this.timing, this.dice]) {
      attribute.setUsage(DynamicDrawUsage);
    }

    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('aLaunch', this.launch);
    geometry.setAttribute('aLand', this.land);
    geometry.setAttribute('aTiming', this.timing);
    geometry.setAttribute('aDice', this.dice);
    geometry.setIndex(new BufferAttribute(indices, 1));
    geometry.instanceCount = 0;
    // Placed in world space by the vertex shader, so its own bounds are a lie
    // and frustum culling has to be off.
    geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
    this.geometry = geometry;

    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: NormalBlending,
      side: DoubleSide,
      toneMapped: false,
      uniforms: sharedUniforms({
        uClock: { value: 0 },
        uPathCurve: { value: 1 },
        uLife: { value: 0.85 },
        uWidth: { value: 0.022 },
        uSpread: { value: 0.17 },
        uDrift: { value: 0.34 },
        uWander: { value: 0.15 },
        uWanderScale: { value: 1.3 },
        uWanderSpeed: { value: 0.35 },
        uColorA: { value: getColor('#ff5a66').clone() },
        uColorB: { value: getColor('#c01a28').clone() },
        uColorC: { value: getColor('#6e0d16').clone() },
        uColorD: { value: getColor('#2a0508').clone() },
        uOpacity: { value: 0.9 },
        uCore: { value: 3.4 },
        uFalloff: { value: 1.7 },
        uSoftFade: { value: 0.35 }
      }),
      vertexShader: MIST_VERTEX,
      fragmentShader: MIST_FRAGMENT
    });

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.layers.set(LAYER.VFX);
    // After the shaded smoke, before the additive particles, exactly as the
    // library's own trail sits.
    this.mesh.renderOrder = 11;
    this.mesh.name = 'Hemolance:mist';
    parent?.add(this.mesh);

    this._live = 0;
  }

  /** One. Always one, however many threads are hanging. */
  get drawCalls() {
    return 1;
  }

  get count() {
    return this._live;
  }

  /**
   * Post one thread's endpoints and clock. Called once per needle per frame.
   *
   * `launch` and `land` are metres, and that is fine: they are written and read
   * inside the same frame, resolved from the live block by the caller, and
   * never survive to the next one.
   */
  setThread(slot, launch, land, delay, flightTime, seed, hand) {
    if (slot >= this.capacity) return;
    const o3 = slot * 3;
    this.launch.array[o3 + 0] = launch.x;
    this.launch.array[o3 + 1] = launch.y;
    this.launch.array[o3 + 2] = launch.z;
    this.land.array[o3 + 0] = land.x;
    this.land.array[o3 + 1] = land.y;
    this.land.array[o3 + 2] = land.z;
    this.timing.array[slot * 2 + 0] = delay;
    this.timing.array[slot * 2 + 1] = flightTime;
    this.dice.array[slot * 2 + 0] = seed;
    this.dice.array[slot * 2 + 1] = hand;
  }

  /** Publish the frame's threads. `count` of them are drawn. */
  commit(count) {
    this._live = Math.max(0, Math.min(this.capacity, count));
    this.geometry.instanceCount = this._live;
    this.launch.needsUpdate = true;
    this.land.needsUpdate = true;
    this.timing.needsUpdate = true;
    this.dice.needsUpdate = true;
  }

  reset() {
    this._live = 0;
    this.geometry.instanceCount = 0;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}

/* ------------------------------------------------------------------ */
/* The ability                                                         */
/* ------------------------------------------------------------------ */

/**
 * HEMOLANCE — a volley of blood needles, and what they leave behind.
 *
 * Three beats: the **volley** leaves the hand as a ripple, the needles
 * **impact** and each one sprays and pools, and the mist **fades** off the
 * threads in the order it was laid.
 *
 * **THE TRICK — the trail outlives the projectile.** A needle is three
 * centimetres across and crosses sixteen metres in an eighth of a second. On
 * its own that is one frame and a half of a bright line and the eye simply does
 * not catch it — the first build looked like a stutter in the renderer. What
 * makes it read is that each lance leaves a hairline of mist on the exact path
 * it flew, and that mist hangs there for the best part of a second after the
 * lance has hit and gone: twelve needles fired over two thirds of a second never
 * have more than three in the air at once, but they stack up into twelve visible
 * threads, and *that* is the volley. The evidence is the effect.
 *
 * The threads do not fade, they disperse. A ribbon whose alpha ramps down reads
 * as a light being turned off; one that swells, softens, drifts upward and
 * wanders off its own line reads as something in the air. All four of those are
 * driven off a single number — the age of the mist at that point on the thread
 * — and that age is a closed form, not a recording: see `MIST_VERTEX` above,
 * which is where the actual work of this file is.
 *
 * **The ripple.** `ripplePhase` is the seconds between one needle and the next.
 * `Projectile` spreads a `RIPPLE` stagger evenly across a `window`, so the
 * ability hands it `window = ripplePhase × (needles − 1)` every frame, which
 * means the signature control is a *per-needle* number rather than a total
 * duration — drag `needles` and the rhythm stays put instead of compressing.
 * The hold phase is stretched from the same numbers so the volley can never
 * outlast its own cast.
 *
 * **What a cast captures.** One seed, a flag for "has the last needle landed",
 * and one timestamp per impact in the floor quad's ring buffer. Nothing else.
 * Pause mid-volley and drag `ripplePhase`: every thread re-lays itself, the
 * ones that had not been fired yet appear, and the ones already down stay down.
 *
 * **Draw calls.** Three of its own — the instanced lances, the one strip that
 * carries every thread of mist, and the ground quad that carries every pool —
 * plus three shared particle systems and a pooled splash per impact.
 */
export class HemolanceAbility extends Ability {
  constructor(context) {
    super('hemolance', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    this.needleMaterial = createNeedleMaterial();

    // `trail: false` — the library's trail is a good trail and it is the wrong
    // one here: it catches its head up after landing and is gone, which is the
    // opposite of the thing this ability is about. One draw call saved, and the
    // mist strip below spends it better.
    this.needles = new Projectile(this.group, {
      geometry: createNeedleGeometry,
      material: this.needleMaterial,
      capacity: MAX_NEEDLES,
      trail: false,
      layer: LAYER.VFX,
      renderOrder: 12
    });

    this.mist = new MistThreads(this.group, { capacity: MAX_NEEDLES, nodes: MIST_NODES });

    // Shaded, not additive: a pool of blood is darker than the stone it is on.
    this.floor = new GroundField(this.group, {
      mode: GroundMode.POCK,
      marks: FLOOR_MARKS,
      additive: false,
      depthTest: true,
      name: 'Hemolance:pools'
    });

    _ground.centre = _centre;

    /** Re-rolled per cast. Unitless, and the only dice this ability keeps. */
    this._seed = 0;
    /** Has the last needle landed? The screen flash fires once, on it. */
    this._closed = false;
    this._live = 0;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Fat droplets that arc and fall. Lit rather than additive — the one place
    // in the palette where a real surface normal is worth having, because a
    // droplet that glows is a spark and this school has no sparks.
    this.droplets = particles.get('hemolance.droplets', {
      capacity: 900,
      shape: ParticleShape.SOFT,
      additive: false,
      lit: true,
      softFade: 0.3
    });
    this.droplets.uniforms.uDrag.value = 0.5;
    this.droplets.uniforms.uEndSize.value = 0.7;
    this.droplets.uniforms.uSizeIn.value = 0.04;
    this.droplets.uniforms.uFadeIn.value = 0.05;
    this.droplets.uniforms.uFadeOut.value = 0.6;

    // Fine spray: velocity-stretched, short-lived, thrown back along the lance.
    this.spray = particles.get('hemolance.spray', {
      capacity: 1000,
      shape: ParticleShape.STREAK,
      additive: false,
      stretch: true,
      softFade: 0.25
    });
    this.spray.uniforms.uDrag.value = 1.8;
    this.spray.uniforms.uEndSize.value = 0.25;
    this.spray.uniforms.uSizeIn.value = 0.02;
    this.spray.uniforms.uFadeIn.value = 0.03;
    this.spray.uniforms.uFadeOut.value = 0.4;

    // The red haze that hangs where the volley struck. Occludes, so it can sit
    // in front of the mist threads and take some of the hardness off them.
    this.haze = particles.get('hemolance.haze', {
      capacity: 700,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.0
    });
    this.haze.uniforms.uDrag.value = 2.1;
    this.haze.uniforms.uEndSize.value = 2.4;
    this.haze.uniforms.uSizeIn.value = 0.14;
    this.haze.uniforms.uFadeIn.value = 0.2;
    this.haze.uniforms.uFadeOut.value = 0.35;
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this._live + this.mist.count;
  }

  /**
   * How long the volley takes, end to end, seconds.
   *
   * Resolved rather than stored, because every number in it is a slider: the
   * last needle leaves at `volleyLead + ripplePhase × (needles − 1)` and lands
   * `needleTime` later.
   */
  get volleyDuration() {
    const c = settings.hemolance;
    const last = Math.max(0, Math.min(MAX_NEEDLES, Math.round(c.needles)) - 1);
    return this._needleDelay(last) + this._needleFlight();
  }

  /**
   * The hold, stretched so a slow ripple cannot outlast its own cast.
   *
   * `lifetime` is the authored floor; the volley's own length plus half the
   * mist's is the floor below which the ability would visibly cut itself off.
   * Taking the larger means dragging `ripplePhase` to its maximum lengthens the
   * beat instead of truncating it, which is what you want from the one control
   * the ability is named after.
   */
  get impactDuration() {
    const c = settings.hemolance;
    const needed = this.volleyDuration + Math.max(0, c.mistLife) * 0.5;
    return Math.max(0.05, Math.max(c.lifetime, needed) * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.hemolance.fadeTime);
  }

  /** An arterial pulse — two beats close together, then a gap. */
  lightShimmer() {
    const c = settings.hemolance;
    const beat = this.age * Math.max(0.05, c.lightPulseSpeed);
    // `sin²` of a doubled rate under a slower envelope: a systole, a weaker
    // diastole, and a rest. A single sine reads as a lamp on a dimmer.
    const wave = Math.pow(Math.sin(beat * Math.PI), 2) * (0.65 + 0.35 * Math.sin(beat * Math.PI * 0.5));
    return 1 - saturate(c.lightPulse) * (1 - wave);
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                  */
  /* ------------------------------------------------------------------ */

  /** Where the volley leaves the caster. */
  _handPoint(out) {
    const c = settings.hemolance;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /** The floor quad's yaw; local +Z runs downrange. */
  _yaw() {
    return Math.atan2(this.direction.x, this.direction.z);
  }

  /**
   * Needle `i`'s launch delay, seconds.
   *
   * A **mirror** of what `Projectile` computes internally for `Stagger.RIPPLE`,
   * and it has to be, because the mist strip needs the same clock the bodies
   * are on and the module does not publish it. The mirror is exact and it is
   * one line: `RIPPLE` spreads `order = i / (count − 1)` across `window`, and
   * this ability sets `window = ripplePhase × (count − 1)`, so the two
   * `(count − 1)` terms cancel and the delay is simply `lead + phase × i`. The
   * only thing that could break it is switching the stagger mode, which is why
   * the mode is named explicitly in `_fillFlight` rather than left on AUTO.
   */
  _needleDelay(index) {
    const c = settings.hemolance;
    return (Math.max(0, c.volleyLead) + Math.max(0, c.ripplePhase) * index) / this._clock();
  }

  /**
   * Needle `i`'s flight time, seconds. Uniform across the volley, on purpose —
   * `speedJitter` is held at zero (see the settings block), so this is exact
   * rather than a mirror of the module's jitter maths.
   */
  _needleFlight() {
    return Math.max(0.02, settings.hemolance.needleTime) / this._clock();
  }

  /**
   * The global speed multiplier, guarded.
   *
   * Every second this ability quotes is divided by it, in one place, because
   * the volley's clock and the mist's clock have to be the *same* clock: the
   * strip is timing itself against delays the bodies were flown on, and a
   * factor applied to one and not the other detaches every thread from its own
   * needle. That bug looks like the mist lagging, which is a plausible enough
   * effect that it survived a session before anyone questioned it.
   */
  _clock() {
    return Math.max(0.05, settings.global.speed);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.floor.clearMarks();
    this.mist.reset();
    this._closed = false;
    this._live = 0;

    this._seed = Math.random() * 100;
    this.needles.roll(this._seed);

    this._sync(1);
    this._muzzleFx();
  }

  /* ------------------------------------------------------------------ */
  /* Per-frame                                                           */
  /* ------------------------------------------------------------------ */

  /** Fill the flight params from the live block. */
  _fillFlight() {
    const c = settings.hemolance;
    const p = _flight;
    const clock = this._clock();
    const count = Math.max(0, Math.min(MAX_NEEDLES, Math.round(c.needles)));

    p.mode = FlightMode.VOLLEY;
    // Named, not AUTO. `_needleDelay` mirrors RIPPLE and only RIPPLE.
    p.stagger = Stagger.RIPPLE;
    p.count = count;
    p.radius = c.needleRadius;
    p.sizeJitter = 0;
    p.stretch = c.needleLength;
    p.align = c.needleAlign;
    p.spin = c.needleSpin;
    p.flash = c.needleFlash;

    /* the launch */
    p.handForward = c.handForward;
    p.handSide = c.handSide;
    p.handHeight = c.handHeight;
    p.fanWidth = c.fanWidth;
    p.skyBack = 0;
    p.skyHeight = 0;
    p.skyScatter = 0;

    /* the landing */
    p.landHeight = c.landHeight;
    p.spreadSide = c.spreadSide;
    p.spreadForward = c.spreadForward;
    p.landInZone = false;
    p.zoneRadius = 1;
    p.zoneBias = 0.5;

    /* the curve — dead straight, which is what lets the mist mirror it */
    p.pathCurve = c.pathCurve;
    p.apex = 0;
    p.apexCurve = 1;
    p.weaveSide = 0;
    p.weaveUp = 0;
    p.weaveTurns = 1;
    p.weaveTurnsUp = 1;
    p.weavePhase = 0;
    p.weaveDecay = 1;

    /* the clock — `window` is derived so `ripplePhase` is per needle, and every
       second goes through `_clock()` so the strip and the bodies agree */
    p.flightTime = this._needleFlight();
    p.speedJitter = 0;
    p.lead = this._needleDelay(0);
    p.window = (Math.max(0, c.ripplePhase) * Math.max(0, count - 1)) / clock;
    p.fillBias = 0;
    p.fillScatter = 0;
    p.hashCell = 1;
    p.linger = 0;
    p.sink = 0;
    p.load = 0;

    /* no trail: the mist strip is the trail */
    p.trailWidth = 0;
    p.trailOpacity = 0;
    return p;
  }

  /** Fill the floor quad's params from the live block. */
  _fillGround(fade) {
    const c = settings.hemolance;
    const g = settings.global;
    const p = _ground;

    p.centre = _centre;
    p.yaw = this._yaw();
    p.height = c.fieldHeight;
    p.radius = c.fieldRadius;
    p.length = c.fieldRadius * 2;

    p.grow = 1;
    p.recede = 0;
    p.progress = 1;
    p.inscribe = 1;
    p.ignite = 0;
    p.fade = fade;
    p.seed = this._seed;

    p.edge = c.fieldEdge;
    p.ragged = c.fieldRagged;
    p.raggedScale = c.fieldRaggedScale;
    p.warp = c.fieldWarp;

    p.relief = c.fieldRelief;
    p.normalStep = 0.04;
    p.ambient = 0.26;
    p.wrap = 0.4;
    p.specular = c.fieldSpecular;
    p.gloss = c.fieldGloss;
    p.parallax = 0.12;

    p.cell = 0.5;
    p.cellJitter = 0.8;
    p.seam = 0.05;
    p.thickness = c.poolThickness;
    p.lift = c.poolRim;
    p.depth = c.poolDepth;
    p.width = 0.5;
    p.sharp = 0.5;
    p.detail = c.poolDetail;
    p.swirl = 0;
    p.arms = 5;
    // POCK's dig rate. Run fast here — blood arrives at the speed of the hit,
    // where Starfall's ring grows slowly and reads as a shockwave.
    p.speed = c.poolSpread;
    p.flow = 0;
    p.windAngle = 0;

    p.markLife = c.poolLife;
    p.markRadius = c.poolRadius;

    p.additive = false;
    p.emissive = c.fieldEmissive * g.glow;
    p.opacity = c.fieldOpacity;
    p.depthFade = 0.35;
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

  /**
   * Lay the mist threads for this frame.
   *
   * Runs after `Projectile.update()`, because the endpoints it reads are the
   * ones that call resolved from the live block. Every needle gets a thread,
   * including the ones that have already landed — that is the entire point —
   * and the strip drops one only when the *tail* of it has aged out, which the
   * shader decides, not this method.
   */
  _layThreads(count) {
    const flight = this._needleFlight();
    for (let i = 0; i < count; i++) {
      this.needles.pointAt(i, 0, _launch);
      this.needles.landPoint(i, _land);
      // Handedness: half the threads take their width to the other side of the
      // axis, so twelve parallel ribbons do not all catch the light identically.
      const hand = hash11(this._seed + i * 4.13) < 0.5 ? -1 : 1;
      this.mist.setThread(i, _launch, _land, this._needleDelay(i), flight, hash11(this._seed + i * 9.7), hand);
    }
    this.mist.commit(count);
  }

  /** Push the live block into the mist strip's uniforms. */
  _syncMist(fade) {
    const c = settings.hemolance;
    const g = settings.global;
    const u = this.mist.material.uniforms;

    u.uClock.value = this.age;
    u.uPathCurve.value = Math.max(0.05, c.pathCurve);
    u.uLife.value = Math.max(0.02, c.mistLife * g.lifetime);
    u.uWidth.value = c.mistWidth;
    u.uSpread.value = c.mistSpread;
    u.uDrift.value = c.mistDrift;
    u.uWander.value = c.mistWander * g.turbulence;
    u.uWanderScale.value = c.mistWanderScale * g.noiseFrequency;
    u.uWanderSpeed.value = c.mistWanderSpeed * g.noiseSpeed;
    u.uColorA.value.copy(getColor(c.colorMistA));
    u.uColorB.value.copy(getColor(c.colorMistB));
    u.uColorC.value.copy(getColor(c.colorMistC));
    u.uColorD.value.copy(getColor(c.colorMistD));
    u.uOpacity.value = c.mistOpacity * fade * g.opacity;
    u.uCore.value = c.mistCore;
    u.uFalloff.value = c.mistFalloff;
    u.uSoftFade.value = c.mistSoftFade;
  }

  /** Push the live block into the lance material and the three particle systems. */
  _syncLook(fade) {
    const c = settings.hemolance;
    const g = settings.global;
    const u = this.needleMaterial.uniforms;

    u.uColorCore.value.copy(getColor(c.colorNeedleCore));
    u.uColorEdge.value.copy(getColor(c.colorNeedleEdge));
    u.uColorDeep.value.copy(getColor(c.colorNeedleDeep));
    u.uGlow.value = c.needleGlow * g.glow;
    u.uOpacity.value = c.needleOpacity * fade * g.opacity;
    u.uRim.value = Math.max(0.05, c.needleRim);
    u.uTip.value = c.needleTip;

    this.droplets.setGradient(
      getColor(c.colorDropletA),
      getColor(c.colorDropletB),
      getColor(c.colorDropletC),
      getColor(c.colorDropletD)
    );
    this.droplets.uniforms.uGravity.value.set(0, c.dropletGravity, 0);
    this.droplets.uniforms.uSizeScale.value = c.dropletSize * g.particleSize * 7;
    this.droplets.uniforms.uLifeScale.value = c.dropletLifetime * 0.5 * g.particleLifetime;
    this.droplets.uniforms.uSpeedScale.value = g.particleSpeed;
    this.droplets.uniforms.uOpacity.value = g.opacity;
    this.droplets.uniforms.uTurbulence.value = 0.2 * g.turbulence;

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
    this.spray.uniforms.uStretch.value = c.sprayStretch;
    this.spray.uniforms.uTurbulence.value = 0.25 * g.turbulence;

    this.haze.setGradient(
      getColor(c.colorHazeA),
      getColor(c.colorHazeB),
      getColor(c.colorHazeC),
      getColor(c.colorHazeD)
    );
    this.haze.uniforms.uGravity.value.set(0, c.hazeRise, 0);
    this.haze.uniforms.uSizeScale.value = c.hazeSize * g.particleSize;
    this.haze.uniforms.uLifeScale.value = c.hazeLifetime * 0.5 * g.particleLifetime;
    this.haze.uniforms.uSpeedScale.value = c.hazeSpeed * g.particleSpeed;
    this.haze.uniforms.uOpacity.value = c.hazeOpacity * g.opacity;
    this.haze.uniforms.uTurbulence.value = 0.35 * g.turbulence;
  }

  /**
   * One frame of the whole ability.
   *
   * @param {number} fade 1 while the volley is lit, ramping to 0 as it lets go
   */
  _sync(fade) {
    // The pools are anchored where the needles converge, not at the caster.
    this.pointAt(1, _centre);

    this._syncLook(fade);

    const p = this._fillFlight();
    this.needles.setBasis(this.origin, this.direction, this.side, this.length);
    this.needles.update(this.age, p);
    this._live = this.needles.count;

    for (let i = 0; i < this.needles.arrivalCount; i++) this._needleImpact(this.needles.arrivals[i]);

    this._layThreads(Math.max(0, Math.min(MAX_NEEDLES, Math.round(settings.hemolance.needles))));
    this._syncMist(fade);
    this.floor.update(this._fillGround(fade));
  }

  /* ------------------------------------------------------------------ */
  /* Events                                                              */
  /* ------------------------------------------------------------------ */

  /** The burst at the hand as the volley leaves it. */
  _muzzleFx() {
    const c = settings.hemolance;
    const g = settings.global;

    this._handPoint(_hand);

    this.ctx.bursts.spawn(BurstMode.WATER, _hand, {
      radius: c.muzzleSize * 0.25,
      endRadius: c.muzzleSize * g.explosionIntensity,
      life: 0.35,
      intensity: c.muzzleIntensity,
      opacity: 0.85,
      fresnel: 1.5,
      displace: 0.4,
      colorA: getColor(c.colorMuzzleA),
      colorB: getColor(c.colorMuzzleB),
      colorC: getColor(c.colorMuzzleC)
    });

    _emit.position = _hand;
    _emit.radius = 0.14;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.7).setY(0.4).normalize();
    _emit.speed = c.spraySpeed * 0.6;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.7;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.1;
    _emit.sizeVariance = 0.6;
    _emit.life = c.sprayLifetime;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.spray.emit(Math.round(18 * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
  }

  /**
   * One needle has arrived.
   *
   * The pool goes on the floor *under* the impact rather than at it: the
   * needles converge at chest height, and blood that pools where it was spilled
   * rather than where it landed is the detail that says there is a body there.
   */
  _needleImpact(index) {
    const c = settings.hemolance;
    const g = settings.global;
    const time = frame.uTime.value;

    this.needles.landPoint(index, _pos);

    /* --- the pool, recorded as fractions of the footprint --- */
    const yaw = this._yaw();
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const ox = _pos.x - _centre.x;
    const oz = _pos.z - _centre.z;
    const radius = Math.max(0.05, c.fieldRadius);
    const strength = 0.6 + 0.4 * hash11(this._seed + index * 5.31);
    this.floor.mark((cos * ox - sin * oz) / radius, (sin * ox + cos * oz) / radius, time, strength);

    /* --- the splash --- */
    this.ctx.bursts.spawn(BurstMode.WATER, _pos, {
      radius: c.shellSize * 0.2,
      endRadius: c.shellSize * g.explosionIntensity,
      life: Math.max(0.05, c.shellLife),
      intensity: c.shellIntensity,
      opacity: 0.8,
      fresnel: 1.6,
      displace: 0.5,
      squash: 0.85,
      colorA: getColor(c.colorShellA),
      colorB: getColor(c.colorShellB),
      colorC: getColor(c.colorShellC)
    });

    /* --- spray thrown back along the lance, droplets thrown up --- */
    _emit.position = _pos;
    _emit.radius = 0.08;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(-0.75).setY(0.5).normalize();
    _emit.speed = c.spraySpeed;
    _emit.speedVariance = 0.85;
    _emit.spread = 0.8;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.12;
    _emit.sizeVariance = 0.7;
    _emit.life = c.sprayLifetime;
    _emit.lifeVariance = 0.55;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.spray.emit(Math.round(c.sprayBurst * g.particleCount), _emit);

    _emit.radius = 0.16;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.dropletSpeed;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.95;
    _emit.size = 0.14;
    _emit.life = c.dropletLifetime;
    _emit.spin = 0;
    this.droplets.emit(Math.round(c.dropletBurst * g.particleCount), _emit);

    _emit.radius = 0.3;
    _emit.speed = c.hazeSpeed;
    _emit.spread = 1.0;
    _emit.size = 0.7;
    _emit.life = c.hazeLifetime;
    _emit.spin = 0.3;
    this.haze.emit(Math.round(c.hazeBurst * g.particleCount), _emit);

    /* --- the room --- */
    this.position.copy(_pos);
    this.lightBoost = Math.min(50, this.lightBoost + c.lightPunch * g.explosionIntensity);
    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.05, c.shakeDuration),
      28
    );

    // The flash belongs to the *last* needle, not the first: the ripple builds
    // and the punctuation goes on the end of it. Firing it on the first inverts
    // the rhythm and the volley reads as a decay.
    const last = Math.max(0, Math.min(MAX_NEEDLES, Math.round(c.needles)) - 1);
    if (!this._closed && index >= last) {
      this._closed = true;
      this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._sync(1);

    // The light rides the leading needle while any are still flying, so the
    // floor lights up ahead of the volley rather than behind it.
    if (this._live > 0) this.needles.slotPosition(0, this.position);

    this.ctx.shake.rumble(settings.hemolance.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    // Deliberately empty. The front reaching the end of the line is not an
    // event here — the needles have their own clock and each one brings its own
    // impact, and a bang on this beat lands between two of them.
  }

  onFade(dt, t) {
    // `t` runs 0..1 while the volley holds, then 1..2 while the mist lets go.
    const fade = t <= 1 ? 1 : 1 - Easing.inCubic(saturate(t - 1));
    this._sync(fade);

    if (t <= 1 && this._live > 0) {
      this.needles.slotPosition(0, this.position);
      this.ctx.shake.rumble(settings.hemolance.rumble * settings.global.cameraShake, dt);
    }
  }

  onDestroy() {
    this.needles.reset();
    this.mist.reset();
    this.floor.clearMarks();
    this._live = 0;
    this._closed = false;
  }

  dispose() {
    this.needles.dispose();
    this.mist.dispose();
    this.floor.dispose();
    this.needleMaterial.dispose();
    super.dispose();
  }
}
