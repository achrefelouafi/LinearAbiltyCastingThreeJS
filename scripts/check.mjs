#!/usr/bin/env node
/**
 * check.mjs — the headless verification harness (docs/EXPANSION.md §7).
 *
 * Forty-four abilities are about to be written by people who cannot see the
 * screen this project renders to. This file is the thing that stands in for
 * looking at it. It runs in plain Node with no WebGL, because three.js builds
 * geometry, materials and scene graphs entirely on the CPU and every VFX system
 * in this repo defers GL to render time — so an ability can be constructed,
 * cast, ticked through all four phases and torn down without a canvas ever
 * existing.
 *
 * Five passes, in increasing order of how much they cost and how much they find:
 *
 *   1. **Structure.** Every registered id has a settings block, a schema, a
 *      sigil and at most one keyboard letter; every block carries the five
 *      fields the framework indexes blind (`range`, `minRange`, `speed`,
 *      `cooldown`, `castAnim`, plus `zoneRadius` for a far cast) and the ranges
 *      are not nonsense.
 *
 *   2. **The static settings cross-check.** The highest-value pass in the file.
 *      Every source file under `src/` is lexed, every property read off a
 *      settings block is collected — `settings.<id>.<key>`, `const c =
 *      settings.<id>` then `c.<key>`, `this.config.<key>`, and destructuring
 *      from any of those — and each one is looked up in the block it names. A
 *      key that does not exist reads as `undefined`, multiplies into `NaN`,
 *      and produces geometry that silently vanishes with no error anywhere.
 *      That is the single most common way one of these abilities breaks, it
 *      costs an afternoon to find by eye, and it costs eight milliseconds to
 *      find here.
 *
 *      The reverse direction — a key in the block that nothing ever reads — is
 *      a **warning**, never a failure, because a shared VFX module reads its
 *      configuration through a live object reference that no amount of
 *      grepping can attribute to an id.
 *
 *   3. **Runtime simulation.** Each ability is constructed against real
 *      subsystems on a bare `Scene`, cast, and ticked 240 frames at 1/60 with
 *      the frame clock driven forward and every subsystem flushed exactly as
 *      `App` flushes it. Any throw, any `NaN` or `Infinity` in a particle
 *      attribute array or a mesh transform, any mesh added to the group during
 *      a cast, any ability that never reaches `DONE` — all fatal. It is then
 *      destroyed and cast a *second* time, because the pooling contract says
 *      `destroy()` leaves the instance reusable and nothing else tests that.
 *
 *   4. **The pause test.** Invariant I1 has one observable consequence: stop
 *      the clock, drag a slider, and the standing effect changes. So we stop
 *      the clock (`dt = 0`, which is exactly what `App` feeds the manager when
 *      paused), snapshot every uniform, every transform and every instance
 *      matrix the ability owns, scale its numeric settings by 1.37, tick one
 *      zero-length frame, and demand that something moved. Twice — once
 *      mid-travel and once mid-impact — because an ability that resolves its
 *      dimensions during travel and then bakes them at impact passes the first
 *      sample and fails the second, and that is the exact shape of the mistake.
 *
 *      When the ability is *stable* at rest (a zero-length frame with no
 *      mutation changes nothing) the harness goes further and probes each
 *      slider on its own, which turns "this ability responds" into "37 of its
 *      54 sliders are observable while paused, and here are the seventeen that
 *      are not". Run with `--sliders` to see the list.
 *
 *   5. **Report.** One row per ability, then a detail section for the rows that
 *      failed. Non-zero exit on any failure.
 *
 * Usage:
 *   npm run check                 every registered ability
 *   npm run check -- --only ice   one id, which is how you will actually use it
 *   npm run check -- --quiet      the table and the failures, nothing else
 *   npm run check -- --sliders    list the sliders that do nothing while paused
 */

/* ------------------------------------------------------------------ */
/* §0 · Browser shims — installed before a single project module loads */
/* ------------------------------------------------------------------ */
/**
 * Nothing in `src/` needs a DOM today, and the harness would import cleanly
 * without any of this. It is here for the ability that eventually reaches for
 * `window.devicePixelRatio` at module scope, or for the three.js code path that
 * decides it is in a browser and asks for a canvas: a missing global there
 * throws during *import*, which reports as "the whole harness is broken"
 * rather than "one module misbehaved".
 *
 * The stubs are deliberately inert. They exist to be present, not to work — a
 * shim that half-works lets a module take a browser path in Node and fail two
 * hundred lines later, which is worse than failing at the first call.
 */
const canvasStub = () => {
  const context2d = {
    canvas: null,
    fillStyle: '#000',
    strokeStyle: '#000',
    globalAlpha: 1,
    fillRect() {},
    clearRect() {},
    drawImage() {},
    getImageData: (_x, _y, w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData() {},
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    measureText: () => ({ width: 0 }),
    fillText() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    fill() {},
    stroke() {},
    save() {},
    restore() {},
    translate() {},
    scale() {},
    rotate() {}
  };
  const element = {
    width: 1,
    height: 1,
    style: {},
    className: '',
    dataset: {},
    children: [],
    getContext: (kind) => (kind === '2d' ? context2d : null),
    toDataURL: () => 'data:,',
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    removeChild() {},
    remove() {},
    setAttribute() {},
    getAttribute: () => null,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 1, height: 1, top: 0, left: 0, right: 1, bottom: 1 }),
    querySelector: () => null,
    querySelectorAll: () => []
  };
  context2d.canvas = element;
  return element;
};

if (typeof globalThis.window === 'undefined') {
  const storage = new Map();
  globalThis.window = globalThis;
  globalThis.self = globalThis;
  globalThis.devicePixelRatio = 1;
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 720;
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.dispatchEvent = () => true;
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(0), 16);
  globalThis.cancelAnimationFrame = (handle) => clearTimeout(handle);
  globalThis.localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => void storage.set(key, String(value)),
    removeItem: (key) => void storage.delete(key),
    clear: () => storage.clear(),
    key: (index) => [...storage.keys()][index] ?? null,
    get length() {
      return storage.size;
    }
  };
}

if (typeof globalThis.document === 'undefined') {
  const root = canvasStub();
  globalThis.document = {
    documentElement: root,
    body: root,
    head: root,
    createElement: () => canvasStub(),
    createElementNS: () => canvasStub(),
    createTextNode: (text) => ({ nodeValue: String(text) }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    createEvent: () => ({ initEvent() {} })
  };
}

if (typeof globalThis.performance === 'undefined') {
  globalThis.performance = { now: () => Number(process.hrtime.bigint() / 1000n) / 1000 };
}

/* ------------------------------------------------------------------ */
/* §1 · Imports                                                        */
/* ------------------------------------------------------------------ */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  Scene,
  Group,
  PerspectiveCamera,
  Vector3,
  Quaternion,
  ConeGeometry,
  IcosahedronGeometry,
  TetrahedronGeometry,
  BoxGeometry,
  Mesh,
  BufferAttribute,
  Bone,
  Skeleton,
  SkinnedMesh,
  MeshBasicMaterial,
  MeshStandardMaterial
} from 'three';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'src');

/*
 * `config/settings.js` is imported FIRST, and the order is load-bearing.
 *
 * Several settings modules now spread a prefixed defaults fragment from the
 * tech library (`shellDefaults`, `tubeDefaults`, `volumeHullDefaults`), and
 * those library modules import `config/settings.js` for their `settings.global`
 * default argument. That closes a cycle:
 *
 *   registry → config/abilities/index → <block> → vfx/Shell → config/settings
 *            → config/abilities/index (already evaluating: TDZ)
 *
 * Entering the cycle at `config/settings.js` instead is fine, because the only
 * thing the library wants from it is a live binding it reads at call time, and
 * by the time anything calls, everything is initialised. Entering at the
 * registry is not: `settings.js` reaches `...ABILITY_SETTINGS` while
 * `abilities/index.js` is still half-way down its own import list, and Node
 * throws `Cannot access 'ABILITY_SETTINGS' before initialization`. The browser
 * happens to enter through `settings.js` (via `core/Renderer.js`); the harness
 * has to do the same deliberately.
 */
const { settings, CAST_ANIMATIONS, CastShape } = await import('../src/config/settings.js');
const { ABILITIES, SCHOOLS } = await import('../src/abilities/registry.js');
const { ABILITY_SETTINGS, ABILITY_SCHEMAS } = await import('../src/config/abilities/index.js');
const { AbilityPhase } = await import('../src/abilities/Ability.js');
const { frame } = await import('../src/core/FrameUniforms.js');
const { ParticleEngine } = await import('../src/particles/ParticleEngine.js');
const { LightPool } = await import('../src/effects/LightPool.js');
const { DecalSystem } = await import('../src/effects/GroundDecals.js');
const { FissureSystem } = await import('../src/effects/GroundFissures.js');
const { BurstSystem } = await import('../src/effects/BurstSphere.js');
const { ELEMENT_SIGILS } = await import('../src/ui/glyphs/index.js');
const { patchOnBeforeCompile } = await import('../src/utils/shaderPatch.js');

/**
 * The two **global** pools an ability can take a piece of the world from: the
 * app-wide `sceneHooks` ledger and the app-wide `timeField`. They are read here
 * so the runtime pass can assert that `destroy()` gave everything back.
 *
 * Imported softly. A syntax error in either file is the VFX stage's business to
 * report, with a filename and a line; if it also took the ability stage down
 * with it, fifty green abilities would read as fifty broken ones.
 */
let _sceneHooks = null;
let _timeField = null;
try {
  ({ sceneHooks: _sceneHooks } = await import('../src/vfx/SceneHooks.js'));
} catch {
  /* reported by the VFX stage */
}
try {
  ({ timeField: _timeField } = await import('../src/vfx/TimeControl.js'));
} catch {
  /* reported by the VFX stage */
}
const sceneHooksLive = () => _sceneHooks?.heldCount ?? 0;
const sceneHooksReleaseAll = () => _sceneHooks?.releaseAll();
const timeRegionsLive = () => _timeField?.liveCount ?? 0;
const timeRegionsReset = () => _timeField?.reset();

/* ------------------------------------------------------------------ */
/* §2 · Arguments and reporting plumbing                               */
/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const ONLY = value('--only');
const QUIET = flag('--quiet');
const SHOW_SLIDERS = flag('--sliders');

const COLOUR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (COLOUR ? `[${code}m${text}[0m` : text);
const red = (t) => paint('31', t);
const green = (t) => paint('32', t);
const yellow = (t) => paint('33', t);
const dim = (t) => paint('2', t);
const bold = (t) => paint('1', t);

/** Simulation constants. Named because every one of them is a judgement call. */
const DT = 1 / 60; //  seconds per simulated frame
const REQUIRED_FRAMES = 240; //  frames every cast is ticked for, minimum
const MAX_FRAMES = 900; //  frames after which a cast that has not finished has hung
const REUSE_FRAMES = 60; //  frames of the second cast, which tests the pooling contract
const NAN_STRIDE = 8; //  scan the (large) particle arrays every Nth frame
const SANITY_RADIUS = 5000; //  metres; a mesh further out than this is a broken transform
const DRAW_CALL_BUDGET = 12; //  I7 — meshes in one ability's group
const MUTATION = 1.37; //  the factor a slider is scaled by in the pause test
const CHANGE_EPSILON = 1e-6; //  relative tolerance below which "it moved" is float noise

/** Keys the framework indexes blind on every block, whether or not it reads them. */
const CAST_KEYS = ['range', 'minRange', 'speed', 'cooldown', 'castAnim'];
/** Keys excluded from the pause mutation: they are consumed at spawn, not per frame. */
const PAUSE_EXCLUDED = new Set(['range', 'minRange', 'speed', 'cooldown']);

/** One of these per registered ability; the table is these rows. */
class Report {
  constructor(id) {
    this.id = id;
    this.failures = [];
    this.warnings = [];
    this.notes = [];
    this.marks = { struct: null, static: null, runtime: null, travel: null, impact: null };
  }

  fail(stage, message) {
    this.failures.push({ stage, message });
    if (stage in this.marks) this.marks[stage] = false;
    return false;
  }

  warn(stage, message) {
    this.warnings.push({ stage, message });
  }

  note(message) {
    this.notes.push(message);
  }

  /** Mark a stage passed unless something already failed in it. */
  pass(stage) {
    if (this.marks[stage] !== false) this.marks[stage] = true;
  }

  get ok() {
    return this.failures.length === 0;
  }
}

/** Failures that belong to the roster as a whole rather than to one ability. */
const globalFailures = [];
const globalWarnings = [];
const failGlobal = (message) => globalFailures.push(message);
const warnGlobal = (message) => globalWarnings.push(message);

const log = (...args) => {
  if (!QUIET) console.log(...args);
};

/* ------------------------------------------------------------------ */
/* §3 · Structure                                                      */
/* ------------------------------------------------------------------ */

const ALL_IDS = ABILITIES.map((a) => a.id);
const TARGET = ONLY ? ABILITIES.filter((a) => a.id === ONLY) : ABILITIES;

if (ONLY && TARGET.length === 0) {
  console.error(red(`check: no registered ability with id "${ONLY}".`));
  console.error(dim(`       known ids: ${ALL_IDS.join(', ')}`));
  process.exit(2);
}

const reports = new Map(TARGET.map((a) => [a.id, new Report(a.id)]));
const SCHOOL_IDS = new Set(SCHOOLS.map((s) => s.id));

/** Registry-wide invariants: unique ids, unique keys, known schools. */
function checkRoster() {
  const seenIds = new Set();
  const seenKeys = new Map();

  for (const descriptor of ABILITIES) {
    if (seenIds.has(descriptor.id)) failGlobal(`duplicate registry id "${descriptor.id}"`);
    seenIds.add(descriptor.id);

    if (descriptor.key) {
      const key = String(descriptor.key).toUpperCase();
      if (seenKeys.has(key)) {
        failGlobal(`key "${key}" is bound to both "${seenKeys.get(key)}" and "${descriptor.id}"`);
      }
      seenKeys.set(key, descriptor.id);
    }
  }

  // A settings block with no registry entry is a block nothing can ever cast.
  for (const id of Object.keys(ABILITY_SETTINGS)) {
    if (!seenIds.has(id)) warnGlobal(`settings block "${id}" is not registered in ABILITIES`);
  }
  for (const id of Object.keys(ABILITY_SCHEMAS)) {
    if (!seenIds.has(id)) warnGlobal(`editor schema "${id}" is not registered in ABILITIES`);
  }
}

/* ------------------------------------------------------------------ */
/* §3b · The schools                                                   */
/* ------------------------------------------------------------------ */
/**
 * A school is four things that have to land together, and the reason this
 * check exists is that only one of them fails loudly.
 *
 * An entry in `SCHOOLS` with no `ui/glyphs/<id>.js`, or with a module that
 * `ui/glyphs/index.js` never folds into `ELEMENT_SIGILS`, is *invisible*: the
 * school builds a spellbook section and an editor folder perfectly happily,
 * and every ability in it silently draws no sigil. The per-ability structure
 * pass catches that eventually — one "no sigil" failure per ability — but only
 * once somebody has written an ability, which is days after the school landed
 * and in someone else's diff. Here it fails on the school itself, immediately,
 * and names the two files to create.
 *
 * The fold is verified two ways on purpose. The source scan proves the wiring
 * exists even when the module is an empty stub with nothing to prove it with —
 * which is exactly the state a new school is in — and the identity comparison
 * proves the marks actually arrive, which catches the other failure: two
 * schools exporting a sigil under the same ability id, where the later spread
 * silently wins and one school's mark disappears.
 */
const GLYPH_DIR = path.join(SRC, 'ui', 'glyphs');

/** Modules in `ui/glyphs/` that are not a school. */
const GLYPH_INFRASTRUCTURE = new Set(['index.js', 'wrap.js']);

/**
 * The bar for "two accents nobody can tell apart", set by the tightest pair
 * that already ships: frost `#7ecbe0` against aether `#8fe8d8` scores 0.081.
 * A new school closer to an existing one than two schools the player has
 * lived with for fifty abilities is a warning, not a failure — it is a
 * judgement about a 7px dot, and the author may have a reason.
 */
const ACCENT_FLOOR = 0.075;

/**
 * Redmean colour distance, normalised to roughly 0..1.
 *
 * Not CIE ΔE: this runs 105 times at fifteen schools and the only question it
 * has to answer is "are these two the same dot". Redmean is the cheapest
 * approximation that is right about that, and unlike a plain RGB distance it
 * knows that two dark blues are closer together than two bright yellows.
 */
function accentDistance(a, b) {
  const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r1, g1, b1] = channels(a);
  const [r2, g2, b2] = channels(b);
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  const mean = (r1 + r2) / 2;
  return Math.sqrt((2 + mean) * dr * dr + 4 * dg * dg + (3 - mean) * db * db) / 3.1623;
}

/**
 * The school ids that have a leading mark in the editor.
 *
 * Read out of the source rather than imported: `ui/Editor.js` pulls in lil-gui,
 * which is a DOM library, and importing it here would trade a real check for a
 * shim big enough to have its own bugs. The table is a frozen object literal of
 * `id: 'glyph'` pairs and is not going to grow a computed key.
 */
const EDITOR_SCHOOL_MARKS = (() => {
  try {
    const source = readFileSync(path.join(SRC, 'ui', 'Editor.js'), 'utf8');
    const block = source.match(/const SCHOOL_MARK = Object\.freeze\(\{([\s\S]*?)\n\}\)/);
    return new Set([...(block?.[1] ?? '').matchAll(/^\s*([a-z][a-z0-9]*)\s*:/gm)].map((m) => m[1]));
  } catch {
    return new Set();
  }
})();

/** Roster-level lines that are neither failures nor warnings. */
const rosterNotes = [];

