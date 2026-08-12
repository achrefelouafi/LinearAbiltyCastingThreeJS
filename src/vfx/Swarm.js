import {
  AdditiveBlending,
  BufferAttribute,
  Color,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  Sphere,
  Vector3
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { disruptGLSL, disruptUniforms } from './SceneHooks.js';
import { LAYER } from '../core/Layers.js';
import { getColor } from '../utils/color.js';

/**
 * What an agent looks like. Drawn as a signed-distance silhouette in the
 * fragment shader — there is no atlas, no alpha map and no sprite sheet.
 */
export const Silhouette = Object.freeze({
  BIRD: 0, // swept wings with a real dihedral fold, body along the heading
  LEAF: 1, // tapered lens with a midrib and a curl across the chord
  CARD: 2, // rounded plate carrying a procedural glyph
  DROPLET: 3, // bulb and tail, tail toward the back
  MOTE: 4 // soft round, the cheapest thing here
});

/** Where the flock's lead point is, and how it moves. */
export const LeadPath = Object.freeze({
  /** A fixed point — a flock milling around a target. */
  POINT: 0,
  /** Down the cast line, with an optional loft. */
  LINE: 1,
  /** A circle about the far point — a cyclone's debris, a summoning ring. */
  ORBIT: 2
});

/* ---------------------------------------------------------------------- */
/* The flock                                                               */
/* ---------------------------------------------------------------------- */

/**
 * The whole flock lives in this vertex shader.
 *
 * A vertex arrives as `(x, y)` on a three-column card plus one per-instance
 * seed and one per-instance index, and leaves as a world position with a full
 * orientation. Nothing about any agent exists on the CPU — no velocities, no
 * neighbour lists, no state that survives a frame — which is what lets four
 * hundred agents cost one draw call and nothing at all in the update loop, and
 * what lets a slider reshape a flock that is already in the air with the clock
 * stopped.
 *
 * Three boid behaviours, none of them simulated:
 *
 *  1. **Cohesion** is a *lag*. Every agent's home is the lead point as it was
 *     `lag` seconds ago, and because the lead is parametric that is one
 *     evaluation, not a history buffer. Agents therefore string out behind the
 *     lead and pour round its corners a beat late, which is most of what
 *     cohesion looks like from outside.
 *  2. **Separation** is a *lattice*. Each agent owns one cell of an
 *     `LX × LY × LZ` grid, decoded from its instance index and rotated per cast
 *     by a wrap-around shift — a bijection, so two agents cannot claim the same
 *     cell. Separation is normally the n² term in a boid solver; here it is
 *     free, and the price is that spacing is authored rather than emergent.
 *     The lattice's third axis is not a distance, it is the **lag**, so the
 *     formation is genuinely three-dimensional: wide, thin, and strung out.
 *  3. **Banking** is the second derivative. Position is sampled at t, t-h and
 *     t-2h, which gives a velocity and an acceleration; the component of that
 *     acceleration along the agent's own wing axis is rolled into the card.
 *     This is the one that matters. A bird that turns without banking reads as
 *     a leaf, and a leaf that banks reads as a bird — the roll *is* the
 *     species.
 *
 * The first version separated agents with a per-agent noise offset instead of
 * the lattice. It gave a cloud, not a flock: the offsets are independent, so
 * agents drift through one another and the whole thing reads as smoke with
 * wings. Distinct cells are what buys the sense of a formation holding.
 */
const SWARM_VERTEX = /* glsl */ `
  #define PI  3.141592653589793
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform float uSeed;

  /* --- the lead --- */
  uniform int   uLeadMode;
  uniform vec3  uLeadA;         // where the flock comes from
  uniform vec3  uLeadB;         // where it is going (or the orbit's centre)
  uniform vec3  uForward;       // unit heading of the cast
  uniform vec3  uSideAxis;      // unit lateral
  uniform float uLeadRise;      // metres the lead lofts at mid-span
  uniform float uLeadS;         // where the lead is now, 0..1 along its path
  uniform float uLeadRate;      // d(s)/dt, so the shader can rewind the lead
  uniform float uOrbitRadius;   // metres
  uniform float uOrbitHeight;   // metres
  uniform float uOrbitTurns;    // turns per unit of s

  /* --- the formation --- */
  uniform vec3  uLattice;       // cells across, up and back (whole numbers)
  uniform float uSpacingSide;   // metres between lateral cells
  uniform float uSpacingUp;     // metres between vertical cells
  uniform float uLag;           // seconds the back rank trails the lead by
  uniform float uJitter;        // metres of per-agent slop off its cell
  uniform float uChurn;         // radians/second the formation rolls
  uniform float uBreathe;       // fraction the formation swells by
  uniform float uBreatheRate;   // radians/second
  uniform float uWander;        // metres of curl-noise drift
  uniform float uWanderScale;   // features per metre
  uniform float uWanderSpeed;
  uniform float uGather;        // 0 collapses every agent onto the lead's path

  /* --- the body --- */
  uniform float uSize;          // metres, nose to tail
  uniform float uAspect;        // span / length
  uniform float uSizeJitter;    // ±fraction
  uniform float uBillboard;     // 0 agent frame, 1 camera facing
  uniform float uBank;          // radians of roll per m/s² of lateral accel
  uniform float uBankMax;       // radians
  uniform float uDihedral;      // wing fold, fraction of size
  uniform float uFlapRate;      // beats/second
  uniform float uCurl;          // leaf curl across the chord, fraction of size
  uniform float uEdgeStretch;   // how much an edge-on card is grown, ≥1
  uniform float uReveal;        // 0..1, agents appear as this passes their dice
  uniform float uRevealSpread;  // 0..1 width of that wave
  uniform vec3  uLightDir;      // world-space direction toward the key light

  attribute float aSeed;        // 0..1, the only thing an agent carries
  attribute float aIndex;       // its slot, used to claim a lattice cell

  ${disruptGLSL}

  varying float vDisrupt;       // spellbreak's field — see vfx/SceneHooks.js
  varying vec2  vUv;
  varying float vSeed;
  varying float vFacing;        // |n · v| — 0 when the card is edge-on
  varying float vNdl;
  varying float vAlpha;
  varying float vViewZ;

  ${noiseGLSL}

  /** Normalise, or fall back — a zero-length basis vector is a NaN silhouette. */
  vec3 safeNormalize(vec3 v, vec3 fallback) {
    float l2 = dot(v, v);
    return l2 > 1e-8 ? v * inversesqrt(l2) : fallback;
  }

  /** The lead point at path parameter s. */
  vec3 leadAt(float s) {
    if (uLeadMode == 2) {
      float a = s * TAU * uOrbitTurns;
      return uLeadB + vec3(cos(a), 0.0, sin(a)) * uOrbitRadius + vec3(0.0, uOrbitHeight, 0.0);
    }
    if (uLeadMode == 1) {
      // Allowed to run behind the start so the tail of the flock is still
      // leaving the hand while the head is downrange; never past the target,
      // because the target is where the ability's impact is.
      float t = clamp(s, -0.5, 1.0);
      vec3 p = mix(uLeadA, uLeadB, t);
      p.y += uLeadRise * sin(PI * clamp(t, 0.0, 1.0));
      return p;
    }
    return uLeadB;
  }

  /**
   * Which cell of the lattice this agent owns.
   *
   * Decoded from the instance index so it is unique by construction, then
   * shifted per cast by a wrap-around offset — still a bijection, so two casts
   * lay the same formation out differently without ever doubling up.
   */
  vec3 cellOf(float idx, vec3 L) {
    vec3 cell = vec3(
      mod(idx, L.x),
      mod(floor(idx / L.x), L.y),
      mod(floor(idx / (L.x * L.y)), L.z)
    );
    vec3 shift = floor(hash31(uSeed * 13.0 + 0.7) * L);
    return mod(cell + shift, L);
  }

  /**
   * Where an agent is, dt seconds from now (dt ≤ 0 for the finite difference).
   */
  vec3 agentAt(vec3 dice, float idx, float dt) {
    vec3 L = max(vec3(1.0), floor(uLattice));
    vec3 cell = cellOf(idx, L);
    vec3 centred = cell - (L - 1.0) * 0.5;

    // The third lattice axis is time, not distance: rank 0 rides the lead, the
    // back rank is uLag seconds behind it.
    float lagN = L.z > 1.0 ? cell.z / (L.z - 1.0) : 0.0;
    float lag = uLag * lagN;

    float t = uTime + dt;
    vec3 home = leadAt(uLeadS + (dt - lag) * uLeadRate);

    vec2 plane = vec2(centred.x * uSpacingSide, centred.y * uSpacingUp);
    plane += (dice.xy - 0.5) * (2.0 * uJitter);
    // The formation rolls as a whole, so the silhouette of the flock keeps
    // changing without any agent leaving its cell.
    plane = rot2(t * uChurn + dice.z * TAU * 0.15 + uSeed) * plane;
    plane *= 1.0 + uBreathe * sin(t * uBreatheRate + dice.y * TAU);

    vec3 pos = home + uSideAxis * plane.x + vec3(0.0, plane.y, 0.0);
    // Keep uWander under half the cell spacing or the lattice's separation
    // guarantee stops being a guarantee.
    pos += curlNoise(pos * uWanderScale + vec3(0.0, t * uWanderSpeed, 0.0) + dice.z * 17.0) * uWander;

    return mix(home, pos, clamp(uGather, 0.0, 1.0));
  }

  void main() {
    vec3 dice = hash31(aSeed * 91.7 + 3.1);
    float idx = aIndex;

    // Three samples: position, velocity, acceleration. The step is a fraction
    // of a second rather than the frame delta on purpose — the bank must not
    // change when the frame rate does.
    const float H = 0.06;
    vec3 p0 = agentAt(dice, idx, 0.0);
    vec3 p1 = agentAt(dice, idx, -H);
    vec3 p2 = agentAt(dice, idx, -2.0 * H);

    vec3 vel = (p0 - p1) / H;
    vec3 acc = (p0 - 2.0 * p1 + p2) / (H * H);

    vec3 forward = safeNormalize(vel, uForward);
    vec3 right = safeNormalize(cross(forward, vec3(0.0, 1.0, 0.0)), uSideAxis);
    vec3 lift0 = cross(right, forward);

    // Bank into the turn. Negative because a bird turning to its right drops
    // its right wing — get the sign backwards and the whole flock reads as
    // sliding rather than turning.
    float bank = clamp(-atan(dot(acc, right) * uBank), -uBankMax, uBankMax);
    // Only the wing axis is rolled; the normal follows from the cross product
    // below, so the card tips as one piece without a second basis to keep in
    // step with the first.
    vec3 wing = right * cos(bank) + lift0 * sin(bank);

    // Camera basis straight off the view matrix's rows.
    vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);

    float bb = clamp(uBillboard, 0.0, 1.0);
    vec3 axisX = safeNormalize(mix(wing, camRight, bb), camRight);
    vec3 axisY = mix(forward, camUp, bb);
    axisY = safeNormalize(axisY - axisX * dot(axisX, axisY), camUp);
    vec3 normal = safeNormalize(cross(axisX, axisY), vec3(0.0, 1.0, 0.0));

    vec3 viewDir = safeNormalize(cameraPosition - p0, vec3(0.0, 0.0, 1.0));
    float facing = abs(dot(normal, viewDir));

    float size = uSize * (1.0 + uSizeJitter * (dice.x - 0.5) * 2.0);
    // An edge-on card is thinner than a pixel and simply disappears; growing it
    // as it turns is what turns the vanishing act into a bright line.
    size *= mix(max(uEdgeStretch, 1.0), 1.0, facing);

    vec2 corner = position.xy;
    vec3 world = p0 + axisX * (corner.x * size * uAspect * 0.5) + axisY * (corner.y * size * 0.5);

    // A real fold, not a painted one: the middle column stays on the plane and
    // the wing columns swing out of it, so the bird genuinely goes edge-on at
    // the top of its stroke.
    float flap = sin(TAU * (uFlapRate * uTime + dice.y));
    world += normal * (uDihedral * abs(corner.x) * flap * size);
    world += normal * (uCurl * corner.x * corner.x * size);

    float threshold = dice.z * (1.0 - clamp(uRevealSpread, 0.0, 1.0));
    vAlpha = smoothstep(threshold, threshold + max(uRevealSpread, 1e-3), clamp(uReveal, 0.0, 1.0));

    vUv = uv;
    vSeed = aSeed;
    vFacing = facing;
    vNdl = abs(dot(normal, normalize(uLightDir)));

    // Opt-in to the disruption field. The mesh matrix is identity and the
    // vertex shader has already placed the card in world space, so this
    // position IS the world point and needs no further transform.
    vDisrupt = disruptAt(world);

    vec4 mv = modelViewMatrix * vec4(world, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

/**
 * The silhouettes.
 *
 * All five are distance fields evaluated in the card's own -1..1 space, so they
 * stay crisp at any size and cost nothing to author. `uShape` is a uniform
 * rather than a `#define` because switching silhouette is a dropdown in the
 * editor, and a recompile in the middle of a drag is a stall you can feel.
 */
const SWARM_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uGlobalGlow;
  uniform vec3  uLightDir;

  uniform int   uShape;
  uniform float uSweep;         // BIRD: how far the wings rake back
  uniform float uGlyphWeight;   // CARD: stroke half-width, card units
  uniform float uGlyphStrokes;  // CARD: strokes in the walk
  uniform float uCardFrame;     // CARD: brightness of the plate's border
  uniform float uEdgeGain;      // emission multiplier when edge-on
  uniform float uLit;           // 0 emissive, 1 wrapped diffuse

  uniform vec3  uColorA;
  uniform vec3  uColorB;
  uniform vec3  uColorC;
  uniform vec3  uColorD;
  uniform float uTint;          // where in the gradient the flock sits
  uniform float uTintJitter;    // ±per-agent walk along it
  uniform float uTintAlong;     // extra walk from head to tail
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uSoftFade;      // metres of depth feather

  ${disruptGLSL}

  varying float vDisrupt;
  varying vec2  vUv;
  varying float vSeed;
  varying float vFacing;
  varying float vNdl;
  varying float vAlpha;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  float segDist(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a;
    vec2 ba = b - a;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-5), 0.0, 1.0);
    return length(pa - ba * h);
  }

  /* --- BIRD ---------------------------------------------------------- */
  float birdMask(vec2 c) {
    float x = abs(c.x);
    float y = c.y;
    // Leading and trailing edges both rake back with the span, which is what
    // makes a two-triangle card read as a wing rather than as a lozenge.
    float lead = 0.62 - uSweep * x + 0.22 * x * x;
    float trail = -0.10 - (uSweep + 0.35) * x;
    float wing = smoothstep(0.0, 0.07, y - trail) * smoothstep(0.0, 0.07, lead - y);
    float body = smoothstep(0.34, 0.14, length(vec2(c.x * 3.4, (y - 0.08) * 0.8)));
    return clamp(max(wing, body), 0.0, 1.0);
  }

  /* --- LEAF ---------------------------------------------------------- */
  float leafMask(vec2 c) {
    float w = max(0.0, 1.0 - c.y * c.y);
    float body = smoothstep(w * 0.66, w * 0.30, abs(c.x));
    float rib = smoothstep(0.05, 0.0, abs(c.x)) * 0.5;
    return clamp(body - rib * 0.35, 0.0, 1.0);
  }

  /* --- CARD ---------------------------------------------------------- */
  /**
   * One lattice point of a 3 × 5 grid inside the card.
   *
   * The grid is what makes the marks read as *writing*. An unconstrained random
   * walk gives scribble; snapping the endpoints to a coarse lattice gives
   * strokes that share terminals and angles across every card in the storm, and
   * a few hundred of those look like an alphabet nobody has taught you.
   */
  vec2 glyphNode(float h) {
    float ix = floor(hash11(h) * 3.0);
    float iy = floor(hash11(h + 11.7) * 5.0);
    return vec2((ix - 1.0) * 0.40, (iy - 2.0) * 0.27);
  }

  float glyphMask(vec2 p, float seed) {
    float d = 1e3;
    vec2 prev = glyphNode(seed);
    float strokes = clamp(uGlyphStrokes, 1.0, 6.0);
    // Masked rather than broken out of: GLSL ES 1.00 wants a constant loop
    // bound, and a break on a uniform is the kind of thing that compiles on
    // the desktop driver and fails on the one the player has.
    for (int i = 1; i <= 6; i++) {
      vec2 next = glyphNode(seed + float(i) * 3.77);
      // A zero-length stroke is a blot; nudge the degenerate case sideways.
      if (dot(next - prev, next - prev) < 1e-4) next += vec2(0.40, 0.0);
      float on = step(float(i), strokes);
      d = min(d, mix(1e3, segDist(p, prev, next), on));
      prev = mix(prev, next, on);
    }
    d = min(d, length(p - prev) - 0.03);
    float weight = max(uGlyphWeight, 1e-3);
    return smoothstep(weight, weight * 0.35, d);
  }

  float cardMask(vec2 c, float seed) {
    vec2 q = abs(c) - vec2(0.74, 0.92);
    float plate = min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - 0.08;
    float frame = smoothstep(0.035, 0.0, abs(plate) - 0.014) * uCardFrame;
    float mark = glyphMask(c * vec2(1.0, 0.86), seed * 37.0 + 1.3);
    return clamp(max(frame, mark), 0.0, 1.0);
  }

  /* --- DROPLET ------------------------------------------------------- */
  float dropletMask(vec2 c) {
    float bulb = length(c - vec2(0.0, -0.34)) - 0.54;
    float t = clamp((c.y + 0.34) / 1.34, 0.0, 1.0);
    float taper = abs(c.x) - 0.54 * pow(1.0 - t, 1.5);
    float d = min(bulb, max(taper, -(c.y + 0.34)));
    return smoothstep(0.07, -0.02, d);
  }

  void main() {
    if (vAlpha < 0.004) discard;

    vec2 c = (vUv - 0.5) * 2.0;

    float mask;
    if (uShape == 0)      mask = birdMask(c);
    else if (uShape == 1) mask = leafMask(c);
    else if (uShape == 2) mask = cardMask(c, vSeed);
    else if (uShape == 3) mask = dropletMask(c);
    else                  mask = smoothstep(1.0, 0.0, length(c));

    if (mask <= 0.004) discard;

    float alpha = mask * vAlpha * uOpacity;
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.004) discard;

    float t = clamp(uTint + uTintJitter * (vSeed - 0.5) * 2.0 + (1.0 - vUv.y) * uTintAlong, 0.0, 1.0);
    vec3 colour = gradient4(uColorA, uColorB, uColorC, uColorD, t);

    // Wrapped, two-sided diffuse: a leaf lit from behind is still a leaf, so the
    // term uses |n·l| rather than a clamped dot.
    colour *= mix(1.0, mix(0.42, 1.3, vNdl), clamp(uLit, 0.0, 1.0));
    // Edge-on is where the storm flickers: the card collapses to a line and the
    // line has to be *brighter* than the plate was, or it just reads as a gap.
    colour *= mix(max(uEdgeGain, 0.0), 1.0, vFacing);
    colour *= uGlow * uGlobalGlow;
    disruptShade(colour, alpha, vDisrupt, gl_FragCoord.xy);

    gl_FragColor = vec4(colour, clamp(alpha, 0.0, 1.0));
  }
