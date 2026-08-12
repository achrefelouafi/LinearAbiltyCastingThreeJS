/**
 * A bench for `vfx/LensFlare.js` and `vfx/Mirror.js`.
 *
 * `npm run check` drives both modules for a handful of frames and looks for
 * NaN, which is the right thing for a shared stage to do and is not enough for
 * either of these two. What is specific here:
 *
 *  1. **Static shader sanity.** Balanced braces and preprocessor, no reserved
 *     word used as a variable, every `u*` referenced by a stage declared in it,
 *     every declared uniform actually boxed, every fragment varying declared by
 *     the vertex stage. Those are the failures that survive writing the file
 *     and turn up as a blank screen and a link error naming no file.
 *  2. **`commonGLSL` is not injected into a vertex stage.** It carries `aastep`,
 *     which calls `fwidth`, and derivatives do not exist in a vertex shader —
 *     the whole program fails to compile, pointing at a helper you are not
 *     using. `LensFlare`'s vertex stage restates the two helpers it wants; this
 *     asserts nobody "tidies" that back into an injection.
 *  3. **The mirror scheduler**, which is pure CPU and is the part most likely
 *     to be wrong: a frame token that survives nested `render()` calls, a hard
 *     per-frame budget, and a starvation weighting that must not leave one
 *     mirror showing a frozen reflection forever.
 *  4. **I1** — a value changed on a zero-length frame must move a uniform.
 *
 * Run: `node scripts/check-vfx-lensflare-mirror.mjs`
 */
import { Scene, Group, PerspectiveCamera, Vector3 } from 'three';
import { LensFlare, lensFlareParams, MAX_FLARE_GHOSTS } from '../src/vfx/LensFlare.js';
import { Mirror, mirrorParams, mirrorBudget, setMirrorBudget } from '../src/vfx/Mirror.js';
import { LAYER } from '../src/core/Layers.js';
import { frame } from '../src/core/FrameUniforms.js';

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
  'cast'
];

/**
 * Built-in function names that read like perfectly ordinary variable names.
 *
 * `three` converts a `ShaderMaterial` (as opposed to a `RawShaderMaterial`) to
 * `#version 300 es`, so the ES 3.00 built-in set applies — and `round` is in
 * it. `float round = …` inside an iris SDF is the obvious name, compiles on
 * some drivers, and is refused by others; the flare's aperture parameter is
 * called `roundness` for exactly that reason and this list is what stops it
 * quietly going back.
 */