async function checkSchools() {
  const seen = new Set();
  let index = '';
  try {
    index = readFileSync(path.join(GLYPH_DIR, 'index.js'), 'utf8');
  } catch (error) {
    failGlobal(`ui/glyphs/index.js could not be read — ${describeError(error)}`);
  }

  for (const school of SCHOOLS) {
    const { id } = school;

    if (seen.has(id)) failGlobal(`duplicate school id "${id}" in SCHOOLS`);
    seen.add(id);

    if (!/^[a-z][a-z0-9]*$/.test(id ?? '')) {
      failGlobal(`school id ${JSON.stringify(id)} must be lower case with no punctuation — it is a file name`);
      continue;
    }
    if (!school.label) failGlobal(`school "${id}" has no label`);
    if (!/^#[0-9a-f]{6}$/i.test(school.accent ?? '')) {
      failGlobal(`school "${id}" accent must be #rrggbb, got ${JSON.stringify(school.accent)}`);
    }

    /* --- the glyph module --- */
    const file = `${id}.js`;
    const full = path.join(GLYPH_DIR, file);
    let exists = false;
    try {
      exists = statSync(full).isFile();
    } catch {
      exists = false;
    }
    if (!exists) {
      failGlobal(
        `school "${id}" has no glyph module — create src/ui/glyphs/${file} from the stub shape the ` +
          `others use (both append anchors included) and fold it into src/ui/glyphs/index.js`
      );
      continue;
    }

    const exported = `${id.toUpperCase()}_SIGILS`;
    let map = null;
    try {
      const module = await import(full);
      map = module[exported] ?? null;
      if (!map || typeof map !== 'object') {
        failGlobal(`src/ui/glyphs/${file} must export \`${exported}\`, an object keyed by ability id`);
      }
    } catch (error) {
      failGlobal(`src/ui/glyphs/${file} failed to import — ${describeError(error)}`);
      continue;
    }

    if (!index.includes(`'./${file}'`)) {
      failGlobal(`src/ui/glyphs/index.js never imports './${file}' — school "${id}" draws no sigils at all`);
    } else if (!new RegExp(`\\.\\.\\.\\s*${exported}\\b`).test(index)) {
      failGlobal(`src/ui/glyphs/index.js imports './${file}' but never spreads \`${exported}\` into ELEMENT_SIGILS`);
    }

    for (const [ability, markup] of Object.entries(map ?? {})) {
      if (ELEMENT_SIGILS[ability] !== markup) {
        failGlobal(
          `src/ui/glyphs/${file} exports a sigil for "${ability}" that is not the one in ELEMENT_SIGILS — ` +
            `two schools are claiming the same ability id and the later spread wins`
        );
      }
    }

    /* --- the editor's leading mark --- */
    if (!EDITOR_SCHOOL_MARKS.has(id)) {
      warnGlobal(`school "${id}" has no SCHOOL_MARK in ui/Editor.js — its folder falls back to "◇"`);
    }
  }

  /* --- a module in the directory that no school claims --- */
  for (const name of readdirSync(GLYPH_DIR)) {
    if (!name.endsWith('.js') || GLYPH_INFRASTRUCTURE.has(name)) continue;
    if (!seen.has(name.slice(0, -3))) {
      warnGlobal(`src/ui/glyphs/${name} is not a school in SCHOOLS — its sigils are orphaned`);
    }
  }

  /* --- accents that are the same dot --- */
  for (let i = 0; i < SCHOOLS.length; i++) {
    for (let j = i + 1; j < SCHOOLS.length; j++) {
      const a = SCHOOLS[i];
      const b = SCHOOLS[j];
      if (!/^#[0-9a-f]{6}$/i.test(a.accent ?? '') || !/^#[0-9a-f]{6}$/i.test(b.accent ?? '')) continue;
      const distance = accentDistance(a.accent, b.accent);
      if (distance < ACCENT_FLOOR) {
        warnGlobal(
          `school accents ${a.id} ${a.accent} and ${b.id} ${b.accent} score ${distance.toFixed(3)} apart, ` +
            `under the ${ACCENT_FLOOR} floor — at 7px on the rail they are one colour`
        );
      }
    }
  }

  /* --- schools with nothing in them yet --- */
  const populated = new Set(ABILITIES.map((a) => a.school));
  const empty = SCHOOLS.filter((school) => !populated.has(school.id)).map((school) => school.id);
  if (empty.length) {
    rosterNotes.push(
      `${SCHOOLS.length} school(s), ${empty.length} still empty: ${empty.join(', ')} — wired, but ` +
        `absent from the spellbook and the editor until their first ability lands`
    );
  }
}

/**
 * Everything about one descriptor that can be judged without running anything.
 *
 * The `zoneRadius` rule is the one worth stating: a far cast whose block has no
 * `zoneRadius` still *aims* — `zoneRadiusOf` falls back to 0 — so the circle
 * indicator collapses to a point and the ability lands on a footprint of
 * nothing. It is a silent, plausible-looking failure, which is why it is
 * checked here rather than trusted to review.
 */
function checkStructure(descriptor, report) {
  const { id } = descriptor;
  const block = settings[id];

  if (!block || typeof block !== 'object') {
    return report.fail('struct', `no settings block: settings.${id} is ${block}`);
  }
  if (ABILITY_SETTINGS[id] !== block) {
    report.fail('struct', `settings.${id} is not the same object as ABILITY_SETTINGS.${id} — the editor will edit a copy`);
  }
  if (descriptor.settings !== block) {
    report.fail('struct', `registry descriptor for "${id}" does not carry the live block`);
  }

  if (!SCHOOL_IDS.has(descriptor.school)) {
    report.fail('struct', `unknown school "${descriptor.school}"`);
  }
  if (!/^#[0-9a-f]{6}$/i.test(descriptor.accent ?? '')) {
    report.fail('struct', `accent must be #rrggbb, got ${JSON.stringify(descriptor.accent)}`);
  }
  if (typeof descriptor.load !== 'function') {
    report.fail('struct', 'descriptor.load is not a function');
  }
  if (!descriptor.label || !descriptor.blurb) {
    report.warn('struct', 'descriptor is missing a label or a blurb');
  }

  for (const key of CAST_KEYS) {
    if (!(key in block)) report.fail('struct', `settings.${id}.${key} is missing`);
  }

  const shape = descriptor.cast;
  if (shape !== CastShape.LINE && shape !== CastShape.ZONE) {
    report.fail('struct', `cast must be CastShape.LINE or CastShape.ZONE, got ${JSON.stringify(shape)}`);
  }
  if (shape === CastShape.ZONE && !('zoneRadius' in block)) {
    report.fail('struct', `a ZONE cast needs settings.${id}.zoneRadius — without it the footprint is a point`);
  }
  if (shape === CastShape.LINE && 'zoneRadius' in block) {
    report.warn('struct', 'a LINE cast carries zoneRadius, which nothing will draw');
  }

  if (!CAST_ANIMATIONS.includes(block.castAnim)) {
    report.fail('struct', `castAnim ${JSON.stringify(block.castAnim)} is not one of ${CAST_ANIMATIONS.join(' / ')}`);
  }

  const numeric = (key) => typeof block[key] === 'number' && Number.isFinite(block[key]);
  for (const key of ['range', 'minRange', 'speed', 'cooldown']) {
    if (key in block && !numeric(key)) report.fail('struct', `${key} must be a finite number, got ${block[key]}`);
  }
  if (numeric('range') && numeric('minRange') && block.minRange >= block.range) {
    report.fail('struct', `minRange (${block.minRange} m) must be below range (${block.range} m)`);
  }
  if (numeric('range') && block.range <= 0) report.fail('struct', `range must be positive, got ${block.range} m`);
  if (numeric('minRange') && block.minRange < 0) report.fail('struct', `minRange must not be negative, got ${block.minRange} m`);
  if (numeric('speed') && block.speed <= 0) report.fail('struct', `speed must be positive, got ${block.speed} m/s`);
  if (numeric('cooldown') && block.cooldown < 0) report.fail('struct', `cooldown must not be negative, got ${block.cooldown} s`);
  if (shape === CastShape.ZONE && typeof block.zoneRadius === 'number' && block.zoneRadius <= 0) {
    report.fail('struct', `zoneRadius must be positive, got ${block.zoneRadius} m`);
  }

  // Colours are `#rrggbb` strings so lil-gui can bind them directly; anything
  // else in a key named `color*` is a colour that will never get a picker.
  for (const [key, entry] of Object.entries(block)) {
    if (!/^colou?r/i.test(key)) continue;
    if (typeof entry !== 'string' || !/^#[0-9a-f]{6}$/i.test(entry)) {
      report.fail('struct', `${key} must be a "#rrggbb" string, got ${JSON.stringify(entry)}`);
    }
  }

  if (!ELEMENT_SIGILS[id]) {
    report.fail('struct', `no sigil: ui/glyphs has no entry for "${id}"`);
  } else if (!/<svg[\s>]/i.test(ELEMENT_SIGILS[id])) {
    report.fail('struct', 'sigil is not inline SVG markup');
  }

  checkSchema(id, block, report);
  report.pass('struct');
  return report.ok;
}

/**
 * The editor schema names keys. A name that is not in the block builds a
 * controller bound to `undefined`, which lil-gui renders as a dead row.
 *
 * A schema is allowed to be *incomplete* — unmentioned keys land in the
 * trailing "More" folder by design — so the missing direction is a warning and
 * only the wrong direction is a failure.
 */
function checkSchema(id, block, report) {
  const schema = ABILITY_SCHEMAS[id];
  if (!schema || typeof schema !== 'object') {
    return report.fail('struct', `no editor schema: ABILITY_SCHEMAS.${id} is missing`);
  }

  const mentioned = new Set();
  for (const [folder, entries] of Object.entries(schema)) {
    if (!Array.isArray(entries)) {
      report.fail('struct', `schema folder "${folder}" is not an array`);
      continue;
    }
    for (const entry of entries) {
      const key = Array.isArray(entry) ? entry[0] : entry;
      if (typeof key !== 'string') {
        report.fail('struct', `schema folder "${folder}" holds an entry with no key: ${JSON.stringify(entry)}`);
        continue;
      }
      if (key.endsWith('*')) {
        // A gradient group: `colorMist*` stands for colorMistA/B/C/D.
        const prefix = key.slice(0, -1);
        for (const stop of ['A', 'B', 'C', 'D']) {
          const full = prefix + stop;
          mentioned.add(full);
          if (!(full in block)) {
            report.fail('struct', `schema gradient "${key}" in "${folder}" wants ${id}.${full}, which does not exist`);
          }
        }
        continue;
      }
      mentioned.add(key);
      if (!(key in block)) {
        report.fail('struct', `schema key "${key}" in folder "${folder}" does not exist on settings.${id}`);
      }
    }
  }

  const unfiled = Object.keys(block).filter((key) => !mentioned.has(key));
  if (unfiled.length) {
    report.warn(
      'struct',
      `${unfiled.length} key(s) not filed in the schema (they land in "More"): ${preview(unfiled)}`
    );
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* §4 · The static settings cross-check                                */
/* ------------------------------------------------------------------ */

/**
 * Strip comments — and, by default, string literals — replacing them with
 * spaces.
 *
 * Positions are preserved so a hit can still be reported with a line number.
 * The first version of this pass ran the regexes over the raw source, and the
 * very first thing it "found" was `settings.rime.plateSize` inside the doc
 * comment of a module that did not exist yet — a wrong answer that reads as a
 * right one, which is the worst kind for a tool people are meant to trust.
 *
 * `keepStrings` exists for exactly one caller: an ability declares which block
 * `this.config` resolves to by writing `super('beam', context)`, and that id is
 * a *string*. Reading it out of the fully stripped source finds `super(  ,` and
 * silently drops every aliased read in the file — which is how this harness
 * first reported that Nova Beam touches eighty-two of its own settings when the
 * real number is a hundred and sixty.
 *
 * Template literals resume code mode inside `${…}`, because a shader string is
 * a template literal and the interpolations in it are real code. Regex
 * literals are *not* handled: telling a regex from a division needs the parser
 * we do not have, so a `/` is simply left alone. The failure mode of that
 * choice is a missed read, never an invented one.
 */
function stripToCode(source, keepStrings = false) {
  const out = new Array(source.length);
  for (let i = 0; i < source.length; i++) out[i] = source[i];

  const erase = (from, to) => {
    for (let i = from; i < to && i < source.length; i++) {
      if (source[i] !== '\n' && source[i] !== '\r') out[i] = ' ';
    }
  };
  /** Comments always go; string bodies stay when `keepStrings` is set. */
  const blank = keepStrings ? () => {} : erase;

  /** Template-literal nesting: each entry is the `${` depth of one template. */
  const templates = [];
  let i = 0;
  let braceDepth = 0;

  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (c === '/' && next === '/') {
      let j = i;
      while (j < source.length && source[j] !== '\n') j++;
      erase(i, j);
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      let j = i + 2;
      while (j < source.length && !(source[j] === '*' && source[j + 1] === '/')) j++;
      erase(i, Math.min(j + 2, source.length));
      i = j + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < source.length && source[j] !== c) {
        if (source[j] === '\\') j++;
        if (source[j] === '\n') break;
        j++;
      }
      blank(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '`') {
      // Walk the template, blanking its text but leaving `${…}` as code.
      let j = i + 1;
      blank(i, i + 1);
      while (j < source.length) {
        if (source[j] === '\\') {
          blank(j, j + 2);
          j += 2;
          continue;
        }
        if (source[j] === '`') {
          blank(j, j + 1);
          j++;
          break;
        }
        if (source[j] === '$' && source[j + 1] === '{') {
          blank(j, j + 2);
          // Hand control back to the outer loop for the interpolation body.
          templates.push(braceDepth);
          braceDepth++;
          j += 2;
          i = j;
          break;
        }
        blank(j, j + 1);
        j++;
      }
      if (j > i && (source[j - 1] === '`' || j >= source.length)) i = j;
      else if (i !== j) i = j;
      continue;
    }
    if (c === '{') braceDepth++;
    if (c === '}') {
      braceDepth--;
      if (templates.length && braceDepth === templates[templates.length - 1]) {
        // Closing a `${…}`: resume the template's text.
        templates.pop();
        blank(i, i + 1);
        let j = i + 1;
        while (j < source.length) {
          if (source[j] === '\\') {
            blank(j, j + 2);
            j += 2;
            continue;
          }
          if (source[j] === '`') {
            blank(j, j + 1);
            j++;
            break;
          }
          if (source[j] === '$' && source[j + 1] === '{') {
            blank(j, j + 2);
            templates.push(braceDepth);
            braceDepth++;
            j += 2;
            break;
          }
          blank(j, j + 1);
          j++;
        }
        i = j;
        continue;
      }
    }
    i++;
  }

  return out.join('');
}

/** Every `.js` under `src/`, excluding the archive (it reads a dead settings tree). */
function sourceFiles(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'archive' || entry === 'node_modules') continue;
      sourceFiles(full, found);
    } else if (entry.endsWith('.js')) {
      found.push(full);
    }
  }
  return found;
}

const IDENT = '[A-Za-z_$][A-Za-z0-9_$]*';

/**
 * Which local identifiers in a file are safe to treat as "an alias for a
 * settings block".
 *
 * `const c = settings.beam` makes `c.<key>` a settings read for the rest of
 * that method — and in this codebase the same file will bind `c` to
 * `this.config` in the next method, which is the same block by another name.
 * What must never happen is treating `c.foo` as a settings read when some
 * *third* binding put an unrelated object in `c`, because that invents a
 * failure out of nothing.
 *
 * So the pass keeps two sets, and the difference between them is the whole
 * trick:
 *
 *  - **strict** — every binding of the name in the file is a settings binding
 *    *and* the name never appears in anything that parses as a parameter list.
 *    Reads through a strict alias are *required*: a key that is not in the
 *    block is a failure.
 *  - **loose** — the name is bound to a block somewhere, and is also a
 *    parameter somewhere. `IceAbility` threads its block through helpers as
 *    `_halfWidth(s, c)`, which is idiomatic here and would otherwise blind the
 *    pass to two thirds of that file. Reads through a loose alias are recorded
 *    as *optional*: they count toward "this key is used" and can never raise a
 *    failure, so the worst a wrong guess can do is make a warning quieter.
 *
 * Anything bound to a non-settings right-hand side anywhere in the file is out
 * of both sets. That test is deliberately over-eager: its failure mode is
 * dropping a real alias, which loses coverage, and never inventing a fake one,
 * which loses trust.
 */
function collectAliases(code, configIds) {
  const candidates = new Map(); //  name -> Set(blockName) | null when polluted

  const bind = (name, block) => {
    if (candidates.get(name) === null) return;
    if (!candidates.has(name)) candidates.set(name, new Set());
    if (block === null) candidates.set(name, null);
    else candidates.get(name).add(block);
  };

  // Declarations and plain assignments, settings-shaped or not.
  const declaration = new RegExp(
    `(?:\\b(?:const|let|var)\\s+(${IDENT})|(?:^|[;{}(),]\\s*)(${IDENT}))\\s*=\\s*(?!=)([^;\\n]*)`,
    'g'
  );
  for (const match of code.matchAll(declaration)) {
    const name = match[1] ?? match[2];
    const rhs = match[3].trim();
    const settingsBlock = rhs.match(new RegExp(`^settings\\s*\\.\\s*(${IDENT})\\s*;?$`));
    if (settingsBlock) {
      bind(name, settingsBlock[1]);
      continue;
    }
    if (/^this\s*\.\s*config\s*;?$/.test(rhs)) {
      for (const id of configIds) bind(name, id);
      continue;
    }
    bind(name, null);
  }

  /** Names that appear in a parameter list: strict-disqualifying, loose-tolerated. */
  const parameters = new Set();
  const paramForms = [
    new RegExp(`\\bfunction\\s*${IDENT}?\\s*\\(([^)]*)\\)`, 'g'),
    new RegExp(`(?:^|[;{}\\s])(?:async\\s+)?(?:get\\s+|set\\s+|static\\s+)*${IDENT}\\s*\\(([^)]*)\\)\\s*\\{`, 'g'),
    /\(([^)]*)\)\s*=>/g,
    new RegExp(`\\bcatch\\s*\\(\\s*(${IDENT})\\s*\\)`, 'g')
  ];
  for (const pattern of paramForms) {
    for (const match of code.matchAll(pattern)) {
      for (const raw of match[1].split(',')) {
        const name = raw.trim().replace(/^\.\.\./, '').split('=')[0].trim();
        if (new RegExp(`^${IDENT}$`).test(name)) parameters.add(name);
      }
    }
  }
  for (const match of code.matchAll(new RegExp(`(?:^|[^.\\w$])(${IDENT})\\s*=>`, 'g'))) {
    parameters.add(match[1]);
  }

  const strict = new Map(); //  name -> [blockName], reads are required
  const loose = new Map(); //  name -> [blockName], reads are advisory only
  for (const [name, blocks] of candidates) {
    if (blocks === null || blocks.size === 0) continue;
    (parameters.has(name) ? loose : strict).set(name, [...blocks]);
  }
  return { strict, loose };
}

/** Split a destructuring pattern body into the source keys it names. */
function destructuredKeys(body) {
  const keys = [];
  let depth = 0;
  let current = '';
  const flush = () => {
    const piece = current.trim();
    current = '';
    if (!piece || piece.startsWith('...')) return;
    const name = piece.split(':')[0].split('=')[0].trim();
    if (new RegExp(`^${IDENT}$`).test(name)) keys.push(name);
  };
  for (const ch of body) {
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    if (ch === ',' && depth === 0) flush();
    else current += ch;
  }
  flush();
  return keys;
}

/**
 * The whole static pass.
 *
 * Returns `{ reads, unknownBlocks }` where `reads` is `blockName -> key ->
 * [{ file, line, optional }]`. `optional` marks a read written defensively —
 * `this.config.zoneRadius ?? 1`, `c?.foo` — which counts as a read for the
 * unused-key warning but does not make the key mandatory. The aim controller
 * reads `zoneRadius` off whatever block is in the slot; a line cast is entitled
 * not to have one.
 */
