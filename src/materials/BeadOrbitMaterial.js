import {
  BufferAttribute,
  Color,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  NormalBlending,
  ShaderMaterial,
  Sphere,
  Vector3
} from 'three';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * BeadOrbitMaterial — beads of blood on real inclined orbits.
 *
 * ## Why this is not a ring of sprites
 *
 * The first version of Sanguine Pact drew its beads as billboards on a circle
 * in the ground plane, which is what almost every "orbiting motes" effect
 * actually is. It reads as a decal. There is no perspective in it: nothing ever
 * passes *in front of* the mist column and nothing ever passes *behind* it, so
 * the ring sits on the image rather than in the room, and the moment the camera
 * drops toward the floor the whole thing collapses to a line.
 *
 * So these are solid spheres on **inclined ellipses**, and the inclination is
 * the entire point. Every bead owns its own orbital plane — its own ascending
 * node round the vertical, its own tilt off horizontal — so at any instant a
 * third of them are between the camera and the column and the rest are behind
 * it, correctly occluded by the depth buffer they write into themselves. Tip
 * the camera and the ring becomes a sphere of paths. That is what "real orbits"
 * buys and it cannot be faked in two dimensions.
 *
 * ## Everything is in the vertex shader
 *
 * A vertex arrives as a point on a unit icosphere plus two per-instance
 * numbers — a dice roll and an index — and leaves as a world position. No orbit
 * exists on the CPU, so there is nothing to go stale: dragging `orbitTilt` on a
 * paused frame re-inclines every plane, and dragging `beadRim` slides the whole
 * flock onto a different circle. That is invariant I1 kept by construction
 * rather than by discipline.
 *
 * The orbit is built in three steps:
 *
 *  1. **the plane** — a line of nodes `n` in the ground plane at longitude
 *     `node`, and a second axis `t` tipped out of horizontal by `tilt`. Spread
 *     the nodes on the golden angle rather than uniformly: `count` beads evenly
 *     spaced round the vertical produces visible symmetry the moment two orbits
 *     line up, and the golden angle is the standard cure.
 *  2. **the ellipse** — semi-major `a`, semi-minor `a·sqrt(1 - e²)`. A real
 *     ellipse rather than a circle, because a bead that speeds up as it passes
 *     the near focus is most of what says *orbit* rather than *turntable*.
 *  3. **the climb** — each bead's plane sits at its own height up the column,
 *     and `uClimb` lifts the whole stack out of the pool over the beat.
 *
 * ## The seal
 *
 * `uSeal` runs 0 → 1 and does four things at once, which is why it reads as one
 * event: it takes every `tilt` to zero, pulls every `a` onto `uRimRadius`, takes
 * the eccentricity out of the ellipse, and slides each bead's phase onto an
 * evenly spaced slot. The flock flattens into the ring plane and arrives as a
 * rim. `uMerge` then stretches each bead along its own orbital tangent so the
 * beads touch and the rim closes — a scale along a single axis, so the shading
 * normal is the analytic ellipsoid normal rather than the sphere's, which is the
 * difference between a chain of beads and a chain of beads with a lighting bug.
 *
 * The phase mix is deliberately taken against the **cast's own age** and not the
 * global clock. Mixing an angular *rate* against `uTime` would jump the whole
 * flock by tens of turns the instant the seal began; against an age that starts
 * at zero the slew is bounded, and the bounded slew is exactly the "beads racing
 * into their slots" the seal wants.
 */

/** Hard ceiling on beads. The `beadCount` slider clamps here. */
export const MAX_BEADS = 96;

