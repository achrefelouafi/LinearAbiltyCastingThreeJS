/**
 * `scripts/check-vfx-distortion-portal.mjs` — the harness for
 * `vfx/Distortion.js` and `vfx/Portal.js`.
 *
 * Separate from `scripts/check.mjs` for the same reason
 * `check-vfx-tube-shell.mjs` is: that one walks the **registry**, and neither of
 * these modules is reachable from an ability yet. Fold it in — or add a
 * `"check:vfx"` script — the moment one is.
 *
 * No WebGL, so this cannot prove the GLSL compiles. Three things stand in:
 *
 *  1. **The module imports at all.** That sounds trivial and is not. Both files
 *     keep their shaders in tagged template literals, and a backtick inside a
 *     GLSL *comment* terminates the string — it fails as
 *     `SyntaxError: Unexpected identifier` pointing at a line in the middle of
 *     the shader, which is not an obvious read. This harness caught it twice
 *     while the modules were being written.
 *  2. **Static shader sanity.** Every `uXxx` a stage references is declared in
 *     that stage, the two stages agree on their varyings, and the braces and the
 *     preprocessor balance. Between them those catch essentially every typo that
 *     survives writing the file, including the reserved-word collisions (`flat`)
 *     that only a real compiler would otherwise find.
 *  3. **Behaviour.** The writer counter, the premultiplied blend setup, and
 *     **I1** — a value changed on a zero-length frame must move a uniform.
 *
 * Run: `node scripts/check-vfx-distortion-portal.mjs`
 */
import { Vector3, IcosahedronGeometry, CustomBlending, OneFactor, OneMinusSrcAlphaFactor } from 'three';
import { DistortionField, DistortionMode, DistortionFacing } from '../src/vfx/Distortion.js';
import { Portal } from '../src/vfx/Portal.js';
import { LAYER, distortionWriters } from '../src/core/Layers.js';
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

/* ---------------------------------------------------------------- */
/* 1 · static shader sanity                                          */
/* ---------------------------------------------------------------- */

/** Identifiers three declares for us, which a stage may use without declaring. */
const PROVIDED = new Set([
  'uv',
  'uv1',
  'uv2',
  'position',
  'normal',
  'tangent',
  'projectionMatrix',
  'modelViewMatrix',
  'modelMatrix',
  'viewMatrix',
  'normalMatrix',
  'cameraPosition',
  'isOrthographic',
  'logDepthBufFC'
]);

/** Strip comments so a name mentioned in prose is not read as a reference. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function declared(src, prefix) {
  const out = new Set();
  const re = new RegExp(
    `\\b(?:uniform|varying|attribute|in|out)\\s+(?:lowp\\s+|mediump\\s+|highp\\s+)?\\w+\\s+([^;]+);`,
    'g'
  );
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

  let depth = 0;
  let stray = false;
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (/^#if|^#ifdef|^#ifndef/.test(t)) depth++;
    else if (/^#endif/.test(t)) depth--;
    if (depth < 0) stray = true;
  }
  ok(!stray, `${label}: #endif without a matching #if`);
  ok(depth === 0, `${label}: unbalanced preprocessor`, `${depth}`);
}

/** GLSL ES keywords and reserved words that must never be a local name. */
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

function checkReserved(label, src) {
  const body = stripComments(src);
  for (const word of RESERVED) {
    const re = new RegExp(`\\b(?:float|int|bool|vec2|vec3|vec4|mat2|mat3|mat4)\\s+${word}\\b`);
    ok(!re.test(body), `${label}: "${word}" is reserved and cannot be a variable name`);
  }
}

function auditMaterial(label, material) {
  const v = material.vertexShader;
  const f = material.fragmentShader;
  checkBalance(`${label} vertex`, v);
  checkBalance(`${label} fragment`, f);
  checkReserved(`${label} vertex`, v);
  checkReserved(`${label} fragment`, f);

  const vu = checkStage(`${label} vertex`, v, 'u');
  const fu = checkStage(`${label} fragment`, f, 'u');
  for (const name of [...vu, ...fu]) {
    if (PROVIDED.has(name)) continue;
    ok(material.uniforms[name] !== undefined, `${label}: ${name} declared but has no uniform box`);
  }

  // A varying written by the vertex stage must be declared identically in the
  // fragment stage, or the link fails with a message that names neither file.
  const vVary = declared(stripComments(v), 'v');
  const fVary = declared(stripComments(f), 'v');
  for (const name of fVary) {
    ok(vVary.has(name), `${label}: fragment declares varying ${name} the vertex stage does not`);
  }
}

