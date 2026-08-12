/**
 * `scripts/check-vfx-tube-shell.mjs` — the harness for `vfx/Tube.js` and
 * `vfx/Shell.js`.
 *
 * Separate from `scripts/check.mjs` only because that one walks the **registry**
 * and these two modules are not yet reachable from an ability. Fold it in — or
 * add `"check:vfx"` to package.json — the moment one is.
 *
 * No WebGL needed, for the same reason `check.mjs` does not need it: three
 * builds geometry, materials and scene graphs on the CPU and both modules defer
 * GL to render time. What that cannot check is whether the GLSL *compiles*, so
 * the first section does the next best thing statically — every `uXxx` used in
 * a shader must be declared in the same stage, the preprocessor and the braces
 * must balance, and the two stages must agree on their varyings. Those three
 * catch essentially every typo that survives writing the file.
 *
 * The interesting assertions are further down:
 *
 *  - the whip's tip actually beats its own wave speed, and cracks exactly once;
 *  - the funnel's skirt and mouth are both wider than its throat;
 *  - the ring train's far end is a node to within floating point;
 *  - and **I1**: a slider dragged on a zero-length frame moves the standing
 *    shape, including re-arming a crack that had not fired.
 */
import { Vector3 } from 'three';
import { Tube, TubePath, TubeLayer, tubeDefaults, tubeKeys, tubeSchema, createTubeMaterial } from '../src/vfx/Tube.js';
import { Shell, ShellMode, shellDefaults, shellSchema, BurstMode, BurstSystem } from '../src/vfx/Shell.js';
import { settings } from '../src/config/settings.js';
import { frame } from '../src/core/FrameUniforms.js';

let failures = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) {
    failures++;
    console.error(`  FAIL  ${name} ${extra}`);
  } else {
    console.log(`  ok    ${name}`);
  }
};

const finite = (v) => Number.isFinite(v);

function scanUniforms(material, label) {
  for (const [key, box] of Object.entries(material.uniforms)) {
    const v = box.value;
    if (typeof v === 'number' && !finite(v)) return `${label}.${key} = ${v}`;
    if (v && v.isVector3 && !(finite(v.x) && finite(v.y) && finite(v.z))) return `${label}.${key} = ${v.toArray()}`;
    if (v && v.isColor && !(finite(v.r) && finite(v.g) && finite(v.b))) return `${label}.${key} = colour NaN`;
  }
  return null;
}

/* ---------------------------------------------------------------- */
/* 1. GLSL identifier sanity — every uXxx used must be declared      */
/* ---------------------------------------------------------------- */
console.log('\n[glsl] uniform declaration / usage cross-check');
for (const [layer, path] of [[TubeLayer.CORE, TubePath.WHIP], [TubeLayer.SHEATH, TubePath.FUNNEL], [TubeLayer.HALO, TubePath.VINE], [TubeLayer.CORE, TubePath.ARC], [TubeLayer.CORE, TubePath.STRAIGHT]]) {
  const m = createTubeMaterial(layer, path);
  checkShader(`Tube(layer=${layer},path=${path})`, m);
}
for (const mode of Object.values(ShellMode)) {
  const { createShellMaterial } = await import('../src/vfx/Shell.js');
  checkShader(`Shell(mode=${mode})`, createShellMaterial(mode));
}

function checkShader(label, material) {
  for (const [stage, src] of [['vs', material.vertexShader], ['fs', material.fragmentShader]]) {
    const declared = new Set([...src.matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)].map((m) => m[1]));
    // three injects these
    for (const k of ['modelMatrix', 'viewMatrix', 'projectionMatrix', 'cameraPosition', 'normalMatrix', 'modelViewMatrix']) declared.add(k);
    const used = new Set([...src.matchAll(/\bu[A-Z]\w*/g)].map((m) => m[0]));
    const missing = [...used].filter((u) => !declared.has(u) && !u.startsWith('uv'));
    ok(`${label} ${stage} uniforms declared`, missing.length === 0, missing.join(', '));

    // balanced preprocessor
    let depth = 0;
    for (const line of src.split('\n')) {
      const t = line.trim();
      if (t.startsWith('#if')) depth++;
      else if (t.startsWith('#endif')) depth--;
      if (depth < 0) break;
    }
    ok(`${label} ${stage} #if/#endif balanced`, depth === 0, `depth=${depth}`);

    // varyings written in vs must be declared, and vice versa
    const brace = (src.match(/{/g) || []).length - (src.match(/}/g) || []).length;
    ok(`${label} ${stage} braces balanced`, brace === 0, `delta=${brace}`);
  }
  const vsVary = new Set([...material.vertexShader.matchAll(/varying\s+\w+\s+(\w+)\s*;/g)].map((m) => m[1]));
  const fsVary = new Set([...material.fragmentShader.matchAll(/varying\s+\w+\s+(\w+)\s*;/g)].map((m) => m[1]));
  ok(`${label} varying sets match`, [...fsVary].every((v) => vsVary.has(v)) && [...vsVary].every((v) => fsVary.has(v)));
}