const SHADOWS = [
  'round',
  'sign',
  'step',
  'mix',
  'length',
  'distance',
  'reflect',
  'refract',
  'fract',
  'floor',
  'ceil',
  'trunc',
  'min',
  'max',
  'abs',
  'mod',
  'pow',
  'log',
  'exp',
  'sqrt',
  'cross',
  'dot',
  'texture',
  'degrees',
  'radians'
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

function checkStage(label, src, prefix) {
  const body = stripComments(src);
  const decls = declared(body, prefix);
  for (const name of referenced(body, prefix)) {
    if (PROVIDED.has(name)) continue;
    ok(decls.has(name), `${label}: ${name} referenced but not declared`);
  }
  return decls;
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

function checkReserved(label, src) {
  const body = stripComments(src);
  for (const word of RESERVED) {
    const re = new RegExp(`\\b(?:float|int|bool|vec2|vec3|vec4|mat2|mat3|mat4)\\s+${word}\\b`);
    ok(!re.test(body), `${label}: "${word}" is reserved and cannot be a variable name`);
  }
  for (const word of SHADOWS) {
    const re = new RegExp(`\\b(?:float|int|bool|vec2|vec3|vec4|mat2|mat3|mat4)\\s+${word}\\b`);
    ok(!re.test(body), `${label}: "${word}" shadows a built-in function`);
  }
}

function auditMaterial(label, material) {
  const v = material.vertexShader;
  const f = material.fragmentShader;
  checkBalance(`${label} vertex`, v);
  checkBalance(`${label} fragment`, f);
  checkReserved(`${label} vertex`, v);
  checkReserved(`${label} fragment`, f);
  ok(!v.includes('`') && !f.includes('`'), `${label}: a backtick in the shader source`);
  ok(!/\bcosh\s*\(/.test(v + f), `${label}: cosh() does not exist in ESSL 1.00`);

  const vu = checkStage(`${label} vertex`, v, 'u');
  const fu = checkStage(`${label} fragment`, f, 'u');
  for (const name of [...vu, ...fu]) {
    if (PROVIDED.has(name)) continue;
    ok(material.uniforms[name] !== undefined, `${label}: ${name} declared but has no uniform box`);
  }

  const vVary = declared(stripComments(v), 'v');
  const fVary = declared(stripComments(f), 'v');
  for (const name of fVary) {
    ok(vVary.has(name), `${label}: fragment declares varying ${name} the vertex stage does not`);
  }
}

section('static shader sanity');

const flare = new LensFlare({ name: 'bench' });
const mirror = new Mirror({ name: 'bench', resolution: 128 });
auditMaterial('LensFlare', flare.material);
auditMaterial('Mirror', mirror.material);

// Derivatives are fragment-only. Injecting `commonGLSL` into a vertex stage
// takes `aastep`'s fwidth with it and fails the whole program to compile.
ok(!/\bfwidth\s*\(/.test(flare.material.vertexShader), 'LensFlare vertex stage is free of fwidth');
ok(!/\bfwidth\s*\(/.test(mirror.material.vertexShader), 'Mirror vertex stage is free of fwidth');
ok(
  flare.material.vertexShader.includes('#include <packing>'),
  'LensFlare vertex stage pulls <packing> in for the depth unpack'
);
console.log(`  ${checks} static assertion(s)`);

/* ---------------------------------------------------------------- */
/* 2 · LensFlare behaviour                                           */
/* ---------------------------------------------------------------- */

section('LensFlare');

ok(flare.drawCalls === 1, 'the whole flare is one draw call');
ok(flare.object3D.layers.mask === 1 << LAYER.VFX, 'the flare sits on LAYER.VFX alone');
ok(flare.material.depthTest === false, 'the flare is not depth tested — it is on the lens');
ok(flare.material.toneMapped === false, 'the flare is not tone mapped by the renderer');
ok(flare.object3D.renderOrder >= 3000, 'the flare draws after the scene');
ok(flare.object3D.frustumCulled === false, 'an NDC-built quad must not be frustum culled');

const fp = lensFlareParams();
flare.setAnchorXYZ(0, 2, 12);

for (let ghosts = 0; ghosts <= MAX_FLARE_GHOSTS + 2; ghosts++) {
  fp.ghosts = ghosts;
  flare.update(fp);
  const expected = 3 + Math.min(ghosts, MAX_FLARE_GHOSTS);
  ok(
    flare.object3D.geometry.instanceCount === expected,
    `ghosts=${ghosts} draws ${expected} instances`,
    String(flare.object3D.geometry.instanceCount)
  );
}

// README trap 7, inverted: with no depth buffer bound the kernel would decide
// the source is buried in a wall and the flare would never appear at all.
const restoreDepth = frame.uSceneDepth.value;
frame.uSceneDepth.value = null;
fp.occlusion = 1;
flare.update(fp);
ok(flare.material.uniforms.uOcclusion.value === 0, 'no depth buffer bound disables the occlusion test');
frame.uSceneDepth.value = { isTexture: true };
flare.update(fp);
ok(flare.material.uniforms.uOcclusion.value === 1, 'a bound depth buffer re-enables it');
frame.uSceneDepth.value = restoreDepth;

// I1 — a zero-length frame is still a frame.
fp.streakLength = 0.9;
fp.colorStreak = '#ff0000';
flare.update(fp);
ok(flare.material.uniforms.uStreakLength.value === 0.9, 'a size dragged while paused reaches the uniform');
ok(flare.material.uniforms.uColorStreak.value.r > 0.9, 'a colour dragged while paused reaches the uniform');

// Nothing dimensioned may be captured: every metre and every fraction has to
// come back out of the params object on the next update.
fp.streakLength = 0.1;
flare.update(fp);
ok(flare.material.uniforms.uStreakLength.value === 0.1, 'and it re-resolves the frame after');

const taps = flare.material.uniforms.uOccTaps;
fp.occTaps = 40;
flare.update(fp);
ok(taps.value <= 9, 'the occlusion kernel is clamped to the unrolled loop bound', String(taps.value));

/* ---------------------------------------------------------------- */
/* 3 · Mirror — the scheduler                                        */
/* ---------------------------------------------------------------- */

section('Mirror');

ok(mirror.drawCalls === 1, 'the surface is one draw call');
ok(mirror.object3D.frustumCulled === false, 'a uniform-built quad culls itself, in _wantsRender');
ok(mirror.material.uniforms.uHasReflection.value === 0, 'nothing is reflected before the first pass');

const baseLive = mirrorBudget.live;
ok(baseLive === 0, 'constructing a mirror does not register it');
mirror.visible = true;
ok(mirrorBudget.live === 1, 'showing a mirror registers it');
mirror.visible = true;
ok(mirrorBudget.live === 1, 'showing it twice registers it once');
mirror.visible = false;
ok(mirrorBudget.live === 0, 'hiding it releases');

/** The least renderer `_renderReflection()` will accept. */
function stubRenderer() {
  return {
    info: { render: { frame: 0, calls: 9, triangles: 5300 } },
    xr: { enabled: false },
    shadowMap: { autoUpdate: true },
    autoClear: false,
    state: { buffers: { depth: { setMask() {} } }, viewport() {} },
    getRenderTarget: () => null,
    setRenderTarget() {},
    clear() {},
    render() {
      // The real one increments here too, which is the whole reason the module
      // subtracts its own nested renders back out of the frame token.
      this.info.render.frame++;
    }
  };
}

const scene = new Scene();
const group = new Group();
scene.add(group);
const camera = new PerspectiveCamera(50, 16 / 9, 0.1, 400);
camera.position.set(0, 2.4, -7);
camera.lookAt(new Vector3(0, 1.2, 12));
camera.updateMatrixWorld(true);
camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

const gl = stubRenderer();
const previousBudget = mirrorBudget.max;
setMirrorBudget(2);

const panes = [];
for (let i = 0; i < 5; i++) {
  const m = new Mirror({ resolution: 128, name: `pane${i}` });
  group.add(m.object3D);
  m.visible = true;
  panes.push(m);
}
ok(mirrorBudget.live === 5, 'five live mirrors');

const mp = mirrorParams();
const at = new Vector3();
const firstSeen = new Map();
let worstFrame = 0;

for (let f = 0; f < 12; f++) {
  gl.info.render.frame++; // the outer frame's own render call
  for (let i = 0; i < panes.length; i++) {
    at.set(i * 2.2 - 4.4, 1.2, 12);
    mp.width = 2 + i * 0.3;
    mp.height = 2;
    mp.roughness = f % 2 ? 0.8 : 0;
    panes[i].setPlacement(at, new Vector3(0, 0, -1), new Vector3(1, 0, 0));
    panes[i].update(mp);
  }
  for (const pane of panes) pane.object3D.onBeforeRender(gl, scene, camera);

  worstFrame = Math.max(worstFrame, mirrorBudget.rendered);
  for (const pane of panes) {
    if (pane.material.uniforms.uHasReflection.value > 0.5 && !firstSeen.has(pane.mesh.name)) {
      firstSeen.set(pane.mesh.name, f);
    }
  }
}

ok(worstFrame <= 2, 'never more than the budget in one frame', `worst frame rendered ${worstFrame}`);
ok(worstFrame === 2, 'and the budget is actually spent');
ok(firstSeen.size === panes.length, 'every mirror got a turn', `${firstSeen.size} of ${panes.length}`);
ok(
  Math.max(...firstSeen.values()) <= 3,
  'starvation weighting gives everyone a first turn inside four frames',
  `worst wait ${Math.max(...firstSeen.values())} frames`
);
ok(mirrorBudget.calls === 2 * 9, 'the reflection cost is measured off renderer.info', String(mirrorBudget.calls));

for (const pane of panes) {
  const e = pane.material.uniforms.uReflectMatrix.value.elements;
  ok(e.every(Number.isFinite), `${pane.mesh.name}: the oblique lookup matrix is finite`);
}

// The oblique near plane has to *move* when the mirror does, or it is not
// clipped to the mirror at all.
const before = panes[0].material.uniforms.uReflectMatrix.value.elements.slice();
at.set(0, 4.5, 6);
panes[0].setPlacement(at, new Vector3(0, 1, 0), new Vector3(0, 0, 1));
panes[0].update(mp);
gl.info.render.frame++;
setMirrorBudget(5);
for (const pane of panes) pane.object3D.onBeforeRender(gl, scene, camera);
const after = panes[0].material.uniforms.uReflectMatrix.value.elements;
ok(before.some((v, i) => Math.abs(v - after[i]) > 1e-6), 'moving the plane rebuilds the reflection matrix');

// A recursion guard: a mirror asked to render from inside another mirror's
// reflection must decline rather than blow the stack.
let depth = 0;
const recursive = stubRenderer();
recursive.render = function render() {
  this.info.render.frame++;
  if (depth++ > 4) return;
  for (const pane of panes) pane.object3D.onBeforeRender(recursive, scene, camera);
};
gl.info.render.frame++;
recursive.info.render.frame = gl.info.render.frame;
for (const pane of panes) pane.object3D.onBeforeRender(recursive, scene, camera);
ok(depth <= panes.length, 'a nested reflection is refused, not recursed', `depth ${depth}`);

// The depth prepass draws WORLD with an override material; a mirror on that
// layer must not render its reflection from inside it.
const overridden = new Scene();
overridden.overrideMaterial = mirror.material;
const beforePrepass = mirrorBudget.rendered;
gl.info.render.frame++;
for (const pane of panes) pane.object3D.onBeforeRender(gl, overridden, camera);
ok(mirrorBudget.rendered === beforePrepass, 'the depth prepass does not trigger a reflection');

// I1 and the live re-size.
mp.resolution = 256;
panes[0].update(mp);
ok(panes[0].resolution === 256, 'the resolution slider re-sizes the target');
ok(panes[0].material.uniforms.uHasReflection.value === 0, 'a re-sized target is not trusted until it is redrawn');
mp.roughness = 0.42;
panes[0].update(mp);
ok(panes[0].material.uniforms.uRoughness.value === 0.42, 'roughness dragged while paused reaches the uniform');
mp.width = 7.5;
panes[0].update(mp);
ok(panes[0].material.uniforms.uSize.value.x === 7.5, 'a metre dragged while paused reaches the uniform');

for (const pane of panes) pane.dispose();
ok(mirrorBudget.live === 0, 'disposing every mirror empties the register');
setMirrorBudget(previousBudget);
flare.dispose();
mirror.dispose();

/* ---------------------------------------------------------------- */

console.log(
  failures === 0
    ? `\n✓ ${checks} assertions, no failures\n`
    : `\n✗ ${failures} of ${checks} assertions failed\n`
);
process.exit(failures === 0 ? 0 : 1);
