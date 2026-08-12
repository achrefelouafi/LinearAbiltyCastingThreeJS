import {
  BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Sphere,
  ShaderMaterial,
  AdditiveBlending,
  DoubleSide,
  Color,
  Vector2,
  Vector3
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * Legs of the cascade the shader can carry — four mirrors plus the run to the
 * floor. A ceiling rather than a count: `refractcascade`'s `mirrors` slider
 * clamps into it, and the geometry's `instanceCount` is set to the live number
 * every frame so the dead instances are never submitted.
 */
export const MAX_BEAM_SEGMENTS = 5;

const TAU = Math.PI * 2;

/* ---------------------------------------------------------------- */
/* Geometry                                                          */
/* ---------------------------------------------------------------- */

/**
 * The column every leg is drawn on — a tube in **parameter** space, instanced.
 *
 * `createBeamTubeGeometry` in `assets/ProceduralGeometry.js` is exactly this
 * grid and is what Nova Beam draws on, but it is a plain `BufferGeometry`: one
 * beam, one draw call. A cascade is four or five beams that are all the same
 * shape function evaluated between different pairs of points, and submitting
 * that as five meshes is five draw calls for one idea.
 *
 * So the grid is instanced and the instance attribute is nothing but the leg's
 * ordinal. Every vertex carries `position = (t, a, 0)` — `t` runs 0 → 1 from the
 * leg's start to its end, `a` once around the barrel — and the vertex shader
 * turns that pair plus `aSegment` into a world position. There are no metres in
 * the buffer, so one upload serves a cascade of any length with the mirrors
 * anywhere.
 *
 * A camera-facing ribbon (`createBoltRibbonGeometry`) would have been cheaper
 * and is wrong here for the reason the beam's own doc comment gives: this thing
 * crosses the frame at four different angles at once and you orbit around it,
 * so the silhouette has to actually bow, and the far wall has to add through
 * the near one where a leg is seen end-on. A ribbon fakes neither.
 *
 * The seam column is duplicated so `a` reaches a full 1.0 rather than wrapping
 * to 0 — the longitudinal grain in the shader would otherwise show a hard join
 * line down every leg.
 *
 * @param {number} nodes    samples along one leg; the ceiling on profile detail
 * @param {number} sides    facets around the barrel (16–24 reads clean)
 * @param {number} segments instance capacity
 */
export function createCascadeBeamGeometry(nodes = 24, sides = 18, segments = MAX_BEAM_SEGMENTS) {
  const steps = Math.max(2, Math.round(nodes));
  const facets = Math.max(3, Math.round(sides));
  const columns = facets + 1;
  const count = Math.max(1, Math.round(segments));

  const positions = new Float32Array(steps * columns * 3);
  let v = 0;
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    for (let j = 0; j < columns; j++) {
      positions[v++] = t;
      positions[v++] = j / facets;
      positions[v++] = 0;
    }
  }

  const indices = new Uint16Array((steps - 1) * facets * 6);
  let k = 0;
  for (let i = 0; i < steps - 1; i++) {
    for (let j = 0; j < facets; j++) {
      const a = i * columns + j;
      const b = a + columns;
      indices[k++] = a;
      indices[k++] = b;
      indices[k++] = a + 1;
      indices[k++] = b;
      indices[k++] = b + 1;
      indices[k++] = a + 1;
    }
  }

  const segmentIndex = new Float32Array(count);
  for (let i = 0; i < count; i++) segmentIndex[i] = i;

  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('aSegment', new InstancedBufferAttribute(segmentIndex, 1));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.instanceCount = count;
  // Placed in world space by the vertex shader — its own bounds mean nothing
  // and the ability sets `frustumCulled = false`.
  geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
  return geometry;
}

/* ---------------------------------------------------------------- */
/* Shaders                                                           */
/* ---------------------------------------------------------------- */