/* ---------------------------------------------------------------- */
/* 2. Tube — every path, 240 frames, no NaN                          */
/* ---------------------------------------------------------------- */
console.log('\n[tube] path modes');
const origin = new Vector3(0, 1.2, 0);
const target = new Vector3(0, 0.6, 12);
const side = new Vector3(1, 0, 0);

for (const [name, path] of Object.entries(TubePath)) {
  const config = { ...tubeDefaults('tube', path) };
  const tube = new Tube({ path, nodes: 64, sides: 20 });
  const state = { origin, target, side, progress: 0, fade: 1, widthFade: 1, seed: 0.37, time: 0, grow: 0, snapAge: -1 };

  let bad = null;
  let sawCrack = 0;
  let peakTip = 0;
  for (let i = 0; i < 240; i++) {
    const t = i / 60;
    frame.uTime.value = t;
    state.time = t;
    state.progress = Math.min(1, t * 1.6);
    state.grow = Math.min(1, t * 1.2);
    state.snapAge = path === TubePath.VINE && t > 1.2 ? t - 1.2 : -1;
    tube.sync(config, state);
    if (tube.crack.fired) sawCrack++;
    peakTip = Math.max(peakTip, tube.tipSpeed);
    for (const key of ['core', 'sheath', 'halo']) {
      bad = bad || scanUniforms(tube.materials[key], `${name}.${key}`);
    }
    for (const q of [0, 0.25, 0.5, 0.75, 1]) {
      if (!finite(tube.radiusAt(q))) bad = bad || `${name}.radiusAt(${q}) NaN`;
      const p = tube.pointAt(q, new Vector3());
      if (!finite(p.x + p.y + p.z)) bad = bad || `${name}.pointAt(${q}) NaN`;
      if (p.length() > 500) bad = bad || `${name}.pointAt(${q}) escaped: ${p.toArray()}`;
      const tg = tube.tangentAt(q, new Vector3());
      if (!finite(tg.x + tg.y + tg.z)) bad = bad || `${name}.tangentAt(${q}) NaN`;
    }
  }
  ok(`${name}: 240 frames clean`, bad === null, bad || '');
  ok(`${name}: draw calls = 3`, tube.drawCalls === 3);
  if (path === TubePath.WHIP) {
    ok('WHIP: the crack fired', sawCrack > 0, `fired ${sawCrack}×`);
    ok('WHIP: tip beats the wave', peakTip > tube.waveSpeed, `peak ${peakTip.toFixed(2)} vs wave ${tube.waveSpeed.toFixed(2)}`);
    console.log(`        peak tip speed ${peakTip.toFixed(2)} m/s, wave speed ${tube.waveSpeed.toFixed(2)} m/s, cracks ${sawCrack}`);
  }
  if (path === TubePath.VINE) {
    ok('VINE: tip radius is zero', tube.radiusAt(1) < 1e-3, `${tube.radiusAt(1)}`);
    ok('VINE: recoil moved the tip', peakTip > 0, `${peakTip}`);
  }
  if (path === TubePath.FUNNEL) {
    const throat = tube.radiusAt(0.4);
    ok('FUNNEL: skirt > throat', tube.skirtRadius > throat, `${tube.skirtRadius.toFixed(2)} vs ${throat.toFixed(2)}`);
    ok('FUNNEL: mouth > throat', tube.mouthRadius > throat, `${tube.mouthRadius.toFixed(2)} vs ${throat.toFixed(2)}`);
    console.log(`        skirt ${tube.skirtRadius.toFixed(2)}m  throat ${throat.toFixed(2)}m  mouth ${tube.mouthRadius.toFixed(2)}m`);
  }
  tube.dispose();
}

