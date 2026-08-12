import {
  AdditiveBlending,
  BufferAttribute,
  Color,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  NormalBlending,
  ShaderMaterial,
  Sphere,
  Vector2,
  Vector3
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { getColor } from '../utils/color.js';

/**
 * WildfireMaterial — how a cellular automaton is drawn without a texture.
 *
 * ## The problem this file exists to solve
 *
 * Wildfire's trick is that the spread is a real automaton on a grid: cell to
 * cell, biased by wind, jumping gaps, leaving islands, burning back over its
 * own ground. The state of that automaton is a few hundred numbers that change
 * every tick, and the obvious way to get a few hundred numbers onto the GPU is
 * a `DataTexture` — which invariant **I2** forbids, and rightly: a texture is a
 * resource with a size, a filter and a format, and this sandbox has spent fifty
 * abilities proving it does not need one.
 *
 * So the grid is **instanced geometry**: one quad per cell, with the cell's
 * state carried in instanced attributes the ability writes into directly. Two
 * meshes — the burnt floor and the flames standing on it — share one set of
 * attribute objects, so the state is one array, one upload, and the flame on a
 * cell can never disagree with the scar under it. Both are one draw call each,
 * whatever the grid resolution.
 *
 * ## What is a dimension and what is not
 *
 * Per cell the attributes are: its **lattice coordinate** (a pair of integers),
 * two **dice rolls** (a placement jitter and a seed), its **fuel** (0..1) and
 * the **timestamp** it caught fire, or a negative number if it has not. Not one
 * of those is a metre or a second of duration. The pitch of the lattice is
 * `2·zoneRadius / grid`, resolved in `update()` every frame, so dragging the
 * zone radius on a paused fire re-scales the whole burn — cells, flames,
 * jitter and all — and the *pattern* stays exactly the pattern the automaton
 * produced. That separation is the entire reason the CA state is unitless.
 *
 * ## Why the flames are not Firewalk's pillars
 *
 * They look related and they are deliberately not shared. A Firewalk pillar is
 * one of a dozen, tall, individually authored and individually watched; a
 * Wildfire flame is one of several hundred, short, and only ever read as part
 * of a *front*. Folding them together gives one material with a mode switch and
 * two sets of uniforms that are dead in the other mode, which is exactly the
 * shape of thing this project keeps refusing to write.
 */

/* ====================================================================== */
/* The lattice                                                            */
/* ====================================================================== */
/**
 * Where cell `(col, row)` is, in world metres.
 *
 * `uGrid` is a **count** — the automaton's own topology, fixed for the life of
 * a cast because changing it mid-burn would renumber every cell — and `uPitch`
 * is a metre, re-resolved every frame. Keeping those two apart is what lets the
 * zone radius stay a live slider over a running simulation.
 */
export const CELL_LATTICE_GLSL = /* glsl */ `
  uniform vec3  uCentre;      // world, on the floor, the middle of the zone
  uniform vec3  uForward;     // unit, downrange (lattice +y)
  uniform vec3  uSideAxis;    // unit, lateral (lattice +x)
  uniform float uGrid;        // cells across — a count, not a measurement
  uniform float uPitch;       // metres between cell centres
  uniform float uJitter;      // metres of per-cell placement slop
  uniform float uLift;        // metres above the floor
  uniform float uNow;         // the ability's age, seconds

  attribute vec2  aCell;      // lattice coordinate
  attribute vec2  aJitter;    // two dice rolls, -1..1
  attribute float aSeed;      // dice roll
  attribute float aFuel;      // 0..1 fuel this cell had when it caught
  attribute float aIgnite;    // timestamp it caught, or negative

  /** Lattice coordinate to metres in the zone's own frame. */
  vec2 cellOffset(vec2 cell) {
    return (cell - (uGrid - 1.0) * 0.5) * uPitch + aJitter * uJitter;
  }

  vec3 cellCentre(vec2 cell) {
    vec2 o = cellOffset(cell);
    return uCentre + uSideAxis * o.x + uForward * o.y;
  }
`;

/* ====================================================================== */
/* The burnt floor                                                        */
/* ====================================================================== */
/**
 * One ground quad per cell that has caught.
 *
 * A cell that has never been lit is culled in the vertex shader, so the scar on
 * the floor **is** the automaton's state — you are looking straight at the
 * array. That is the point: the unburnt islands are holes in this mesh, not
 * darker patches in a texture, and the front is a jagged boundary between
 * instances rather than a smoothstep on a radius.
 *
 * `uBlock` is the honesty slider. At 1 a cell is a square and the lattice is
 * plainly visible; at 0 it is a disc and the burn reads as organic. It ships
 * near the middle, where the grid is *felt* rather than counted — which is
 * where an automaton should sit, because hiding the lattice completely throws
 * away the only visual evidence that the spread is simulated at all.
 */
const CELL_VERTEX = /* glsl */ `
  ${CELL_LATTICE_GLSL}

  uniform float uCellSize;    // metres, the drawn width of a cell

  varying vec2  vLocal;       // -1..1 within the cell
  varying vec3  vWorld;
  varying float vAge;         // seconds since this cell caught
  varying float vFuel;
  varying float vSeed;
  varying float vViewZ;

  void main() {
    if (aIgnite < 0.0) {
      vLocal = vec2(0.0);
      vWorld = vec3(0.0);
      vAge = -1.0;
      vFuel = 0.0;
      vSeed = 0.0;
      vViewZ = -1.0;
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    vec2 local = position.xz * uCellSize;
    vec3 world = cellCentre(aCell) + uSideAxis * local.x + uForward * local.y;
    world.y = uLift;

    vLocal = position.xz * 2.0;
    vWorld = world;
    vAge = uNow - aIgnite;
    vFuel = aFuel;
    vSeed = aSeed;

    vec4 mv = modelViewMatrix * vec4(world, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const CELL_FRAGMENT = /* glsl */ `
  uniform vec2      uResolution;
  uniform sampler2D uSceneDepth;
  uniform float     uCameraNear;
  uniform float     uCameraFar;
  uniform float     uGlobalGlow;

  uniform float uBlock;       // 0 a disc, 1 a square — how visible the lattice is
  uniform float uRough;       // 0..1 noise chewed out of the cell's edge
  uniform float uRoughScale;  // features per metre on that noise
  uniform float uCatchTime;   // seconds a cell takes to come up to full heat
  uniform float uBurnTime;    // seconds a cell with full fuel burns for
  uniform float uCharTime;    // seconds the char takes to blacken
  uniform float uAshTime;     // seconds after burnout the ash takes to grey over
  uniform float uVein;        // 0..1 how much of the ember is vein rather than wash
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uFade;
  uniform float uSoftFade;    // metres of depth feather

  uniform vec3 uColorFlash;   // the moment it catches
  uniform vec3 uColorEmber;
  uniform vec3 uColorChar;
  uniform vec3 uColorAsh;

  varying vec2  vLocal;
  varying vec3  vWorld;
  varying float vAge;
  varying float vFuel;
  varying float vSeed;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  /** Rounded box, in the cell's own -1..1 space. */
  float sdCell(vec2 p, float corner) {
    vec2 q = abs(p) - vec2(1.0) + corner;
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - corner;
  }

  void main() {
    if (vAge < 0.0 || uFade < 0.004) discard;

    float corner = clamp(1.0 - uBlock, 0.0, 1.0);
    float sd = sdCell(vLocal, corner);
    // Chewed in world metres, so neighbouring cells erode into each other and
    // the burn stops being a mosaic of identical tiles.
    sd += (snoise(vec3(vWorld.xz * max(uRoughScale, 0.01), vSeed * 5.3)) * 0.5) * uRough;

    float cover = 1.0 - smoothstep(-0.12, 0.06, sd);
    if (cover < 0.004) discard;

    // How long this cell burns is its own fuel times a live setting: a rich
    // cell is a long, hot burn, a starved one flares and dies. Drag the burn
    // time on a paused fire and every cell re-times at once.
    float burn = max(vFuel, 0.05) * max(uBurnTime, 0.05);
    float rise = smoothstep(0.0, max(uCatchTime, 1e-3), vAge);
    float heat = rise * (1.0 - smoothstep(burn * 0.55, burn, vAge));
    float soot = 1.0 - exp(-vAge / max(uCharTime, 0.05));
    float ash = smoothstep(burn, burn + max(uAshTime, 0.05), vAge);

    float grain = snoise(vec3(vWorld.xz * max(uRoughScale, 0.01) * 2.7, vSeed * 17.0)) * 0.5 + 0.5;
    float vein = mix(1.0, smoothstep(0.45 - uVein * 0.35, 0.8, grain), clamp(uVein, 0.0, 1.0));

    vec3 colour = mix(uColorChar, uColorAsh, ash);
    colour = mix(uColorChar, colour, soot);
    colour += uColorEmber * heat * vein * uGlow * uGlobalGlow;
    // The catch itself: a hard white flick on the frame a cell takes, which is
    // what makes the front read as a chain of ignitions rather than a wipe.
    colour += uColorFlash * exp(-pow(vAge / max(uCatchTime * 1.4, 1e-3), 2.0)) * uGlow * uGlobalGlow;

    float alpha = cover * uOpacity * uFade;
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.004) discard;

    gl_FragColor = vec4(colour, clamp(alpha, 0.0, 1.0));
  }