/**
 * The vertex shader owns the whole path.
 *
 * Two things about it are not obvious.
 *
 * **The endpoint lookup is an unrolled loop with an `if` in it**, not
 * `uFrom[int(aSegment)]`. GLSL ES 1.00 guarantees uniform-array indexing only
 * by a constant-index-expression, a loop counter qualifies and a value derived
 * from an attribute does not, and the direct version fails on ANGLE. This is
 * the same shape `FilamentPaths` uses for its role lookup and for the same
 * reason; do not "simplify" it.
 *
 * **The tube's frame is derived from the leg, not carried on it.** Each leg
 * picks a reference axis by looking at how vertical it is and builds two
 * normals off the heading, so the ability never has to compute or store a side
 * vector per mirror. That matters because the mirrors move every frame: a
 * stored frame would be a captured dimension and the tube would twist a frame
 * behind the path it is drawn on.
 */
const BEAM_VERTEX = /* glsl */ `
  attribute float aSegment;      // which leg of the cascade this instance is

  uniform vec3  uFrom[${MAX_BEAM_SEGMENTS}];   // world start of each leg
  uniform vec3  uTo[${MAX_BEAM_SEGMENTS}];     // world end
  uniform vec2  uSpan[${MAX_BEAM_SEGMENTS}];   // its start/end as fractions of the whole path

  uniform float uCount;          // legs live this frame
  uniform float uProgress;       // 0..1 how far down the whole path the light has got
  uniform float uTipSoft;        // fraction of the path the drawn tip tapers over

  uniform float uRadiusNear;     // half-width at the muzzle, metres
  uniform float uRadiusFar;      // ... at the far end
  uniform float uRadiusCurve;    // >1 stays fat and thins late
  uniform float uThrob;          // fraction of the radius that pulses
  uniform float uThrobBands;     // pulses along the whole path
  uniform float uThrobSpeed;     // radians/second they slide at
  uniform float uLoss;           // width and brightness kept per bounce
  uniform float uSeed;
  uniform float uTime;

  varying float vGT;             // position along the WHOLE path, 0..1
  varying float vSeg;            // leg ordinal, as a float
  varying float vGrow;           // 0..1 has the light reached here yet
  varying float vEnergy;         // what is left after the bounces so far
  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying float vViewZ;

  void main() {
    float seg = aSegment;

    /* ---- this instance's leg. Loop counter, never the attribute. ---- */
    vec3 head = uFrom[0];
    vec3 tail = uTo[0];
    vec2 reach = uSpan[0];
    for (int i = 0; i < ${MAX_BEAM_SEGMENTS}; i++) {
      if (float(i) == seg) {
        head = uFrom[i];
        tail = uTo[i];
        reach = uSpan[i];
      }
    }

    float t = position.x;
    float ang = position.y * ${TAU.toFixed(7)};

    /* ---- where this ring sits along the cascade as a whole ---- */
    vGT = mix(reach.x, reach.y, t);
    vSeg = seg;
    // The drawn tip: 1 well behind the front, 0 ahead of it. Written as
    // 1 - smoothstep rather than smoothstep with the edges swapped, because
    // smoothstep with edge0 > edge1 is undefined and one driver in three
    // returns something plausible enough to ship by accident.
    vGrow = 1.0 - smoothstep(max(uProgress - uTipSoft, 0.0), uProgress, vGT);
    vEnergy = pow(max(uLoss, 0.001), seg);

    /* ---- the tube's own frame ---- */
    vec3 axis = tail - head;
    float span = max(length(axis), 1e-4);
    axis /= span;
    vec3 ref = abs(axis.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 n1 = normalize(cross(axis, ref));
    vec3 n2 = cross(axis, n1);
    vec3 outward = cos(ang) * n1 + sin(ang) * n2;

    float radius = mix(uRadiusNear, uRadiusFar, pow(clamp(vGT, 0.0, 1.0), max(uRadiusCurve, 0.05)));
    radius *= vEnergy;
    radius *= 1.0 + uThrob * sin(vGT * uThrobBands * ${TAU.toFixed(7)} - uTime * uThrobSpeed + uSeed);
    // Collapse to the axis where the light has not arrived, and for any
    // instance past the live count — a degenerate tube costs nothing and is
    // simpler than a second branch in the fragment stage.
    radius *= vGrow * step(seg, uCount - 0.5);

    vec3 world = mix(head, tail, t) + outward * max(radius, 0.0);

    vNormalW = outward;
    vViewDir = cameraPosition - world;
    vec4 mv = viewMatrix * vec4(world, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

/**
 * The fragment shader shades a cylinder wall, and the two terms it is made of
 * are opposites on purpose.
 *
 * `pow(|N·V|, coreSharp)` peaks where the wall faces the camera — the *middle*
 * of the silhouette — and is what makes a beam of light read as a beam rather
 * than as a pipe. `pow(1 - |N·V|, rimPower)` peaks at the grazing edge and is
 * the glass: without it a bright additive tube has no boundary and dissolves
 * into its own bloom.
 *
 * The first version had only the rim term, which is the reflex from writing
 * fresnel on everything, and it produced a hollow drinking straw — bright edges
 * with nothing between them. The one after that had only the core term and the
 * beam had no silhouette at all against a bright floor. Both are cheap; the
 * point is that they answer different questions and an emissive tube needs
 * both.
 *
 * `vEnergy` is the physical bit: each bounce keeps `uLoss` of the width and the
 * brightness, so the cascade visibly runs down. A cascade whose fourth leg is
 * as hot as its first says the mirrors are amplifiers.
 */
const BEAM_FRAGMENT = /* glsl */ `
  uniform vec3  uColorCore;
  uniform vec3  uColorInner;
  uniform vec3  uColorOuter;
  uniform vec3  uColorHalo;

  uniform float uCoreSharp;      // how fast the body falls off toward the silhouette
  uniform float uCoreTight;      // how small the white centre is
  uniform float uRimPower;       // how tight the glass edge is
  uniform float uRim;            // how strong it is
  uniform float uBands;          // travelling energy bands along the path
  uniform float uBandDepth;
  uniform float uBandSpeed;      // radians/second
  uniform float uBandStagger;    // radians of phase added per leg
  uniform float uGrain;          // longitudinal noise on the body
  uniform float uGrainScale;
  uniform float uGrainSpeed;
  uniform float uTipGlow;        // extra heat right behind the drawn front
  uniform float uTipLength;      // how far back that reaches, fraction of the path
  uniform float uGlow;
  uniform float uOpacity;
  uniform float uSoft;           // metres of soft fade where a leg meets geometry
  uniform float uFade;
  uniform float uProgress;
  uniform float uSeed;

  uniform float     uTime;
  uniform vec2      uResolution;
  uniform sampler2D uSceneDepth;
  uniform float     uCameraNear;
  uniform float     uCameraFar;
  uniform float     uGlobalGlow;

  varying float vGT;
  varying float vSeg;
  varying float vGrow;
  varying float vEnergy;
  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(vViewDir);
    float ndv = clamp(abs(dot(N, V)), 0.0, 1.0);

    float core = pow(ndv, max(uCoreSharp, 0.05));
    float rim = pow(1.0 - ndv, max(uRimPower, 0.05));

    float bands = 0.5 + 0.5 * sin(vGT * uBands * 6.2831853 - uTime * uBandSpeed + vSeg * uBandStagger);
    float grain = snoise(vec3(vGT * uGrainScale, vSeg * 7.3 + uSeed, uTime * uGrainSpeed));
    float body = core * (1.0 + uBandDepth * (bands - 0.5)) * (1.0 + uGrain * grain * 0.5);

    // The head of the light, while it is still travelling. Zero once the
    // cascade is complete, because there is no front any more.
    float behind = max(uProgress - vGT, 0.0);
    float tip = (1.0 - smoothstep(0.0, max(uTipLength, 1e-4), behind)) * uTipGlow * step(uProgress, 0.999);

    vec3 color = mix(uColorOuter, uColorInner, clamp(core, 0.0, 1.0));
    color = mix(color, uColorCore, pow(clamp(core, 0.0, 1.0), max(uCoreTight, 0.05)));
    color *= max(body, 0.0);
    color += uColorHalo * rim * uRim;
    color += uColorCore * tip * core;
    color *= vEnergy;

    // The soft ceiling every emissive surface in this project carries: the
    // terms above are independent and stack, and a rim crossing the white
    // centre sums past 10 where the bloom pass eats the silhouette whole.
    color *= uGlow * uGlobalGlow;
    color /= 1.0 + color * 0.14;

    float alpha = clamp(body + rim * uRim * 0.5 + tip * 0.4, 0.0, 1.0) * uOpacity * uFade * vGrow;

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoft);
    if (alpha < 0.004) discard;

    gl_FragColor = vec4(color, alpha);
  }