section('static shader sanity');

const audited = [
  ['HEAT', new DistortionField({ mode: DistortionMode.HEAT })],
  ['LENS', new DistortionField({ mode: DistortionMode.LENS })],
  ['SHOCK', new DistortionField({ mode: DistortionMode.SHOCK, facing: DistortionFacing.GROUND })],
  ['BLADE', new DistortionField({ mode: DistortionMode.BLADE, edge: true })],
  ['REFRACT', new DistortionField({ mode: DistortionMode.REFRACT, geometry: new IcosahedronGeometry(1, 1) })]
];
for (const [label, field] of audited) {
  auditMaterial(`Distortion:${label}`, field.material);
  if (field.edgeMaterial) auditMaterial(`Distortion:${label}:edge`, field.edgeMaterial);
}

const portal = new Portal();
auditMaterial('Portal', portal.material);
console.log(`  ${checks} static assertion(s)`);

/* ---------------------------------------------------------------- */
/* 2 · the writer counter                                            */
/* ---------------------------------------------------------------- */

section('the distortion writer counter');

const base = distortionWriters.count;
const probe = new DistortionField({ mode: DistortionMode.LENS, name: 'probe' });
ok(probe.object3D.layers.mask === (1 << LAYER.DISTORTION), 'the emitter sits on LAYER.DISTORTION alone');
ok(distortionWriters.count === base, 'constructing an emitter does not retain');

probe.visible = true;
ok(distortionWriters.count === base + 1, 'showing retains');
probe.visible = true;
ok(distortionWriters.count === base + 1, 'showing twice retains once');
probe.visible = false;
ok(distortionWriters.count === base, 'hiding releases');
probe.visible = false;
ok(distortionWriters.count === base, 'hiding twice releases once');
probe.visible = true;
probe.dispose();
ok(distortionWriters.count === base, 'disposing a visible emitter releases');

/* ---------------------------------------------------------------- */
/* 3 · I1 — a zero-length frame moves the uniforms                   */
/* ---------------------------------------------------------------- */

section('I1 — every dimension re-resolves on a zero-length frame');

const p = {};
const lens = new DistortionField({ mode: DistortionMode.LENS });
p.width = 4;
p.height = 4;
p.radius = 2;
p.strength = 0.3;
p.core = 0.2;
p.invert = 0;
lens.update(p);
const before = {
  size: lens.material.uniforms.uSize.value.x,
  radius: lens.material.uniforms.uRadius.value,
  strength: lens.material.uniforms.uStrength.value
};
p.width = 9;
p.radius = 7.5;
p.strength = 0.9;
lens.update(p); // no dt, no render — exactly what a paused frame does
ok(lens.material.uniforms.uSize.value.x === 9, 'width reaches uSize with the clock stopped', `${before.size} → 9`);
ok(lens.material.uniforms.uRadius.value === 7.5, 'radius reaches uRadius with the clock stopped');
ok(lens.material.uniforms.uStrength.value === 0.9, 'strength reaches uStrength with the clock stopped');

const savedPost = settings.post.distortion;
const savedGlobal = settings.global.distortion;
settings.post.distortion = 0.08;
settings.global.distortion = 2;
lens.update(p);
ok(
  Math.abs(lens.material.uniforms.uPostScale.value - 0.16) < 1e-9,
  'uPostScale mirrors post.distortion × global.distortion',
  String(lens.material.uniforms.uPostScale.value)
);
settings.post.distortion = savedPost;
settings.global.distortion = savedGlobal;

// The fold guard is the one place the module reads settings, and it must not
// have folded the master gains into the strength as well.
lens.update(p);
ok(lens.material.uniforms.uStrength.value === 0.9, 'strength is never pre-multiplied by the global gains');

/* ---------------------------------------------------------------- */
/* 4 · the blade shares its uniform boxes with its hairline          */
/* ---------------------------------------------------------------- */

section('the blade and its hairline are one plane');