`;

/* ---------------------------------------------------------------------- */
/* Scratch — the frame allocates nothing                                   */
/* ---------------------------------------------------------------------- */

const _leadA = new Vector3();
const _leadB = new Vector3();

/* ---------------------------------------------------------------------- */
/* Swarm                                                                   */
/* ---------------------------------------------------------------------- */

/**
 * **What it draws.** Up to a few hundred instanced agents on a
 * shader-evaluated flock: ember birds, falling leaves, a blizzard of glyph
 * cards, blood droplets, drifting motes.
 *
 * **Draw calls.** One. However many agents, however many silhouettes — as long
 * as they share a silhouette. Two flocks that must differ in *shape* are two
 * `Swarm`s and two draw calls.
 *
 * **What it reads from settings.** Nothing directly. `update(now, params)` is
 * handed a live block every frame and resolves every key as `p.key ?? default`,
 * so you can pass `settings[id]` outright or fill a scratch object from it.
 * `swarmParams()` returns the full key list with defaults and units. Every
 * metre in there is live: drag `spacingSide` with **P** held and the formation
 * opens out mid-flight.
 *
 * **The one rule for using it well.** The agents carry a seed and an index and
 * nothing else. If you catch yourself wanting to store an agent's velocity, the
 * answer is another `agentAt()` evaluation at `-H` — the flock is a closed-form
 * function of time and that is the only reason it is free.
 *
 * ---
 *
 * ## Sizing the lattice
 *
 * `latticeX × latticeY × latticeZ` is the number of *distinct* slots. Ask for
 * more agents than that and they start doubling up, which is the one way the
 * separation guarantee breaks. `latticeZ` is the number of ranks strung out
 * behind the lead, and `lag` is how far back the last of them sits in seconds —
 * so a long, thin skein is `4 × 2 × 16`, and a wall of glyphs coming at you is
 * `14 × 10 × 2`.
 */
export class Swarm {
  /**
   * @param {object}  options
   * @param {number}  [options.capacity]    hard ceiling on agents
   * @param {number}  [options.silhouette]  Silhouette.* — the initial shape
   * @param {boolean} [options.additive]    additive (embers) vs normal (leaves)
   * @param {number}  [options.renderOrder]
   */
  constructor(
    parent,
    { capacity = 256, silhouette = Silhouette.BIRD, additive = true, renderOrder = 12 } = {}
  ) {
    this.capacity = Math.max(1, Math.round(capacity));

    this.group = new Group();
    this.group.name = 'Swarm';
    this.group.matrixAutoUpdate = false;
    parent?.add(this.group);

    /*
     * Three columns, two rows. The middle column is what makes the wing fold
     * possible: a four-vertex quad can only ever be flat, and a flat bird does
     * not flap — it strobes. Four triangles is a rounding error next to the
     * fill cost of the silhouette.
     */
    const columns = [-1, 0, 1];
    const positions = new Float32Array(6 * 3);
    const uvs = new Float32Array(6 * 2);
    for (let c = 0; c < 3; c++) {
      for (let r = 0; r < 2; r++) {
        const v = (c * 2 + r) * 3;
        const t = (c * 2 + r) * 2;
        positions[v + 0] = columns[c];
        positions[v + 1] = r === 0 ? -1 : 1;
        positions[v + 2] = 0;
        uvs[t + 0] = (columns[c] + 1) * 0.5;
        uvs[t + 1] = r;
      }
    }
    const indices = new Uint16Array(12);
    for (let c = 0; c < 2; c++) {
      const a = c * 2;
      const o = c * 6;
      indices[o + 0] = a;
      indices[o + 1] = a + 2;
      indices[o + 2] = a + 1;
      indices[o + 3] = a + 1;
      indices[o + 4] = a + 2;
      indices[o + 5] = a + 3;
    }

    this.seeds = new InstancedBufferAttribute(new Float32Array(this.capacity), 1);
    const slots = new Float32Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) {
      this.seeds.array[i] = Math.random();
      slots[i] = i;
    }

    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
    geometry.setAttribute('aSeed', this.seeds);
    geometry.setAttribute('aIndex', new InstancedBufferAttribute(slots, 1));
    geometry.setIndex(new BufferAttribute(indices, 1));
    geometry.instanceCount = 0;
    // Placed in world space by the vertex shader; its own bounds mean nothing.
    geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
    this.geometry = geometry;

    this.material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: additive ? AdditiveBlending : NormalBlending,
      side: DoubleSide,
      toneMapped: false,
      uniforms: sharedUniforms({
        // Opt-in to vfx/SceneHooks.js's disruption field — shared boxes, by
        // identity. See the README's SceneHooks section for the three lines of
        // GLSL that go with it.
        ...disruptUniforms(),
        uSeed: { value: 0 },

        uLeadMode: { value: LeadPath.LINE },
        uLeadA: { value: new Vector3() },
        uLeadB: { value: new Vector3(0, 0, 1) },
        uForward: { value: new Vector3(0, 0, 1) },
        uSideAxis: { value: new Vector3(1, 0, 0) },
        uLeadRise: { value: 0 },
        uLeadS: { value: 0 },
        uLeadRate: { value: 1 },
        uOrbitRadius: { value: 3 },
        uOrbitHeight: { value: 1.5 },
        uOrbitTurns: { value: 1 },

        uLattice: { value: new Vector3(6, 3, 8) },
        uSpacingSide: { value: 0.5 },
        uSpacingUp: { value: 0.35 },
        uLag: { value: 0.5 },
        uJitter: { value: 0.12 },
        uChurn: { value: 0.7 },
        uBreathe: { value: 0.18 },
        uBreatheRate: { value: 1.6 },
        uWander: { value: 0.14 },
        uWanderScale: { value: 0.5 },
        uWanderSpeed: { value: 0.5 },
        uGather: { value: 1 },

        uSize: { value: 0.32 },
        uAspect: { value: 1.5 },
        uSizeJitter: { value: 0.3 },
        uBillboard: { value: 0 },
        uBank: { value: 0.06 },
        uBankMax: { value: 1.2 },
        uDihedral: { value: 0.3 },
        uFlapRate: { value: 5 },
        uCurl: { value: 0 },
        uEdgeStretch: { value: 1.6 },
        uReveal: { value: 1 },
        uRevealSpread: { value: 0.35 },

        uShape: { value: silhouette },
        uSweep: { value: 0.85 },
        uGlyphWeight: { value: 0.07 },
        uGlyphStrokes: { value: 4 },
        uCardFrame: { value: 0.35 },
        uEdgeGain: { value: 2.4 },
        uLit: { value: 0 },

        uColorA: { value: new Color('#ffe6b0') },
        uColorB: { value: new Color('#ff8a3c') },
        uColorC: { value: new Color('#8a2a0c') },
        uColorD: { value: new Color('#1a0a06') },
        uTint: { value: 0.2 },
        uTintJitter: { value: 0.25 },
        uTintAlong: { value: 0.35 },
        uOpacity: { value: 1 },
        uGlow: { value: 1.3 },
        uSoftFade: { value: 0.35 }
      }),
      vertexShader: SWARM_VERTEX,
      fragmentShader: SWARM_FRAGMENT
    });

    this.mesh = new Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.layers.set(LAYER.VFX);
    this.mesh.renderOrder = renderOrder;
    this.group.add(this.mesh);

    /* --- the basis --------------------------------------------------- */

    this._origin = new Vector3();
    this._direction = new Vector3(0, 0, 1);
    this._side = new Vector3(1, 0, 0);
    this._length = 1;

    /**
     * The last block `update()` resolved, defaults filled in. Owned per
     * instance, written into, never replaced — no frame allocates.
     */
    this._p = swarmParams();
    this._p.silhouette = silhouette;
    this.seed = 0;
    this.liveAgents = 0;
  }

  get uniforms() {
    return this.material.uniforms;
  }

  /** Agents drawn on the last update. → `Ability#instanceCount`. */
  get count() {
    return this.liveAgents;
  }

  /** One, however many agents. */
  get drawCalls() {
    return 1;
  }

  /**
   * Four pickers, none derived from another.
   *
   * Takes `THREE.Color`s or `#rrggbb` strings straight out of a settings block;
   * the strings go through the memoised `getColor`, so calling this every frame
   * costs four copies and no allocation.
   */
  setColors(a, b, c, d) {
    const u = this.material.uniforms;
    u.uColorA.value.copy(typeof a === 'string' ? getColor(a) : a);
    u.uColorB.value.copy(typeof b === 'string' ? getColor(b) : b);
    u.uColorC.value.copy(typeof c === 'string' ? getColor(c) : c);
    const tail = d ?? c;
    u.uColorD.value.copy(typeof tail === 'string' ? getColor(tail) : tail);
    return this;
  }

  /** The cast's frame. Called once per frame by the ability. */
  setBasis(origin, direction, side, length) {
    this._origin.copy(origin);
    this._direction.copy(direction);
    this._side.copy(side);
    this._length = Math.max(0.01, length);
    return this;
  }

  /**
   * Re-roll the per-agent seeds. Call from `onSpawn` and nowhere else.
   *
   * The seeds are the *only* thing an agent carries, and they are unitless.
   * Everything else — where its cell is, how far it lags, how big it is, how
   * hard it banks — is resolved from `params` in the vertex shader every frame.
   *
   * @param {number} [seed] per-cast seed; shifts the whole lattice
   */
  roll(seed = Math.random() * 100) {
    this.seed = seed;
    this.material.uniforms.uSeed.value = seed;
    for (let i = 0; i < this.capacity; i++) this.seeds.array[i] = Math.random();
    this.seeds.needsUpdate = true;
    return this;
  }

  /** Hide the flock. Leaves the instance reusable — the pooling contract. */
  reset() {
    this.liveAgents = 0;
    this.geometry.instanceCount = 0;
    this.mesh.visible = false;
  }

  /**
   * Fill `_p` from the caller's block, defaults where it is silent.
   *
   * A `for...in` over sixty keys per frame is a rounding error next to one
   * uniform upload, and it is what lets an ability hand this module its raw
   * `settings[id]` — the version of the contract that cannot be got wrong.
   */
  _resolve(params) {
    const p = this._p;
    for (const key in DEFAULT_PARAMS) {
      const value = params[key];
      p[key] = value === undefined ? DEFAULT_PARAMS[key] : value;
    }
    return p;
  }

  /**
   * Push the live params into the uniforms.
   *
   * @param {number} _now  seconds since the cast began. Accepted for symmetry
   *   with `Projectile`; the flock's own clock is the shared `uTime`, because a
   *   flock is a standing motion rather than an event — its churn should not
   *   restart every time the ability is cast.
   * @param {object} params live block; every key falls back to `swarmParams()`
   *   where it is absent.
   */
  update(_now, params) {
    const p = this._resolve(params ?? DEFAULT_PARAMS);
    const u = this.material.uniforms;

    const count = Math.max(0, Math.min(this.capacity, Math.round(p.count)));
    this.liveAgents = count;
    this.geometry.instanceCount = count;
    this.mesh.visible = count > 0 && p.opacity > 0 && p.size > 0;

    /* --- the lead's endpoints, resolved from the basis every frame --- */
    _leadA
      .copy(this._origin)
      .addScaledVector(this._direction, p.handForward)
      .addScaledVector(this._side, p.handSide);
    _leadA.y = p.handHeight;
    _leadB.copy(this._origin).addScaledVector(this._direction, this._length);
    _leadB.y = p.endHeight;

    u.uLeadMode.value = p.leadMode;
    u.uLeadA.value.copy(_leadA);
    u.uLeadB.value.copy(_leadB);
    u.uForward.value.copy(this._direction);
    u.uSideAxis.value.copy(this._side);
    u.uLeadRise.value = p.leadRise;
    u.uLeadS.value = p.leadS;
    u.uLeadRate.value = p.leadRate;
    u.uOrbitRadius.value = p.orbitRadius;
    u.uOrbitHeight.value = p.orbitHeight;
    u.uOrbitTurns.value = p.orbitTurns;

    /* --- the formation ---------------------------------------------- */
    u.uLattice.value.set(
      Math.max(1, Math.round(p.latticeX)),
      Math.max(1, Math.round(p.latticeY)),
      Math.max(1, Math.round(p.latticeZ))
    );
    u.uSpacingSide.value = p.spacingSide;
    u.uSpacingUp.value = p.spacingUp;
    u.uLag.value = p.lag;
    u.uJitter.value = p.jitter;
    u.uChurn.value = p.churn;
    u.uBreathe.value = p.breathe;
    u.uBreatheRate.value = p.breatheRate;
    u.uWander.value = p.wander;
    u.uWanderScale.value = p.wanderScale;
    u.uWanderSpeed.value = p.wanderSpeed;
    u.uGather.value = p.gather;

    /* --- the body ---------------------------------------------------- */
    u.uSize.value = p.size;
    u.uAspect.value = p.aspect;
    u.uSizeJitter.value = p.sizeJitter;
    u.uBillboard.value = p.billboard;
    u.uBank.value = p.bank;
    u.uBankMax.value = p.bankMax;
    u.uDihedral.value = p.dihedral;
    u.uFlapRate.value = p.flapRate;
    u.uCurl.value = p.curl;
    u.uEdgeStretch.value = p.edgeStretch;
    u.uReveal.value = p.reveal;
    u.uRevealSpread.value = p.revealSpread;

    /* --- the silhouette ---------------------------------------------- */
    u.uShape.value = p.silhouette;
    u.uSweep.value = p.sweep;
    u.uGlyphWeight.value = p.glyphWeight;
    u.uGlyphStrokes.value = p.glyphStrokes;
    u.uCardFrame.value = p.cardFrame;
    u.uEdgeGain.value = p.edgeGain;
    u.uLit.value = p.lit;

    u.uTint.value = p.tint;
    u.uTintJitter.value = p.tintJitter;
    u.uTintAlong.value = p.tintAlong;
    u.uOpacity.value = p.opacity;
    u.uGlow.value = p.glow;
    u.uSoftFade.value = p.softFade;
  }

  /**
   * Where the lead point is right now, in world space.
   *
   * The CPU mirror of `leadAt()` — the ability needs it to place a light, a
   * burst or an emitter on the front of the flock. Mirror, so if you change one
   * change the other.
   */
  leadPoint(out) {
    const p = this._p;
    if (p.leadMode === LeadPath.ORBIT) {
      const a = p.leadS * Math.PI * 2 * p.orbitTurns;
      out.copy(this._origin).addScaledVector(this._direction, this._length);
      out.x += Math.cos(a) * p.orbitRadius;
      out.z += Math.sin(a) * p.orbitRadius;
      out.y = p.endHeight + p.orbitHeight;
      return out;
    }
    if (p.leadMode === LeadPath.LINE) {
      const t = Math.max(-0.5, Math.min(1, p.leadS));
      _leadA
        .copy(this._origin)
        .addScaledVector(this._direction, p.handForward)
        .addScaledVector(this._side, p.handSide);
      _leadA.y = p.handHeight;
      _leadB.copy(this._origin).addScaledVector(this._direction, this._length);
      _leadB.y = p.endHeight;
      out.copy(_leadA).lerp(_leadB, t);
      out.y += p.leadRise * Math.sin(Math.PI * Math.max(0, Math.min(1, t)));
      return out;
    }
    out.copy(this._origin).addScaledVector(this._direction, this._length);
    out.y = p.endHeight;
    return out;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.group.parent?.remove(this.group);
  }
}