function scanSources() {
  const reads = new Map();
  const unknownBlocks = [];
  const blockNames = new Set(Object.keys(settings));

  const record = (block, key, file, line, optional) => {
    if (!reads.has(block)) reads.set(block, new Map());
    const table = reads.get(block);
    if (!table.has(key)) table.set(key, []);
    table.get(key).push({ file, line, optional });
  };

  for (const file of sourceFiles(SRC)) {
    const relative = path.relative(ROOT, file);
    const raw = readFileSync(file, 'utf8');
    const code = stripToCode(raw);
    const withStrings = stripToCode(raw, true);

    // Line numbers, computed once per file.
    const lineStarts = [0];
    for (let i = 0; i < code.length; i++) if (code[i] === '\n') lineStarts.push(i + 1);
    const lineAt = (index) => {
      let low = 0;
      let high = lineStarts.length - 1;
      while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (lineStarts[mid] <= index) low = mid;
        else high = mid - 1;
      }
      return low + 1;
    };

    // `super('ice', context)` is how a class declares which block `this.config`
    // resolves to. A file with no such call and a `this.config` read is either
    // the base class or the aim controller: it reads whatever is in the slot,
    // so its reads apply to *every* id.
    const ownIds = [...withStrings.matchAll(new RegExp(`\\bsuper\\s*\\(\\s*['"\`](${IDENT})['"\`]\\s*[,)]`, 'g'))]
      .map((m) => m[1])
      .filter((id) => blockNames.has(id));
    const superIds = [...new Set(ownIds)];
    const configIds = superIds.length ? superIds : ALL_IDS;

    const isOptional = (index, length) => {
      const before = code.slice(Math.max(0, index - 2), index);
      const after = code.slice(index + length, index + length + 12);
      return before.endsWith('?.') || /^\s*\?\?/.test(after) || /^\s*\?\./.test(after);
    };

    /* --- settings.<block>.<key> --- */
    for (const match of code.matchAll(new RegExp(`\\bsettings\\s*\\??\\.\\s*(${IDENT})\\s*\\??\\.\\s*(${IDENT})`, 'g'))) {
      const [text, block, key] = match;
      if (!blockNames.has(block)) {
        unknownBlocks.push({ block, file: relative, line: lineAt(match.index) });
        continue;
      }
      record(block, key, relative, lineAt(match.index), isOptional(match.index, text.length));
    }

    /* --- settings[<expr>].<key> — the framework's blind index --- */
    for (const match of code.matchAll(new RegExp(`\\bsettings\\s*\\[[^\\]]+\\]\\s*\\??\\.\\s*(${IDENT})`, 'g'))) {
      // Always recorded as optional: `settings[element].zoneRadius` is read for
      // whichever ability happens to be in the slot, and a line cast is
      // entitled not to have one.
      for (const id of ALL_IDS) record(id, match[1], relative, lineAt(match.index), true);
    }

    /* --- this.config.<key> --- */
    // A framework file's `this.config` is whichever ability is in the slot, so
    // its reads land on every block — and they are *required* there, which is
    // how `Ability.js` reading `cfg.lightColor` becomes a contract every one of
    // the fifty blocks has to honour without anybody writing it down twice. The
    // one genuinely optional read in that set, `this.config.zoneRadius ?? 1` in
    // the aim controller, marks itself optional by being written defensively.
    for (const match of code.matchAll(new RegExp(`\\bthis\\s*\\.\\s*config\\s*\\??\\.\\s*(${IDENT})`, 'g'))) {
      const optional = isOptional(match.index, match[0].length);
      for (const id of configIds) record(id, match[1], relative, lineAt(match.index), optional);
    }

    /* --- aliases: `const c = settings.beam` then `c.foo` --- */
    const { strict, loose } = collectAliases(code, configIds);
    const aliases = new Map([...loose, ...strict]);
    for (const [name, blocks] of aliases) {
      const advisory = loose.has(name) && !strict.has(name);
      const pattern = new RegExp(`(?:^|[^.\\w$])${name}\\s*\\??\\.\\s*(${IDENT})`, 'g');
      for (const match of code.matchAll(pattern)) {
        const optional = advisory || isOptional(match.index, match[0].length);
        for (const block of blocks) {
          if (!blockNames.has(block)) continue;
          record(block, match[1], relative, lineAt(match.index), optional);
        }
      }
    }

    /* --- destructuring off a block, an alias, or this.config --- */
    const destructure = new RegExp(
      `\\b(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*(this\\s*\\.\\s*config|settings\\s*\\.\\s*${IDENT}|${IDENT})`,
      'g'
    );
    for (const match of code.matchAll(destructure)) {
      const source = match[2].replace(/\s+/g, '');
      let blocks = null;
      if (source === 'this.config') blocks = configIds;
      else if (source.startsWith('settings.')) blocks = [source.slice('settings.'.length)];
      else if (aliases.has(source)) blocks = aliases.get(source);
      if (!blocks) continue;
      const line = lineAt(match.index);
      for (const block of blocks) {
        if (!blockNames.has(block)) {
          if (source.startsWith('settings.')) unknownBlocks.push({ block, file: relative, line });
          continue;
        }
        const advisory = loose.has(source) && !strict.has(source);
        for (const key of destructuredKeys(match[1])) {
          record(block, key, relative, line, advisory);
        }
      }
    }
  }

  return { reads, unknownBlocks };
}

const STATIC = scanSources();

for (const { block, file, line } of STATIC.unknownBlocks) {
  failGlobal(`${file}:${line} reads settings.${block}, which is not a settings block`);
}

function checkStaticReads(descriptor, report) {
  const { id } = descriptor;
  const block = settings[id] ?? {};
  const table = STATIC.reads.get(id) ?? new Map();

  /* --- reads with no key behind them: the NaN factory --- */
  const missing = [];
  for (const [key, sites] of table) {
    if (key in block) continue;
    const required = sites.filter((site) => !site.optional);
    if (required.length === 0) continue; //  a guarded read of an absent key is fine
    missing.push({ key, sites: required });
  }
  missing.sort((a, b) => a.key.localeCompare(b.key));
  for (const { key, sites } of missing) {
    const where = sites.slice(0, 3).map((s) => `${s.file}:${s.line}`).join(', ');
    report.fail(
      'static',
      `reads settings.${id}.${key}, which does not exist — undefined here becomes NaN geometry (${where}${sites.length > 3 ? ', …' : ''})`
    );
  }

  /* --- keys nothing reads: a warning, and a soft one --- */
  const unread = Object.keys(block).filter((key) => !table.has(key));
  if (unread.length) {
    report.warn(
      'static',
      `${unread.length} settings key(s) with no visible read — check they are not dead, or that they are consumed through a shared VFX module: ${preview(unread)}`
    );
  }

  // Counted against the block, not against the table: a loose alias can pick up
  // `c.length` off something that is not this block at all, and a "reads 205 of
  // its 161 keys" line is a number nobody can act on.
  const realised = [...table.keys()].filter((key) => key in block).length;
  report.note(
    `${realised}/${Object.keys(block).length} settings key(s) read, across ${countSites(table)} site(s)`
  );
  report.pass('static');
  return report.ok;
}

const countSites = (table) => [...table.values()].reduce((total, sites) => total + sites.length, 0);
const preview = (list, limit = 8) =>
  list.slice(0, limit).join(', ') + (list.length > limit ? `, … (+${list.length - limit})` : '');

/* ------------------------------------------------------------------ */
/* §5 · The mock context                                               */
/* ------------------------------------------------------------------ */

/**
 * `shake` and `flash` are stubs because both of them reach outside the scene —
 * one into the camera rig, the other into a DOM overlay — and neither has any
 * bearing on whether an ability's geometry is sane. Everything else is the real
 * subsystem, on a real `Scene`, because a mock `ParticleEngine` would not have
 * caught a single one of the bugs this harness exists for.
 */
function makeContext() {
  const scene = new Scene();
  const camera = new PerspectiveCamera(46, 16 / 9, 0.1, 400);
  camera.position.set(0, 8, 12);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);

  const noop = { add() {}, rumble() {}, trigger() {}, reset() {}, update() {} };

  return {
    scene,
    camera,
    /**
     * `Environment` itself needs a live `Renderer`, so it is stood in for — but
     * the two methods materials actually call are reproduced faithfully rather
     * than stubbed to `noop`. `registerShadowCasterWithPatch` is what attaches
     * an ability's `onBeforeCompile` hook, and a version of it that does nothing
     * would quietly turn the harness into a test that ice and cinder *do not*
     * patch their shaders — which is the opposite of the truth and the reason
     * both of them threw on the first run of this file.
     */
    environment: {
      scene,
      camera,
      renderer: null,
      envMap: null,
      registerShadowCaster: (material) => material,
      registerShadowCasterWithPatch: (material, patch) => patchOnBeforeCompile(material, patch),
      setFocus() {},
      update() {}
    },
    particles: new ParticleEngine(scene),
    lights: new LightPool(scene),
    decals: new DecalSystem(scene),
    fissures: new FissureSystem(scene),
    bursts: new BurstSystem(scene),
    shake: noop,
    flash: noop
  };
}

/**
 * Capture whatever three.js (or the ability) prints while a block of work runs.
 *
 * Not censorship — the opposite. A cast that triggers a three.js warning on
 * every one of nine hundred frames buries the report under nine hundred
 * identical lines, and the useful information ("this geometry is already
 * non-indexed") is one line and a count. So they are collected, de-duplicated
 * and attached to the ability that caused them.
 */
async function captureConsole(report, fn) {
  const seen = new Map();
  const original = { warn: console.warn, error: console.error };
  const sink = (...args) => {
    const message = args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ');
    seen.set(message, (seen.get(message) ?? 0) + 1);
  };
  console.warn = sink;
  console.error = sink;
  try {
    return await fn();
  } finally {
    console.warn = original.warn;
    console.error = original.error;
    for (const [message, count] of seen) {
      report.warn('runtime', `console: ${message}${count > 1 ? ` (×${count})` : ''}`);
    }
  }
}

/** One simulated frame, in exactly the order `App.update` runs it. */
function step(ctx, ability, dt) {
  frame.uTime.value += dt;
  frame.uDelta.value = dt;
  ability.update(dt);
  ctx.particles.flush();
  ctx.decals.update(dt);
  ctx.fissures.update(dt);
  ctx.bursts.update(dt);
  ctx.lights.update(dt);
}

/* ------------------------------------------------------------------ */
/* §6 · Non-finite and sanity scanning                                 */
/* ------------------------------------------------------------------ */

/**
 * Every uniform a material actually drives, from both places they hide.
 *
 * A `ShaderMaterial` keeps them on `material.uniforms`. A patched
 * `MeshStandardMaterial` — Frost Lance's crystal, Cinder Fall's rock — cannot:
 * its uniforms are handed to the shader inside `onBeforeCompile`, which never
 * runs without a GL context, so the live boxes are parked on
 * `material.userData.uniforms` by convention and `material.uniforms` does not
 * exist at all.
 *
 * Missing that second location is not a small gap. It made the pause test
 * blind to every value on a patched standard material, and the first run of
 * this harness cheerfully reported that thirty of Frost Lance's shading
 * sliders did nothing while paused. All thirty of them work.
 */
function* uniformsOf(material) {
  if (!material) return;
  if (material.uniforms) yield* Object.entries(material.uniforms);
  if (material.userData?.uniforms) yield* Object.entries(material.userData.uniforms);
}

function scanArray(array, label, out) {
  for (let i = 0; i < array.length; i++) {
    const v = array[i];
    if (!Number.isFinite(v)) {
      out.push(`${label}[${i}] is ${Number.isNaN(v) ? 'NaN' : v}`);
      return; //  one report per array; a NaN never arrives alone
    }
  }
}

function scanParticles(ctx, out) {
  for (const system of ctx.particles.systems.values()) {
    for (const [key, array] of Object.entries(system.data)) {
      scanArray(array, `particles["${system.name}"].${key}`, out);
    }
  }
}

function scanGroup(group, out) {
  let index = 0;
  group.traverse((object) => {
    // The meshes in an ability group are usually unnamed, so the traversal
    // index is the only handle a reader has on *which* of the three it was.
    const name = `${object.name || object.type}#${index++}`;
    for (const [label, vector] of [
      ['position', object.position],
      ['scale', object.scale]
    ]) {
      if (!Number.isFinite(vector.x) || !Number.isFinite(vector.y) || !Number.isFinite(vector.z)) {
        out.push(`${name}.${label} is (${vector.x}, ${vector.y}, ${vector.z})`);
      }
    }
    const q = object.quaternion;
    if (!Number.isFinite(q.x) || !Number.isFinite(q.y) || !Number.isFinite(q.z) || !Number.isFinite(q.w)) {
      out.push(`${name}.quaternion is non-finite`);
    }
    if (object.position.lengthSq() > SANITY_RADIUS * SANITY_RADIUS) {
      out.push(
        `${name}.position is ${object.position.length().toFixed(0)} m from the origin — beyond the ${SANITY_RADIUS} m sanity radius`
      );
    }

    if (object.isInstancedMesh) {
      scanArray(object.instanceMatrix.array, `${name}.instanceMatrix`, out);
      if (object.instanceColor) scanArray(object.instanceColor.array, `${name}.instanceColor`, out);
    }
    if (object.geometry) {
      for (const [attributeName, attribute] of Object.entries(object.geometry.attributes ?? {})) {
        if (attribute.isInstancedBufferAttribute) {
          scanArray(attribute.array, `${name}.${attributeName}`, out);
        }
      }
    }
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      for (const [uniformName, uniform] of uniformsOf(material)) {
        const v = uniform?.value;
        if (typeof v === 'number' && !Number.isFinite(v)) out.push(`${name}.${uniformName} is ${v}`);
        else if (v?.isVector2 || v?.isVector3 || v?.isVector4 || v?.isQuaternion) {
          if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z ?? 0) || !Number.isFinite(v.w ?? 0)) {
            out.push(`${name}.${uniformName} is non-finite`);
          }
        } else if (v?.isColor) {
          if (!Number.isFinite(v.r) || !Number.isFinite(v.g) || !Number.isFinite(v.b)) {
            out.push(`${name}.${uniformName} is a non-finite colour`);
          }
        }
      }
    }
  });
}

/* ------------------------------------------------------------------ */
/* §7 · Snapshots — what "something changed" means                     */
/* ------------------------------------------------------------------ */

/**
 * A snapshot is every number an ability owns that a viewer could see change:
 * the transform of every object in its group, every numeric uniform on every
 * material it draws with, every instance matrix and instanced attribute, and
 * the uniforms of the particle systems it namespaces.
 *
 * Labels are built once per sample point and reused, because the pause test
 * takes a few hundred snapshots per ability and building a few hundred
 * thousand label strings to throw all of them away is the kind of thing that
 * turns a two-second harness into a thirty-second one.
 */
/** djb2 over a uuid, so "the geometry object was replaced" is one number. */
function hashString(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return hash;
}

/** `[sum, index-weighted sum]` over a numeric array. */
function checksum(array) {
  let sum = 0;
  let weighted = 0;
  for (let i = 0; i < array.length; i++) {
    const v = array[i];
    if (!Number.isFinite(v)) continue;
    sum += v;
    weighted += v * (i + 1);
  }
  return [sum, weighted];
}

class Snapshotter {
  constructor(ability, ctx) {
    this.ability = ability;
    this.systems = [...ctx.particles.systems.values()].filter((s) => s.name.startsWith(`${ability.element}.`));
    this.labels = null;
  }

  capture(withLabels = false) {
    const values = [];
    const labels = withLabels ? [] : null;
    const push = (label, number) => {
      values.push(number);
      if (labels) labels.push(label);
    };

    const flatten = (label, v) => {
      if (typeof v === 'number') push(label, v);
      else if (typeof v === 'boolean') push(label, v ? 1 : 0);
      else if (v == null) return;
      else if (v.isColor) {
        push(`${label}.r`, v.r);
        push(`${label}.g`, v.g);
        push(`${label}.b`, v.b);
      } else if (v.isVector2 || v.isVector3 || v.isVector4 || v.isQuaternion) {
        push(`${label}.x`, v.x);
        push(`${label}.y`, v.y);
        if (v.z !== undefined) push(`${label}.z`, v.z);
        if (v.w !== undefined) push(`${label}.w`, v.w);
      } else if (v.isEuler) {
        push(`${label}.x`, v.x);
        push(`${label}.y`, v.y);
        push(`${label}.z`, v.z);
      } else if (v.elements) {
        for (let i = 0; i < v.elements.length; i++) push(`${label}[${i}]`, v.elements[i]);
      } else if (ArrayBuffer.isView(v) || Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          const entry = v[i];
          if (typeof entry === 'number') {
            push(`${label}[${i}]`, entry);
          } else if (entry && (entry.isVector2 || entry.isVector3 || entry.isVector4 || entry.isColor)) {
            // A uniform whose value is an **array of vectors**. This is not an
            // exotic case: `vfx/FilamentPaths.js` keeps every role's entire
            // geometry in six of them (`uFrom`, `uTo`, `uShape`, `uShape2`,
            // `uStyle`, `uDraw`, indexed by role), and so does every ability
            // built on it. Skipping them made this snapshot blind to the whole
            // of such an ability's shape, and the pause test duly reported
            // thirty perfectly live path sliders as dead — the same failure
            // mode as the patched-`MeshStandardMaterial` gap, arrived at from
            // the other direction.
            flatten(`${label}[${i}]`, entry);
          }
        }
      }
    };

    let index = 0;
    this.ability.group.traverse((object) => {
      const name = `${object.name || object.type}#${index++}`;
      flatten(`${name}.position`, object.position);
      flatten(`${name}.scale`, object.scale);
      flatten(`${name}.quaternion`, object.quaternion);
      push(`${name}.visible`, object.visible ? 1 : 0);

      if (object.isInstancedMesh) {
        push(`${name}.count`, object.count);
        flatten(`${name}.instanceMatrix`, object.instanceMatrix.array);
        if (object.instanceColor) flatten(`${name}.instanceColor`, object.instanceColor.array);
      }
      if (object.geometry) {
        const geometry = object.geometry;
        push(`${name}.instanceCount`, geometry.instanceCount ?? -1);
        push(`${name}.drawRange`, geometry.drawRange?.count ?? -1);
        // A live rebuild swaps the whole object, so its identity is the cheapest
        // and most direct evidence that `facets` or `roughness` did something.
        push(`${name}.geometry.uuid`, hashString(geometry.uuid));
        for (const [attributeName, attribute] of Object.entries(geometry.attributes ?? {})) {
          if (attribute.isInstancedBufferAttribute) {
            flatten(`${name}.${attributeName}`, attribute.array);
          } else {
            // Per-vertex arrays are far too big to snapshot four hundred times,
            // and nobody needs to know *which* vertex moved — only that the
            // geometry was regenerated. Two checksums, one position-weighted so
            // a permutation is not mistaken for a no-op.
            const [sum, weighted] = checksum(attribute.array);
            push(`${name}.${attributeName}.length`, attribute.array.length);
            push(`${name}.${attributeName}.sum`, sum);
            push(`${name}.${attributeName}.weighted`, weighted);
          }
        }
      }
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!material) continue;
        push(`${name}.opacity`, material.opacity);
        push(`${name}.emissiveIntensity`, material.emissiveIntensity ?? 0);
        flatten(`${name}.color`, material.color);
        flatten(`${name}.emissive`, material.emissive);
        for (const [uniformName, uniform] of uniformsOf(material)) {
          flatten(`${name}.u.${uniformName}`, uniform?.value);
        }
      }
    });

    // Materials the ability owns but has not hung on a mesh *yet*.
    //
    // The traversal above finds everything in the group, which is every
    // material in almost every ability. The exception is an ability whose
    // meshes are conditional on something the harness cannot supply: `mirage`
    // clones the caster's skinned rig, and in a headless scene there is no
    // caster, so its refraction material exists as a field and is attached to
    // nothing. Walking the instance's own properties finds it anyway, and the
    // ability's sliders are measured instead of being written off as dead —
    // which is the whole job of this probe. One shallow pass over own
    // properties, no recursion, so it cannot wander into the context object.
    let field = 0;
    for (const value of Object.values(this.ability)) {
      const candidates = Array.isArray(value) ? value : [value];
      for (const candidate of candidates) {
        if (!candidate?.isMaterial) continue;
        const name = `field:${candidate.name || candidate.type}#${field++}`;
        push(`${name}.opacity`, candidate.opacity);
        for (const [uniformName, uniform] of uniformsOf(candidate)) {
          flatten(`${name}.u.${uniformName}`, uniform?.value);
        }
      }
    }

    for (const system of this.systems) {
      for (const [uniformName, uniform] of Object.entries(system.uniforms ?? {})) {
        flatten(`${system.name}.${uniformName}`, uniform?.value);
      }
    }

    // The dynamic light is not in the group — it lives in the pool, in the
    // scene — but it is unambiguously something the ability drives and the
    // player sees, so `lightIntensity` and `lightRadius` are measured here
    // rather than written off as unobservable. `light.intensity` itself is
    // damped and therefore frozen on a zero-length frame; `target` is not.
    const handle = this.ability.light;
    if (handle) {
      push('light.target', handle.target);
      push('light.distance', handle.light.distance);
      flatten('light.position', handle.light.position);
      flatten('light.color', handle.light.color);
    }

    if (labels) this.labels = labels;
    return values;
  }
}

