/**
 * A bench for `vfx/BrushStroke.js` and `vfx/InkDiffusion.js` — the Ink school.
 *
 * `npm run check` drives both modules for a handful of frames and looks for
 * NaN. That is the right job for a shared stage and it is not enough for these
 * two, because almost everything interesting about them is either in a shader
 * (which nothing here can run) or is a *distribution* rather than a value.
 * What this file adds:
 *
 *  1. **Static shader sanity.** Balanced braces, no reserved word used as a
 *     variable, no backtick, no `cosh`, every `u*` a stage references declared
 *     in it and boxed on the material, every fragment varying declared by the
 *     vertex stage, and no `fwidth` in a vertex stage. These are the failures
 *     that survive writing the file and turn up as a blank screen.
 *  2. **The anti-glow contract.** This is the school's entire premise and it is
 *     one careless line from being lost, so it is asserted rather than trusted:
 *     no `uGlobalGlow` anywhere, no additive blending, a luminance ceiling in
 *     both fragment stages, and a default ceiling strictly below the shipped
 *     `post.bloomThreshold`.
 *  3. **The bristle model.** A dry tail is only a dry tail if the bristles are
 *     distinct and their ink loads are not. Layout, spread and dice are checked
 *     per tip, and so is the parking path — the one that must not shuffle a
 *     stroke into another stroke's slot.
 *  4. **The dispersion relation.** The instability's whole claim is that finer
 *     modes are *released* as the front grows. The JS mirror of the amplitude
 *     schedule asserts that a small front has one live mode and a large one has
 *     all five, and that the front law's closed-form inverse really inverts it.
 *  5. **The power law.** The satellites are the readable half of a splatter and
 *     a uniform draw would look like a stencil. The bounded-Pareto inverse CDF
 *     is sampled four thousand times and its shape is asserted.
 *  6. **I1** — a value changed on a zero-length frame must move a uniform.
 *
 * Run: `node scripts/check-vfx-ink.mjs`
 */
import { Group, Vector3 } from 'three';
import { BrushStroke, BrushTip, BRUSH_TIP_NAMES, brushStrokeParams } from '../src/vfx/BrushStroke.js';
import { InkDiffusion, InkMode, INK_MODE_NAMES, inkDiffusionParams } from '../src/vfx/InkDiffusion.js';
import { settings } from '../src/config/settings.js';

let failures = 0;
let checks = 0;

function ok(condition, label, detail) {
  checks++;
  if (condition) return;
  failures++;
  console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
}

function section(name) {
  console.log(`\n${name}`);
}

const near = (a, b, eps, label) => ok(Math.abs(a - b) <= eps, label, `${a} vs ${b}`);

/* ---------------------------------------------------------------- */
/* 1 · static shader sanity                                          */
/* ---------------------------------------------------------------- */

/** Identifiers three declares for us, which a stage may use without declaring. */
const PROVIDED = new Set([
  'uv',
  'position',
  'normal',
  'projectionMatrix',
  'modelViewMatrix',
  'modelMatrix',
  'viewMatrix',
  'normalMatrix',
  'cameraPosition'
]);

const RESERVED = [
  'flat',
  'smooth',
  'noperspective',
  'input',
  'output',
  'sample',
  'filter',
  'active',
  'asm',
  'union',
  'namespace',
  'using',
  'this',
  'packed',
  'cast',
  'goto',
  'switch',
  'default',
  'inline',
  'volatile',
  'public',
  'static',
  'extern',
  'external',
  'interface',
  'long',
  'short',
  'double',
  'half',
  'fixed',
  'unsigned',
  'sizeof'
];

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