`;

/* ====================================================================== */
/* The flames                                                             */
/* ====================================================================== */
/**
 * One upright billboard per burning cell, leaning downwind.
 *
 * The lean is the same wind vector the automaton spreads along, handed in as
 * two components in the lattice's frame. Getting that agreement right is worth
 * more than any amount of flame detail: a front that spreads north-east while
 * its flames lean south-west is instantly, unaccountably wrong, and it took a
 * while to work out that *that* was what looked wrong rather than the noise.
 *
 * Cells that are not burning collapse to nothing through `heat`, so the mesh
 * carries every cell and draws only the front. No compaction, no sorting, no
 * per-frame rebuild: the flames are wherever the state array says the fire is.
 */
const FLAME_VERTEX = /* glsl */ `
  ${CELL_LATTICE_GLSL}

  uniform float uHeight;      // metres at full heat on a full-fuel cell
  uniform float uWidth;       // metres, half-width at the base
  uniform float uCatchTime;   // seconds a cell takes to come up to full heat
  uniform float uBurnTime;    // seconds a cell with full fuel burns for
  uniform float uLean;        // metres the crown leans downwind
  uniform vec2  uWind;        // unit-ish, in the lattice frame
  uniform float uWaver;       // metres of sway at the crown
  uniform float uWaverRate;   // sways per second

  varying vec2  vQuad;        // x: -1..1 across, y: 0..1 up
  varying vec3  vWorld;
  varying float vHeat;
  varying float vSeed;
  varying float vViewZ;

  void main() {
    float age = uNow - aIgnite;
    float burn = max(aFuel, 0.05) * max(uBurnTime, 0.05);
    float heat = aIgnite < 0.0
      ? 0.0
      : smoothstep(0.0, max(uCatchTime, 1e-3), age) * (1.0 - smoothstep(burn * 0.5, burn, age));

    if (heat < 0.01) {
      vQuad = vec2(0.0);
      vWorld = vec3(0.0);
      vHeat = 0.0;
      vSeed = 0.0;
      vViewZ = -1.0;
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    vec3 base = cellCentre(aCell);
    base.y = uLift;

    // Cylindrical billboard: the camera's right, flattened into the floor plane.
    // A full billboard tips the whole front over as the camera orbits, which
    // reads as the wind following you around the room.
    vec3 camRight = normalize(vec3(viewMatrix[0][0], 0.0, viewMatrix[2][0]) + vec3(1e-5, 0.0, 0.0));
    vec3 windDir = uSideAxis * uWind.x + uForward * uWind.y;

    float h = position.y + 0.5;
    float across = position.x * 2.0;
    float grow = heat * (0.45 + 0.55 * aFuel);
    float sway = sin(uNow * uWaverRate + aSeed * 6.2831) * uWaver * h * h;

    vec3 world = base
      + camRight * (across * uWidth * grow + sway)
      + vec3(0.0, h * uHeight * grow, 0.0)
      + windDir * (uLean * h * h * grow);

    vQuad = vec2(across, h);
    vWorld = world;
    vHeat = heat;
    vSeed = aSeed;

    vec4 mv = modelViewMatrix * vec4(world, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const FLAME_FRAGMENT = /* glsl */ `
  uniform vec2      uResolution;
  uniform sampler2D uSceneDepth;
  uniform float     uCameraNear;
  uniform float     uCameraFar;
  uniform float     uGlobalGlow;
  uniform float     uTime;

  uniform float uTaper;
  uniform float uBulge;
  uniform float uNoiseScale;
  uniform float uNoiseSpeed;
  uniform float uErosion;
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uFade;
  uniform float uSoftFade;

  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uColorC;
  uniform vec3 uColorD;

  varying vec2  vQuad;
  varying vec3  vWorld;
  varying float vHeat;
  varying float vSeed;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    if (vHeat < 0.01 || uFade < 0.004) discard;

    float h = clamp(vQuad.y, 0.0, 1.0);
    float profile = pow(1.0 - h, max(uTaper, 0.05)) * (1.0 + uBulge * sin(h * 3.14159265));
    float body = 1.0 - abs(vQuad.x) / max(profile, 1e-3);
    if (body <= 0.0) discard;

    // World-space field: two cells side by side flicker independently, which is
    // the difference between a fire front and a row of identical sprites.
    float n = fbm3(vec3(vWorld.xz * uNoiseScale, vWorld.y * uNoiseScale - uTime * uNoiseSpeed) + vSeed * 7.0);
    float shape = body - uErosion * (0.5 + 0.5 * n) * h;

    float alpha = smoothstep(0.0, 0.3, shape) * vHeat * uOpacity * uFade;
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.004) discard;

    vec3 colour = gradient4(uColorA, uColorB, uColorC, uColorD, clamp(h * 0.9 + (1.0 - shape) * 0.25, 0.0, 1.0));
    colour *= uGlow * uGlobalGlow * mix(0.55, 1.0, vHeat);

    gl_FragColor = vec4(colour, clamp(alpha, 0.0, 1.0));
  }
`;

/* ====================================================================== */
/* Construction                                                           */
/* ====================================================================== */

/**
 * The uniform boxes the two materials **share by identity** — the lattice, the
 * clock and where the zone is. One write per frame drives the scar and the
 * flame standing on it, so they cannot part company on a frame where one was
 * updated and the other was not.
 */
export function createWildfirePlacement() {
  return {
    uCentre: { value: new Vector3() },
    uForward: { value: new Vector3(0, 0, 1) },
    uSideAxis: { value: new Vector3(1, 0, 0) },
    uGrid: { value: 24 },
    uPitch: { value: 0.4 },
    uJitter: { value: 0.06 },
    uLift: { value: 0.014 },
    uNow: { value: 0 }
  };
}

/**
 * The five per-cell attributes, built once and handed to both geometries.
 *
 * `aCell` and `aJitter` are set here and never touched again; `aFuel` and
 * `aIgnite` are the automaton's state, written straight into these arrays by
 * the ability every frame. Nothing is allocated during a cast.
 */
export function createCellAttributes(capacity, grid) {
  const cell = new Float32Array(capacity * 2);
  const jitter = new Float32Array(capacity * 2);
  const seed = new Float32Array(capacity);
  const fuel = new Float32Array(capacity);
  const ignite = new Float32Array(capacity);
  for (let i = 0; i < capacity; i++) {
    cell[i * 2] = i % grid;
    cell[i * 2 + 1] = Math.floor(i / grid);
    jitter[i * 2] = Math.random() * 2 - 1;
    jitter[i * 2 + 1] = Math.random() * 2 - 1;
    seed[i] = Math.random() * 100;
    fuel[i] = 0;
    ignite[i] = -1;
  }
  return {
    aCell: new InstancedBufferAttribute(cell, 2),
    aJitter: new InstancedBufferAttribute(jitter, 2),
    aSeed: new InstancedBufferAttribute(seed, 1),
    aFuel: new InstancedBufferAttribute(fuel, 1),
    aIgnite: new InstancedBufferAttribute(ignite, 1)
  };
}

/** A unit quad, flat in XZ for the scar or upright in XY for the flame. */
function cellQuad(attributes, ground) {
  const geometry = new InstancedBufferGeometry();

  const position = ground
    ? new Float32Array([-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5])
    : new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
  geometry.setAttribute('position', new BufferAttribute(position, 3));
  geometry.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));

  for (const [name, attribute] of Object.entries(attributes)) geometry.setAttribute(name, attribute);
  geometry.instanceCount = 0;

  // Placed entirely in the vertex shader; three's bounds are meaningless here.
  geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
  return geometry;
}

export function createCellGeometry(attributes) {
  return cellQuad(attributes, true);
}

export function createFlameGeometry(attributes) {
  return cellQuad(attributes, false);
}

/** The burnt floor. Alpha-blended: a scar is darker than the stone it is on. */
export function createCellMaterial(placement) {
  return new ShaderMaterial({
    name: 'Wildfire:cells',
    vertexShader: CELL_VERTEX,
    fragmentShader: CELL_FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: NormalBlending,
    toneMapped: false,
    uniforms: sharedUniforms({
      ...placement,

      uCellSize: { value: 0.42 },
      uBlock: { value: 0.55 },
      uRough: { value: 0.45 },
      uRoughScale: { value: 2.6 },
      uCatchTime: { value: 0.22 },
      uBurnTime: { value: 2.2 },
      uCharTime: { value: 0.6 },
      uAshTime: { value: 2.0 },
      uVein: { value: 0.55 },
      uOpacity: { value: 1 },
      uGlow: { value: 2.0 },
      uFade: { value: 1 },
      uSoftFade: { value: 0.3 },

      uColorFlash: { value: new Color(1, 0.95, 0.8) },
      uColorEmber: { value: new Color(1, 0.42, 0.1) },
      uColorChar: { value: new Color(0.07, 0.05, 0.05) },
      uColorAsh: { value: new Color(0.34, 0.31, 0.3) }
    })
  });
}

/** The flames. Additive, because they are fire. */
export function createFlameMaterial(placement) {
  return new ShaderMaterial({
    name: 'Wildfire:flames',
    vertexShader: FLAME_VERTEX,
    fragmentShader: FLAME_FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    toneMapped: false,
    uniforms: sharedUniforms({
      ...placement,

      uHeight: { value: 0.85 },
      uWidth: { value: 0.16 },
      uCatchTime: { value: 0.22 },
      uBurnTime: { value: 2.2 },
      uLean: { value: 0.3 },
      uWind: { value: new Vector2(0, 1) },
      uWaver: { value: 0.05 },
      uWaverRate: { value: 3.6 },

      uTaper: { value: 1.25 },
      uBulge: { value: 0.5 },
      uNoiseScale: { value: 2.1 },
      uNoiseSpeed: { value: 2.6 },
      uErosion: { value: 0.95 },
      uOpacity: { value: 1 },
      uGlow: { value: 1.6 },
      uFade: { value: 1 },
      uSoftFade: { value: 0.4 },

      uColorA: { value: new Color(1, 0.94, 0.72) },
      uColorB: { value: new Color(1, 0.58, 0.14) },
      uColorC: { value: new Color(0.78, 0.18, 0.04) },
      uColorD: { value: new Color(0.1, 0.08, 0.08) }
    })
  });
}

/** Four pickers into the flame's height gradient. Memoised through `getColor`. */
export function setFlameGradient(material, a, b, c, d) {
  const u = material.uniforms;
  u.uColorA.value.copy(getColor(a));
  u.uColorB.value.copy(getColor(b));
  u.uColorC.value.copy(getColor(c));
  u.uColorD.value.copy(getColor(d));
  return material;
}