/** Indices at which two snapshots differ by more than float noise. */
function diffIndices(a, b, limit = 6) {
  if (a.length !== b.length) return ['<structure>'];
  const changed = [];
  for (let i = 0; i < a.length; i++) {
    const scale = Math.max(1, Math.abs(a[i]), Math.abs(b[i]));
    if (Math.abs(a[i] - b[i]) > CHANGE_EPSILON * scale) {
      changed.push(i);
      if (changed.length >= limit) break;
    }
  }
  return changed;
}

const didChange = (a, b) => diffIndices(a, b, 1).length > 0;

/* ------------------------------------------------------------------ */
/* §8 · Runtime simulation                                             */
/* ------------------------------------------------------------------ */

const _origin = new Vector3(0, 0, 0);
const _direction = new Vector3(0, 0, 1);

/** A cast distance inside the ability's own declared reach. */
function castDistance(block) {
  const range = Number.isFinite(block.range) ? block.range : 10;
  const minRange = Number.isFinite(block.minRange) ? block.minRange : 0;
  return Math.max(minRange + 0.5, range * 0.8);
}

async function runAbility(descriptor, report) {
  const { id } = descriptor;
  const block = settings[id];

  let Type;
  try {
    Type = await descriptor.load();
  } catch (error) {
    return report.fail('runtime', `load() rejected: ${describeError(error)}`);
  }
  if (typeof Type !== 'function') {
    return report.fail('runtime', `load() resolved to ${typeof Type}, not a class — did you forget \`.then(m => m.XAbility)\`?`);
  }

  const ctx = makeContext();
  frame.uTime.value = 0;
  frame.uDelta.value = 0;

  let ability;
  try {
    ability = new Type(ctx);
    ctx.scene.add(ability.group);
  } catch (error) {
    return report.fail('runtime', `constructor threw: ${describeError(error)}`);
  }

  if (ability.element !== id) {
    report.fail('runtime', `constructed with element "${ability.element}" but registered as "${id}"`);
  }

  /* --- the namespacing rule: "<id>.<role>", or a shared system --- */
  for (const name of ctx.particles.systems.keys()) {
    if (!name.startsWith(`${id}.`) && !name.startsWith('shared.')) {
      report.warn('runtime', `particle system "${name}" is not namespaced "${id}.<role>" — it will collide with another ability`);
    }
  }

  const meshCount = countDrawables(ability.group);
  if (meshCount > DRAW_CALL_BUDGET) {
    report.warn('runtime', `${meshCount} drawable(s) in the group; the budget in §0/I7 is ${DRAW_CALL_BUDGET}`);
  }
  report.note(`${meshCount} drawable(s), ${ctx.particles.systems.size} particle system(s)`);

  const distance = castDistance(block);
  const problems = [];

  /* ---------------- first cast: the full run ---------------- */
  try {
    ability.spawn(_origin, _direction, distance);
  } catch (error) {
    return report.fail('runtime', `spawn() threw: ${describeError(error)}`);
  }

  const childrenAtSpawn = countDrawables(ability.group);
  const systemsAtSpawn = ctx.particles.systems.size;

  let frames = 0;
  let finishedAt = -1;
  const seenPhases = new Set([ability.phase]);
  try {
    while (frames < MAX_FRAMES) {
      step(ctx, ability, DT);
      frames++;
      seenPhases.add(ability.phase);
      if (frames % NAN_STRIDE === 0 || ability.isFinished) {
        scanParticles(ctx, problems);
      }
      scanGroup(ability.group, problems);
      if (problems.length) break;
      if (ability.isFinished) {
        finishedAt = frames;
        if (frames >= REQUIRED_FRAMES) break;
      }
      if (finishedAt >= 0 && frames >= REQUIRED_FRAMES) break;
    }
  } catch (error) {
    return report.fail('runtime', `threw on frame ${frames + 1} (phase ${ability.phase}): ${describeError(error)}`);
  }

  for (const problem of problems.slice(0, 5)) {
    report.fail('runtime', `non-finite value after ${frames} frame(s): ${problem}`);
  }

  if (finishedAt < 0 && problems.length) {
    // The loop was cut short by the NaN above; "it never finished" is that
    // failure wearing a second hat, and reporting both sends people hunting for
    // a timing bug that is not there.
    report.note('the tick loop was stopped early by the non-finite value above');
  } else if (finishedAt < 0) {
    report.fail(
      'runtime',
      `never reached DONE in ${MAX_FRAMES} frames (${(MAX_FRAMES * DT).toFixed(1)} s) — stuck in ${ability.phase}; ` +
        `check impactDuration (${safeNumber(ability.impactDuration)} s) and fadeDuration (${safeNumber(ability.fadeDuration)} s)`
    );
  } else {
    report.note(`cast ran ${finishedAt} frames (${(finishedAt * DT).toFixed(2)} s) to DONE`);
  }

  for (const phase of [AbilityPhase.TRAVEL, AbilityPhase.IMPACT, AbilityPhase.FADE]) {
    if (!seenPhases.has(phase)) report.warn('runtime', `never entered the ${phase.toUpperCase()} phase`);
  }

  const childrenAtEnd = countDrawables(ability.group);
  if (childrenAtEnd !== childrenAtSpawn) {
    report.fail(
      'runtime',
      `the group grew from ${childrenAtSpawn} to ${childrenAtEnd} drawable(s) during the cast — I3 says nothing is built during a cast`
    );
  }
  if (ctx.particles.systems.size !== systemsAtSpawn) {
    report.fail(
      'runtime',
      `${ctx.particles.systems.size - systemsAtSpawn} particle system(s) created mid-cast — build them in createParticles()`
    );
  }

  /* ---------------- destroy, then cast again ---------------- */
  try {
    ability.destroy();
  } catch (error) {
    return report.fail('runtime', `destroy() threw: ${describeError(error)}`);
  }
  if (ability.phase !== AbilityPhase.IDLE) {
    report.fail('runtime', `destroy() left the instance in phase ${ability.phase}, not IDLE — the pool will hand out a live cast`);
  }
  /* The two global pools an ability can take a piece of the *world* from. A
   * leaked light costs the next cast its light; a leaked scene hook holds the
   * sun, the grade or the floor's material wrong for the rest of the session,
   * and a leaked time region stops a sphere of the world permanently. Neither
   * failure is traceable back to the cast that caused it, so it is caught here.
   * `Ability#borrow()` is the net — see `abilities/Ability.js`. */
  if (sceneHooksLive() !== 0) {
    report.fail(
      'runtime',
      `destroy() left ${sceneHooksLive()} scene hook(s) held — acquire through this.borrow(), or release in onDestroy()`
    );
    sceneHooksReleaseAll();
  }
  if (timeRegionsLive() !== 0) {
    report.fail(
      'runtime',
      `destroy() left ${timeRegionsLive()} time region(s) live — acquire through this.borrow(), or release in onDestroy()`
    );
    timeRegionsReset();
  }

  try {
    ability.spawn(_origin, _direction, distance);
    for (let i = 0; i < REUSE_FRAMES; i++) step(ctx, ability, DT);
  } catch (error) {
    return report.fail('runtime', `the second cast threw — destroy() did not leave the instance reusable: ${describeError(error)}`);
  }
  const reuseProblems = [];
  scanParticles(ctx, reuseProblems);
  scanGroup(ability.group, reuseProblems);
  for (const problem of reuseProblems.slice(0, 3)) {
    report.fail('runtime', `non-finite value on the second cast: ${problem}`);
  }
  ability.destroy();

  report.pass('runtime');

  /* ---------------- the pause test, on a fresh cast ---------------- */
  runPauseTest(descriptor, report, ctx, ability);

  try {
    ability.dispose?.();
    ctx.particles.dispose();
    ctx.decals.dispose();
    ctx.fissures.dispose();
    ctx.bursts.dispose();
    ctx.lights.dispose();
  } catch (error) {
    report.warn('runtime', `teardown threw: ${describeError(error)}`);
  }

  return report.ok;
}

function countDrawables(group) {
  let total = 0;
  group.traverse((object) => {
    if (object.isMesh || object.isPoints || object.isLine || object.isSprite) total++;
  });
  return total;
}

/* ------------------------------------------------------------------ */
/* §9 · The pause test (invariant I1)                                  */
/* ------------------------------------------------------------------ */

/**
 * Two sample points, chosen because they are the two beats where the mistake
 * lives:
 *
 *  - **mid-travel**, when the front is halfway out and everything is being
 *    resolved from settings because it has to be;
 *  - **mid-impact**, when the effect is standing still and it is very tempting
 *    to have cached the metres it stood up with.
 *
 * At each one we stop the clock and feed the ability zero-length frames, which
 * is precisely what `App` does when you press **P**. If scaling every dimension
 * on the block by 1.37 does not move a single number the ability owns, the
 * effect on screen would not move either, and the ability is not done.
 */
function runPauseTest(descriptor, report, ctx, ability) {
  const { id } = descriptor;
  const block = settings[id];
  const distance = castDistance(block);

  const mutable = Object.keys(block).filter(
    (key) => typeof block[key] === 'number' && Number.isFinite(block[key]) && block[key] !== 0 && !PAUSE_EXCLUDED.has(key)
  );
  if (mutable.length === 0) {
    report.fail('travel', 'no non-zero numeric settings to mutate — every dimension must be a slider (I5)');
    report.fail('impact', 'no non-zero numeric settings to mutate');
    return;
  }

  for (const sample of ['travel', 'impact']) {
    let outcome;
    try {
      outcome = probeSample(ctx, ability, block, mutable, sample, distance);
    } catch (error) {
      report.fail(sample, `threw while probing at ${sample}: ${describeError(error)}`);
      continue;
    }

    if (outcome.skipped) {
      report.fail(sample, outcome.skipped);
      continue;
    }

    if (!outcome.restless) {
      report.note(
        `${sample}: ${outcome.responsive.length}/${mutable.length} slider(s) observable while paused` +
          (outcome.dead.length && SHOW_SLIDERS ? `\n      dead here: ${outcome.dead.join(', ')}` : '')
      );
    } else {
      report.warn(
        sample,
        'the ability is not stable at rest — a zero-length frame with nothing changed already moves it, ' +
          'so per-slider attribution is unavailable (usually Math.random() called from the per-frame sync). ' +
          `First to drift: ${outcome.driftLabels.join(', ')}`
      );
    }

    if (outcome.changed) report.pass(sample);
    else {
      report.fail(
        sample,
        `nothing observable changed at ${sample} when all ${mutable.length} numeric slider(s) were scaled by ${MUTATION} on a zero-length frame — ` +
          'invariant I1: every metre, radian and second must be re-resolved from settings every frame, including a paused one'
      );
    }
  }
}

/**
 * Run one sample point. Returns
 * `{ changed, restless, driftLabels[], responsive[], dead[], skipped? }`.
 */
function probeSample(ctx, ability, block, mutable, sample, distance) {
  ability.destroy();
  frame.uTime.value = 0;
  ability.spawn(_origin, _direction, distance);

  /* --- tick to the sample point --- */
  let frames = 0;
  if (sample === 'travel') {
    // Half-way down the line, still travelling. An ability that buys a wind-up
    // by refusing to advance (Nova Beam) sits at u = 0 for a while first, so
    // this waits on `u`, not on a frame count.
    while (frames < MAX_FRAMES && !(ability.phase === AbilityPhase.TRAVEL && ability.u >= 0.5)) {
      step(ctx, ability, DT);
      frames++;
      if (ability.phase !== AbilityPhase.TRAVEL) break;
    }
    if (ability.phase !== AbilityPhase.TRAVEL) {
      return { skipped: `the cast left TRAVEL before reaching the half-way point (phase ${ability.phase} after ${frames} frames)` };
    }
  } else {
    while (frames < MAX_FRAMES && ability.phase === AbilityPhase.TRAVEL) {
      step(ctx, ability, DT);
      frames++;
    }
    const half = Math.max(1, Math.round((ability.impactDuration * 0.5) / DT));
    for (let i = 0; i < half && ability.phase === AbilityPhase.IMPACT; i++) {
      step(ctx, ability, DT);
      frames++;
    }
    if (ability.phase !== AbilityPhase.IMPACT && ability.phase !== AbilityPhase.FADE) {
      return { skipped: `the cast was already ${ability.phase} at the mid-impact sample (after ${frames} frames)` };
    }
  }

  const snapshotter = new Snapshotter(ability, ctx);

  /* --- let the clock-stopped state settle --- */
  // The first zero-length frame after a real one is not idle: an impact punch
  // is still decaying out of `lightBoost`, an eased value is still a step from
  // its target. That is settling, not a slider responding, and mistaking one
  // for the other would report every ability in the project as "restless".
  // Three frames is enough for everything in the repo; the check below proves
  // it rather than assuming it.
  for (let i = 0; i < 3; i++) ability.update(0);

  /* --- is it stable at rest? --- */
  const before = snapshotter.capture(true);
  ability.update(0);
  const baseline = snapshotter.capture();
  const drift = diffIndices(before, baseline, 4);
  const restless = drift.length > 0;
  const driftLabels = drift.map((i) => (typeof i === 'number' ? snapshotter.labels[i] : i));

  /* --- the gate: scale every slider at once --- */
  const originals = mutable.map((key) => block[key]);
  for (const key of mutable) block[key] *= MUTATION;
  ability.update(0);
  const mutated = snapshotter.capture();
  const changed = didChange(baseline, mutated);
  mutable.forEach((key, i) => {
    block[key] = originals[i];
  });
  ability.update(0);

  /* --- attribution, one slider at a time --- */
  const responsive = [];
  const dead = [];
  if (!restless) {
    for (let i = 0; i < mutable.length; i++) {
      const key = mutable[i];
      const rest = snapshotter.capture();
      block[key] *= MUTATION;
      ability.update(0);
      const probe = snapshotter.capture();
      block[key] = originals[i];
      ability.update(0);
      if (didChange(rest, probe)) responsive.push(key);
      else dead.push(key);
    }
  }

  ability.destroy();
  return { changed, restless, driftLabels, responsive, dead };
}

/* ------------------------------------------------------------------ */
/* §10 · The vfx tech library smoke test                               */
/* ------------------------------------------------------------------ */
/**
 * Construct every exported class in `src/vfx/`, drive it, and take it apart
 * again.
 *
 * The ability stages above only see a module in `src/vfx/` if an ability
 * imports it, and on the day this was written not one of them did: fourteen
 * modules, some of them seventeen hundred lines, and the entire harness walked
 * straight past them. The twenty-two agents about to build abilities on top of
 * this library would each have discovered its breakages personally, in a
 * browser, as a blank screen.
 *
 * So this stage does the least that is still worth doing. It is not a test of
 * whether a `FUNNEL` looks like a vortex — nothing without a GL context can
 * tell you that, and every module's author ran their own harness for it. It
 * asks four questions that a blank screen answers too late:
 *
 *  1. Does it **import**? A reserved word in a shader (`packed`, `flat`) or a
 *     backtick inside a GLSL comment is a syntax error at module scope, and
 *     three of those have already been found in this library by hand.
 *  2. Does it **construct** with the options its own doc comment advertises?
 *  3. Does driving it for a few frames — including a zero-length one — leave a
 *     NaN in a uniform, an instance matrix or a transform? A NaN uniform does
 *     not render wrongly, it renders *nothing*, silently.
 *  4. Does `dispose()` run without throwing?
 *
 * The coverage rule at the end is the part that keeps this honest: every
 * exported class in every file under `src/vfx/` must appear in `VFX_CASES`. A
 * fifteenth module lands with no recipe and this stage fails, naming it. That
 * is deliberate — an untested module in a shared library is worse than no
 * module, because someone will build on it.
 */

const VFX_DIR = path.join(SRC, 'vfx');

/** Cases are built lazily so one module failing to import cannot stop the rest. */
const vfx = {};

/* ------------------------------------------------------------------ */
/* §5b · The GLSL reserved-word sweep                                  */
/* ------------------------------------------------------------------ */

/**
 * Words that cannot be an identifier in the language this project actually
 * compiles to, and the reason the list is exactly this.
 *
 * **Every material here is GLSL ES 3.00.** three's `WebGLProgram` prepends
 * `#version 300 es` to anything that is not a `RawShaderMaterial` — built-in
 * materials *and* every plain `ShaderMaterial` — and adds `#define varying in`
 * and friends so that source written in the 1.00 dialect still compiles. That
 * one line of three's source decides this whole list, and it means the README's
 * old advice was half wrong in both directions: `packed` is illegal in ESSL
 * 1.00 and perfectly legal in 3.00 (`VolumetricFireMaterial` has used it as a
 * local for as long as the project has existed), while `patch` is legal in 1.00
 * and reserved in 3.00 — which is how a `float patch` sat in the floor's ageing
 * patch and took the entire ground material out of the frame with a syntax
 * error that never mentions the word "reserved".
 *
 * The list was not copied from a specification. Every candidate was compiled at
 * `#version 300 es` on a real driver in three positions — as a local, as a
 * parameter and as a function name — and only the words that failed **all
 * three** are here. That is deliberately the narrow, false-positive-free class:
 * shadowing a *built-in function* with a local (`float round = …`) is legal and
 * common and is not flagged, though redefining one as a function is not.
 *
 * `varying` and `attribute` are on the list even though three `#define`s them
 * away, because by the time one is a variable *name* the define has already
 * turned the declaration into nonsense.
 */
const GLSL3_RESERVED = new Set(
  (
    'active asm atomic_uint attribute cast centroid class coherent common double dvec2 dvec3 ' +
    'dvec4 dmat2 dmat3 dmat4 enum extern external filter fixed flat fvec2 fvec3 fvec4 goto half ' +
    'hvec2 hvec3 hvec4 inline input interface invariant layout long namespace noinline ' +
    'noperspective output partition patch public readonly resource restrict sample short sizeof ' +
    'smooth static subroutine superp template this typedef union unsigned using varying volatile ' +
    'writeonly'
  ).split(' ')
);

/** Every type name a declaration can open with. */
const GLSL_TYPE =
  '(?:void|bool|int|uint|float|vec2|vec3|vec4|ivec2|ivec3|ivec4|bvec2|bvec3|bvec4|uvec2|uvec3|' +
  'uvec4|mat2|mat3|mat4|mat2x2|mat2x3|mat2x4|mat3x2|mat3x3|mat3x4|mat4x2|mat4x3|mat4x4|' +
  'sampler2D|samplerCube|sampler3D|sampler2DArray)';