function declared(src, prefix) {
  const out = new Set();
  const re = /\b(?:uniform|varying|attribute|in|out)\s+(?:lowp\s+|mediump\s+|highp\s+)?\w+\s+([^;]+);/g;
  let m;
  while ((m = re.exec(src))) {
    for (const name of m[1].split(',')) {
      const clean = name.trim().replace(/\[.*$/, '').trim();
      if (clean.startsWith(prefix)) out.add(clean);
    }
  }
  return out;
}

function referenced(src, prefix) {
  const out = new Set();
  const re = new RegExp(`\\b${prefix}[A-Z]\\w*`, 'g');
  let m;
  while ((m = re.exec(src))) out.add(m[0]);
  return out;
}

function checkBalance(label, src) {
  const body = stripComments(src);
  let braces = 0;
  let parens = 0;
  let underflow = false;
  for (const ch of body) {
    if (ch === '{') braces++;
    else if (ch === '}') braces--;
    else if (ch === '(') parens++;
    else if (ch === ')') parens--;
    if (braces < 0) underflow = true;
  }
  ok(!underflow, `${label}: closing brace before an opening one`);
  ok(braces === 0, `${label}: unbalanced braces`, `${braces}`);
  ok(parens === 0, `${label}: unbalanced parentheses`, `${parens}`);
}

/** `#if` / `#else` / `#endif` must nest, or the whole program disappears. */
function checkPreprocessor(label, src) {
  let depth = 0;
  let underflow = false;
  for (const line of src.split('\n')) {
    const directive = line.trim();
    if (/^#if(n?def)?\b/.test(directive)) depth++;
    else if (/^#endif\b/.test(directive)) depth--;
    if (depth < 0) underflow = true;
  }
  ok(!underflow, `${label}: #endif without a matching #if`);
  ok(depth === 0, `${label}: ${depth} unterminated #if`);
}

function auditMaterial(label, material) {
  const v = material.vertexShader;
  const f = material.fragmentShader;
  for (const [stage, src] of [
    [`${label} vertex`, v],
    [`${label} fragment`, f]
  ]) {
    checkBalance(stage, src);
    checkPreprocessor(stage, src);
    const body = stripComments(src);
    for (const word of RESERVED) {
      const re = new RegExp(`\\b(?:float|int|bool|vec2|vec3|vec4|mat2|mat3|mat4)\\s+${word}\\b`);
      ok(!re.test(body), `${stage}: "${word}" is reserved and cannot be a variable name`);
    }
    for (const name of referenced(body, 'u')) {
      if (PROVIDED.has(name)) continue;
      ok(declared(body, 'u').has(name), `${stage}: ${name} referenced but not declared`);
    }
    for (const name of declared(body, 'u')) {
      if (PROVIDED.has(name)) continue;
      ok(material.uniforms[name] !== undefined, `${stage}: ${name} declared but has no uniform box`);
    }
  }

  ok(!v.includes('`') && !f.includes('`'), `${label}: a backtick in the shader source`);
  ok(!/\bcosh\s*\(/.test(v + f), `${label}: cosh() does not exist in ESSL 1.00`);
  // Derivatives are fragment-only: injecting commonGLSL into a vertex stage
  // takes aastep's fwidth with it and fails the whole program to compile.
  ok(!/\bfwidth\s*\(/.test(v), `${label}: vertex stage is free of fwidth`);

  const vVary = declared(stripComments(v), 'v');
  for (const name of declared(stripComments(f), 'v')) {
    ok(vVary.has(name), `${label}: fragment declares varying ${name} the vertex stage does not`);
  }
}

section('static shader sanity');

const _up = new Vector3(0, 1, 0);
const _from = new Vector3(0, 0.15, 0);
const _to = new Vector3(0, 0.15, 11);
const _dirZ = new Vector3(0, 0, 1);
const _probe = new Vector3();

const benchParent = new Group();
const brushes = Object.values(BrushTip).map(
  (tip) => new BrushStroke(benchParent, { strokes: 3, bristles: 8, samples: 10, sides: 6, tip })
);
const fields = Object.values(InkMode).map(
  (mode) => new InkDiffusion(benchParent, { mode, sources: 4, satellites: 8 })
);

auditMaterial('BrushStroke', brushes[0].material);
for (const field of fields) {
  auditMaterial(`InkDiffusion ${INK_MODE_NAMES[field.mode]}`, field.material);
}

/**
 * Drop every `#if INK_MODE == n ... #endif` region that this mode does not
 * take, the way the GLSL preprocessor will. Crude — it only understands the one
 * directive form this file uses — but it is enough to prove the guards are on
 * the right blocks, which is the thing a string search cannot tell you.
 */
function activeSource(src, mode) {
  const out = [];
  let skipping = 0;
  for (const line of src.split('\n')) {
    const trimmed = line.trim();
    let m = /^#if\s+INK_MODE\s*(==|!=)\s*(\d+)/.exec(trimmed);
    if (m) {
      const takes = m[1] === '==' ? mode === Number(m[2]) : mode !== Number(m[2]);
      skipping = takes ? 0 : 1;
      continue;
    }
    if (/^#(else|endif)\b/.test(trimmed)) {
      skipping = /^#else/.test(trimmed) ? 1 - skipping : 0;
      continue;
    }
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}

// The mode is a #define, so the satellite loop must genuinely not exist outside
// SPLATTER — an eight-iteration loop per fragment over the whole zone is not
// something a bloom should be paying for.
for (const field of fields) {
  const live = activeSource(field.material.fragmentShader, field.mode);
  const wantsSatellites = field.mode === InkMode.SPLATTER;
  ok(
    live.includes('uSatDice[i]') === wantsSatellites,
    `${INK_MODE_NAMES[field.mode]}: the satellite loop is ${wantsSatellites ? 'in' : 'compiled out'}`
  );
  ok(
    live.includes('fingers(q') === (field.mode !== InkMode.WASH),
    `${INK_MODE_NAMES[field.mode]}: the instability is ${field.mode === InkMode.WASH ? 'compiled out' : 'in'}`
  );
  ok(
    live.includes('uCrown *') === wantsSatellites,
    `${INK_MODE_NAMES[field.mode]}: the crown is ${wantsSatellites ? 'in' : 'compiled out'}`
  );
  checkBalance(`${INK_MODE_NAMES[field.mode]} after preprocessing`, live);
}

// Uniform arrays may be subscripted only by a loop counter in ESSL 1.00, and
// the obvious `uSatDice[someUniform]` compiles on the desktop driver and fails
// on the one the player has. The declarations are the only other subscript.
for (const field of fields) {
  const body = stripComments(field.material.fragmentShader).replace(
    /\buniform\s+vec4\s+u\w+\[[^\]]+\];/g,
    ' '
  );
  ok(
    !/u(?:Sat|Source)Dice\[\s*(?!i\s*\])/.test(body),
    `${INK_MODE_NAMES[field.mode]}: uniform arrays are indexed only by the loop counter`
  );
}

/* ---------------------------------------------------------------- */
/* 2 · the anti-glow contract                                        */
/* ---------------------------------------------------------------- */

section('the anti-glow contract');

for (const [label, material] of [
  ['BrushStroke', brushes[0].material],
  ['InkDiffusion', fields[0].material]
]) {
  ok(material.toneMapped === true, `${label}: declares itself tone mapped`);
  ok(material.blending === 1, `${label}: blends normally, never additively`, `${material.blending}`);
  ok(
    !stripComments(material.fragmentShader).includes('uGlobalGlow'),
    `${label}: the global glow slider cannot reach ink`
  );
  ok(material.fragmentShader.includes('uCeiling'), `${label}: clamps its output luminance`);
}

// The bloom high pass runs on linear colour before the tone map, so its
// threshold is a linear luminance and the ceiling has to sit under it.
const threshold = settings.post.bloomThreshold;
ok(
  brushStrokeParams().ceiling < threshold,
  'BrushStroke ceiling is under post.bloomThreshold',
  `${brushStrokeParams().ceiling} vs ${threshold}`
);
ok(
  inkDiffusionParams().ceiling < threshold,
  'InkDiffusion ceiling is under post.bloomThreshold',
  `${inkDiffusionParams().ceiling} vs ${threshold}`
);

/* ---------------------------------------------------------------- */
/* 3 · the bristle model                                             */
/* ---------------------------------------------------------------- */

section('the bristle model');

for (const brush of brushes) {
  const label = BRUSH_TIP_NAMES[brush.tip];
  const attr = brush.geometry.attributes.aBrush.array;
  const n = brush.bristles;
  const across = [];
  const through = [];
  for (let b = 0; b < n; b++) {
    across.push(attr[b * 4 + 0]);
    through.push(attr[b * 4 + 1]);
  }

  // Distinct slots. Two bristles in the same place is one bristle with twice
  // the ink, and the streak it leaves never breaks.
  const unique = new Set(across.map((x, i) => `${x.toFixed(4)}:${through[i].toFixed(4)}`));
  ok(unique.size === n, `${label}: every bristle has its own place in the ferrule`, `${unique.size}/${n}`);
  ok(
    Math.max(...across.map(Math.abs)) <= 1.0001,
    `${label}: no bristle hangs outside the ferrule`
  );

  if (brush.tip === BrushTip.FLAT) {
    let ordered = true;
    for (let b = 1; b < n; b++) if (across[b] <= across[b - 1]) ordered = false;
    ok(ordered, 'FLAT: one rank, in order across the width');
    ok(through.every((t) => t === 0), 'FLAT: nothing spread through the paper normal');
  }
  if (brush.tip === BrushTip.ROUND) {
    ok(
      through.filter((t) => Math.abs(t) > 0.1).length >= n / 2,
      'ROUND: most bristles are off the mid-plane'
    );
  }
  if (brush.tip === BrushTip.SPLIT) {
    const sorted = [...across].sort((a, b) => a - b);
    const gaps = [];
    for (let b = 1; b < n; b++) gaps.push(sorted[b] - sorted[b - 1]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    ok(
      gaps.filter((g) => g > mean * 1.5).length >= 2,
      'SPLIT: at least two tuft gaps wider than the mean spacing',
      gaps.map((g) => g.toFixed(3)).join(' ')
    );
  }

  // Loads must differ or the tail is a clean cut, which is the whole failure
  // this module exists to avoid.
  const dice = new Set();
  for (let i = 0; i < brush.capacity; i++) dice.add(attr[i * 4 + 2].toFixed(6));
  ok(dice.size >= brush.capacity - 1, `${label}: ink-load dice are per bristle`, `${dice.size}`);
}

// Parking. Stroke 1 goes inactive and must vanish without moving strokes 0 or 2.
{
  const brush = brushes[0];
  const p = brushStrokeParams();
  p.progress = 1;
  brush.setPaper(_up);
  for (let s = 0; s < 3; s++) {
    brush.stroke(s).line(_from, _to, 0.3 * s, 0).pressure(0.1, 1, 0.8, 0.05).ink(7).timing(0, 1);
  }
  brush.update(0, p);
  const before = brush.geometry.attributes.aP1.array.slice();
  const seedBefore = brush.stroke(2).seed;
  brush.stroke(1).active = false;
  brush.update(0, p);
  const slot = 1 * brush.bristles * 4;
  ok(
    brush.geometry.attributes.aStroke.array[slot] > 1,
    'a parked stroke has its draw window pushed past the clock'
  );
  const after = brush.geometry.attributes.aP1.array;
  let moved = false;
  for (let i = 2 * brush.bristles * 3; i < after.length; i++) {
    if (after[i] !== before[i]) moved = true;
  }
  ok(!moved, 'parking stroke 1 does not slide stroke 2 into another slot');
  ok(brush.stroke(2).seed === seedBefore, 'and its seed stays with its slot');
}

/* ---------------------------------------------------------------- */
/* 4 · the CPU mirrors of the spine and the pressure curve           */
/* ---------------------------------------------------------------- */

section('the spine mirrors');

{
  const brush = brushes[0];
  const stroke = brush.stroke(0);
  stroke.line(_from, _to, 0.8, 0.35).pressure(0.11, 1, 0.77, 0.04).timing(0.25, 0.5);

  brush.pointAt(0, 0, _probe);
  near(_probe.distanceTo(_from), 0, 1e-6, 'pointAt(0) is the start of the stroke');
  brush.pointAt(0, 1, _probe);
  near(_probe.distanceTo(_to), 0, 1e-6, 'pointAt(1) is the end of it');
  near(brush.pressureOf(0, 0), 0.11, 1e-6, 'the entry pressure is hit exactly');
  near(brush.pressureOf(0, 1), 0.04, 1e-6, 'so is the exit');
  ok(
    brush.pressureOf(0, 0.5) > brush.pressureOf(0, 0),
    'the body carries more weight than the entry'
  );

  const p = brushStrokeParams();
  p.progress = 0.2;
  brush.update(0, p);
  near(brush.headOf(0), 0, 1e-9, 'a stroke whose window has not opened is unwritten');
  p.progress = 0.5;
  brush.update(0, p);
  near(brush.headOf(0), 0.5, 1e-6, 'halfway through its window is halfway through the stroke');
  p.progress = 0.9;
  brush.update(0, p);
  near(brush.headOf(0), 1, 1e-9, 'and past the end of it, it is finished');
  brush.tipPoint(0, _probe);
  near(_probe.distanceTo(_to), 0, 1e-6, 'the brush ends up where the stroke does');
}

/* ---------------------------------------------------------------- */
/* 5 · the dispersion relation                                       */
/* ---------------------------------------------------------------- */

section('the fingering instability');

/**
 * The JS mirror of `fingers()`'s amplitude schedule. Not used at runtime — the
 * shader owns the field — but the *admission order* is the physical claim the
 * module makes and the thing that separates a growing bloom from an fbm ring
 * being scaled up, so it is worth being able to fail on it.
 *
 * Returns the amplitude, in metres, of each octave at a given front radius.
 * Octave 0 is the coarsest.
 */
function octaveAmplitudes(p, frontRadius) {
  const out = [];
  let L = Math.max(p.coarse, 0.05);
  for (let i = 0; i < 5; i++) {
    const onset = p.onset * L;
    const e = Math.min((p.growth * Math.max(frontRadius - onset, 0)) / L, 8);
    out.push(L * Math.min(Math.exp(e) - 1, p.growthMax));
    L *= 0.5;
  }
  return out;
}

const liveCount = (p, r) => octaveAmplitudes(p, r).filter((a) => a > 1e-4).length;

{
  const p = inkDiffusionParams();
  const finest = p.coarse / 16;

  ok(liveCount(p, p.onset * finest * 0.5) === 0, 'a nucleus smaller than every mode is a disc');
  ok(liveCount(p, p.onset * finest * 1.4) === 1, 'the finest crinkle arrives first');
  ok(
    liveCount(p, p.onset * p.coarse * 0.9) === 4,
    'the coarsest lobe is still inadmissible just below its own onset'
  );
  ok(liveCount(p, p.onset * p.coarse * 1.5) === 5, 'and a mature front has grown into all five');

  let previous = -1;
  let monotone = true;
  for (let r = 0; r <= 12; r += 0.05) {
    const live = liveCount(p, r);
    if (live < previous) monotone = false;
    previous = live;
  }
  ok(monotone, 'modes are only ever admitted, never withdrawn');

  // The whole shape claim: a young front is crinkle, a mature one is lobes with
  // the crinkle riding on them. So the coarse octave must go from contributing
  // nothing to dominating, and the fine one must never dominate again.
  const young = octaveAmplitudes(p, 0.4);
  const old = octaveAmplitudes(p, 9);
  ok(young[0] === 0 && young[4] > 0, 'a young bloom is all crinkle and no lobe');
  ok(old[0] > old[4] * 8, 'a mature bloom is dominated by its coarsest lobe', `${old[0] / old[4]}`);
  ok(old[4] > 0, 'and it keeps the crinkle');

  // Saturation: without it the first octave to mature runs away and the bloom
  // is two lobes for ever. With it, a mature mode settles at its own wavelength.
  near(old[0], p.coarse * p.growthMax, 1e-9, 'a mature mode saturates at growthMax wavelengths');
}

{
  const field = fields[InkMode.BLOOM];
  const p = inkDiffusionParams();
  field.setPlacement(_to, _dirZ);
  field.update(2.25, p);
  const r = field.frontRadius(0);
  near(r, p.spread * Math.sqrt(2.25), 1e-9, 'Fickian spreading: r goes as the square root of t');
  // The closed-form inverse is what gives every fragment its arrival time, and
  // therefore the whole wet-to-dry gradient. If it stops inverting, the gloss
  // detaches from the front.
  const arrival = Math.pow(r / p.spread, 1 / p.spreadPower);
  near(arrival, 2.25, 1e-6, 'arrivalOf(frontAt(t)) is t');
}

/* ---------------------------------------------------------------- */
/* 6 · the satellites                                                */
/* ---------------------------------------------------------------- */

section('splatter morphology');

{
  const field = fields[InkMode.SPLATTER];
  const p = inkDiffusionParams();
  p.satellites = 8;
  field.setPlacement(_to, _dirZ);
  field.roll(3);
  field.update(3, p);

  const sizes = [];
  for (let i = 0; i < field.satellites; i++) sizes.push(field.satelliteSize(i));
  ok(
    sizes.every((s) => s >= p.satMin - 1e-6 && s <= p.satMax + 1e-6),
    'every droplet is inside the authored size range'
  );

  // The distribution, sampled properly. A bounded Pareto with exponent 2.3 puts
  // most of its mass at the small end; a uniform draw would put half of it
  // above the midpoint and the splatter would read as a stencil of dots.
  const a = p.satAlpha;
  const loA = Math.pow(p.satMin, -a);
  const hiA = Math.pow(p.satMax, -a);
  const draw = (u) => Math.pow(u * (hiA - loA) + loA, -1 / a);
  near(draw(0), p.satMin, 1e-9, 'the draw bottoms out at satMin');
  near(draw(1), p.satMax, 1e-9, 'and tops out at satMax');
  let big = 0;
  const N = 4096;
  for (let i = 0; i < N; i++) if (draw((i + 0.5) / N) > p.satMin * 2) big++;
  ok(big / N < 0.35, 'fewer than a third of droplets are twice the minimum', `${(big / N).toFixed(3)}`);
  ok(draw(0.5) < (p.satMin + p.satMax) * 0.5, 'the median sits well below the midpoint');

  // Small droplets fly furthest. If this correlation inverts, the far field
  // becomes a row of large blobs and the throw stops reading as a throw.
  let smallest = 0;
  let largest = 0;
  for (let i = 1; i < field.satellites; i++) {
    if (field.satelliteSize(i) < field.satelliteSize(smallest)) smallest = i;
    if (field.satelliteSize(i) > field.satelliteSize(largest)) largest = i;
  }
  ok(
    field.satelliteReach(smallest) > field.satelliteReach(largest),
    'the smallest droplet outflies the largest'
  );

  // Placement, against a rotated cast — the mirror splatterbrand aims with.
  const along = new Vector3(1, 0, 0);
  field.setPlacement(_to, along);
  field.update(3, p);
  for (let i = 0; i < field.satellites; i++) {
    field.satellitePoint(i, _probe);
    const reach = field.satelliteReach(i);
    near(_probe.x - _to.x, reach, 1e-5, `satellite ${i} lands down the travel vector`);
    ok(
      Math.abs(_probe.z - _to.z) <= p.throwSpread * reach + 1e-5,
      `satellite ${i} stays inside the throw cone`
    );
    near(_probe.y, p.height, 1e-9, `satellite ${i} lands on the floor`);
  }

  // And the canvas has to reach past the furthest one, tail included, or the
  // far field is clipped and the whole thing reads as a rectangle of ink.
  const half = field.mesh.scale.x * 0.5;
  ok(
    half >= p.throwFar + p.satMax * (1 + p.satTail),
    'the quad covers the furthest droplet and its tail',
    `${half.toFixed(2)} m`
  );
}

/* ---------------------------------------------------------------- */
/* 7 · I1 — a paused slider must move something                      */
/* ---------------------------------------------------------------- */

section('I1 on a zero-length frame');

{
  const brush = brushes[0];
  const p = brushStrokeParams();
  brush.update(1, p);
  const before = brush.geometry.attributes.aStroke.array[3];
  p.width = 0.9;
  p.inkLoad = 2.5;
  p.dryBand = 5.5;
  brush.update(1, p); //  same clock, new sliders
  ok(brush.material.uniforms.uWidth.value === 0.9, 'a paused width drag reaches the uniform');
  ok(brush.material.uniforms.uDryBand.value === 5.5, 'so does the dry band');
  ok(brush.geometry.attributes.aStroke.array[3] !== before, 'and the ink load re-expands');

  const field = fields[InkMode.BLOOM];
  const q = inkDiffusionParams();
  field.update(1.5, q);
  const scaleBefore = field.mesh.scale.x;
  q.coarse = 0.75;
  q.radius = 11;
  q.dryTime = 4;
  field.update(1.5, q);
  ok(field.material.uniforms.uCoarse.value === 0.75, 'a paused finger-wavelength drag lands');
  ok(field.material.uniforms.uDryTime.value === 4, 'so does the drying time');
  ok(field.mesh.scale.x !== scaleBefore, 'and the canvas re-sizes to the new radius');
}

/* ---------------------------------------------------------------- */

for (const brush of brushes) brush.dispose();
for (const field of fields) field.dispose();
ok(benchParent.children.length === 0, 'dispose() takes every node back off the parent');

console.log(
  failures === 0
    ? `\n✓ ${checks} assertions, no failures\n`
    : `\n✗ ${failures} of ${checks} assertions failed\n`
);
process.exit(failures === 0 ? 0 : 1);