/* ---------------------------------------------------------------------- */
/* Params                                                                  */
/* ---------------------------------------------------------------------- */

/**
 * Every key `update()` understands, with its default and its unit.
 *
 * Call it to seed a scratch block you fill from `settings[id]` each frame, or
 * ignore it entirely and hand `update()` your settings block — anything absent
 * falls back to the value here. Defaults exist so that a forgotten field gives
 * a flock rather than a `NaN`, which is the most expensive mistake to debug in
 * this codebase.
 */
export function swarmParams() {
  return {
    /* --- how many --- */
    count: 96, // live agents, clamped to capacity

    /* --- the lead --- */
    leadMode: LeadPath.LINE, // LeadPath.*
    leadS: 0, // where the lead is now, 0..1 along its path
    leadRate: 1, // d(s)/dt — how fast that parameter advances, per second
    leadRise: 1.2, // metres the lead lofts at mid-span
    handForward: 0.6, // metres downrange of the caster
    handSide: 0.35, // metres to the caster's side
    handHeight: 1.4, // metres off the floor
    endHeight: 0.9, // metres off the floor at the target
    orbitRadius: 3, // metres
    orbitHeight: 1.5, // metres above the target
    orbitTurns: 1, // turns per unit of s

    /* --- the formation --- */
    latticeX: 6, // cells across
    latticeY: 3, // cells up
    latticeZ: 8, // ranks strung out behind the lead
    spacingSide: 0.5, // metres between lateral cells
    spacingUp: 0.35, // metres between vertical cells
    lag: 0.5, // seconds the back rank trails the lead by
    jitter: 0.12, // metres of slop off the cell
    churn: 0.7, // radians/second the formation rolls
    breathe: 0.18, // fraction it swells by
    breatheRate: 1.6, // radians/second
    wander: 0.14, // metres of curl drift — keep under half the spacing
    wanderScale: 0.5, // features per metre
    wanderSpeed: 0.5,
    gather: 1, // 0 collapses every agent onto the lead's own path

    /* --- the body --- */
    size: 0.32, // metres, nose to tail
    aspect: 1.5, // span / length
    sizeJitter: 0.3, // ±fraction
    billboard: 0, // 0 agent frame, 1 camera facing
    bank: 0.06, // radians of roll per m/s² of lateral acceleration
    bankMax: 1.2, // radians
    dihedral: 0.3, // wing fold, fraction of size
    flapRate: 5, // beats/second
    curl: 0, // leaf curl across the chord, fraction of size
    edgeStretch: 1.6, // how much an edge-on card grows, ≥1
    reveal: 1, // 0..1 — agents appear as this passes their dice
    revealSpread: 0.35, // width of that wave

    /* --- the silhouette --- */
    silhouette: Silhouette.BIRD,
    sweep: 0.85, // BIRD: wing rake
    glyphWeight: 0.07, // CARD: stroke half-width, card units
    glyphStrokes: 4, // CARD: strokes in the walk, 1..6
    cardFrame: 0.35, // CARD: border brightness
    edgeGain: 2.4, // emission multiplier when edge-on
    lit: 0, // 0 emissive, 1 wrapped diffuse

    /* --- colour --- */
    tint: 0.2, // where in the gradient the flock sits
    tintJitter: 0.25, // ±per-agent walk along it
    tintAlong: 0.35, // extra walk from head to tail
    opacity: 1,
    glow: 1.3,
    softFade: 0.35 // metres of depth feather against solid geometry
  };
}

/** Resolved once at module load; `_resolve` walks its keys every frame. */
const DEFAULT_PARAMS = swarmParams();