/* ---------------------------------------------------------------- */
/* 3. I1 — the paused-slider test, on a zero-length frame            */
/* ---------------------------------------------------------------- */
console.log('\n[I1] paused-slider test (dt = 0)');
{
  const config = { ...tubeDefaults('tube', TubePath.FUNNEL) };
  const tube = new Tube({ path: TubePath.FUNNEL });
  const state = { origin: new Vector3(), target: new Vector3(0, 8, 0), side, progress: 1, fade: 1, widthFade: 1, seed: 0.5, time: 1.5, grow: 1, snapAge: -1 };
  frame.uTime.value = 1.5;
  tube.sync(config, state);
  const before = tube.skirtRadius;
  const beforeU = tube.materials.core.uniforms.uSkirtFlare.value;

  config.tubeSkirtFlare = 4.4; // the drag
  tube.sync(config, state); // zero-length frame: same time, same state
  ok('funnel skirt re-resolved', tube.skirtRadius !== before, `${before} → ${tube.skirtRadius}`);
  ok('funnel uniform re-resolved', tube.materials.core.uniforms.uSkirtFlare.value !== beforeU);

  settings.global.opacity = 0.5;
  tube.sync(config, state);
  ok('global multiplier applies live', tube.materials.core.uniforms.uOpacity.value === config.tubeOpacity * 0.5);
  settings.global.opacity = 1;
  tube.dispose();
}
{
  // The crack must be re-armable by a slider while paused.
  const config = { ...tubeDefaults('tube', TubePath.WHIP) };
  config.tubeWaveAmp = 0.02; // far too small to crack
  const tube = new Tube({ path: TubePath.WHIP });
  const state = { origin, target, side, progress: 1, fade: 1, widthFade: 1, seed: 0.1, time: 0.72, grow: 1, snapAge: -1 };
  frame.uTime.value = 0.72;
  tube.sync(config, state);
  const quiet = tube.crack.fired;
  config.tubeWaveAmp = 0.45; // the drag, clock stopped
  tube.sync(config, state);
  ok('whip crack fires off a slider while paused', quiet === false && tube.crack.fired === true);
  tube.sync(config, state);
  ok('whip crack does not re-fire while held', tube.crack.fired === false);
  tube.dispose();
}

/* ---------------------------------------------------------------- */
/* 4. Contract guard                                                 */
/* ---------------------------------------------------------------- */
console.log('\n[contract] missing-key guard');
{
  const tube = new Tube({});
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (m) => warnings.push(m);
  tube.sync({}, { origin, target, side });
  tube.sync({}, { origin, target, side });
  console.warn = realWarn;
  ok('Tube warns once about an incomplete block', warnings.length === 1 && /missing 79 key/.test(warnings[0]), warnings[0] || '');
  ok('Tube still draws finite geometry from the defaults', scanUniforms(tube.materials.core, 'bare') === null);
  tube.dispose();
}

/* ---------------------------------------------------------------- */
/* 5. Shell — every mode                                             */
/* ---------------------------------------------------------------- */
console.log('\n[shell] modes');
for (const [name, mode] of Object.entries(ShellMode)) {
  const config = { ...shellDefaults('shell', mode) };
  const shell = new Shell({ mode, rings: 16 });
  const state = { origin: new Vector3(0, 0, 0), axis: new Vector3(0, 1, 0), side, span: 14, t: 0, fade: 1, seed: 0.8 };

  let bad = null;
  for (let i = 0; i < 240; i++) {
    frame.uTime.value = i / 60;
    state.t = Math.min(1, i / 120);
    shell.sync(config, state);
    bad = bad || scanUniforms(shell.material, name);
    if (!finite(shell.radius)) bad = bad || `${name}.radius NaN`;
  }
  ok(`${name}: 240 frames clean`, bad === null, bad || '');
  ok(`${name}: one draw call`, shell.drawCalls === 1);
  if (mode === ShellMode.RING_TRAIN) {
    ok('RING_TRAIN: instance count follows the slider', shell.geometry.instanceCount === 10);
    const lambda = shell.resonantSpacing(9);
    config.shellSpacing = lambda;
    shell.sync(config, state);
    // With 9 half-waves on the line the far end and every λ/2 back is a node.
    const atNode = shell.standingAt(shell.span);
    const atAnti = shell.standingAt(shell.span - shell.nodeSpacing * 0.5);
    ok('RING_TRAIN: far end is a node', Math.abs(atNode) < 1e-6, `${atNode}`);
    ok('RING_TRAIN: antinode is brighter than the node', atAnti > atNode);
    ok('RING_TRAIN: node count sane', shell.nodeCount === 10, `${shell.nodeCount}`);
    const p = shell.nodePosition(3, new Vector3());
    ok('RING_TRAIN: node position finite', finite(p.x + p.y + p.z));
    console.log(`        resonant λ ${lambda.toFixed(3)} m, ${shell.nodeCount} nodes, spacing ${shell.nodeSpacing.toFixed(3)} m`);
  }
  if (mode === ShellMode.DOME) {
    const r0 = shell.radius;
    config.shellRadiusEnd = 12;
    shell.sync(config, state);
    ok('DOME: radius re-resolves on a paused frame', shell.radius !== r0, `${r0} → ${shell.radius}`);
  }
  shell.dispose();
}