`;

/* ---------------------------------------------------------------- */
/* The material                                                      */
/* ---------------------------------------------------------------- */

const _head = new Vector3();
const _tail = new Vector3();

/**
 * The cascade's beam: every leg between the mirrors, in one draw call.
 *
 * ```js
 * this.beamGeometry = createCascadeBeamGeometry(24, 18);
 * this.beamMaterial = createCascadeBeamMaterial();
 * // per frame, after the nodes have been resolved from settings:
 * this.beamGeometry.instanceCount = legs;
 * this.beamMaterial.userData.sync(this._nodes, legs, state);
 * ```
 *
 * `sync()` is handed the ability's own array of node positions — muzzle,
 * every mirror in order, then the floor — and works out each leg's share of the
 * total path length itself, every frame, from wherever the nodes are *now*.
 * That is the piece that has to live here rather than in the ability: the legs
 * are different lengths and the front has to cross them at one speed, so the
 * mapping from "fraction of the whole cascade" to "fraction of this leg" is a
 * function of the live geometry and cannot be cached across a frame in which
 * anybody dragged a mirror.
 */
export function createCascadeBeamMaterial() {
  const from = [];
  const to = [];
  const span = [];
  for (let i = 0; i < MAX_BEAM_SEGMENTS; i++) {
    from.push(new Vector3());
    to.push(new Vector3());
    span.push(new Vector2(i / MAX_BEAM_SEGMENTS, (i + 1) / MAX_BEAM_SEGMENTS));
  }

  const material = new ShaderMaterial({
    name: 'CascadeBeam',
    transparent: true,
    depthWrite: false,
    depthTest: true,
    // A leg is thin enough that its far wall is always in shot, and the two
    // walls adding is most of why it reads as light rather than as plastic.
    side: DoubleSide,
    blending: AdditiveBlending,
    toneMapped: false,
    uniforms: sharedUniforms({
      uFrom: { value: from },
      uTo: { value: to },
      uSpan: { value: span },

      uCount: { value: 1 },
      uProgress: { value: 1 },
      uTipSoft: { value: 0.02 },

      uRadiusNear: { value: 0.09 },
      uRadiusFar: { value: 0.06 },
      uRadiusCurve: { value: 1 },
      uThrob: { value: 0.06 },
      uThrobBands: { value: 7 },
      uThrobSpeed: { value: 5 },
      uLoss: { value: 0.86 },
      uSeed: { value: 0 },

      uColorCore: { value: new Color('#ffffff') },
      uColorInner: { value: new Color('#ffeec2') },
      uColorOuter: { value: new Color('#ffb43c') },
      uColorHalo: { value: new Color('#5fd8ff') },

      uCoreSharp: { value: 2.2 },
      uCoreTight: { value: 3.4 },
      uRimPower: { value: 2.6 },
      uRim: { value: 0.9 },
      uBands: { value: 9 },
      uBandDepth: { value: 0.4 },
      uBandSpeed: { value: 6 },
      uBandStagger: { value: 1.1 },
      uGrain: { value: 0.35 },
      uGrainScale: { value: 14 },
      uGrainSpeed: { value: 1.4 },
      uTipGlow: { value: 2.2 },
      uTipLength: { value: 0.05 },
      uGlow: { value: 2.8 },
      uOpacity: { value: 1 },
      uSoft: { value: 0.35 },
      uFade: { value: 1 }
    }),
    vertexShader: BEAM_VERTEX,
    fragmentShader: BEAM_FRAGMENT
  });

  /**
   * Push the live settings and this frame's polyline into the beam.
   *
   * @param {THREE.Vector3[]} nodes  `legs + 1` world points, muzzle first
   * @param {number} legs            how many of them are live
   * @param {object} state           `{ progress, fade, seed }`
   */
  material.userData.sync = (nodes, legs, state) => {
    const c = settings.refractcascade;
    const g = settings.global;
    const u = material.uniforms;
    const count = Math.max(1, Math.min(MAX_BEAM_SEGMENTS, Math.round(legs)));

    /* --- the polyline, and each leg's share of it --- */
    // Total length first, then a running cursor: the front has to cross a long
    // leg in proportionally longer, or it appears to accelerate every time the
    // mirrors are moved closer together.
    let total = 0;
    for (let i = 0; i < count; i++) {
      _head.copy(nodes[i]);
      _tail.copy(nodes[i + 1]);
      total += _head.distanceTo(_tail);
    }
    total = Math.max(total, 1e-4);

    let cursor = 0;
    for (let i = 0; i < MAX_BEAM_SEGMENTS; i++) {
      const live = i < count;
      const a = nodes[live ? i : count];
      const b = nodes[live ? i + 1 : count];
      u.uFrom.value[i].copy(a);
      u.uTo.value[i].copy(b);
      const length = live ? a.distanceTo(b) : 0;
      u.uSpan.value[i].set(cursor / total, (cursor + length) / total);
      cursor += length;
    }

    u.uCount.value = count;
    u.uProgress.value = state.progress;
    u.uTipSoft.value = Math.max(1e-4, c.beamTipSoft);
    u.uSeed.value = state.seed;

    u.uRadiusNear.value = c.beamRadiusNear;
    u.uRadiusFar.value = c.beamRadiusFar;
    u.uRadiusCurve.value = c.beamRadiusCurve;
    u.uThrob.value = c.beamThrob;
    u.uThrobBands.value = c.beamThrobBands;
    u.uThrobSpeed.value = c.beamThrobSpeed * g.animationSpeed;
    u.uLoss.value = c.bounceLoss;

    u.uColorCore.value.copy(getColor(c.colorBeamCore));
    u.uColorInner.value.copy(getColor(c.colorBeamInner));
    u.uColorOuter.value.copy(getColor(c.colorBeamOuter));
    u.uColorHalo.value.copy(getColor(c.colorBeamHalo));

    u.uCoreSharp.value = c.beamCoreSharp;
    u.uCoreTight.value = c.beamCoreTight;
    u.uRimPower.value = c.beamRimPower;
    u.uRim.value = c.beamRim * g.fresnel;
    u.uBands.value = c.beamBands;
    u.uBandDepth.value = c.beamBandDepth;
    u.uBandSpeed.value = c.beamBandSpeed * g.animationSpeed;
    u.uBandStagger.value = c.beamBandStagger;
    u.uGrain.value = c.beamGrain * g.noiseStrength;
    u.uGrainScale.value = c.beamGrainScale * g.noiseFrequency;
    u.uGrainSpeed.value = c.beamGrainSpeed * g.noiseSpeed;
    u.uTipGlow.value = c.beamTipGlow;
    u.uTipLength.value = c.beamTipLength;
    u.uGlow.value = c.beamGlow * g.glow;
    u.uOpacity.value = c.beamOpacity * g.opacity;
    u.uSoft.value = c.beamSoftFade;
    u.uFade.value = state.fade;
  };

  return material;
}