const BEAD_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586
  /** The golden angle in radians — 2*PI*(1 - 1/phi). */
  #define GOLDEN 2.399963229728653

  uniform float uAge;          // seconds since the cast began — the orbital clock
  uniform vec3  uCentre;       // the pool's centre, world metres
  uniform float uSeed;         // per-cast dice roll

  /* ---- the orbits ---- */
  uniform float uCount;        // live beads; the slot spacing is derived from it
  uniform float uRadius;       // mean semi-major axis, metres
  uniform float uRadiusJitter; // +/- fraction of it, per bead
  uniform float uEccentric;    // 0 circle .. 0.9 a long ellipse
  uniform float uTilt;         // radians the mean plane is tipped off horizontal
  uniform float uTiltSpread;   // radians of per-bead variation on that
  uniform float uNodeJitter;   // 0..1 slop on the golden-angle node spacing
  uniform float uSpin;         // turns per second
  uniform float uSpinJitter;   // +/- fraction of it, per bead

  /* ---- the climb ---- */
  uniform float uClimbBase;    // metres above the pool the lowest orbit sits
  uniform float uClimbTop;     // metres the highest orbit reaches
  uniform float uClimb;        // 0..1 the beat
  uniform float uWobble;       // metres of vertical breathing
  uniform float uWobbleRate;   // radians/second of it

  /* ---- the seal ---- */
  uniform float uSeal;         // 0..1 flattens the orbits into the ring plane
  uniform float uRimRadius;    // metres the sealed ring stands at
  uniform float uRimHeight;    // metres above the floor it stands at
  uniform float uMerge;        // 0..1 how far the beads run together
  uniform float uMergeStretch; // how many times longer a fully merged bead is

  /* ---- the body ---- */
  uniform float uBeadSize;     // metres, radius of one bead
  uniform float uSizeJitter;   // +/- fraction of it, per bead
  uniform float uReveal;       // 0..1 the beads appear as this passes their dice
  uniform float uRevealSpread; // width of that wave

  attribute float aSeed;
  attribute float aIndex;

  varying vec3  vNormalW;
  varying vec3  vViewW;
  varying float vClimb;    // 0..1 how far up the column this bead is
  varying float vAlive;    // 0..1 revealed
  varying float vDice;     // the bead's own dice roll, for the tint walk

  /** One cheap hash. Three decorrelated draws per bead is all this needs. */
  float beadHash(float n) {
    return fract(sin(n * 127.1) * 43758.5453123);
  }

  void main() {
    float s0 = aSeed;
    float s1 = beadHash(aIndex * 3.17 + uSeed);
    float s2 = beadHash(aIndex * 7.31 + uSeed + 11.0);
    float s3 = beadHash(aIndex * 11.71 + uSeed + 23.0);

    /* ---- has this bead climbed out of the pool yet ---- */
    float spread = max(uRevealSpread, 1e-3);
    float appear = clamp((uReveal - s0 * (1.0 - spread)) / spread, 0.0, 1.0);

    /* ---- the plane ---- */
    // Golden angle, jittered. Evenly spaced nodes put two orbital planes on top
    // of one another every few beads and the eye finds the pattern instantly.
    float node = aIndex * GOLDEN + s1 * TAU * uNodeJitter + uSeed;
    float tilt = (uTilt + (s2 - 0.5) * 2.0 * uTiltSpread) * (1.0 - uSeal);

    vec3 nAxis = vec3(cos(node), 0.0, sin(node));
    vec3 mAxis = vec3(sin(node), 0.0, -cos(node));   // cross(up, nAxis)
    vec3 tAxis = mAxis * cos(tilt) + vec3(0.0, 1.0, 0.0) * sin(tilt);

    /* ---- the ellipse ---- */
    float a = mix(uRadius * (1.0 + (s3 - 0.5) * 2.0 * uRadiusJitter), uRimRadius, uSeal);
    float ecc = clamp(uEccentric, 0.0, 0.95) * (1.0 - uSeal);
    float b = a * sqrt(max(1.0 - ecc * ecc, 0.02));

    /* ---- where on it ---- */
    // The differential rate is faded out by the seal, and because the clock is
    // the cast's own age the resulting slew is bounded — see the header.
    float rate = uSpin + uSpin * (s2 - 0.5) * 2.0 * uSpinJitter * (1.0 - uSeal);
    float slot = aIndex / max(uCount, 1.0) * TAU;
    float theta = uAge * rate * TAU + mix(s0 * TAU, slot, uSeal);

    /* ---- how high ---- */
    float lane = s1;
    float y = mix(uClimbBase, uClimbBase + uClimbTop * lane, clamp(uClimb, 0.0, 1.0));
    y += uWobble * sin(uAge * uWobbleRate + s2 * TAU);
    y = mix(y, uRimHeight, uSeal);

    vec3 centre = uCentre + vec3(0.0, y, 0.0);
    float ct = cos(theta);
    float st = sin(theta);
    vec3 orbit = centre + nAxis * (a * ct) + tAxis * (b * st);

    /* ---- the body ---- */
    // Stretched along the orbital tangent as the rim closes. A single-axis
    // scale, so the correct normal is the analytic ellipsoid one: divide the
    // tangential component of the unit normal by the square of the scale.
    vec3 tangent = normalize(nAxis * (-a * st) + tAxis * (b * ct) + vec3(1e-5));
    float stretch = 1.0 + uMerge * uSeal * uMergeStretch;
    float size = uBeadSize * (1.0 + (s3 - 0.5) * 2.0 * uSizeJitter) * appear;

    float along = dot(position, tangent);
    vec3 local = position + tangent * (along * (stretch - 1.0));
    vec3 world = orbit + local * size;

    vec3 nrm = normalize(normal - tangent * (dot(normal, tangent) * (1.0 - 1.0 / (stretch * stretch))));

    vNormalW = nrm;
    vViewW = cameraPosition - world;
    vClimb = clamp((y - uClimbBase) / max(uClimbTop, 0.01), 0.0, 1.0);
    vAlive = appear;
    vDice = s0;

    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const BEAD_FRAGMENT = /* glsl */ `
  uniform vec3  uLightDir;
  uniform float uAmbient;      // 0..1 floor on the wrapped diffuse
  uniform float uWrap;         // 0..1 how far the terminator wraps round the back
  uniform float uSpecular;
  uniform float uGloss;        // Blinn exponent
  uniform float uFresnel;
  uniform float uGlow;
  uniform float uOpacity;
  uniform float uFade;
  uniform float uTintAlong;    // how far up the column the gradient walks
  uniform float uTintJitter;   // per-bead walk on top of that
  uniform vec3  uColorBody;
  uniform vec3  uColorDeep;    // the shadow side — almost black
  uniform vec3  uColorRim;     // the fresnel edge
  uniform vec3  uColorSheen;   // the highlight
  uniform float uGlobalGlow;

  varying vec3  vNormalW;
  varying vec3  vViewW;
  varying float vClimb;
  varying float vAlive;
  varying float vDice;

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(vViewW);
    vec3 L = normalize(uLightDir);

    // Wrapped diffuse. A hard lambert on a 4 mm sphere gives a hemisphere of
    // pure black, and forty of those read as holes punched in the mist.
    float ndl = dot(N, L);
    float lam = clamp((ndl + uWrap) / (1.0 + uWrap), 0.0, 1.0);
    float lit = uAmbient + (1.0 - uAmbient) * lam;

    // The tint walk: higher beads are thinner, and every bead is a little
    // different from its neighbour. Both are walks toward the deep colour, so
    // no colour here is derived from another — I5.
    float walk = clamp(vClimb * uTintAlong + (vDice - 0.5) * 2.0 * uTintJitter, 0.0, 1.0);
    vec3 body = mix(uColorBody, uColorDeep, walk) * lit;

    vec3 H = normalize(L + V);
    float spec = pow(max(dot(N, H), 0.0), max(uGloss, 1.0)) * uSpecular;
    float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0) * uFresnel;

    vec3 color = body + uColorSheen * spec + uColorRim * fres;
    color *= uGlow * uGlobalGlow;

    float alpha = uOpacity * uFade * vAlive;
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * One unit icosphere, instanced `capacity` times.
 *
 * The source geometry's arrays are **copied** rather than shared. Handing the
 * icosahedron's own `BufferAttribute`s to the instanced geometry and then
 * disposing the source frees the GPU buffers out from under the copy that is
 * still being drawn, and the symptom is an ability that renders correctly until
 * something else in the scene triggers a resource sweep.
 *
 * @param {number} capacity how many beads the buffer can ever hold
 * @param {number} detail   icosahedron subdivision; 1 is 80 triangles and is
 *                          plenty for a bead a few centimetres across
 */
export function createBeadGeometry(capacity, detail = 1) {
  const source = new IcosahedronGeometry(1, detail);
  const geometry = new InstancedBufferGeometry();

  geometry.setAttribute('position', new BufferAttribute(source.attributes.position.array.slice(), 3));
  geometry.setAttribute('normal', new BufferAttribute(source.attributes.normal.array.slice(), 3));
  if (source.index) geometry.setIndex(new BufferAttribute(source.index.array.slice(), 1));
  source.dispose();

  const seeds = new Float32Array(capacity);
  const indices = new Float32Array(capacity);
  for (let i = 0; i < capacity; i++) {
    seeds[i] = Math.random();
    indices[i] = i;
  }
  geometry.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 1));
  geometry.setAttribute('aIndex', new InstancedBufferAttribute(indices, 1));
  geometry.instanceCount = capacity;

  // Placed entirely by the vertex shader; three's idea of its bounds is a
  // one-metre ball at the origin and has nothing to do with where it draws.
  geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
  return geometry;
}

/**
 * The material. Reads `settings.sanguinepact` in `userData.sync()`, which is
 * the same contract `LightningMaterial` uses: the ability hands over the state
 * that only it knows (where the pool is, how far through the beat it is) and
 * every dimension is re-read here, every frame.
 */
export function createBeadOrbitMaterial() {
  const material = new ShaderMaterial({
    name: 'BeadOrbit',
    // Solid bodies: they write depth so they occlude each other and the mist
    // column correctly, which is the whole reason they are spheres.
    transparent: true,
    depthWrite: true,
    depthTest: true,
    blending: NormalBlending,
    toneMapped: false,
    uniforms: sharedUniforms({
      uAge: { value: 0 },
      uCentre: { value: new Vector3() },
      uSeed: { value: 0 },

      uCount: { value: 48 },
      uRadius: { value: 3 },
      uRadiusJitter: { value: 0.2 },
      uEccentric: { value: 0.45 },
      uTilt: { value: 0.9 },
      uTiltSpread: { value: 0.6 },
      uNodeJitter: { value: 0.15 },
      uSpin: { value: 0.24 },
      uSpinJitter: { value: 0.3 },

      uClimbBase: { value: 0.1 },
      uClimbTop: { value: 3.4 },
      uClimb: { value: 0 },
      uWobble: { value: 0.1 },
      uWobbleRate: { value: 1.6 },

      uSeal: { value: 0 },
      uRimRadius: { value: 3.6 },
      uRimHeight: { value: 0.5 },
      uMerge: { value: 1 },
      uMergeStretch: { value: 2.4 },

      uBeadSize: { value: 0.12 },
      uSizeJitter: { value: 0.35 },
      uReveal: { value: 1 },
      uRevealSpread: { value: 0.35 },

      uAmbient: { value: 0.14 },
      uWrap: { value: 0.6 },
      uSpecular: { value: 1.6 },
      uGloss: { value: 42 },
      uFresnel: { value: 1.1 },
      uGlow: { value: 1 },
      uOpacity: { value: 1 },
      uFade: { value: 1 },
      uTintAlong: { value: 0.5 },
      uTintJitter: { value: 0.25 },
      uColorBody: { value: new Color('#c81a28') },
      uColorDeep: { value: new Color('#2a0207') },
      uColorRim: { value: new Color('#7a0a14') },
      uColorSheen: { value: new Color('#ff9aa0') }
    }),
    vertexShader: BEAD_VERTEX,
    fragmentShader: BEAD_FRAGMENT
  });

  /**
   * Push the live block and the cast's own state into the uniforms.
   *
   * @param {object} state `{ centre, age, seed, count, climb, seal, reveal, fade }`
   *   — the four numbers in the middle are unitless beats and the rest is a
   *   world point and a dice roll. Not one metre comes in through here.
   */
  material.userData.sync = (state) => {
    const c = settings.sanguinepact;
    const g = settings.global;
    const u = material.uniforms;

    u.uAge.value = state.age;
    u.uCentre.value.copy(state.centre);
    u.uSeed.value = state.seed;
    u.uCount.value = state.count;
    u.uClimb.value = state.climb;
    u.uSeal.value = state.seal;
    u.uReveal.value = state.reveal;
    u.uFade.value = state.fade;

    // The footprint the aim indicator promised drives the orbit, the rim and
    // nothing else scales itself independently — that is the sanctioned kind of
    // sharing in I5, because the sharing *is* the design.
    const zone = Math.max(0.05, c.zoneRadius);
    u.uRadius.value = zone * c.orbitScale;
    u.uRadiusJitter.value = c.orbitRadiusJitter * g.randomness;
    u.uEccentric.value = c.orbitEccentric;
    u.uTilt.value = c.orbitTilt;
    u.uTiltSpread.value = c.orbitTiltSpread * g.randomness;
    u.uNodeJitter.value = c.orbitNodeJitter * g.randomness;
    u.uSpin.value = c.orbitSpin;
    u.uSpinJitter.value = c.orbitSpinJitter * g.randomness;

    u.uClimbBase.value = c.beadClimbBase;
    u.uClimbTop.value = c.beadClimbTop;
    u.uWobble.value = c.beadWobble;
    u.uWobbleRate.value = c.beadWobbleRate;

    u.uRimRadius.value = zone * c.rimScale;
    u.uRimHeight.value = c.rimHeight;
    u.uMerge.value = c.rimMerge;
    u.uMergeStretch.value = c.rimMergeStretch;

    u.uBeadSize.value = c.beadSize;
    u.uSizeJitter.value = c.beadSizeJitter * g.randomness;
    u.uRevealSpread.value = c.beadRevealSpread;

    u.uAmbient.value = c.beadAmbient;
    u.uWrap.value = c.beadWrap;
    u.uSpecular.value = c.beadSpecular;
    u.uGloss.value = c.beadGloss;
    u.uFresnel.value = c.beadFresnel * g.fresnel;
    u.uGlow.value = c.beadGlow * g.glow;
    u.uOpacity.value = c.beadOpacity * g.opacity;
    u.uTintAlong.value = c.beadTintAlong;
    u.uTintJitter.value = c.beadTintJitter;

    u.uColorBody.value.copy(getColor(c.colorBeadBody));
    u.uColorDeep.value.copy(getColor(c.colorBeadDeep));
    u.uColorRim.value.copy(getColor(c.colorBeadRim));
    u.uColorSheen.value.copy(getColor(c.colorBeadSheen));
  };

  return material;
}