const blade = new DistortionField({ mode: DistortionMode.BLADE, edge: true });
const bu = blade.material.uniforms;
const eu = blade.edgeMaterial.uniforms;
for (const key of ['uAnchor', 'uSize', 'uPivot', 'uAxisX', 'uAxisY', 'uCut', 'uEdge', 'uOpacity']) {
  ok(bu[key] === eu[key], `${key} is the same uniform box in both passes`);
}
blade.setAnchorXYZ(1, 2, 3);
ok(eu.uAnchor.value.x === 1 && eu.uAnchor.value.z === 3, 'moving the blade moves the hairline');
blade.setBasis(new Vector3(0, 0, 1), new Vector3(0, 1, 0));
ok(Math.abs(eu.uAxisX.value.z - 1) < 1e-6, 'setBasis writes the shared axis');
ok(Math.abs(eu.uAxisY.value.y - 1) < 1e-6, 'setBasis re-orthogonalises up against along');
ok(blade.edgeMesh.layers.mask === (1 << LAYER.VFX), 'the hairline is on LAYER.VFX, not the offset buffer');

/* ---------------------------------------------------------------- */
/* 5 · Portal                                                        */
/* ---------------------------------------------------------------- */

section('Portal');

const rift = new Portal({ name: 'rift' });
const ru = rift.material.uniforms;

ok(rift.material.blending === CustomBlending, 'the portal blends custom');
ok(rift.material.blendSrc === OneFactor, 'premultiplied: src = ONE');
ok(rift.material.blendDst === OneMinusSrcAlphaFactor, 'premultiplied: dst = ONE_MINUS_SRC_ALPHA');
ok(rift.material.blendSrcAlpha === OneFactor, 'premultiplied: srcAlpha = ONE');
ok(rift.material.blendDstAlpha === OneMinusSrcAlphaFactor, 'premultiplied: dstAlpha = ONE_MINUS_SRC_ALPHA');
ok(rift.material.depthTest === true, 'depthTest is on — nearer opaque geometry hides the hole');
ok(rift.material.depthWrite === false, 'depthWrite is off by default');
ok(new Portal({ writeDepth: true }).material.depthWrite === true, 'writeDepth: true turns depthWrite on');

const po = { radiusX: 3, radiusY: 1, margin: 0.5, open: 0.25 };
rift.update(po);
ok(ru.uRadii.value.x === 3 && ru.uRadii.value.y === 1, 'the radii reach uRadii');
ok(ru.uSize.value.x === 9 && ru.uSize.value.y === 3, 'the quad holds the aperture plus the crack margin');
ok(ru.uOpen.value === 0.25, 'open reaches uOpen');
po.radiusX = 6;
po.open = 0.8;
rift.update(po);
ok(ru.uSize.value.x === 18, 'resizing on a zero-length frame re-sizes the quad');
ok(ru.uOpen.value === 0.8, 'the tear progresses on a zero-length frame');

// I5: ten pickers, none derived from another, none sharing a Color instance.
const colourKeys = Object.keys(ru).filter((k) => k.startsWith('uColor'));
ok(colourKeys.length === 10, 'the portal exposes ten colours', String(colourKeys.length));
const instances = new Set(colourKeys.map((k) => ru[k].value));
ok(instances.size === 10, 'no two colours share a Color instance');

rift.update({ ...po, colorRim: '#ff0000', colorCore: '#00ff00' });
ok(ru.uColorRim.value.r > 0.9 && ru.uColorRim.value.g < 0.01, 'colorRim reaches its uniform');
ok(ru.uColorCore.value.g > 0.9 && ru.uColorCore.value.r < 0.01, 'colorCore is independent of colorRim');

/* ---------------------------------------------------------------- */
/* 6 · no allocation in the frame path                               */
/* ---------------------------------------------------------------- */

section('I3 — the frame path does not allocate');

const sizeBox = ru.uSize.value;
const anchorBox = ru.uAnchor.value;
const colourBox = ru.uColorRim.value;
rift.setPlacement(new Vector3(1, 2, 3), new Vector3(1, 0, 0), new Vector3(0, 1, 0));
rift.update(po);
ok(ru.uSize.value === sizeBox, 'update() mutates uSize rather than replacing it');
ok(ru.uAnchor.value === anchorBox, 'setPlacement() mutates uAnchor rather than replacing it');
ok(ru.uColorRim.value === colourBox, 'update() mutates the Color rather than replacing it');

const lensSize = lens.material.uniforms.uSize.value;
lens.update(p);
ok(lens.material.uniforms.uSize.value === lensSize, 'the field mutates its uniform boxes too');

/* ---------------------------------------------------------------- */

console.log('');
if (failures === 0) {
  console.log(`Distortion + Portal: all ${checks} assertion(s) pass.`);
} else {
  console.error(`Distortion + Portal: ${failures} of ${checks} assertion(s) FAILED.`);
  process.exitCode = 1;
}