/* ---------------------------------------------------------------- */
/* 6. Degenerate frames                                              */
/* ---------------------------------------------------------------- */
console.log('\n[degenerate] vertical axes and zero-length casts');
{
  const config = { ...tubeDefaults('tube', TubePath.FUNNEL) };
  const tube = new Tube({ path: TubePath.FUNNEL });
  // Vertical axis with `side` parallel to it — the frame must not go NaN.
  tube.sync(config, {
    origin: new Vector3(),
    target: new Vector3(0, 6, 0),
    side: new Vector3(0, 1, 0),
    progress: 1, fade: 1, widthFade: 1, seed: 0, time: 0, grow: 1, snapAge: -1
  });
  const p = tube.pointAt(0.5, new Vector3());
  ok('vertical funnel, parallel side ref', finite(p.x + p.y + p.z), p.toArray().join(','));
  // Zero-length cast.
  tube.sync(config, {
    origin: new Vector3(3, 0, 3), target: new Vector3(3, 0, 3), side,
    progress: 1, fade: 1, widthFade: 1, seed: 0, time: 0, grow: 1, snapAge: -1
  });
  ok('zero-length cast', finite(tube.pointAt(1, new Vector3()).x) && finite(tube.tipSpeed));
  tube.dispose();

  const shell = new Shell({ mode: ShellMode.CONE });
  shell.sync({ ...shellDefaults('shell', ShellMode.CONE) }, {
    origin: new Vector3(), axis: new Vector3(0, 0, 0), side: new Vector3(0, 1, 0), span: 0, t: 0.5, fade: 1, seed: 0
  });
  ok('shell with a zero axis and zero span', scanUniforms(shell.material, 'cone') === null);
  shell.dispose();
}

/* ---------------------------------------------------------------- */
/* 7. Schemas + the BurstSphere re-export                            */
/* ---------------------------------------------------------------- */
console.log('\n[schema] editor coverage');
{
  const config = tubeDefaults('tube');
  const schema = tubeSchema('tube', TubePath.WHIP);
  const covered = new Set();
  for (const list of Object.values(schema)) for (const e of list) covered.add(Array.isArray(e) ? e[0] : e);
  const uncovered = Object.keys(config).filter((k) => !covered.has(k));
  ok('tubeSchema references only real keys', [...covered].every((k) => k in config), [...covered].filter((k) => !(k in config)).join(', '));
  console.log(`        ${Object.keys(config).length} tube keys, ${covered.size} in named folders, ${uncovered.length} fall through to "More"`);

  const sconfig = shellDefaults('shell');
  const sschema = shellSchema('shell', ShellMode.RING_TRAIN);
  const scovered = new Set();
  for (const list of Object.values(sschema)) for (const e of list) scovered.add(Array.isArray(e) ? e[0] : e);
  ok('shellSchema references only real keys', [...scovered].every((k) => k in sconfig), [...scovered].filter((k) => !(k in sconfig)).join(', '));
  console.log(`        ${Object.keys(sconfig).length} shell keys, ${scovered.size} in named folders`);

  ok('two prefixes do not collide', Object.keys(tubeDefaults('lash', TubePath.WHIP)).every((k) => !(k in config)));
  ok('per-path tuning applies', tubeDefaults('lash', TubePath.WHIP).lashRadius !== tubeDefaults('lash', TubePath.STRAIGHT).lashRadius);
  ok('prefixed overrides win', tubeDefaults('lash', TubePath.WHIP, { lashRadius: 9 }).lashRadius === 9);
  ok('BurstSphere still re-exports', typeof BurstSystem === 'function' && BurstMode.FIRE === 0);
  ok('tubeKeys maps unprefixed → prefixed', tubeKeys('lash').radius === 'lashRadius');
}

console.log(failures === 0 ? '\nALL CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