/**
 * Pull every `/* glsl *​/` template literal out of one JS source file.
 *
 * Tagging is the convention the whole project already follows for editor
 * highlighting, so it costs nothing to rely on and it is exact: a shader that
 * is not tagged is not scanned, and a JS string that merely mentions `float` is
 * not mistaken for one. `${…}` interpolations are skipped by brace depth so
 * that a nested template literal cannot end the block early.
 */
function glslBlocks(source) {
  const blocks = [];
  const marker = /\/\*\s*glsl\s*\*\/\s*`/g;
  let hit;
  while ((hit = marker.exec(source))) {
    const start = marker.lastIndex;
    let i = start;
    let depth = 0;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === '\\') {
        i++;
      } else if (c === '$' && source[i + 1] === '{') {
        depth++;
        i++;
      } else if (c === '}' && depth > 0) {
        depth--;
      } else if (c === '`' && depth === 0) {
        break;
      }
    }
    blocks.push({ start, text: source.slice(start, i) });
    marker.lastIndex = i + 1;
  }
  return blocks;
}

/**
 * Sweep every tagged GLSL block under `src/` for a reserved identifier.
 *
 * A source-text sweep rather than a walk over constructed materials, because
 * the two failures this exists to catch both live in source that no constructed
 * material in the harness carries: a `patchOnBeforeCompile` body, which needs a
 * renderer before it is ever assembled, and a shader behind a `#define` that
 * this run's options did not select.
 *
 * Comments are stripped first, so the word may appear in prose as often as it
 * is useful to — and it is, because explaining *why* a variable is not called
 * `patch` is the only thing that stops the next author calling it that.
 */
function sweepGlslReservedWords(failures) {
  let blocks = 0;
  const decl = new RegExp(`\\b${GLSL_TYPE}\\s+([A-Za-z_][A-Za-z0-9_]*)`, 'g');
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, 'utf8');
    for (const block of glslBlocks(source)) {
      blocks++;
      const body = block.text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
      const before = source.slice(0, block.start).split('\n').length - 1;
      decl.lastIndex = 0;
      let found;
      while ((found = decl.exec(body))) {
        if (!GLSL3_RESERVED.has(found[1])) continue;
        const line = before + body.slice(0, found.index).split('\n').length;
        failures.push(
          `${path.relative(ROOT, file)}:${line} declares "${found[1]}", which is reserved in ` +
            `GLSL ES 3.00 — three compiles every non-raw material at #version 300 es, so this ` +
            `material does not compile at all and its whole mesh is missing from the frame`
        );
      }
      sweepUnguardedPow(file, block, body, before, failures);
    }
  }
  return blocks;
}

/**
 * `pow()` whose base is a raw `sin()` or `cos()`.
 *
 * This one cost a day and blacked out three abilities, so it gets a rule.
 *
 * `pow(x, y)` is `exp2(y * log2(x))` on every driver, so a **negative base is
 * NaN at every exponent** — including 1.0, which is why turning the exponent's
 * slider to zero never masks it. And a trig base that is non-negative on paper
 * is not non-negative in float32: `sin(PI * t)` at `t = 0` or `t = 1` comes back
 * at about ±1e-7, and half the time the sign is wrong.
 *
 * One NaN fragment is not one bad pixel. It lands in the HDR buffer, the very
 * next bloom blur convolves it across its whole kernel, and tone-mapping NaN
 * gives black — so a single fragment on a ground quad turns the entire frame
 * black. That is precisely what `GroundField`'s SCOUR mode did to Pyroclasm,
 * Cyclone and Hourglass.
 *
 * The rule is narrow on purpose — only a *literal* `sin(`/`cos(` immediately
 * inside `pow(` — so it has no false positives and needs no dataflow analysis.
 * The fix is always the same: `pow(max(sin(...), 0.0), e)`.
 */
function sweepUnguardedPow(file, block, body, before, failures) {
  const unguarded = /\bpow\s*\(\s*(sin|cos)\s*\(/g;
  let hit;
  while ((hit = unguarded.exec(body))) {
    const line = before + body.slice(0, hit.index).split('\n').length;
    failures.push(
      `${path.relative(ROOT, file)}:${line} calls pow() on a raw ${hit[1]}() — float32 ` +
        `${hit[1]}() returns ~-1e-7 at its zeroes, pow() of a negative base is NaN at every ` +
        `exponent, and one NaN fragment is smeared over the whole frame by the bloom blur. ` +
        `Wrap the base: pow(max(${hit[1]}(...), 0.0), e)`
    );
  }
}

/**
 * Load every module under `src/vfx/` once, keeping the failures rather than
 * throwing on the first one — a broken module should cost its own line in the
 * report, not the whole stage.
 */
async function loadVfxModules() {
  const modules = new Map();
  const names = readdirSync(VFX_DIR)
    .filter((name) => name.endsWith('.js'))
    .sort();
  for (const name of names) {
    try {
      modules.set(name, await import(path.join(VFX_DIR, name)));
    } catch (error) {
      modules.set(name, { __error: error });
    }
  }
  return modules;
}

const VFX_MODULES = await loadVfxModules();

/** Shorthand: a module's export, or `undefined` if the module did not load. */
const vx = (file, name) => VFX_MODULES.get(file)?.[name];

/* --- the shared props every case borrows ---------------------------- */

const _from = new Vector3(0, 0.2, 0);
const _to = new Vector3(0, 0.2, 12);
const _side = new Vector3(1, 0, 0);
const _up = new Vector3(0, 1, 0);
const _dirZ = new Vector3(0, 0, 1);

/** A body geometry factory. Modules that own their geometry demand a factory. */
const shardFactory = () => new TetrahedronGeometry(0.22, 0);
const spikeFactory = () => new ConeGeometry(0.5, 1, 5, 1, true);

/**
 * A case is `{ file, label, build }`, where `build` returns the handle this
 * stage drives. `node` is whatever Object3D the module hung its meshes on —
 * `scanGroup` walks it, so a group is as good as a mesh.
 */
function vfxCases() {
  const cases = [];
  const add = (file, label, build) => cases.push({ file, label, build });

  /* --- GrowthField ------------------------------------------------- */
  const { GrowthField, GrowthLayout, GrowthEmerge, growthParams, patchGrowthMaterial } =
    VFX_MODULES.get('GrowthField.js') ?? {};
  for (const [layoutName, layout] of [
    ['LINE', GrowthLayout?.LINE],
    ['ZONE', GrowthLayout?.ZONE]
  ]) {
    add('GrowthField.js', `GrowthField ${layoutName}`, () => {
      const parent = new Group();
      const material = patchGrowthMaterial(new MeshStandardMaterial(), {});
      const field = new GrowthField(parent, {
        geometry: spikeFactory,
        material,
        variants: 2,
        capacity: 48
      });
      const p = growthParams();
      p.layout = layout;
      p.emerge = GrowthEmerge?.PUSH ?? 0;
      field.plant(32, 0.25);
      field.triggerAll(0, 0.4);
      return {
        node: parent,
        drawCalls: () => field.drawCalls,
        tick: (now) => field.update(now, p),
        dispose: () => {
          field.dispose();
          material.dispose();
        }
      };
    });
  }

  /* --- ShatterField ------------------------------------------------- */
  const { ShatterField, shatterParams } = VFX_MODULES.get('ShatterField.js') ?? {};
  add('ShatterField.js', 'ShatterField', () => {
    const parent = new Group();
    const field = new ShatterField(parent, { geometry: shardFactory, variants: 2, capacity: 64 });
    const p = shatterParams();
    field.sync(p);
    field.burst(0, 40, 1, 0.6);
    return {
      node: parent,
      drawCalls: () => field.drawCalls,
      tick: (now) => field.update(now, p),
      dispose: () => field.dispose()
    };
  });

  /* --- FilamentPaths: every path mode through one strip -------------- */
  const { FilamentPaths, PathMode, filamentLook } = VFX_MODULES.get('FilamentPaths.js') ?? {};
  add('FilamentPaths.js', 'FilamentPaths (9 path modes)', () => {
    const parent = new Group();
    const paths = new FilamentPaths(parent, { samples: 32, capacity: 16 });
    const look = filamentLook();
    paths.setNodeCount(6);
    for (let i = 0; i < 6; i++) paths.setNode(i, i / 5, (i % 2 ? 0.2 : -0.2), 0.1);
    // One role per frame cycles through all nine modes over the tick loop, so
    // every parametric path gets its uniforms written at least once.
    const modes = Object.values(PathMode ?? {});
    return {
      node: parent,
      drawCalls: () => paths.drawCalls,
      tick: (now, index) => {
        const role = paths.role(index % 4);
        role.count = 5;
        role.style(0.3, 0.1, 0.5, 0.2);
        role.ends(0.05, 0.95, 0.1, 0.9);
        role.draw(2, 0.1, 0, 1.5);
        switch (modes[index % modes.length]) {
          case PathMode.HELIX: role.helix(_from, _to, 0.6, 0.3, 3, 1, 0.2, 0.4, 1.2); break;
          case PathMode.ORBIT: role.orbit(_to, _up, 1.4, 1, 1.2, 0.3, 0.2, 0.4, 0.2); break;
          case PathMode.MEANDER: role.meander(_to, _up, 0.4, 2.2, 1.1, 0.5, 0.3, 0.4, 0.6); break;
          case PathMode.RIM: role.rim(_to, _up, 2.4, 1.6, 0.8, 0.3, 0.2, 0.3, 0.1); break;
          case PathMode.CHAIN: role.chain(_from, _to, 0.4, 0.3, 0.2, 0.3, 3, 0.4, 0.2, 0.6); break;
          case PathMode.LINK: role.link(_from, _to, 0.3, 0.6, 0.2, 1.1, 0.4, 0.3); break;
          case PathMode.SPIRAL_IN: role.spiralIn(_from, _to, 1.2, 0.1, 2.5, 1, 1.3, 0.3, 0.2); break;
          case PathMode.CRACK: role.crack(_from, _to, 0.5, 0.7, 0.6, 0.4, 0.1, 0.2, 0.5); break;
          default: role.line(_from, _to, 0.2, 0.1, 0.4, 1.2, 0.3, 1.1, 0.2);
        }
        paths.sync(look, 1, now);
      },
      dispose: () => paths.dispose()
    };
  });

  /* --- ArcNetwork ---------------------------------------------------- */
  const { ArcNetwork, arcNetworkParams } = VFX_MODULES.get('ArcNetwork.js') ?? {};
  add('ArcNetwork.js', 'ArcNetwork', () => {
    const parent = new Group();
    const net = new ArcNetwork(parent, { samples: 48, capacity: 12 });
    const p = arcNetworkParams();
    net.from.copy(_from);
    net.to.copy(_to);
    net.reset(3);
    return {
      node: parent,
      drawCalls: () => net.drawCalls,
      tick: (now, index, dt) => net.update(dt, p, 1),
      dispose: () => net.dispose()
    };
  });

  /* --- GroundField: all ten modes ------------------------------------ */
  const { GroundField, GroundMode, GROUND_MODE_NAMES, groundFieldParams } =
    VFX_MODULES.get('GroundField.js') ?? {};
  for (const [name, mode] of Object.entries(GroundMode ?? {})) {
    add('GroundField.js', `GroundField ${name}`, () => {
      const parent = new Group();
      const field = new GroundField(parent, { mode, marks: 8 });
      const p = groundFieldParams();
      field.mark(0.3, -0.2, 0, 1);
      field.mark(-0.5, 0.4, 0.2, 0.6);
      return {
        node: parent,
        drawCalls: () => field.drawCalls,
        tick: () => field.update(p),
        dispose: () => field.dispose()
      };
    });
  }

  /* --- VolumeHull: every hull, every medium -------------------------- */
  const { VolumeHull, HullShape, Medium, HULL_NAMES, MEDIUM_NAMES, volumeHullDefaults } =
    VFX_MODULES.get('VolumeHull.js') ?? {};
  const hullCombos = [];
  for (const hull of Object.values(HullShape ?? {})) hullCombos.push([hull, Medium?.FLAME ?? 0]);
  for (const medium of Object.values(Medium ?? {})) hullCombos.push([HullShape?.BOX ?? 0, medium]);
  for (const [hull, medium] of hullCombos) {
    const label = `VolumeHull ${HULL_NAMES?.[hull]}/${MEDIUM_NAMES?.[medium]}`;
    add('VolumeHull.js', label, () => {
      const parent = new Group();
      const prefix = 'vol';
      const hullObject = new VolumeHull({ hull, medium, prefix, maxSteps: 12 });
      parent.add(hullObject.mesh);
      const c = volumeHullDefaults(prefix, medium);
      hullObject.place(_to, _dirZ).setSize(2, 3, 2).setFade(1);
      return {
        node: parent,
        drawCalls: () => 1,
        tick: () => hullObject.sync(c, settings.global),
        dispose: () => hullObject.dispose()
      };
    });
  }

  /* --- Tube: every path ---------------------------------------------- */
  const { Tube, TubePath, TUBE_PATH_NAMES, tubeDefaults } = VFX_MODULES.get('Tube.js') ?? {};
  for (const path of Object.values(TubePath ?? {})) {
    add('Tube.js', `Tube ${TUBE_PATH_NAMES?.[path]}`, () => {
      const parent = new Group();
      const tube = new Tube({ path, prefix: 'tube', nodes: 32, sides: 10 });
      parent.add(tube.group);
      const c = tubeDefaults('tube', path);
      const state = {
        origin: _from, target: _to, side: _side,
        progress: 0.6, fade: 1, widthFade: 1, seed: 4, time: 0, grow: 1, snapAge: 0
      };
      return {
        node: parent,
        drawCalls: () => tube.drawCalls,
        tick: (now) => {
          state.time = now;
          tube.sync(c, state, settings.global);
          // The crack is recomputed by sync(); poll it as an ability would.
          void tube.crack.fired;
          void tube.radiusAt(0.5);
        },
        dispose: () => tube.dispose()
      };
    });
  }

  /* --- Shell: every mode --------------------------------------------- */
  const { Shell, ShellMode, SHELL_MODE_NAMES, shellDefaults } = VFX_MODULES.get('Shell.js') ?? {};
  for (const mode of Object.values(ShellMode ?? {})) {
    add('Shell.js', `Shell ${SHELL_MODE_NAMES?.[mode]}`, () => {
      const parent = new Group();
      const shell = new Shell({ mode, prefix: 'shell', nodes: 16, sides: 16, rings: 6, segments: 32 });
      parent.add(shell.group);
      const c = shellDefaults('shell', mode);
      const state = { origin: _to, axis: _up, side: _side, span: 6, t: 0.4, fade: 1, seed: 2 };
      return {
        node: parent,
        drawCalls: () => shell.drawCalls,
        tick: (now, index) => {
          state.t = Math.min(1, index / 8);
          shell.sync(c, state, settings.global);
          void shell.standingAt(0.5);
        },
        dispose: () => shell.dispose()
      };
    });
  }

  /* --- BurstSystem, re-exported by Shell.js -------------------------- */
  const { BurstSystem, BurstMode } = VFX_MODULES.get('Shell.js') ?? {};
  add('Shell.js', 'BurstSystem (re-export)', () => {
    const scene = new Group();
    const bursts = new BurstSystem(scene);
    for (const mode of Object.values(BurstMode ?? {})) bursts.spawn(mode, _to, { life: 0.4 });
    return {
      node: scene,
      drawCalls: () => 1,
      tick: (now, index, dt) => bursts.update(dt),
      dispose: () => bursts.dispose?.()
    };
  });

  /* --- Projectile: every flight mode --------------------------------- */
  const { Projectile, FlightMode, projectileParams } = VFX_MODULES.get('Projectile.js') ?? {};
  const flights = Object.values(FlightMode ?? {});
  add('Projectile.js', `Projectile (${flights.length} flight modes)`, () => {
    const parent = new Group();
    const material = new MeshBasicMaterial();
    const body = new Projectile(parent, {
      geometry: () => new IcosahedronGeometry(0.3, 0),
      material,
      capacity: 12,
      trail: true,
      trailNodes: 12
    });
    const p = projectileParams();
    body.setBasis(_from, _dirZ, _side, 12);
    body.roll(7);
    return {
      node: parent,
      drawCalls: () => body.drawCalls,
      tick: (now, index) => {
        p.flight = flights[index % flights.length];
        body.update(now, p);
        // Arrivals must be safe to read straight after update(), every frame.
        void body.arrivalCount;
      },
      dispose: () => {
        body.dispose();
        material.dispose();
      }
    };
  });

  /* --- Swarm: every silhouette --------------------------------------- */
  const { Swarm, Silhouette, LeadPath, swarmParams } = VFX_MODULES.get('Swarm.js') ?? {};
  for (const [name, silhouette] of Object.entries(Silhouette ?? {})) {
    add('Swarm.js', `Swarm ${name}`, () => {
      const parent = new Group();
      const swarm = new Swarm(parent, { capacity: 64, silhouette });
      const p = swarmParams();
      p.lead = LeadPath?.ORBIT ?? 0;
      swarm.setBasis(_from, _dirZ, _side, 12);
      swarm.roll(5);
      return {
        node: parent,
        drawCalls: () => swarm.drawCalls,
        tick: (now) => swarm.update(now, p),
        dispose: () => swarm.dispose()
      };
    });
  }

  /* --- Distortion: every emitter ------------------------------------- */
  const { DistortionField, DistortionMode, DistortionFacing } = VFX_MODULES.get('Distortion.js') ?? {};
  for (const [name, mode] of Object.entries(DistortionMode ?? {})) {
    add('Distortion.js', `DistortionField ${name}`, () => {
      const parent = new Group();
      const field = new DistortionField({ mode, facing: DistortionFacing?.BILLBOARD, edge: true });
      parent.add(field.object3D);
      field.visible = true;
      field.setAnchorXYZ(0, 1, 8);
      field.setBasis(_dirZ, _up);
      // An empty params object is the interesting call: it proves every read
      // falls back rather than writing `undefined` into a uniform.
      const p = { radius: 2.5, strength: 0.4, seed: 3 };
      return {
        node: parent,
        drawCalls: () => 1,
        tick: (now, index) => field.update(index % 2 ? p : {}),
        dispose: () => {
          field.visible = false; //  release the writer counter
          field.dispose();
        }
      };
    });
  }

  /* --- Portal --------------------------------------------------------- */
  const { Portal } = VFX_MODULES.get('Portal.js') ?? {};
  add('Portal.js', 'Portal', () => {
    const parent = new Group();
    const portal = new Portal({});
    parent.add(portal.object3D);
    portal.setPlacement(_to, _dirZ, _up);
    const p = { open: 0.8, radiusX: 2, radiusY: 3, seed: 9 };
    return {
      node: parent,
      drawCalls: () => 1,
      tick: (now, index) => portal.update(index % 2 ? p : {}),
      dispose: () => portal.dispose()
    };
  });

  /* --- LiquidSurface: both modes -------------------------------------- */
  const { LiquidSurface, LiquidMode, liquidParams } = VFX_MODULES.get('LiquidSurface.js') ?? {};
  for (const [name, mode] of Object.entries(LiquidMode ?? {})) {
    add('LiquidSurface.js', `LiquidSurface ${name}`, () => {
      const parent = new Group();
      const surface = new LiquidSurface({ mode, segments: 24 });
      parent.add(surface.object3D);
      surface.setPlacement(_to, _dirZ, _up);
      const p = liquidParams();
      return {
        node: parent,
        drawCalls: () => surface.drawCalls,
        tick: (now, index) => {
          surface.update(now, p);
          // rippleAtWorld() has to be called after update() — it needs this
          // frame's half-extents to turn a metre into the fraction it stores.
          if (index === 2) surface.rippleAtWorld(_to, 1, now);
          void surface.lipHeight(p, 0);
        },
        dispose: () => surface.dispose()
      };
    });
  }

  /* --- Curtain: every mode, every layout ------------------------------ */
  const { Curtain, CurtainMode, CurtainLayout, curtainParams } = VFX_MODULES.get('Curtain.js') ?? {};
  const curtainCombos = [];
  for (const mode of Object.values(CurtainMode ?? {})) curtainCombos.push([mode, CurtainLayout?.LINE ?? 0]);
  for (const layout of Object.values(CurtainLayout ?? {})) curtainCombos.push([CurtainMode?.RAIN ?? 0, layout]);
  for (const [mode, layout] of curtainCombos) {
    add('Curtain.js', `Curtain mode:${mode} layout:${layout}`, () => {
      const parent = new Group();
      const curtain = new Curtain({ mode, layout, capacity: 6, segmentsX: 8, segmentsY: 6, floor: true });
      parent.add(curtain.object3D);
      curtain.setPlacement(_to, _side, _up);
      curtain.roll(11);
      const p = curtainParams();
      return {
        node: parent,
        drawCalls: () => curtain.drawCalls,
        tick: (now) => curtain.update(now, p),
        dispose: () => curtain.dispose()
      };
    });
  }

  /* --- LensFlare ------------------------------------------------------ */
  const { LensFlare, lensFlareParams, MAX_FLARE_GHOSTS } = VFX_MODULES.get('LensFlare.js') ?? {};
  add('LensFlare.js', 'LensFlare', () => {
    const parent = new Group();
    const flare = new LensFlare({ ghosts: MAX_FLARE_GHOSTS });
    parent.add(flare.object3D);
    flare.visible = true;
    const p = lensFlareParams();
    return {
      node: parent,
      drawCalls: () => flare.drawCalls,
      tick: (now, index) => {
        flare.setAnchor(_to);
        // Sweep the ghost count so the instanceCount arithmetic is exercised
        // at both ends, including 0 — an off-by-one there draws a ghost with
        // a hashed spacing and no tint, which is a stripe across the frame.
        p.ghosts = index % (MAX_FLARE_GHOSTS + 1);
        p.occTaps = 1 + (index % 9);
        p.intensity = 0.5 + 0.5 * Math.sin(now);
        flare.update(p);
        if (flare.object3D.geometry.instanceCount > 3 + MAX_FLARE_GHOSTS) {
          throw new Error(`instanceCount ${flare.object3D.geometry.instanceCount} exceeds the built instances`);
        }
      },
      dispose: () => flare.dispose()
    };
  });

  /* --- Mirror: the surface, and the scheduler that feeds it ----------- */
  /**
   * The scheduler is the part of `Mirror` that a blank screen tells you about
   * far too late, and it is pure CPU: a frame token, a budget, a starvation
   * score and the oblique projection maths. All of that runs against a stub
   * renderer here — no GL, no reflection, but every line of `_renderReflection`
   * except the draw itself, which is where a NaN in the clip plane would come
   * from.
   */
  const { Mirror, mirrorParams, mirrorBudget, setMirrorBudget } = VFX_MODULES.get('Mirror.js') ?? {};
  add('Mirror.js', 'Mirror + scheduler', () => {
    const parent = new Group();
    const scene = new Scene();
    scene.add(parent);

    const camera = new PerspectiveCamera(50, 16 / 9, 0.1, 400);
    camera.position.set(0, 2.4, -7);
    camera.lookAt(_to);
    camera.updateMatrixWorld(true);
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

    /** The least renderer `_renderReflection()` will accept. */
    const gl = {
      info: { render: { frame: 0, calls: 7, triangles: 4200 } },
      xr: { enabled: false },
      shadowMap: { autoUpdate: true },
      autoClear: false,
      state: { buffers: { depth: { setMask() {} } }, viewport() {} },
      getRenderTarget: () => null,
      setRenderTarget() {},
      clear() {},
      render() {
        this.info.render.frame++;
      }
    };

    const previousBudget = mirrorBudget.max;
    setMirrorBudget(2);

    const mirrors = [];
    for (let i = 0; i < 4; i++) {
      const mirror = new Mirror({ resolution: 128, name: `mirror${i}` });
      parent.add(mirror.object3D);
      mirror.visible = true;
      mirrors.push(mirror);
    }

    const p = mirrorParams();
    const seen = new Set();
    const where = new Vector3(); // built once per case, not per frame

    return {
      node: parent,
      drawCalls: () => mirrors[0].drawCalls,
      tick: (now, index) => {
        gl.info.render.frame++; // the outer frame's own render call
        for (let i = 0; i < mirrors.length; i++) {
          const mirror = mirrors[i];
          where.set(i * 2.5 - 3.75, 1.2, 12);
          mirror.setPlacement(where, _dirZ, _up);
          p.width = 2 + i * 0.5;
          p.height = 2;
          p.roughness = (index % 4) / 3;
          p.resolution = index === 3 ? 256 : 128; // exercise the live re-size
          p.priority = 1 + i * 0.1;
          mirror.update(p);
        }
        // Scene order, as the renderer would walk it.
        for (const mirror of mirrors) mirror.object3D.onBeforeRender(gl, scene, camera);

        if (mirrorBudget.rendered > 2) {
          throw new Error(`${mirrorBudget.rendered} reflections in one frame with a budget of 2`);
        }
        for (const mirror of mirrors) {
          const m = mirror.material.uniforms.uReflectMatrix.value.elements;
          for (let e = 0; e < 16; e++) {
            if (!Number.isFinite(m[e])) throw new Error(`${mirror.mesh.name}: uReflectMatrix[${e}] is ${m[e]}`);
          }
          if (mirror.material.uniforms.uHasReflection.value > 0.5) seen.add(mirror.mesh.name);
        }
        // Four mirrors, two slots, starvation weighting: everyone must have had
        // a turn well inside six frames, or the scheduler is starving someone.
        if (index === 5 && seen.size < mirrors.length) {
          throw new Error(`only ${seen.size} of ${mirrors.length} mirrors rendered in six frames`);
        }
      },
      dispose: () => {
        for (const mirror of mirrors) mirror.dispose();
        setMirrorBudget(previousBudget);
      }
    };
  });

  /* --- SceneHooks: the borrow/restore discipline ---------------------- */
  /*
   * This one is not a renderer, so "does it produce a NaN" is the least
   * interesting question about it. What can actually go wrong is the ledger:
   * a hook still held by an ability that was destroyed, a double release taking
   * away somebody else's borrow, a restore that does not restore. All three are
   * testable without a GL context, so this case asserts them and throws — and a
   * throw inside `tick` is reported by `runVfxCase` like any other failure.
   *
   * The mock world is the smallest thing the module will accept: a Group
   * standing in for the DirectionalLight (it wants `.position`, `.color` and
   * `.intensity`, and a Group plus a borrowed Color covers it), a bare
   * MeshStandardMaterial for the floor, and a plain uniform block for the
   * grade. `mockEnvironment()` reproduces what `Environment.update()` does to
   * the sun every frame, because the module's central claim — that KEY_LIGHT
   * and GRADE need no restore, since their owners re-author them from settings
   * before the hook runs — is only true if something does that, and asserting
   * the sun comes back is worthless without it.
   */
  const { SceneHooks, Hook } = VFX_MODULES.get('SceneHooks.js') ?? {};
  add('SceneHooks.js', 'SceneHooks (six hooks, borrow/restore)', () => {
    const parent = new Group();
    const hooks = new SceneHooks();

    const sun = new Group();
    sun.color = new MeshBasicMaterial().color; //  a Color without a new import
    sun.intensity = 1;
    const sunTarget = new Group();
    const environment = { sun, sunTarget, focus: new Vector3(1, 0, -2) };
    const groundMaterial = new MeshStandardMaterial();
    const grade = {
      uSaturation: { value: 1 },
      uTemperature: { value: 0 },
      uLift: { value: 0 },
      uVignette: { value: 0 }
    };
    parent.add(sun, sunTarget);

    hooks.install({ scene: parent, environment, ground: { material: groundMaterial }, grade });

    // Exercise the floor patch. `onBeforeCompile` is never called without a
    // renderer, so the harness calls it by hand against the real chunk tokens.
    const probe = {
      uniforms: {},
      vertexShader: '#include <common>\nvoid main(){\n#include <begin_vertex>\n}',
      fragmentShader: '#include <common>\nvoid main(){\n#include <metalnessmap_fragment>\n}'
    };
    groundMaterial.onBeforeCompile(probe, null);
    if (!probe.fragmentShader.includes('sceneAgeField')) {
      throw new Error('the floor ageing patch did not reach the fragment shader');
    }
    if (!probe.vertexShader.includes('vSceneAgeWorld =')) {
      throw new Error('the floor ageing patch did not reach the vertex shader');
    }
    for (const key of ['uAgeField', 'uAgeMix', 'uAgeRustColor']) {
      if (!probe.uniforms[key]) throw new Error(`the ageing patch did not add ${key}`);
    }

    const owner = { id: 'harness' };
    const rivalOwner = { id: 'rival' };
    const baseDir = new Vector3();
    const baseSunPos = new Vector3();
    const held = {};

    /** What `Environment.update()` does to the key light, every frame. */
    const mockEnvironment = () => {
      const e = settings.environment;
      const cosE = Math.cos(e.sunElevation);
      baseDir
        .set(
          -Math.cos(e.sunAzimuth) * cosE,
          -Math.sin(e.sunElevation),
          -Math.sin(e.sunAzimuth) * cosE
        )
        .normalize();
      baseSunPos.copy(environment.focus).addScaledVector(baseDir, -70);
      sunTarget.position.copy(environment.focus);
      sun.position.copy(baseSunPos);
      sun.intensity = e.sunIntensity;
      grade.uSaturation.value = settings.post.saturation;
      grade.uVignette.value = settings.post.vignette;
    };

    const takeAll = () => {
      for (const hook of Object.values(Hook)) held[hook] = hooks.acquire(hook, owner);
      held[Hook.KEY_LIGHT].aim(1.1, 0.2).brightness(9).tint('#ffd0a0').blend(0.8);
      held[Hook.GRADE].saturate(0.1).temper(-0.4).raise(-0.06).darken(0.9).blend(1);
      held[Hook.AGE]
        .at(2, 0, -3)
        .field(7, 0.4, 1, 0.35)
        .wear(0.7, 0.4, 0.3, 0.5, 0.2)
        .scale(1.8)
        .colours('#7a3b1c', '#8a8375', '#3d5a20');
      held[Hook.HOLE].at(0, 1.5, 6).size(2.4, 0.8);
      held[Hook.GRAVITY].at(0, 1, 6).well(5, 0.3).scale(-1.4, 1);
      held[Hook.DISRUPT].at(0, 1, 6).region(6, 0.3).power(0.9, 0.5, 0.4).shardSize(7);
    };

    const holeMesh = () => parent.children.find((child) => child.name === 'SceneHooks.Hole');

    return {
      node: parent,
      drawCalls: () => 1, //  the depth proxy, and only while the hole is held
      tick: (now, index) => {
        mockEnvironment();

        if (index === 0) {
          takeAll();
        } else if (index === 1) {
          // Last acquirer wins, and the earlier holder stays live underneath.
          const rival = hooks.acquire(Hook.KEY_LIGHT, rivalOwner);
          rival.aim(2.4, 1.3).blend(1);
          if (held[Hook.KEY_LIGHT].driving) throw new Error('the earlier holder is still driving');
          if (!rival.driving) throw new Error('the last acquirer is not driving');
          if (rival === held[Hook.KEY_LIGHT]) {
            throw new Error('two owners were handed the same token');
          }
          // Re-acquiring a hook you already hold renews it; it does not stack a
          // second borrow on top of your own.
          if (hooks.acquire(Hook.KEY_LIGHT, rivalOwner) !== rival) {
            throw new Error('re-acquiring your own hook did not return your token');
          }
          rival.release();
          rival.release(); //  a double release must be a no-op
          if (!held[Hook.KEY_LIGHT].driving) throw new Error('LIFO did not hand the hook back');

          /* The recycled-token hazard, which the first design claimed to catch
           * with a serial and did not: a released token must never be handed to
           * a second owner, or the previous owner's late `onDestroy()` evicts
           * whoever is holding the hook now. Assert both halves. */
          const relay = hooks.acquire(Hook.HOLE, rivalOwner).size(1);
          const stale = held[Hook.HOLE];
          stale.release(); //  the earlier holder, from underneath
          stale.release(); //  and again, late — must not touch `relay`
          if (!relay.active || hooks.driver(Hook.HOLE) !== relay) {
            throw new Error('a stale release evicted the current holder');
          }
          relay.release();
          held[Hook.HOLE] = hooks.acquire(Hook.HOLE, owner).at(0, 1.5, 6).size(2.4, 0.8);
        } else if (index === 3) {
          // Everything has been written, so everything must have moved — but
          // only after an apply(), since mockEnvironment() has just put the
          // settings-authored values back on top, exactly as the app does.
          hooks.apply();
          if (!holeMesh()?.visible) throw new Error('the hole proxy is not visible while held');
          if (Math.abs(grade.uSaturation.value - settings.post.saturation) < 1e-6) {
            throw new Error('the grade hook did not reach the grade uniforms');
          }
          if (sun.position.distanceTo(baseSunPos) < 1e-3) {
            throw new Error('the key light hook did not move the sun');
          }
          if (hooks.gravityAt(0, 1, 6) > 0) throw new Error('gravity was not inverted in the well');
          if (hooks.gravityAt(0, 1, 40) !== 1) throw new Error('gravity leaked outside the well');
          if (hooks.disruptAt(0, 1, 6) < 0.99) throw new Error('the disrupt region reads as empty');
          if (hooks.ageAt(6, -3) <= 0) throw new Error('the age field is empty inside its own annulus');
        } else if (index === 4) {
          // Reclaim by owner — the one line an ability's onDestroy() wants —
          // and then assert the world is *exactly* back. For the two
          // settings-authored hooks that means mockEnvironment() alone put it
          // back, which is the claim the whole restore story rests on.
          hooks.reclaim(owner);
          hooks.apply();
          if (hooks.heldCount !== 0) throw new Error('reclaim(owner) left a hook held');
          if (holeMesh()?.visible) throw new Error('the hole proxy survived the release');
          if (hooks.gravityAt(0, 1, 6) !== 1) throw new Error('gravity did not restore to 1');
          if (hooks.disruptAt(0, 1, 6) !== 0) throw new Error('disrupt did not restore to 0');
          if (hooks.ageAt(6, -3) !== 0) throw new Error('the age field did not restore to 0');
          mockEnvironment();
          hooks.apply();
          if (Math.abs(grade.uSaturation.value - settings.post.saturation) > 1e-9) {
            throw new Error('the grade did not come back bit-for-bit');
          }
          if (Math.abs(sun.intensity - settings.environment.sunIntensity) > 1e-9) {
            throw new Error('the key light did not come back bit-for-bit');
          }
          if (sun.position.distanceTo(baseSunPos) > 1e-9) {
            throw new Error('the sun did not come back bit-for-bit');
          }
          takeAll(); //  and back on, so the zero-length frame has work to do
        }

        hooks.apply();
      },
      dispose: () => {
        hooks.reclaim(owner);
        if (hooks.heldCount !== 0) throw new Error('a hook survived teardown');
        hooks.dispose();
        groundMaterial.dispose();
      }
    };
  });


  /* --- Caustics: every shape, every source, and the binding hook --------- */
  const { Caustics, CausticSource, CausticShape, CAUSTIC_BOUND_KEYS, causticsParams } =
    VFX_MODULES.get('Caustics.js') ?? {};
  for (const [shapeName, shape] of Object.entries(CausticShape ?? {})) {
    add('Caustics.js', `Caustics SCROLL/${shapeName}`, () => {
      const parent = new Group();
      const net = new Caustics(parent, { source: CausticSource.SCROLL, shape });
      const p = causticsParams();
      p.centre = _to;
      p.lightAxis = new Vector3(0.2, -1, 0.1);
      return {
        node: parent,
        drawCalls: () => net.drawCalls,
        tick: (now, index) => {
          p.front = (index % 8) / 8;
          p.now = now;
          if (index === 2) net.ripple(0.3, -0.2, 1, now);
          net.update(p);
        },
        dispose: () => net.dispose()
      };
    });
  }

  add('Caustics.js', 'Caustics WAVE bound to a LiquidSurface', () => {
    const parent = new Group();
    const water = new LiquidSurface({ mode: LiquidMode?.WAVE ?? 1, segments: 16 });
    parent.add(water.object3D);
    water.setPlacement(_to, _dirZ, _up);

    const net = new Caustics(parent, { source: CausticSource.WAVE, shape: CausticShape.LANE });
    const taken = net.bindSource(water.uniforms);
    if (taken < 10) throw new Error(`bindSource() only took ${taken} of ${CAUSTIC_BOUND_KEYS.length} boxes`);
    for (const key of CAUSTIC_BOUND_KEYS) {
      if (net.material.uniforms[key] !== water.uniforms[key]) {
        throw new Error(`${key} is not shared by identity after bindSource()`);
      }
    }

    const wet = liquidParams();
    const p = causticsParams();
    p.centre = _to;
    return {
      node: parent,
      drawCalls: () => net.drawCalls,
      tick: (now, index) => {
        wet.waveFront = (index % 6) / 6;
        water.update(now, wet);
        // Written by the surface; the net must not have taken a second author.
        const before = water.uniforms.uCrestHeight.value;
        p.crestHeight = before + 5;
        net.update(p);
        if (water.uniforms.uCrestHeight.value !== before) {
          throw new Error('Caustics.update() overwrote a bound uniform');
        }
      },
      dispose: () => {
        net.dispose();
        water.dispose();
      }
    };
  });

  add('Caustics.js', 'Caustics CUSTOM source', () => {
    const parent = new Group();
    const net = new Caustics(parent, {
      source: CausticSource.CUSTOM,
      shape: CausticShape.DISC,
      custom: `
        uniform float uTestAmp;
        float causticHeight(vec2 xz) { return uTestAmp * sin(xz.x) * cos(xz.y + uTime); }
        float causticRidge(vec2 xz) { return 0.0; }
      `,
      uniforms: { uTestAmp: { value: 0.3 } }
    });
    const p = causticsParams();
    p.centre = _to;
    return {
      node: parent,
      drawCalls: () => net.drawCalls,
      tick: () => net.update(p),
      dispose: () => net.dispose()
    };
  });

  /* --- LightShaft: every layout, plus the CPU mirrors -------------------- */
  const { LightShaft, ShaftLayout, lightShaftParams } = VFX_MODULES.get('LightShaft.js') ?? {};
  for (const [layoutName, shaftLayout] of Object.entries(ShaftLayout ?? {})) {
    add('LightShaft.js', `LightShaft ${layoutName}`, () => {
      const parent = new Group();
      const shafts = new LightShaft(parent, { capacity: 5, layout: shaftLayout, maxSteps: 16 });
      shafts.setPlacement(_to, _dirZ, _up);
      shafts.roll(23);
      const p = lightShaftParams();
      p.layout = shaftLayout;
      p.count = 4;
      const probe = new Vector3();
      const out = new Vector3();
      return {
        node: parent,
        drawCalls: () => shafts.drawCalls,
        tick: (now, index) => {
          p.sweep = (index % 6) / 6;
          shafts.update(p);
          shafts.footPoint(1, p, out);
          shafts.mouthPoint(1, p, probe);
          // Halfway down its own axis, a shaft must light its own centre line.
          probe.lerp(out, 0.5);
          const lit = shafts.irradianceAt(probe, p);
          if (!Number.isFinite(lit)) throw new Error(`irradianceAt() returned ${lit}`);
          if (index === 3 && lit <= 0) {
            throw new Error('irradianceAt() is dark on the shaft’s own centre line');
          }
        },
        dispose: () => shafts.dispose()
      };
    });
  }

  /* --- BrushStroke: every tip layout ---------------------------------- */
  const { BrushStroke, BrushTip, BRUSH_TIP_NAMES, brushStrokeParams } =
    VFX_MODULES.get('BrushStroke.js') ?? {};
  for (const [name, tip] of Object.entries(BrushTip ?? {})) {
    add('BrushStroke.js', `BrushStroke ${BRUSH_TIP_NAMES?.[tip] ?? name}`, () => {
      const parent = new Group();
      const brush = new BrushStroke(parent, { strokes: 3, bristles: 6, samples: 12, sides: 6, tip });
      const p = brushStrokeParams();
      brush.setPaper(_up);
      brush.roll(5);
      const probe = new Vector3();
      return {
        node: parent,
        drawCalls: () => brush.drawCalls,
        tick: (now, index) => {
          // The head walks across the whole set, so every stroke gets a frame
          // where it is unstarted, one where it is mid-draw and one where it is
          // finished — the three cases the remap in the vertex shader has.
          p.progress = (index % 8) / 7;
          for (let s = 0; s < brush.strokeCount; s++) {
            const stroke = brush.stroke(s);
            stroke.line(_from, _to, s % 2 ? 0.6 : -0.4, 0.2);
            stroke.pressure(0.12, 1, 0.8, 0.03);
            stroke.ink(6 + s);
            stroke.timing(s / 3, 1 / 3);
            // Stroke 2 spends a frame parked, which is the path that must not
            // shuffle the remaining strokes into other slots.
            stroke.active = !(s === 2 && index === 4);
          }
          brush.update(now, p);
          void brush.widthAt(0, 0.5);
          brush.tipPoint(0, probe);
          brush.tangentAt(0, 0.5, probe);
        },
        dispose: () => brush.dispose()
      };
    });
  }

  /* --- InkDiffusion: every mode ---------------------------------------- */
  const { InkDiffusion, InkMode, INK_MODE_NAMES, inkDiffusionParams } =
    VFX_MODULES.get('InkDiffusion.js') ?? {};
  for (const [name, mode] of Object.entries(InkMode ?? {})) {
    add('InkDiffusion.js', `InkDiffusion ${INK_MODE_NAMES?.[mode] ?? name}`, () => {
      const parent = new Group();
      const ink = new InkDiffusion(parent, { mode, sources: 4, satellites: 8 });
      const p = inkDiffusionParams();
      p.sources = 3;
      p.satellites = 8;
      ink.setPlacement(_to, _dirZ);
      ink.roll(7);
      const probe = new Vector3();
      return {
        node: parent,
        drawCalls: () => ink.drawCalls,
        tick: (now) => {
          ink.update(now, p);
          // The CPU mirrors are what splatterbrand aims its projectiles with,
          // so a NaN in one of them is a projectile thrown at the origin.
          if (!Number.isFinite(ink.frontRadius(1))) throw new Error('frontRadius() is not finite');
          ink.sourcePoint(2, probe);
          ink.satellitePoint(3, probe);
          if (!Number.isFinite(probe.x + probe.y + probe.z)) {
            throw new Error('satellitePoint() is not finite');
          }
          if (!Number.isFinite(ink.satelliteSize(3))) throw new Error('satelliteSize() is not finite');
          if (!Number.isFinite(ink.satelliteAge(3))) throw new Error('satelliteAge() is not finite');
        },
        dispose: () => ink.dispose()
      };
    });
  }

  /* --- TimeControl: recorder, ghosts, the field, the reverse driver --- */
  const {
    GhostRig,
    RewindGate,
    TimeRecorder,
    TimeWarpClock,
    ghostLook,
    recorderParams,
    reverseParams,
    reverseRate,
    reverseTime,
    timeField,
    timeRegionParams
  } = VFX_MODULES.get('TimeControl.js') ?? {};

  /**
   * A minimal skinned rig, standing in for the character.
   *
   * The recorder and the ghost are the only things in this library that need a
   * *skeleton* rather than a mesh, and the character is an FBX this harness has
   * no way to load. Eight bones in a chain under one `SkinnedMesh` is enough to
   * exercise everything that can go wrong: bone discovery, the parallel clone,
   * the rebind, and the interpolation.
   */
  const probeRig = (boneCount = 8) => {
    const root = new Group();
    root.name = 'Character';
    const geometry = new BoxGeometry(0.3, 1.8, 0.3, 1, boneCount - 1, 1);
    const verts = geometry.attributes.position.count;
    geometry.setAttribute('skinIndex', new BufferAttribute(new Uint16Array(verts * 4), 4));
    geometry.setAttribute('skinWeight', new BufferAttribute(new Float32Array(verts * 4), 4));
    for (let i = 0; i < verts; i++) geometry.attributes.skinWeight.setX(i, 1);

    const bones = [];
    let parent = null;
    for (let i = 0; i < boneCount; i++) {
      const bone = new Bone();
      bone.name = `probe${i}`;
      bone.position.y = i === 0 ? 0 : 0.22;
      if (parent) parent.add(bone);
      parent = bone;
      bones.push(bone);
    }
    const mesh = new SkinnedMesh(geometry, new MeshStandardMaterial());
    mesh.add(bones[0]);
    root.add(mesh);
    mesh.bind(new Skeleton(bones));
    root.updateMatrixWorld(true);
    return { root, bones, geometry, mesh };
  };

  add('TimeControl.js', 'TimeRecorder + GhostRig (skeletal replay)', () => {
    const parent = new Group();
    const rig = probeRig(8);
    parent.add(rig.root);

    const recorder = new TimeRecorder({ capacity: 24, bones: 16 });
    recorder.attach(rig.root);
    const ghosts = [new GhostRig(parent, { source: rig.root }), new GhostRig(parent)];
    // The second ghost is sourced late on purpose: `setSource()` is the one
    // allocating call in the class and abilities are told to make it from
    // `createShaders()`, but the character is an async load and the fallback
    // path — source it on the first cast — has to work too.
    ghosts[1].setSource(rig.root);

    const rp = recorderParams();
    const look = ghostLook();
    const probePos = new Vector3();
    const probeQuat = new Quaternion();

    return {
      node: parent,
      drawCalls: () => ghosts.reduce((total, ghost) => total + ghost.drawCalls, 0),
      tick: (now, index) => {
        for (let b = 0; b < rig.bones.length; b++) {
          rig.bones[b].rotation.z = Math.sin(now * 3 + b) * 0.35;
        }
        rig.root.updateMatrixWorld(true);
        rp.rate = 30 + index;
        recorder.sample(now, rp);
        recorder.trim(now, rp);

        for (let g = 0; g < ghosts.length; g++) {
          const at = now - 0.08 * (g + 1);
          const live = recorder.poseAt(at, ghosts[g]);
          recorder.transformAt(at, probePos, probeQuat);
          if (!Number.isFinite(probePos.x + probeQuat.w)) {
            throw new Error('transformAt() wrote a non-finite root transform');
          }
          look.fade = 0.7 / (g + 1);
          look.seed = g * 3.7;
          // Asking for an instant off the end of the track is normal — the
          // oldest echo has no history for its first `delay` seconds — and it
          // must place the ghost rather than NaN it.
          ghosts[g].visible = live;
          ghosts[g].place(probePos, g * 0.4).setScale(1 - g * 0.05).sync(look);
        }
      },
      dispose: () => {
        for (const ghost of ghosts) ghost.dispose();
        recorder.detach();
        rig.geometry.dispose();
        rig.mesh.material.dispose();
      }
    };
  });

  add('TimeControl.js', 'TimeField (stasis, rewind, slow, and the pool ceiling)', () => {
    const parent = new Group();
    const regions = [];
    const params = [];
    // Every rate the field is documented to support, plus the exhaustion path:
    // the pool is MAX_TIME_REGIONS wide and `acquire()` past that returns null,
    // on the `ctx.lights.acquire()` contract. A case that never sees the null
    // is a case that never checks the guard is needed.
    const rates = [0, -1, 0.25, 1, 0];
    for (let i = 0; i < rates.length; i++) {
      const region = timeField.acquire(0);
      regions.push(region);
      const p = timeRegionParams();
      p.rate = rates[i];
      params.push(p);
      region?.lock(0.25 * i);
    }
    if (regions[regions.length - 1] !== null) {
      throw new Error('acquire() past the pool ceiling must return null');
    }

    return {
      node: parent,
      drawCalls: () => 0,
      tick: (now, index) => {
        for (let i = 0; i < regions.length; i++) {
          const region = regions[i];
          if (!region) continue; //  the guard every ability has to write
          region.placeXYZ(i * 2, 1, 6);
          params[i].radius = 3 + i + index * 0.1;
          params[i].core = 0.2 * i;
          params[i].strength = 1 - i * 0.15;
          region.sync(params[i]);
          if (!Number.isFinite(region.weightAt(_to))) throw new Error('weightAt() is not finite');
        }
        if (!Number.isFinite(timeField.clockAt(now, _to))) {
          throw new Error('clockAt() is not finite');
        }
        if (!Number.isFinite(timeField.weightAt(_from))) {
          throw new Error('weightAt() is not finite');
        }
      },
      dispose: () => {
        for (const region of regions) region?.release();
        // A leaked region is invisible and freezes a piece of the world for the
        // rest of the session, so the case asserts the pool actually emptied.
        timeField.reset();
        if (frame.uTimeRegionCount.value !== 0) {
          throw new Error('the time field did not return to idle');
        }
      }
    };
  });

  add('TimeControl.js', 'reverseTime / TimeWarpClock / RewindGate', () => {
    const clock = new TimeWarpClock();
    const gate = new RewindGate();
    const p = reverseParams();
    return {
      node: null,
      drawCalls: () => 0,
      tick: (now, index, dt) => {
        p.turnAt = 0.1 + index * 0.02;
        const bent = reverseTime(now, p);
        const rate = reverseRate(now, p);
        if (!Number.isFinite(bent) || !Number.isFinite(rate)) {
          throw new Error('the closed form is not finite');
        }
        clock.advance(dt, index % 3 === 2 ? -2 : 1, 0);
        if (!Number.isFinite(clock.now) || clock.emitDt < 0) {
          throw new Error('TimeWarpClock produced a bad step');
        }
        gate.poll(bent, p.turnAt);
      },
      dispose: () => {
        clock.reset();
        gate.reset();
      }
    };
  });

  /* --- FoldMesh: every pattern, every layout --------------------------- */
  const { FoldMesh, FoldPattern, FoldLayout, foldMeshParams, fanCreases } =
    VFX_MODULES.get('FoldMesh.js') ?? {};
  const foldCombos = [];
  for (const [name, pattern] of Object.entries(FoldPattern ?? {})) {
    foldCombos.push([`${name} LINE`, pattern, FoldLayout?.LINE ?? 0]);
  }
  for (const [name, layout] of Object.entries(FoldLayout ?? {})) {
    foldCombos.push([`CRANE ${name}`, FoldPattern?.CRANE ?? 2, layout]);
  }
  for (const [label, pattern, layout] of foldCombos) {
    add('FoldMesh.js', `FoldMesh ${label}`, () => {
      const parent = new Group();
      const paper = new FoldMesh(parent, {
        pattern,
        layout,
        capacity: 6,
        segments: 6,
        segmentsV: 8
      });
      paper.setBasis(_from, _dirZ, _side, 12);
      paper.roll(5);
      const p = foldMeshParams();
      p.count = 5;
      const probe = new Vector3();
      return {
        node: parent,
        drawCalls: () => paper.drawCalls,
        tick: (now, index) => {
          // Sweep the fold across the frames: the whole module is one slider and
          // the interesting arithmetic (the hinge radius, the spiral) divides by
          // things that are zero at exactly one value of it.
          p.progress = index / 6;
          p.payout = index / 6;
          p.curl = index === 3 ? 0 : 0.4; // the straight-run limit of sin(ka)/k
          paper.update(now, p);
          void paper.sheetPoint(index % 5, p, probe);
          void paper.spoolPoint(index % 5, p, probe);
        },
        dispose: () => paper.dispose()
      };
    });
  }
  add('FoldMesh.js', 'FoldMesh custom table', () => {
    const parent = new Group();
    const paper = new FoldMesh(parent, { capacity: 2, segments: 5, segmentsV: 5 });
    paper.setPattern(fanCreases(12, 1));
    paper.setBasis(_from, _dirZ, _side, 8);
    const p = foldMeshParams();
    p.count = 2;
    p.hinge = 0.0005; // under a grid cell: the degenerate hinge
    return {
      node: parent,
      drawCalls: () => paper.drawCalls,
      tick: (now) => paper.update(now, p),
      dispose: () => paper.dispose()
    };
  });

  /* --- Dissolve: the heap, and the patch ------------------------------- */
  const {
    DissolveField,
    DissolveMode,
    DissolveSpace,
    heapParams,
    dissolveParams,
    dissolveUniforms,
    syncDissolve,
    patchDissolveMaterial
  } = VFX_MODULES.get('Dissolve.js') ?? {};

  add('Dissolve.js', 'Dissolve GRANULAR', () => {
    const parent = new Group();
    const heap = new DissolveField(parent, { along: 16, across: 10 });
    heap.setBasis(_from, _dirZ, _side, 14);
    heap.roll(9);
    const p = heapParams();
    const probe = new Vector3();
    return {
      node: parent,
      drawCalls: () => heap.drawCalls,
      tick: (now, index) => {
        // Repose at zero would make tan(0) a divide-by-nothing in the radius,
        // and the clamp inside heapAt is the thing being tested here.
        p.repose = index === 4 ? 0 : 0.58;
        p.rate = index === 5 ? 0 : 5;
        heap.update(now, p);
        void heap.frontPoint(now, p, probe);
        if (!Number.isFinite(heap.crestHeight(now, p))) throw new Error('crestHeight is not finite');
      },
      dispose: () => heap.dispose()
    };
  });

  for (const [name, mode] of [
    ['VOXEL', DissolveMode?.VOXEL ?? 0],
    ['EROSION', DissolveMode?.EROSION ?? 2]
  ]) {
    add('Dissolve.js', `Dissolve patch ${name}`, () => {
      const parent = new Group();
      const material = patchDissolveMaterial(new MeshStandardMaterial(), { mode });
      const mesh = new Mesh(new BoxGeometry(1, 1, 1), material);
      parent.add(mesh);
      const p = dissolveParams();
      return {
        node: parent,
        drawCalls: () => 1,
        tick: (_now, index) => {
          p.progress = index / 6;
          p.span = index === 3 ? 0 : 0.22; // the zero-width let-go
          syncDissolve(material, p);
        },
        dispose: () => {
          mesh.geometry.dispose();
          material.dispose();
        }
      };
    });
  }

  add('Dissolve.js', 'Dissolve patch shared box (WORLD)', () => {
    const parent = new Group();
    // The reason the box is a separate function: two materials, one event.
    const box = dissolveUniforms({ space: DissolveSpace?.WORLD ?? 1, erode: 1 });
    const materials = [new MeshStandardMaterial(), new MeshStandardMaterial()];
    for (const m of materials) {
      patchDissolveMaterial(m, { uniforms: box });
      const mesh = new Mesh(new BoxGeometry(0.5, 0.5, 0.5), m);
      parent.add(mesh);
    }
    const p = dissolveParams();
    p.space = DissolveSpace?.WORLD ?? 1;
    return {
      node: parent,
      drawCalls: () => materials.length,
      tick: (_now, index) => {
        p.progress = index / 6;
        syncDissolve(box, p);
        if (materials[1].userData.uniforms.uDisProgress !== box.uDisProgress) {
          throw new Error('the shared box stopped being shared');
        }
      },
      dispose: () => {
        for (const m of materials) m.dispose();
      }
    };
  });

  /* --- HardSurface: six generators, one material, two solvers ---------- */
  const {
    HardShape,
    HARD_SHAPE_NAMES,
    HardAxis,
    hardShape,
    hardSurfaceGeometry,
    gearShape,
    gearPitchFraction,
    gearRootFraction,
    ShapeCache,
    GearTrain,
    gearTrainParams,
    GrindContact,
    grindParams,
    BrushMode,
    hardSurfaceParams,
    createHardSurfaceMaterial,
    syncHardSurfaceMaterial,
    blackbodyColor,
    heatToKelvin
  } = VFX_MODULES.get('HardSurface.js') ?? {};

  /**
   * `scanGroup` only reads *instanced* attributes, and every one of these is a
   * plain BufferGeometry — so the geometry scan is done here by hand. It is
   * worth the twelve lines: an involute flank is an `acos` of a ratio and a
   * `tan` of the result, and the whole family of ways to get a NaN out of that
   * shows up as a hole in the mesh and nowhere else.
   */
  const scanHardGeometry = (label, geometry) => {
    for (const name of ['position', 'normal', 'aEdge']) {
      const attribute = geometry.getAttribute(name);
      if (!attribute) throw new Error(`${label}: no ${name} attribute`);
      const array = attribute.array;
      for (let i = 0; i < array.length; i++) {
        if (!Number.isFinite(array[i])) throw new Error(`${label}: ${name}[${i}] is ${array[i]}`);
      }
    }
    // The unit-space contract GrowthField's factory relies on.
    const p = geometry.getAttribute('position').array;
    let minY = Infinity;
    let maxY = -Infinity;
    let maxR = 0;
    for (let i = 0; i < p.length; i += 3) {
      minY = Math.min(minY, p[i + 1]);
      maxY = Math.max(maxY, p[i + 1]);
      maxR = Math.max(maxR, Math.hypot(p[i], p[i + 2]));
    }
    if (maxR > 0.5001 || minY < -1e-4 || maxY > 1.0001) {
      throw new Error(
        `${label}: outside unit space — footprint r=${maxR.toFixed(3)} (max 0.5), y=${minY.toFixed(3)}..${maxY.toFixed(3)} (0..1)`
      );
    }
  };

  /* Every generator, on every axis, plus the awkward settings of each: a
     pointed tooth, a solid blank, a slotless blade, a boltless plate, an
     unthreaded bolt and a hornless anvil are all reachable from the editor. */
  const hardVariants = [
    ['GEAR', HardShape?.GEAR, { teeth: 7, addendum: 1.4, backlash: 0, bore: 0, lightenHoles: 6 }],
    ['GEAR pointed', HardShape?.GEAR, { teeth: 5, addendum: 2.2, rootFillet: 0, chamfer: 0 }],
    ['PISTON', HardShape?.PISTON, { axis: HardAxis?.Z, rings: 4, faceRecess: 0 }],
    ['SAWBLADE', HardShape?.SAWBLADE, { teeth: 9, rake: 40, clearance: 55, slots: 0 }],
    ['SAWBLADE fine', HardShape?.SAWBLADE, { teeth: 48, rake: -12, gullet: 0.05 }],
    ['PLATE', HardShape?.PLATE, { bolts: 6, counterSink: 0.08 }],
    ['PLATE bare', HardShape?.PLATE, { bolts: 0, bevel: 0, corner: 0 }],
    ['BOLT', HardShape?.BOLT, { threadTurns: 14, washer: 0 }],
    ['BOLT smooth', HardShape?.BOLT, { threadTurns: 0, threadDepth: 0, tipTaper: 0 }],
    ['ANVIL', HardShape?.ANVIL, { axis: HardAxis?.X }],
    ['ANVIL unfilleted', HardShape?.ANVIL, { fillet: 0, horn: 0, corner: 0 }]
  ];
  for (const [label, kind, overrides] of hardVariants) {
    add('HardSurface.js', `HardSurface ${label}`, () => {
      const parent = new Group();
      const material = createHardSurfaceMaterial({});
      const shape = hardShape(kind, overrides);
      const geometry = hardSurfaceGeometry(kind, shape);
      scanHardGeometry(`HardSurface ${label}`, geometry);
      parent.add(new Mesh(geometry, material));
      const p = hardSurfaceParams();
      return {
        node: parent,
        drawCalls: () => 1,
        tick: (now, index) => {
          // A slider being dragged while the clock is stopped: every one of
          // these has to land in a uniform on the zero-length frame too.
          p.heat = (index % 7) / 6;
          p.brush = index % 3;
          p.grainScale = 60 + index * 11;
          syncHardSurfaceMaterial(material, p);
          void heatToKelvin(p.heat, p);
        },
        dispose: () => {
          geometry.dispose();
          material.dispose();
        }
      };
    });
  }

  add('HardSurface.js', 'HardSurface ShapeCache', () => {
    const cache = new ShapeCache({ capacity: 3 });
    const shape = gearShape();
    return {
      node: null,
      drawCalls: () => 0,
      tick: (now, index) => {
        // Every other frame moves a shape number; the frames in between must
        // hand back the identical geometry rather than rebuild it.
        shape.teeth = 10 + (index % 3);
        const first = cache.get('gear', HardShape.GEAR, shape);
        const rebuilt = cache.changed;
        const second = cache.get('gear', HardShape.GEAR, shape);
        if (second !== first) throw new Error('ShapeCache rebuilt an unchanged shape');
        if (cache.changed) throw new Error('ShapeCache reported a change with nothing changed');
        if (rebuilt) scanHardGeometry('ShapeCache gear', first);
        if (!Number.isFinite(gearPitchFraction(shape) + gearRootFraction(shape))) {
          throw new Error('gear pitch/root fraction is not finite');
        }
      },
      dispose: () => cache.dispose()
    };
  });

  add('HardSurface.js', 'HardSurface GearTrain (meshing)', () => {
    const train = new GearTrain({ capacity: 8 });
    const p = gearTrainParams();
    p.origin = _to;
    p.direction = _dirZ;
    p.side = _side;
    p.teeth = [9, 14, 22];
    train.plant(6, 3.5);
    const a = new Vector3();
    const b = new Vector3();
    return {
      node: null,
      drawCalls: () => 0,
      tick: (now, index) => {
        p.time = now;
        // The ratios are dragged mid-cast, which is the whole point of them
        // living in the params: the train must stay meshed through it.
        p.teeth = index % 2 ? [9, 14, 22] : [11, 13, 30];
        p.module = 0.12 + index * 0.01;
        train.solve(p);
        for (let i = 0; i < train.count; i++) {
          train.positionOf(i, p, a);
          if (!Number.isFinite(a.x + a.y + a.z)) throw new Error(`gear ${i} position is not finite`);
          if (!Number.isFinite(train.yawOf(i) + train.rateOf(i))) throw new Error(`gear ${i} spin is not finite`);
          if (i === 0) continue;
          // Standard centre distance: the sum of the PITCH radii, to the
          // millimetre. If this drifts the teeth are interpenetrating.
          train.positionOf(i - 1, p, b);
          const want = train.pitchRadiusOf(i - 1) + train.pitchRadiusOf(i);
          if (Math.abs(a.distanceTo(b) - want) > 1e-6) {
            throw new Error(`gears ${i - 1}/${i} sit ${a.distanceTo(b).toFixed(4)} m apart, should be ${want.toFixed(4)} m`);
          }
          // And counter-rotating at exactly the inverse tooth ratio.
          const ratio = -train.rateOf(i) / train.rateOf(i - 1);
          if (Math.abs(ratio - train.teethOf(i - 1) / train.teethOf(i)) > 1e-9) {
            throw new Error(`gears ${i - 1}/${i} turn at ${ratio}, not the tooth ratio`);
          }
          train.contactOf(i, p, b);
        }
      },
      dispose: () => train.clear()
    };
  });

  add('HardSurface.js', 'HardSurface GrindContact', () => {
    const grind = new GrindContact();
    const p = grindParams();
    const velocity = new Vector3();
    const contact = new Vector3(0, 0.02, 8);
    const centre = new Vector3(0, 1.1, 8);
    const emit = {};
    const axis = new Vector3(1, 0, 0);
    return {
      node: null,
      drawCalls: () => 0,
      tick: (now, index) => {
        // Frame 3 is the degenerate one: a stalled blade flat against the
        // floor, where the tangent, the binormal and the speed all collapse.
        const rate = index === 3 ? 0 : 90 - index * 6;
        GrindContact.rimVelocity(velocity, index === 3 ? new Vector3() : axis, rate, contact, centre);
        grind.solve(contact, index === 3 ? new Vector3() : _up, velocity, p);
        if (!Number.isFinite(grind.speed) || grind.speed < p.speedFloor - 1e-6) {
          throw new Error(`spark speed ${grind.speed} is below the floor`);
        }
        for (let j = 0; j < grind.jets; j++) {
          grind.jet(j, emit);
          const d = emit.direction;
          if (!Number.isFinite(d.x + d.y + d.z)) throw new Error(`jet ${j} direction is not finite`);
          if (Math.abs(d.length() - 1) > 1e-3) throw new Error(`jet ${j} direction is not unit`);
          // The read the whole helper exists for: sparks leave along the
          // tangent, so a jet must never point into the workpiece.
          if (index !== 3 && d.dot(_up) < -1e-3) throw new Error(`jet ${j} is aimed into the floor`);
        }
        void blackbodyColor(900 + index * 180);
      },
      dispose: () => {}
    };
  });

  /* --- Colony: the SDF swarm, every target shape ---------------------- */
  const {
    ColonySwarm,
    ColonyShape,
    COLONY_SHAPE_NAMES,
    colonySwarmParams,
    WebGraph,
    webGraphParams,
    LatticeGrowth,
    latticeGrowthParams,
    PlateShell,
    plateShellParams
  } = VFX_MODULES.get('Colony.js') ?? {};

  for (const [name, shape] of Object.entries(ColonyShape ?? {})) {
    add('Colony.js', `ColonySwarm ${name}`, () => {
      const parent = new Group();
      const swarm = new ColonySwarm(parent, { capacity: 64 });
      const p = colonySwarmParams();
      // Morph this shape into the next one, because the transition is the
      // thing the module exists for and the blended field is the code path
      // that only runs when the two shapes differ.
      p.shapeA = shape;
      p.shapeB = (shape + 1) % (COLONY_SHAPE_NAMES?.length ?? 6);
      p.waveAmp = 0.4;
      swarm.setBasis(_from, _dirZ, _side, 12);
      swarm.roll(5);
      const out = new Vector3();
      return {
        node: parent,
        drawCalls: () => swarm.drawCalls,
        tick: (now, index) => {
          p.condense = index / VFX_FRAMES;
          p.shapeBlend = (index * 0.3) % 1;
          p.cling = index === 4 ? 1 : 0;
          swarm.update(now, p);
          void swarm.shapeCentre(out);
        },
        dispose: () => swarm.dispose()
      };
    });
  }

  /* --- Colony: the web and its membrane -------------------------------- */
  add('Colony.js', 'WebGraph', () => {
    const parent = new Group();
    const web = new WebGraph(parent, { maxRings: 6, maxSpokes: 14, filmSubdiv: 2 });
    const p = webGraphParams();
    web.setPlacement(_to, _dirZ, _up);
    web.roll(11);
    const out = new Vector3();
    return {
      node: parent,
      drawCalls: () => web.drawCalls,
      tick: (now, index) => {
        p.grow = index / VFX_FRAMES;
        // The topology rebuild is the interesting path: it rewrites both
        // meshes' index attributes mid-flight and must never leave the film
        // pointing at a spoke the strands no longer have.
        p.rings = 3 + (index % 4);
        p.spokes = 8 + (index % 7);
        web.update(now, p);
        void web.nodePoint(index % 4, index, p, out);
      },
      dispose: () => web.dispose()
    };
  });

  /* --- Colony: lattice growth, with the refusal doing work -------------- */
  add('Colony.js', 'LatticeGrowth', () => {
    const parent = new Group();
    const comb = new LatticeGrowth(parent, { capacity: 160 });
    const p = latticeGrowthParams();
    comb.setPlacement(_to, _dirZ);
    const out = new Vector3();
    return {
      node: parent,
      drawCalls: () => comb.drawCalls,
      tick: (now, index) => {
        // Sweep the two structural sliders, so the regrow path runs every
        // frame rather than once. Drift 0 must give a clean lattice and a
        // high refusal must not deadlock the frontier.
        p.drift = index * 0.12;
        p.refuse = 0.8 + index * 0.04;
        comb.update(now, p);
        if (comb.count < 1) throw new Error('the growth placed no cells at all');
        void comb.cellPoint(index, p, out);
      },
      dispose: () => comb.dispose()
    };
  });

  /* --- Colony: the shell tessellation ---------------------------------- */
  add('Colony.js', 'PlateShell', () => {
    const parent = new Group();
    const shell = new PlateShell(parent, { capacity: 64 });
    const p = plateShellParams();
    shell.setPlacement(_to, _dirZ);
    const out = new Vector3();
    return {
      node: parent,
      drawCalls: () => shell.drawCalls,
      tick: (now, index) => {
        p.sites = 12 + index * 8;
        p.jitter = index * 0.15;
        shell.update(now, p);
        // The claim the module is built on. Every plate must survive the
        // clipper with a real polygon; a cell reduced below three vertices
        // means a gap in the dome.
        if (shell.count < 1) throw new Error('the tessellation produced no plates');
        void shell.plateCentre(index, p, out);
        void shell.progress(now, p);
      },
      dispose: () => shell.dispose()
    };
  });

  return cases;
}

/** Frames each case is driven for before the zero-length one. */
const VFX_FRAMES = 6;

/**
 * Drive one case and collect everything that went wrong with it.
 *
 * The zero-length frame at the end is not decoration: it is the same I1 probe
 * the ability pause test runs, reduced to "does a `dt = 0` tick throw or
 * produce a NaN". A module that divides by `dt` fails here and nowhere else.
 */
function runVfxCase(entry, failures) {
  let handle;
  try {
    handle = entry.build();
  } catch (error) {
    failures.push(`${entry.label}: construction threw — ${describeError(error)}`);
    return;
  }

  const problems = [];
  try {
    for (let i = 0; i < VFX_FRAMES; i++) {
      frame.uTime.value += DT;
      frame.uDelta.value = DT;
      handle.tick(frame.uTime.value, i, DT);
    }
    // The zero-length frame — a paused slider drag.
    frame.uDelta.value = 0;
    handle.tick(frame.uTime.value, VFX_FRAMES, 0);

    if (handle.node) {
      handle.node.updateMatrixWorld(true);
      scanGroup(handle.node, problems);
    }

    const calls = handle.drawCalls?.();
    if (Number.isFinite(calls) && calls > DRAW_CALL_BUDGET) {
      problems.push(`draws ${calls} times on its own — the whole-ability budget is ${DRAW_CALL_BUDGET} (I4/I7)`);
    }
  } catch (error) {
    problems.push(`threw while ticking — ${describeError(error)}`);
  }

  try {
    handle.dispose?.();
  } catch (error) {
    problems.push(`dispose() threw — ${describeError(error)}`);
  }

  for (const problem of problems) failures.push(`${entry.label}: ${problem}`);
}

/** True for an ES class, which is what the coverage rule is looking for. */
function isClass(value) {
  return typeof value === 'function' && /^class\s/.test(Function.prototype.toString.call(value));
}

/**
 * Run the whole stage. Reports through the roster-level channels, because a
 * broken shared module is not any one ability's fault — it is everyone's.
 */
async function checkVfxLibrary() {
  const failures = [];

  // Before anything is constructed: the one class of shader breakage that a
  // headless harness can find with certainty, and that a browser finds by
  // deleting a mesh from the frame without saying which.
  vfx.glslBlocks = sweepGlslReservedWords(failures);

  for (const [name, module] of VFX_MODULES) {
    if (module.__error) failures.push(`${name}: failed to import — ${describeError(module.__error)}`);
  }

  let cases = [];
  try {
    cases = vfxCases();
  } catch (error) {
    failures.push(`building the case list threw — ${describeError(error)}`);
  }

  for (const entry of cases) {
    if (VFX_MODULES.get(entry.file)?.__error) continue; //  already reported
    runVfxCase(entry, failures);
  }

  /* --- the coverage rule --- */
  const covered = new Set(cases.map((entry) => entry.file));
  for (const [name, module] of VFX_MODULES) {
    if (module.__error) continue;
    const classes = Object.entries(module).filter(([, value]) => isClass(value));
    if (!classes.length) continue;
    if (!covered.has(name)) {
      failures.push(
        `${name} exports ${classes.map(([key]) => key).join(', ')} but has no case in VFX_CASES — ` +
          `add one to scripts/check.mjs so the abilities built on it get an error here rather than a blank screen`
      );
    }
  }

  vfx.cases = cases.length;
  vfx.modules = VFX_MODULES.size;
  vfx.failures = failures;
  for (const message of failures) failGlobal(`[vfx] ${message}`);
  return failures.length === 0;
}

/* ------------------------------------------------------------------ */
/* §11 · Output                                                        */
/* ------------------------------------------------------------------ */

function describeError(error) {
  if (!(error instanceof Error)) return String(error);
  const frameLine = (error.stack ?? '').split('\n').find((line) => line.includes('/src/'));
  const where = frameLine ? dim(` (${frameLine.trim().replace(/^at\s+/, '')})`) : '';
  return `${error.message}${where}`;
}

const safeNumber = (n) => (Number.isFinite(n) ? n.toFixed(2) : String(n));

/** `null` means the stage never ran — usually because an earlier one failed. */
const markText = (state) => (state === null ? '—' : state ? 'ok' : 'FAIL');
const colourMark = (state, text) => (state === null ? dim(text) : state ? green(text) : red(text));

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

checkRoster();
await checkSchools();

log(
  bold(
    `\ncheck · ${TARGET.length} of ${ABILITIES.length} abilities · ` +
      `${SCHOOLS.length} schools · node ${process.version}\n`
  )
);

for (const descriptor of TARGET) {
  const report = reports.get(descriptor.id);
  if (checkStructure(descriptor, report)) {
    checkStaticReads(descriptor, report);
    await captureConsole(report, () => runAbility(descriptor, report));
  } else {
    // Without a settings block there is nothing coherent left to test.
    checkStaticReads(descriptor, report);
  }
}

/* --- the shared library --- */
// Skipped under `--only <id>`, which exists to make one ability's loop fast;
// `--vfx` forces it back on when the library is what you are working on.
const RUN_VFX = !ONLY || flag('--vfx');
if (RUN_VFX) await checkVfxLibrary();

/* --- the table --- */
// Widths are measured on the *plain* text and the colour is wrapped around the
// finished cell: `padEnd` counts escape sequences as characters, so colouring
// first shifts every row that failed a few columns to the right.
const COLUMNS = [
  ['struct', 'struct'],
  ['static', 'static'],
  ['runtime', 'runtime'],
  ['travel', 'pause:travel'],
  ['impact', 'pause:impact']
];
const idWidth = Math.max(10, ...TARGET.map((a) => a.id.length + 2));
const cellWidth = COLUMNS.map(([, title]) => title.length + 2);

const row = (first, cells) =>
  first.padEnd(idWidth) + cells.map((text, i) => centre(text, cellWidth[i])).join('');

const centre = (text, size) => {
  const pad = Math.max(0, size - text.length);
  const left = Math.floor(pad / 2);
  return ' '.repeat(left) + text + ' '.repeat(pad - left);
};

const headerLine = row('ability', COLUMNS.map(([, title]) => title));
console.log(bold(headerLine));
console.log(dim('─'.repeat(headerLine.length)));

let failed = 0;
let skipped = false;
for (const descriptor of TARGET) {
  const report = reports.get(descriptor.id);
  if (!report.ok) failed++;
  const cells = COLUMNS.map(([key], i) => {
    if (report.marks[key] === null) skipped = true;
    return colourMark(report.marks[key], centre(markText(report.marks[key]), cellWidth[i]));
  });
  console.log(descriptor.id.padEnd(idWidth) + cells.join(''));
}
if (skipped) console.log(dim('— · not reached, because an earlier stage failed'));

/* --- notes and warnings --- */
if (!QUIET) {
  for (const descriptor of TARGET) {
    const report = reports.get(descriptor.id);
    if (!report.notes.length && !report.warnings.length) continue;
    console.log(`\n${bold(descriptor.id)}`);
    for (const note of report.notes) console.log(dim(`    ${note}`));
    for (const { stage, message } of report.warnings) console.log(yellow(`  ! [${stage}] ${message}`));
  }
  for (const note of rosterNotes) console.log(dim(`\n    [roster] ${note}`));
  for (const warning of globalWarnings) console.log(yellow(`\n  ! [roster] ${warning}`));

  if (RUN_VFX) {
    const state = vfx.failures?.length ? red(`${vfx.failures.length} failed`) : green('all pass');
    console.log(`\n${bold('vfx')}`);
    console.log(dim(`    ${vfx.cases} case(s) across ${vfx.modules} module(s) — ${state}`));
    console.log(dim(`    ${vfx.glslBlocks} GLSL block(s) swept for GLSL ES 3.00 reserved words`));
  }
}

/* --- failures --- */
if (failed || globalFailures.length) {
  console.log(`\n${bold(red('FAILURES'))}`);
  for (const message of globalFailures) console.log(`\n  ${red('roster')}\n    ${message}`);
  for (const descriptor of TARGET) {
    const report = reports.get(descriptor.id);
    if (report.ok) continue;
    console.log(`\n  ${red(descriptor.id)}`);
    for (const { stage, message } of report.failures) {
      console.log(`    ${bold(`[${stage}]`)} ${message}`);
    }
  }
}

const total = TARGET.length;
const broken = failed + (globalFailures.length ? 1 : 0);
const warnings = TARGET.reduce((sum, a) => sum + reports.get(a.id).warnings.length, 0) + globalWarnings.length;
console.log('');
if (warnings && QUIET) console.log(dim(`${warnings} warning(s) — drop --quiet to read them.`));
if (broken) {
  console.log(red(bold(`${failed} of ${total} abilities failed${globalFailures.length ? `, plus ${globalFailures.length} roster-level failure(s)` : ''}.`)));
  process.exit(1);
}
console.log(green(bold(`all ${total} abilities pass.`)));
