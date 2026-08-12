import GUI from 'lil-gui';
import { settings, CAST_ANIMATIONS } from '../config/settings.js';
import { ABILITY_SCHEMAS } from '../config/abilities/index.js';
import { abilitiesBySchool } from '../abilities/registry.js';
import { PresetManager } from './PresetManager.js';

/**
 * Real-time VFX editor.
 *
 * Every control binds straight to a field in `config/settings.js`. Because all
 * shaders, particle systems, lights and post passes *read* those fields each
 * frame, no controller needs an onChange handler: moving a slider updates the
 * ice field that is already standing, the bolt that is already in the air, the
 * next cast, the environment and the post stack simultaneously, with no rebuild
 * and no shader recompilation.
 *
 * That holds while the simulation is paused (`P`), which is the point — the
 * silhouette of a frozen eruption and the shape of a frozen bolt are the things
 * worth tuning, and both abilities re-resolve themselves from these values on a
 * zero-length frame.
 *
 * ## A hundred abilities
 *
 * The stage furniture — presets, globals, the aim arrow, the far-cast circle,
 * the environment, post, camera and character — is still hand-written here,
 * because there is one of each and each is its own argument about what matters.
 *
 * The abilities are not. Six hand-written `_buildX()` methods were fine at six
 * and would have been sixteen thousand lines at a hundred, every one of them a
 * second place for a settings key to be forgotten. They are gone;
 * `_buildAbility()` walks the schema that ships beside each settings block
 * (`config/abilities/<id>.js`) and builds the same folders out of it. The six
 * shipped abilities produce a control set identical to the one the methods
 * produced — same folders, same order, same labels, same ranges — because the
 * schemas were lifted from those methods rather than re-derived.
 *
 * Four things make the panel survive a hundred entries:
 *
 *  - **Schools nest.** One top-level folder per school, ability folders inside
 *    it. Collapsed, the panel is fifteen rows plus the eight fixed sections.
 *  - **Ability folders are built on first open.** See below — this is the one
 *    change the roster's second half forced.
 *  - **Search.** Type in the box under the title and the whole tree filters to
 *    controllers whose label matches, opening the folders that hold them.
 *    Clearing it puts every folder back the way you left it.
 *  - **Jump.** `focusAbility(id)` opens the selected ability's folder and
 *    scrolls it into view; `App` calls it when the player changes slot and the
 *    ⤓ button in the header strip calls it again on demand. Scrolling past a
 *    hundred folders to find the one you are casting is not a UI.
 *
 * ## Why the ability folders are lazy
 *
 * They were not, and at fifty abilities that was defensible. Measured in
 * Chrome on an M-series laptop, against the real schemas:
 *
 * | | 50 abilities | 100 abilities |
 * | --- | --- | --- |
 * | `new Editor()` | 152 ms | **597 ms** |
 * | …including first layout | 386 ms | **683 ms** |
 * | controllers | 8,555 | 16,937 |
 * | DOM nodes | 54,292 | **107,472** |
 * | one keystroke in the search box | 11 ms | **48 ms** |
 *
 * Six hundred milliseconds is not a slow panel, it is a *stalled boot* — it
 * happens on the main thread while the loading bar is up and nothing else can
 * run — and a hundred thousand permanently-resident DOM nodes tax every style
 * recalculation the page ever does afterwards, including the HUD's. All of it
 * to build controls for ninety-nine abilities nobody has opened.
 *
 * So `_buildSchools()` now creates the *folders* — which is what you have to
 * see to navigate — and parks the descriptor in `_pending`. The controls are
 * built the first time the folder is opened, in the `onOpenClose` handler,
 * synchronously inside the click so lil-gui's open animation still measures
 * the right height. One ability costs about six milliseconds.
 *
 * The thing that nearly sank the idea is that **search has to see controls
 * that do not exist**. Typing `mist` and getting only the two abilities you
 * happen to have opened is worse than a slow panel; it is a lying one. The fix
 * is that the searchable text does not come from the controllers at all — it
 * comes from `Editor.plan()`, the same DOM-free function that decides what the
 * controllers *will be*, run once over every schema on the first keystroke
 * (18 ms for a hundred abilities) and cached. A query is matched against that
 * index, the abilities it names are built, and the ordinary DOM filter then
 * runs over a tree that now contains them.
 *
 * With a budget and a delay, because a one-character query names every ability
 * in the game and building all hundred to answer it would put back the exact
 * stall this removed — and because a 50 ms hitch between two characters of a
 * word is what "the panel is slow" actually means to the person typing. The
 * keystroke filters and lists; the building happens 140 ms after the typing
 * stops. See `SEARCH_BUILD_LIMIT`.
 */

/* ------------------------------------------------------------------ */
/* School marks                                                        */
/* ------------------------------------------------------------------ */
/**
 * One leading character per school.
 *
 * Not the sigils. `ui/glyphs/` holds 100×100 stroke SVGs and lil-gui writes its
 * folder titles with `textContent`, so markup is not on offer — the editor gets
 * a single glyph from the font instead, chosen to read at 11px on a dark
 * background and to be told apart from its neighbours at a glance.
 *
 * Frost and storm keep the marks their hand-written folders had (`❄`, `⚡`), and
 * arcane keeps Nova Beam's `✦`. Flame does not: `☄` is drawn as a hairline at
 * this size and all but disappears against the panel, so the school takes the
 * solid `✷` instead. The two zone abilities give up their own marks (`◈`, `❆`)
 * and inherit their school's, which is the point of grouping by school —
 * fifteen marks the eye can learn, not a hundred it cannot.
 *
 * The six later schools are all drawn from the BMP's geometric-shape and
 * mathematical blocks on purpose. The obvious candidates were the pictographs
 * — `⚒` for forge, `☀` for lumen, `⚙` for gearlock — and every one of them is
 * an emoji-presentation codepoint on macOS and Windows both: the browser
 * substitutes a colour emoji font, the glyph arrives at twice the line height
 * in full colour, and the folder title jumps a pixel. Monochrome outline
 * characters do not have that problem. Hive would obviously like `⬡`, which is
 * stone's `⬢` with the fill taken out and indistinguishable from it at 11px,
 * so it takes `※` — many marks read as one, which is the school.
 */
const SCHOOL_MARK = Object.freeze({
  frost: '❄',
  flame: '✷',
  storm: '⚡',
  stone: '⬢',
  verdant: '✿',
  void: '◍',
  arcane: '✦',
  blood: '✜',
  aether: '❂',
  tide: '≋', //  three waves
  forge: '▤', //  a brushed plate
  lumen: '☼', //  a sun that is not an emoji
  ink: '▮', //  the slab, and the stroke it makes
  chrono: '◷', //  a quarter gone
  hive: '※' //  many marks, one shape
});

/** A school with no mark still gets a bullet, so titles stay aligned. */
const DEFAULT_MARK = '◇';

/* ------------------------------------------------------------------ */
/* Inference tables                                                    */
/* ------------------------------------------------------------------ */

/** `#rrggbb`, the only colour spelling the settings tree uses. */
const HEX = /^#[0-9a-f]{6}$/i;

/** Key names that name a *quantity of things*, and therefore step by one. */
const COUNTED =
  /(count|facets|octaves|steps|strands|arms|spokes|ticks|dashes|shards|sparks|debris|embers|motes|rings|coils|tendrils|arcs|branches|cuts|craters|plates|segments|points|chunks)$/i;

/**
 * Key names that are a *measurement*, whatever their value happens to be.
 *
 * These veto the "a whole number of eight or more is a count" rule below. A
 * range of 18 metres and a lifetime of 12 seconds are both integers today and
 * neither wants a step of one — `range` in particular is the dial most likely
 * to be dragged, and a whole-metre track makes it useless.
 */
const CONTINUOUS =
  /(range|radius|height|width|length|size|scale|time|life|lifetime|delay|duration|speed|distance|intensity|opacity|gravity|angle|depth|curve|falloff|power)$/i;

/** Key names somebody will want to run backwards, so their track is symmetric. */
const SIGNED = /(speed|spin|crawl|twist|sag|lean|drift|wander|scroll|bias|flow|tilt|shear|sweep)$/i;

/**
 * How many unbuilt abilities one search is allowed to build, and how much of a
 * query has to be typed before it is allowed to build any.
 *
 * A search that matches four abilities should open into their controls, the
 * way it always has — that is the whole value of the box. A search that
 * matches ninety is a different question: three thousand visible controllers
 * is not a result, it is the panel again, and building them costs the
 * half-second the laziness was introduced to remove.
 *
 * Past the budget the matching abilities are still *listed* — their folders
 * show, closed, in the filtered tree — and clicking one builds it and drops
 * you into its matching controls. So a broad query degrades into "here are the
 * eleven abilities with a `mist` control", which is a reasonable answer to a
 * broad query, rather than into a stall.
 *
 * The minimum length exists because a two-character query is a prefix on the
 * way somewhere rather than a question, and the eight abilities `mi` names are
 * not the eight `mist` names — building for both is building sixteen to answer
 * one.
 *
 * The delay is why typing does not stutter at all. Building costs about six
 * milliseconds an ability, so a budget of eight is a ~50 ms hitch, and a hitch
 * in the middle of a word is exactly the thing people describe as "the panel
 * is slow". So the keystroke does the cheap half — filter what exists, list
 * what does not — and the expensive half runs once the typing stops. 140 ms is
 * comfortably longer than a fast typist's inter-key gap and short enough that
 * it reads as the panel settling rather than as a wait.
 */
const SEARCH_BUILD_LIMIT = 8;
const SEARCH_BUILD_MIN = 3;
const SEARCH_BUILD_DELAY = 140; //  ms of quiet before a search builds anything

/** ms after a folder is clicked before its animated height is released. */
const UNCLAMP_DELAY = 340; //  lil-gui's transition is 300 ms

/** Readable ceilings: one of these × a power of ten. */
const NICE = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

/** Readable steps. Coarser than the ceilings on purpose — 2.5 is not a step. */
const NICE_STEP = [1, 2, 5, 10];

/** Smallest of `list` × a power of ten that is ≥ `x`. `x` > 0. */
function niceUp(x, list) {
  const decade = 10 ** Math.floor(Math.log10(x));
  for (const n of list) {
    const candidate = n * decade;
    if (candidate >= x - 1e-12) return Number(candidate.toPrecision(6));
  }
  return Number((10 * decade).toPrecision(6));
}

export class Editor {
  /**
   * @param {object} hooks { onClear, onToast }
   */
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.presets = new PresetManager();

    this.gui = new GUI({ title: 'VFX Editor', width: 330 });
    this.gui.domElement.style.setProperty('--title-height', '30px');

    this._presetState = { name: 'My preset', selected: this.presets.names[0] ?? '' };

    /** school id → its top-level folder. */
    this.schoolFolders = new Map();
    /** ability id → { school, folder, ability }, the pair `focusAbility` opens. */
    this.abilityFolders = new Map();
    /** folder → the descriptor whose controls it has not built yet. */
    this._pending = new Map();
    /** the `.lil-title` element of each ability folder → that folder. */
    this._byTitle = new Map();
    /** ability id → every label under it, lower case. Built on first search. */
    this._searchIndex = null;
    /** Unbuilt ability folders the running query names but could not afford. */
    this._hits = new Set();
    /** Pending "the typing stopped, finish the search" timer. */
    this._settleTimer = 0;

    this._activeAbility = null;
    /** The `{ school, folder }` pair `focusAbility` last opened. */
    this._focused = null;
    /** Folder collapse state as it was before the current search. */
    this._preSearch = null;

    this._buildPresets();
    this._buildGlobal();
    this._buildAim();
    this._buildZone();
    this._buildSchools();
    this._buildEnvironment();
    this._buildPost();
    this._buildCamera();
    this._buildCharacter();
    this._buildTools();

    // Everything starts collapsed, top-level folders included. There are enough
    // controls here that any folder left open pushes the rest off the screen,
    // so the panel opens as a list of sections and the user picks one.
    this.gui.foldersRecursive().forEach((folder) => folder.close());
  }

  /* ------------------------------------------------------------------ */
  /* helpers                                                             */
  /* ------------------------------------------------------------------ */

  static range(folder, object, key, min, max, step, label) {
    return folder.add(object, key, min, max, step).name(label ?? key);
  }

  /**
   * Which clip the body throws when this ability fires.
   *
   * One per ability, because the gesture is part of how a spell reads — the
   * beam and the snare should not be cast the same way. `App` reads the value
   * at the moment of the cast, so switching it applies to the very next click.
   */
  static castAnimation(folder, object, label = 'cast animation') {
    return folder.add(object, 'castAnim', CAST_ANIMATIONS).name(label);
  }

  /**
   * The four colour stops of a particle system's lifetime gradient.
   *
   * `ParticleSystem#setGradient` samples them across a particle's own life, so
   * they are labelled by *when* they are seen rather than by what they are —
   * `A` is the instant it is born, `D` is the moment it dies.
   *
   * @param {string} prefix settings key without the A/B/C/D suffix
   */
  static gradient(folder, object, prefix, title) {
    const group = folder.addFolder(title);
    group.addColor(object, `${prefix}A`).name('birth');
    group.addColor(object, `${prefix}B`).name('early');
    group.addColor(object, `${prefix}C`).name('late');
    group.addColor(object, `${prefix}D`).name('death');
    return group;
  }

  refresh() {
    this.gui.controllersRecursive().forEach((controller) => controller.updateDisplay());
  }

  toggle() {
    this._hidden = !this._hidden;
    this.gui.show(!this._hidden);
  }

  /* ------------------------------------------------------------------ */
  /* the generic ability builder                                         */
  /* ------------------------------------------------------------------ */

  /**
   * A schema and a settings block, resolved into a flat build list.
   *
   * Pure, static and DOM-free on purpose: this is the one place that decides
   * *what controls an ability has*, so the headless harness (`npm run check`)
   * can ask the same question the panel asks without a WebGL context or a
   * `document`. `_buildAbility()` is then a switch over the answer.
   *
   * Each step is `{ folder, kind, key, label }` plus what its kind needs:
   *
   * | kind | extra | drawn as |
   * | --- | --- | --- |
   * | `range` | `min`, `max`, `step` | a slider |
   * | `color` | — | a picker |
   * | `gradient` | `prefix` | a sub-folder of four pickers |
   * | `castAnim` | — | the clip dropdown |
   * | `boolean` | — | a checkbox |
   * | `string` | — | a text field |
   * | `missing` | — | nothing; the schema names a key the block does not have |
   *
   * `folder` is the path as an array, so `'The fire trail/Silhouette'` arrives
   * as `['The fire trail', 'Silhouette']` and the builder does not parse
   * strings twice.
   *
   * `missing` steps are emitted rather than swallowed. A schema that has drifted
   * off its block is a real defect — it is how a control silently disappears —
   * and this is the seam a checker can grep for.
   *
   * @param {object} schema `config/abilities/<id>.js`'s `<id>Schema`, or undefined
   * @param {object} block  the live settings block
   * @returns {Array<object>} build steps, in build order
   */
  static plan(schema, settingsBlock) {
    // Both halves are allowed to be absent: a registry entry whose settings
    // module has not landed yet should give an empty folder, not take the whole
    // panel — and with it the boot — down with a TypeError.
    const block = settingsBlock ?? {};
    const steps = [];
    const seen = new Set();

    for (const [path, entries] of Object.entries(schema ?? {})) {
      const folder = path
        .split('/')
        .map((part) => part.trim())
        .filter(Boolean);
      for (const entry of entries) steps.push(Editor._step(folder, entry, block, seen));
    }

    // Anything the schema forgot. A block key that no folder mentions still gets
    // a control, filed at the bottom under "More", so the panel is never a *lie*
    // about what is in `settings[id]` — only untidy about it. An ability whose
    // schema has not been written yet renders entirely out of this branch, which
    // is what lets a registry entry land before its layout does.
    const more = [];
    for (const key of Object.keys(block)) {
      if (!seen.has(key)) more.push(Editor._step(['More'], key, block, seen));
    }

    return steps.concat(more);
  }

  /**
   * One schema entry → one build step. See `config/abilities/index.js` for the
   * entry forms; the shape is read by `length`, never by sniffing the value.
   */
  static _step(folder, entry, block, seen) {
    if (typeof entry === 'string') return Editor._infer(folder, entry, entry, block, seen);

    const [key] = entry;

    // `['colorMist*', 'Mist colour']` — the four lifetime stops as one entry.
    if (typeof key === 'string' && key.endsWith('*')) {
      const prefix = key.slice(0, -1);
      const stops = ['A', 'B', 'C', 'D'].map((suffix) => `${prefix}${suffix}`);
      // A quartet with a stop missing is not a gradient. The remaining stops are
      // deliberately *not* marked seen, so they fall through to "More" as plain
      // pickers rather than disappearing along with the group.
      if (stops.some((stop) => !(stop in block))) {
        return { folder, kind: 'missing', key, label: entry[1] ?? prefix };
      }
      for (const stop of stops) seen.add(stop);
      return { folder, kind: 'gradient', key, prefix, label: entry[1] ?? prefix };
    }

    // `['key', min, max, step]` / `['key', min, max, step, 'label']`, and the
    // three-element form for the rare dial that wants its own ends but not its
    // own precision.
    if (entry.length >= 3) {
      const [, min, max, step, label] = entry;
      seen.add(key);
      if (!(key in block)) return { folder, kind: 'missing', key, label: label ?? key };
      return {
        folder,
        kind: 'range',
        key,
        label: label ?? key,
        min,
        max,
        step: step ?? niceUp((max - min) / 400, NICE_STEP)
      };
    }

    // `['key', 'label']` — the type comes from the value.
    return Editor._infer(folder, key, entry[1] ?? key, block, seen);
  }

  /** A key with no authored range: the type from its value, the range guessed. */
  static _infer(folder, key, label, block, seen) {
    seen.add(key);
    if (!(key in block)) return { folder, kind: 'missing', key, label };

    const value = block[key];

    if (key === 'castAnim') return { folder, kind: 'castAnim', key, label };
    if (typeof value === 'boolean') return { folder, kind: 'boolean', key, label };
    if (typeof value === 'string') {
      return { folder, kind: HEX.test(value) ? 'color' : 'string', key, label };
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { folder, kind: 'missing', key, label };
    }
    return { folder, kind: 'range', key, label, ...Editor.inferRange(key, value) };
  }

  /**
   * A range for a key nobody wrote a tuple for.
   *
   * This is the fallback that makes a schema *incomplete* rather than *wrong*:
   * a slider added to a settings block during a tuning session appears in the
   * panel on the next reload without anyone touching the layout. It guesses
   * from two things and nothing else — the magnitude of the shipped value and
   * the shape of the key's name.
   *
   *  - **The ceiling is three times the shipped value**, rounded up to a
   *    readable number. Three because a control pinned to its own maximum can
   *    only ever come down, and ten would leave the interesting quarter of the
   *    track inside the first three millimetres.
   *  - **Counts step by one.** A key is a count when its name ends in one of
   *    the plural nouns this project actually uses (`…Count`, `…Facets`,
   *    `…Strands`, `…Shards`), or when the shipped value is a whole number of
   *    eight or more *and* the name is not a measurement — `range: 18` is
   *    eighteen metres, not eighteen of anything, and a whole-metre track on
   *    the most-dragged dial in the panel would be a poor joke.
   *  - **A negative default gets a negative track** — gravity is the whole
   *    reason — and a name ending in a signed word (`…Speed`, `…Spin`,
   *    `…Crawl`, `…Lean`) gets a symmetric one.
   *  - **A zero default carries no magnitude**, so it gets `0..1`. That is the
   *    case where the guess is worst, and the fix is a tuple in the schema.
   *
   * A guessed range is never as good as an authored one, and none of the six
   * shipped abilities uses it: all ~900 of their controls carry their own
   * min/max/step, arrived at by dragging rather than by rounding the default.
   * The first thing to do with a control that turns up in "More" is to give it
   * a folder and a tuple.
   *
   * @returns {{min:number, max:number, step:number}}
   */
  static inferRange(key, value) {
    const magnitude = Math.abs(value);
    const counted =
      Number.isInteger(value) && (COUNTED.test(key) || (magnitude >= 8 && !CONTINUOUS.test(key)));
    const ceiling = magnitude > 0 ? niceUp(magnitude * 3, NICE) : 1;

    const symmetric = SIGNED.test(key);
    const min = value < 0 ? -ceiling : symmetric ? -ceiling : 0;
    const max = value < 0 && !symmetric ? 0 : ceiling;

    const step = counted ? 1 : niceUp((max - min) / 400, NICE_STEP);
    return { min, max, step };
  }

  /**
   * Build one ability's folder from its schema.
   *
   * Folders are created on first mention and memoised by path, so the schema
   * can nest with a `/` in the key and the map underneath stays flat. A step
   * whose kind is `missing` draws nothing — the schema named a key the block no
   * longer has, and a controller bound to `undefined` is worse than a gap.
   */
  _buildAbility(root, ability) {
    const block = ability.settings ?? {};
    const plan = Editor.plan(ABILITY_SCHEMAS[ability.id], block);
    const folders = new Map([['', root]]);

    for (const step of plan) {
      if (step.kind === 'missing') continue;
      const folder = this._folderAt(root, folders, step.folder);

      switch (step.kind) {
        case 'range':
          Editor.range(folder, block, step.key, step.min, step.max, step.step, step.label);
          break;
        case 'color':
          folder.addColor(block, step.key).name(step.label);
          break;
        case 'gradient':
          Editor.gradient(folder, block, step.prefix, step.label);
          break;
        case 'castAnim':
          Editor.castAnimation(folder, block, step.label);
          break;
        default:
          // boolean and string: lil-gui picks the widget off the value's type.
          folder.add(block, step.key).name(step.label);
          break;
      }
    }

    return root;
  }

  /** `['The fire trail', 'Silhouette']` → the folder, creating what is missing. */
  _folderAt(root, folders, path) {
    let folder = root;
    let key = '';
    for (const name of path) {
      key = key ? `${key}/${name}` : name;
      let child = folders.get(key);
      if (!child) {
        child = folder.addFolder(name);
        folders.set(key, child);
      }
      folder = child;
    }
    return folder;
  }

  /**
   * One folder per school, in registry order, with its abilities inside it —
   * as empty folders, filled in on first open.
   *
   * The nesting is the whole reason the panel still works at a hundred: a
   * school folder collapses everything under it, so the default view is
   * fifteen rows and the count in each title says how much is behind it. A
   * school with no abilities yet does not appear at all; `abilitiesBySchool()`
   * drops it, and an empty folder is a row that promises something.
   */
  _buildSchools() {
    for (const { school, abilities } of abilitiesBySchool()) {
      const mark = SCHOOL_MARK[school.id] ?? DEFAULT_MARK;
      const folder = this.gui.addFolder(`${mark}  ${school.label}  ·  ${abilities.length}`);
      this.schoolFolders.set(school.id, folder);

      for (const ability of abilities) {
        const sub = folder.addFolder(`${mark}  ${ability.label}`);
        this._pending.set(sub, ability);
        this._byTitle.set(sub.$title, sub);
        this.abilityFolders.set(ability.id, { school: folder, folder: sub, ability });
      }
    }

    /*
     * Build on the way *into* lil-gui's own click handler, not after it.
     *
     * The obvious hook is `onOpenClose`, and it is wrong here by one frame.
     * lil-gui animates a folder open by scheduling a `requestAnimationFrame`
     * that measures `$children.scrollHeight` and transitions to it; children
     * that appear after that measurement are inside an element whose height
     * has already been decided, and the folder opens to nothing. (Worse: the
     * height ends up 0 → 0, no `transitionend` fires, and the inline
     * `height: 0px` never gets cleared, so the folder stays empty until it is
     * clicked twice.) It is a genuinely confusing failure — the controls exist
     * in the DOM, they are simply inside a box of zero height.
     *
     * A capture-phase listener on the panel root runs before any listener on
     * the title itself, so by the time lil-gui starts the animation the
     * controls are already there and it measures the real height. A listener
     * added to `$title` directly would not do: at the target element, handlers
     * run in registration order regardless of the capture flag, and lil-gui
     * registered first.
     */
    this.gui.domElement.addEventListener(
      'click',
      (event) => {
        const title = event.target?.closest?.('.lil-title');
        if (!title) return;
        const folder = this._byTitle.get(title);
        if (folder) this._realise(folder);
        this._unclamp(title.parentElement);
      },
      true
    );

    // And a fallback for the folders opened from code rather than from a
    // click — `open()` has no animation and no measurement, so late children
    // are fine there. `focusAbility` realises explicitly anyway; this is here
    // so that no future caller can find an empty folder.
    this.gui.onOpenClose((changed) => {
      if (!changed._closed) this._realise(changed);
    });
  }

  /**
   * Build an ability folder's controls, if they are not built already.
   *
   * @param {object} folder a lil-gui folder
   * @returns {boolean} whether anything was built
   */
  _realise(folder) {
    const ability = this._pending.get(folder);
    if (!ability) return false;

    // Deleted first: `_buildAbility` creates sub-folders, and a sub-folder is
    // created *open*, which re-enters this handler for the child. Without the
    // delete the child would look up its parent's descriptor and build the
    // whole ability a second time into itself.
    this._pending.delete(folder);
    this._byTitle.delete(folder.$title);
    this._buildAbility(folder, ability);

    // Filling a folder that is *already* open — the programmatic path — leaves
    // whatever height a previous animation pinned on it. Clearing the inline
    // height lets it size to the content that has just arrived.
    if (!folder._closed) {
      folder.$children.style.height = '';
      folder.domElement.classList.remove('lil-transition');
    }

    // Everything in this panel starts collapsed — see the constructor. The
    // folders that have just appeared were born open, so they are put back to
    // the state they would have been in had they existed at boot.
    for (const child of folder.foldersRecursive()) {
      child.close();
      // A search is running: these folders did not exist when the collapse
      // state was snapshotted, so record them or clearing the box leaves them
      // expanded behind the restored tree.
      if (this._preSearch) this._preSearch.push([child, true]);
    }

    return true;
  }

  /**
   * Undo lil-gui's open animation once it has had its chance.
   *
   * Not part of the lazy building — this is an older bug that a hundred
   * ability folders would have made everyone's problem. lil-gui opens a folder
   * by pinning an inline pixel height on its children and clearing that height
   * again on `transitionend`. Its measurement is taken one frame after the
   * click, and on a folder's *first* open in this panel it frequently comes
   * back as zero: the children are still `display: none` under
   * `.lil-closed:not(.lil-transition)` at the moment `clientHeight` is read.
   * A height of zero animating to zero fires no `transitionend`, so nothing
   * ever clears it, and the folder stays open and permanently clamped shut —
   * which is why "Presets" (nothing lazy about it) opens empty and needs a
   * second click. It is easy to blame that on whatever changed most recently.
   *
   * Clearing the inline height after the animation window costs nothing when
   * the animation worked, and unclamps the folder when it did not.
   *
   * @param {HTMLElement} element the folder's `.lil-gui` element
   */
  _unclamp(element) {
    setTimeout(() => {
      const children = element?.querySelector(':scope > .lil-children');
      if (!children) return;
      element.classList.remove('lil-transition');
      children.style.height = '';
    }, UNCLAMP_DELAY);
  }

  /**
   * Every control label an ability *will* have, without building any of them.
   *
   * `Editor.plan()` is the same function `_buildAbility()` walks, so the index
   * cannot disagree with the panel about what a control is called — which is
   * the failure that makes a lazy tree unsearchable. Built once, on the first
   * keystroke rather than at boot, because most sessions never search.
   *
   * @returns {Map<string, string>} ability id → its labels, newline-joined
   */
  _index() {
    if (this._searchIndex) return this._searchIndex;

    this._searchIndex = new Map();
    for (const [id, entry] of this.abilityFolders) {
      const words = new Set();
      for (const step of Editor.plan(ABILITY_SCHEMAS[id], entry.ability.settings ?? {})) {
        if (step.kind === 'missing') continue;
        words.add(String(step.label).toLowerCase());
        for (const part of step.folder) words.add(part.toLowerCase());
        // A gradient is one schema entry and four controllers, and the four are
        // named here rather than in the schema. Searching "death" has always
        // found every gradient's last stop; it still does.
        if (step.kind === 'gradient') {
          words.add('birth');
          words.add('early');
          words.add('late');
          words.add('death');
        }
      }
      this._searchIndex.set(id, [...words].join('\n'));
    }
    return this._searchIndex;
  }

  /* ------------------------------------------------------------------ */
  /* the header strip: search and jump                                   */
  /* ------------------------------------------------------------------ */

  /**
   * The two affordances that make a thousand controllers navigable.
   *
   * They live in a strip of our own between lil-gui's title bar and its
   * scrolling children, which is the only place in the panel that does not
   * scroll away. The jump button is *not* inside the title: lil-gui's title is
   * itself a `<button>`, a button inside a button is invalid, and the click
   * would collapse the panel on its way past.
   */
  _buildTools() {
    const bar = document.createElement('div');
    bar.className = 'editor-tools';

    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'editor-tools__search';
    search.placeholder = 'Search controls…';
    search.setAttribute('aria-label', 'Search controls');
    search.addEventListener('input', () => this._filter(search.value));
    search.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      search.value = '';
      this._filter('');
      search.blur();
    });

    const jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'editor-tools__jump';
    jump.textContent = '⤓';
    jump.title = 'Jump to the selected ability';
    jump.addEventListener('click', () => this.focusAbility(this._activeAbility));

    bar.append(search, jump);
    this.gui.domElement.insertBefore(bar, this.gui.$children);

    this._search = search;
    this._jump = jump;
  }

  /**
   * Filter the whole tree by controller label.
   *
   * Folder titles match too, and a matching folder shows *everything* inside
   * it: typing `mist` should give you the whole "Mist, chips & glitter" folder,
   * not the four controllers that happen to have the word in their own label,
   * and typing `frost lance` should give you the ability. That cascade is the
   * `inherited` flag below.
   *
   * The collapse state is snapshotted the moment a search begins and put back
   * the moment it ends, so filtering is a lens rather than an edit: whatever
   * you had open before you typed is what you get back when you clear the box.
   */
  _filter(query) {
    const needle = query.trim().toLowerCase();

    if (!needle) {
      this._restore();
      return;
    }

    if (!this._preSearch) {
      this._preSearch = this.gui.foldersRecursive().map((folder) => [folder, folder._closed]);
    }

    // The cheap half, on the keystroke: which unbuilt abilities the query
    // names, so the DOM pass can list their folders. Free once the index
    // exists — a `Map` lookup and a substring test per ability — and on the
    // very first keystroke the index does not exist yet, so unbuilt abilities
    // match on their title alone and the rest arrive with the settle below.
    this._hits.clear();
    for (const [id, entry] of this.abilityFolders) {
      if (!this._pending.has(entry.folder)) continue;
      if ((this._searchIndex?.get(id) ?? '').includes(needle)) this._hits.add(entry.folder);
    }

    this._filterFolder(this.gui, needle, false);
    this.gui.open();

    // The expensive half, once the typing stops.
    clearTimeout(this._settleTimer);
    if (needle.length >= SEARCH_BUILD_MIN) {
      this._settleTimer = setTimeout(() => this._settleSearch(needle), SEARCH_BUILD_DELAY);
    }
  }

  /**
   * Finish a search: build the index if this is the first one, build the
   * controls of the abilities the query names, and re-run the filter over the
   * tree that now contains them.
   *
   * Deliberately allowed to be slow. It runs on a timer after the last
   * keystroke, so the cost lands in a gap in the user's own typing rather than
   * between two of their characters, and `_filter` cancels it the moment
   * another key arrives.
   */
  _settleSearch(needle) {
    const index = this._index();

    // Registry order, so the same query always builds the same eight rather
    // than whichever the Map happened to yield first.
    let budget = SEARCH_BUILD_LIMIT;
    let built = 0;
    this._hits.clear();
    for (const [id, entry] of this.abilityFolders) {
      if (!this._pending.has(entry.folder)) continue;
      const named =
        String(entry.folder._title ?? '').toLowerCase().includes(needle) ||
        (index.get(id) ?? '').includes(needle);
      if (!named) continue;
      if (budget > 0) {
        budget--;
        if (this._realise(entry.folder)) built++;
      } else {
        this._hits.add(entry.folder);
      }
    }

    this._filterFolder(this.gui, needle, false);
    this.gui.open();
    return built;
  }

  /** @returns {boolean} whether anything under `folder` survived the filter. */
  _filterFolder(folder, needle, inherited) {
    const self =
      inherited || (folder !== this.gui && String(folder._title ?? '').toLowerCase().includes(needle));

    // An ability whose controls were not built has nothing to walk, and its
    // schema index has already answered for it. Shown, closed, as a row the
    // user can click into — never opened, because opening it here would build
    // it and put the budget back where it started.
    if (this._pending.has(folder)) return self || this._hits.has(folder);

    let hit = false;
    for (const controller of folder.controllers) {
      const show = self || String(controller._name ?? '').toLowerCase().includes(needle);
      controller.show(show);
      hit = hit || show;
    }

    for (const child of folder.folders) {
      const childHit = this._filterFolder(child, needle, self);
      child.show(childHit);
      if (childHit && !this._pending.has(child)) child.open();
      hit = hit || childHit;
    }

    return hit || self;
  }

  /** Undo a filter: everything visible again, every folder as it was. */
  _restore() {
    clearTimeout(this._settleTimer);
    this._hits.clear();
    this.gui.controllersRecursive().forEach((controller) => controller.show());
    this.gui.foldersRecursive().forEach((folder) => folder.show());

    if (this._preSearch) {
      for (const [folder, closed] of this._preSearch) folder.open(!closed);
      this._preSearch = null;
    }
  }

  /**
   * Open an ability's folder and put it under the user's eyes.
   *
   * `App` calls this when the player changes slot, so the panel follows the
   * spellbook instead of being scrolled to match it; the ⤓ button calls it
   * again for the ability already selected, which is what you want after you
   * have wandered off into Environment. Exactly one ability folder is left open
   * at a time — the previously focused pair is closed on the way — so the panel
   * does not silently grow a column of expanded schools behind you.
   *
   * @param {string} id ability id, as in the registry
   * @param {object} [options]
   * @param {boolean} [options.open=true]  open and scroll; `false` only records
   *   the selection, which is what boot-time slotting wants — the panel must
   *   still come up fully collapsed.
   * @param {boolean} [options.scroll=open] scroll the folder into view
   */
  focusAbility(id, { open = true, scroll = open } = {}) {
    const entry = id ? this.abilityFolders.get(id) : null;

    if (id && entry) {
      this._activeAbility = id;
      if (this._jump) this._jump.title = `Jump to ${this._jumpLabel(entry)}`;
    }
    if (!entry || !open) return;

    // A standing filter would leave the folder hidden behind the search, so the
    // jump wins: the box is cleared and the tree comes back first. The test is
    // the snapshot, not the box — `_filter()` can be driven from code as well as
    // from typing, and a jump landing on a folder that is still `hidden` is a
    // panel that has silently gone blank.
    if (this._preSearch) {
      if (this._search) this._search.value = '';
      this._restore();
    }

    const previous = this._focused;
    if (previous && previous !== entry) {
      previous.folder.close();
      if (previous.school !== entry.school) previous.school.close();
    }

    // Before the open rather than as a side effect of it: the folder is about
    // to be scrolled into view, and a folder that grows its contents after the
    // scroll has been computed lands with its title off the top of the panel.
    this._realise(entry.folder);
    entry.school.open();
    entry.folder.open();
    this.gui.open();
    this._focused = entry;

    if (scroll) entry.folder.domElement.scrollIntoView?.({ block: 'nearest' });
  }

  /** The ability's own title, minus the school mark, for the button tooltip. */
  _jumpLabel(entry) {
    return String(entry.folder._title ?? '').trim().replace(/^\S+\s+/, '');
  }

  /* ------------------------------------------------------------------ */
  /* folders                                                             */
  /* ------------------------------------------------------------------ */

  _buildPresets() {
    const folder = this.gui.addFolder('Presets');
    const state = this._presetState;

    let selector = folder
      .add(state, 'selected', this.presets.names.length ? this.presets.names : [''])
      .name('preset');

    // lil-gui rebuilds the controller when the option list changes, so the
    // reference has to be replaced rather than mutated.
    const refreshOptions = () => {
      const names = this.presets.names;
      selector = selector.options(names.length ? names : ['']).name('preset');
      selector.setValue(names.includes(state.selected) ? state.selected : (names[0] ?? ''));
    };

    folder.add(state, 'name').name('name');

    folder
      .add(
        {
          save: () => {
            this.presets.save(state.name);
            state.selected = state.name;
            refreshOptions();
            this.hooks.onToast?.(`Saved preset "${state.name}"`);
          }
        },
        'save'
      )
      .name('Save preset');

    folder
      .add(
        {
          load: () => {
            if (this.presets.load(state.selected)) {
              this.refresh();
              this.hooks.onToast?.(`Loaded "${state.selected}"`);
            }
          }
        },
        'load'
      )
      .name('Load preset');

    folder
      .add(
        {
          duplicate: () => {
            const copy = this.presets.duplicate(state.selected);
            if (copy) {
              state.selected = copy;
              refreshOptions();
              this.hooks.onToast?.(`Duplicated to "${copy}"`);
            }
          }
        },
        'duplicate'
      )
      .name('Duplicate');

    folder
      .add(
        {
          remove: () => {
            if (this.presets.remove(state.selected)) {
              refreshOptions();
              this.hooks.onToast?.('Preset deleted');
            }
          }
        },
        'remove'
      )
      .name('Delete');

    folder.add({ exportOne: () => this.presets.exportJSON() }, 'exportOne').name('Export current (JSON)');
    folder.add({ exportAll: () => this.presets.exportAll() }, 'exportAll').name('Export all presets');

    folder
      .add(
        {
          import: async () => {
            const result = await this.presets.importFromFile();
            refreshOptions();
            this.refresh();
            this.hooks.onToast?.(
              result.applied
                ? 'Settings imported'
                : result.imported.length
                  ? `Imported ${result.imported.length} preset(s)`
                  : 'Nothing imported'
            );
          }
        },
        'import'
      )
      .name('Import JSON…');

    folder
      .add(
        {
          reset: () => {
            this.presets.reset();
            this.refresh();
            this.hooks.onToast?.('Reset to defaults');
          }
        },
        'reset'
      )
      .name('Reset to defaults');

    this.presetFolder = folder;
  }

  _buildGlobal() {
    const folder = this.gui.addFolder('Global');
    const g = settings.global;
    const R = Editor.range;

    R(folder, g, 'timeScale', 0.02, 2, 0.01, 'time scale');
    R(folder, g, 'speed', 0.1, 4, 0.01, 'cast speed');
    R(folder, g, 'lifetime', 0.1, 4, 0.01, 'lifetime');
    R(folder, g, 'glow', 0, 5, 0.01, 'glow intensity');
    R(folder, g, 'shaderIntensity', 0, 2, 0.01, 'shader intensity');
    R(folder, g, 'opacity', 0, 2, 0.01, 'opacity');
    R(folder, g, 'noiseFrequency', 0.1, 4, 0.01, 'noise frequency');
    R(folder, g, 'noiseSpeed', 0, 4, 0.01, 'noise speed');
    R(folder, g, 'turbulence', 0, 4, 0.01, 'turbulence');
    R(folder, g, 'randomness', 0, 2, 0.01, 'randomness');
    R(folder, g, 'fresnel', 0, 3, 0.01, 'fresnel strength');
    R(folder, g, 'distortion', 0, 3, 0.01, 'heat distortion');

    const particles = folder.addFolder('Particles');
    R(particles, g, 'particleCount', 0, 3, 0.01, 'count');
    R(particles, g, 'particleLifetime', 0.1, 3, 0.01, 'lifetime');
    R(particles, g, 'particleSpeed', 0.1, 3, 0.01, 'speed');
    R(particles, g, 'particleSize', 0.1, 3, 0.01, 'size');
    R(particles, g, 'emissionRate', 0, 3, 0.01, 'emission rate');

    const lighting = folder.addFolder('Lighting & impact');
    R(lighting, g, 'lightIntensity', 0, 4, 0.01, 'light intensity');
    R(lighting, g, 'lightRadius', 0.1, 4, 0.01, 'light radius');
    R(lighting, g, 'explosionIntensity', 0, 3, 0.01, 'impact intensity');
    R(lighting, g, 'cameraShake', 0, 3, 0.01, 'camera shake');
    R(lighting, g, 'animationSpeed', 0, 3, 0.01, 'animation speed');

    this.globalFolder = folder;
  }

  /* ------------------------------------------------------------------ */

  _buildAim() {
    const folder = this.gui.addFolder('➤  Aim indicator');
    const a = settings.aim;
    const R = Editor.range;

    const shape = folder.addFolder('Silhouette (metres)');
    R(shape, a, 'shaftWidth', 0.05, 2, 0.01, 'shaft half-width');
    R(shape, a, 'headLength', 0.2, 8, 0.05, 'head length');
    R(shape, a, 'headWidth', 0.1, 5, 0.01, 'head half-width');
    R(shape, a, 'round', 0, 0.6, 0.01, 'corner rounding');
    R(shape, a, 'startOffset', 0, 5, 0.05, 'gap at the caster');
    R(shape, a, 'height', 0.005, 0.4, 0.005, 'hover height');

    const look = folder.addFolder('Rendering');
    R(look, a, 'edge', 0.01, 0.5, 0.005, 'outline thickness');
    R(look, a, 'edgeGlow', 0, 8, 0.05, 'outline glow');
    R(look, a, 'softness', 0.005, 0.5, 0.005, 'edge softness');
    R(look, a, 'fill', 0, 1.5, 0.01, 'interior fill');
    R(look, a, 'fillFalloff', 0.1, 4, 0.05, 'fill falloff');
    R(look, a, 'opacity', 0, 2, 0.01, 'opacity');
    look.addColor(a, 'colorCore').name('core colour');
    look.addColor(a, 'colorEdge').name('edge colour');
    look.addColor(a, 'colorInvalid').name('too-close colour');

    const energy = folder.addFolder('Energy & frost');
    R(energy, a, 'stripes', 0, 4, 0.01, 'chevrons / metre');
    R(energy, a, 'stripeSharp', 0, 1, 0.01, 'chevron sharpness');
    R(energy, a, 'stripeDepth', 0, 1, 0.01, 'chevron depth');
    R(energy, a, 'scrollSpeed', -10, 10, 0.05, 'scroll speed');
    R(energy, a, 'pulse', 0, 1, 0.01, 'pulse');
    R(energy, a, 'pulseSpeed', 0, 8, 0.05, 'pulse speed');
    R(energy, a, 'noise', 0, 1.5, 0.01, 'frost noise');
    R(energy, a, 'noiseScale', 0.1, 8, 0.05, 'noise scale');
    R(energy, a, 'noiseSpeed', 0, 3, 0.01, 'noise speed');
    R(energy, a, 'crystals', 0, 2, 0.01, 'frost plates');
    R(energy, a, 'crystalScale', 0.2, 10, 0.05, 'plate scale');

    const furniture = folder.addFolder('Rings & rosette');
    R(furniture, a, 'baseRing', 0, 3, 0.01, 'base ring radius');
    R(furniture, a, 'baseRingWidth', 0.005, 0.4, 0.005, 'base ring width');
    R(furniture, a, 'tipGlyph', 0, 2, 0.01, 'tip rosette');
    R(furniture, a, 'tipGlyphSize', 0.1, 4, 0.05, 'rosette radius');
    R(furniture, a, 'tipSpin', -3, 3, 0.01, 'rosette spin');
    R(furniture, a, 'rangeArc', 0, 2, 0.01, 'range arc');
    R(furniture, a, 'reveal', 0.01, 1, 0.005, 'sweep-out time');
  }

  /* ------------------------------------------------------------------ */

  /**
   * The far-cast indicator — the circle every zone ability is aimed with.
   *
   * Shared, like the arrow: it is a property of the *targeting*, not of any one
   * ability, so a second far cast inherits the whole thing and brings only its
   * own `zoneRadius`. The two controls worth reaching for first are `boundary`
   * (how thick the footprint edge reads) and `snap` (how hard it overshoots on
   * the way out), which between them decide whether the circle feels like a UI
   * overlay or like something the caster is doing.
   */
  _buildZone() {
    const folder = this.gui.addFolder('◎  Far-cast circle');
    const z = settings.zone;
    const R = Editor.range;

    const edge = folder.addFolder('The boundary (metres)');
    R(edge, z, 'boundary', 0.02, 2, 0.01, 'band thickness');
    R(edge, z, 'boundaryBias', 0, 1, 0.01, 'band bias out/in');
    R(edge, z, 'boundaryGlow', 0, 8, 0.05, 'band glow');
    R(edge, z, 'liner', 0.005, 0.4, 0.005, 'inner liner');
    R(edge, z, 'softness', 0.005, 0.4, 0.005, 'edge softness');
    R(edge, z, 'height', 0.005, 0.4, 0.005, 'hover height');

    const inside = folder.addFolder('The interior');
    R(inside, z, 'fill', 0, 1.5, 0.01, 'interior fill');
    R(inside, z, 'fillFalloff', 0.1, 5, 0.05, 'fill falloff');
    R(inside, z, 'rings', 0, 12, 0.1, 'contour rings');
    R(inside, z, 'ringWidth', 0.005, 0.5, 0.005, 'ring width');
    R(inside, z, 'ringSpeed', -4, 4, 0.01, 'ring speed');
    R(inside, z, 'crawl', 0, 3, 0.01, 'filaments');
    R(inside, z, 'crawlScale', 0.1, 8, 0.05, 'filaments / metre');
    R(inside, z, 'crawlSpeed', -4, 4, 0.01, 'filament crawl');
    R(inside, z, 'noise', 0, 1.5, 0.01, 'break-up');
    R(inside, z, 'noiseScale', 0.1, 8, 0.05, 'break-up scale');

    const furniture = folder.addFolder('Ticks, sweep & reticle');
    R(furniture, z, 'ticks', 0, 96, 1, 'boundary ticks');
    R(furniture, z, 'tickLength', 0.05, 3, 0.01, 'tick length');
    R(furniture, z, 'tickWidth', 0.02, 0.9, 0.01, 'tick duty');
    R(furniture, z, 'tickSpin', -2, 2, 0.005, 'tick spin');
    R(furniture, z, 'sweep', 0, 3, 0.01, 'radar sweep');
    R(furniture, z, 'sweepSpeed', -3, 3, 0.01, 'sweep speed');
    R(furniture, z, 'core', 0, 3, 0.01, 'centre mark');
    R(furniture, z, 'coreSize', 0.05, 3, 0.01, 'centre size');
    R(furniture, z, 'crosshair', 0, 3, 0.01, 'reticle arms');
    R(furniture, z, 'crosshairLength', 0.1, 6, 0.05, 'arm length');
    R(furniture, z, 'pulse', 0, 1, 0.01, 'pulse');
    R(furniture, z, 'pulseSpeed', 0, 8, 0.05, 'pulse speed');

    const reach = folder.addFolder('The reach ring');
    R(reach, z, 'reach', 0, 3, 0.01, 'reach brightness');
    R(reach, z, 'reachWidth', 0.005, 0.5, 0.005, 'reach width');
    R(reach, z, 'reachDashes', 0, 200, 1, 'dashes');
    R(reach, z, 'reachDashGap', 0, 0.95, 0.01, 'dash gap');
    R(reach, z, 'reachSpin', -1, 1, 0.005, 'dash creep');
    R(reach, z, 'reachLead', 0, 3, 0.01, 'lead marker');

    const look = folder.addFolder('Rendering');
    R(look, z, 'opacity', 0, 2, 0.01, 'opacity');
    R(look, z, 'reveal', 0.01, 1, 0.005, 'snap-out time');
    R(look, z, 'snap', 1, 2, 0.01, 'snap overshoot');
    look.addColor(z, 'colorCore').name('core colour');
    look.addColor(z, 'colorEdge').name('fill colour');
    look.addColor(z, 'colorInvalid').name('too-close colour');
  }

  /* ------------------------------------------------------------------ */

  _buildEnvironment() {
    const folder = this.gui.addFolder('Environment');
    const e = settings.environment;
    const R = Editor.range;

    R(folder, e, 'sunIntensity', 0, 8, 0.01, 'key intensity');
    folder.addColor(e, 'sunColor').name('key colour');
    R(folder, e, 'sunAzimuth', 0, Math.PI * 2, 0.01, 'key azimuth');
    R(folder, e, 'sunElevation', 0.05, 1.5, 0.01, 'key elevation');
    R(folder, e, 'ambientIntensity', 0, 3, 0.01, 'ambient');
    folder.addColor(e, 'ambientColor').name('ambient colour');
    R(folder, e, 'hemiIntensity', 0, 3, 0.01, 'hemisphere');
    R(folder, e, 'envIntensity', 0, 3, 0.01, 'env (IBL)');
    R(folder, e, 'shadowRadius', 0, 8, 0.05, 'shadow softness');
    R(folder, e, 'shadowBias', -0.01, 0.001, 0.0001, 'shadow bias');
    R(folder, e, 'contactShadow', 0, 1.5, 0.01, 'contact shadow');

    const rim = folder.addFolder('Rim light');
    R(rim, e, 'rimIntensity', 0, 4, 0.01, 'rim intensity');
    rim.addColor(e, 'rimColor').name('rim colour');
    R(rim, e, 'rimAzimuth', 0, Math.PI * 2, 0.01, 'rim azimuth');
    R(rim, e, 'rimElevation', 0.05, 1.5, 0.01, 'rim elevation');
    rim.addColor(e, 'hemiSkyColor').name('hemi sky');
    rim.addColor(e, 'hemiGroundColor').name('hemi bounce');

    const fog = folder.addFolder('Backdrop, fog & dust');
    fog.addColor(e, 'backgroundColor').name('backdrop');
    fog.add(e, 'fogEnabled').name('fog enabled');
    fog.addColor(e, 'fogColor').name('fog colour');
    // near = where the fog starts, far = where it is total; widening the gap or
    // pushing both out thins the fog, closing it thickens it.
    R(fog, e, 'fogNear', 1, 200, 1, 'fog near');
    R(fog, e, 'fogFar', 10, 400, 1, 'fog far');
    R(fog, e, 'dustAmount', 0, 3, 0.01, 'floating dust');

    const floor = folder.addFolder('Stage floor');
    floor.add(e, 'floorTexture').name('stone tile');
    R(floor, e, 'floorTextureScale', 0.5, 24, 0.1, 'tile size (m)');
    R(floor, e, 'floorNormalScale', 0, 3, 0.01, 'relief strength');
    R(floor, e, 'floorTexTint', 0, 1, 0.01, 'tint toward floor');
    floor.addColor(e, 'floorColor').name('floor colour');
    floor.addColor(e, 'floorTint').name('floor tint');
    R(floor, e, 'floorRoughness', 0.05, 1, 0.01, 'roughness');
    R(floor, e, 'floorSheen', 0, 1, 0.01, 'sheen');
    R(floor, e, 'floorPool', 0, 1, 0.01, 'light pool');
  }

  _buildPost() {
    const folder = this.gui.addFolder('Post processing');
    const p = settings.post;
    const R = Editor.range;

    folder.add(p, 'enabled').name('enabled');
    R(folder, p, 'exposure', 0.1, 3, 0.01, 'exposure');
    R(folder, p, 'bloomStrength', 0, 3, 0.01, 'bloom intensity');
    R(folder, p, 'bloomRadius', 0, 1.5, 0.01, 'bloom radius');
    R(folder, p, 'bloomThreshold', 0, 2, 0.01, 'bloom threshold');
    R(folder, p, 'contrast', 0.5, 2, 0.01, 'contrast');
    R(folder, p, 'saturation', 0, 2.5, 0.01, 'saturation');
    R(folder, p, 'temperature', -0.5, 0.5, 0.01, 'temperature');
    R(folder, p, 'lift', -0.2, 0.2, 0.005, 'lift');
    R(folder, p, 'gain', 0.5, 2, 0.01, 'gain');
    R(folder, p, 'vignette', 0, 1.5, 0.01, 'vignette');
    R(folder, p, 'chromaticAberration', 0, 3, 0.01, 'chromatic aberration');
    R(folder, p, 'grain', 0, 0.2, 0.001, 'film grain');
    // 0..2, not 0..0.2. The old range predates anything writing to the
    // refraction buffer and could not reach the shipping default of 1.0 — a
    // control pinned below its own value can only ever come down.
    R(folder, p, 'distortion', 0, 2, 0.005, 'screen warp');
    // Quality path for the refraction pass. Off costs nothing per frame; the
    // scale reallocates the offset buffer on the frame it changes and no other.
    folder.add(p, 'distortionEnabled').name('refraction pass');
    R(folder, p, 'distortionScale', 0.25, 1, 0.05, 'warp buffer scale');
    R(folder, p, 'flashStrength', 0, 2, 0.01, 'impact flash');
  }

  _buildCamera() {
    const folder = this.gui.addFolder('Camera');
    const c = settings.camera;
    const R = Editor.range;

    // The wheel writes `distance` straight into settings, so the slider listens.
    R(folder, c, 'distance', 1, 40, 0.1, 'distance').listen();
    R(folder, c, 'minDistance', 1, 20, 0.1, 'min distance');
    R(folder, c, 'maxDistance', 4, 40, 0.1, 'max distance');
    R(folder, c, 'zoomSpeed', 0.1, 3, 0.01, 'zoom speed');
    R(folder, c, 'fov', 20, 90, 0.5, 'field of view');
    R(folder, c, 'targetHeight', 0, 4, 0.01, 'target height');
    R(folder, c, 'minPolar', 0.05, 1.5, 0.01, 'min pitch');
    R(folder, c, 'maxPolar', 0.2, 1.55, 0.01, 'max pitch');
    R(folder, c, 'damping', 0.001, 0.5, 0.001, 'follow damping');
    R(folder, c, 'autoFrame', 0, 1, 0.01, 'auto framing');

    folder.add({ clear: () => this.hooks.onClear?.() }, 'clear').name('Clear effects (C)');
  }

  _buildCharacter() {
    const folder = this.gui.addFolder('Character');
    const c = settings.character;
    const R = Editor.range;

    // The mixer's own rate, so it scales the idle and the cast clips together.
    // The same value as Global → animation speed, mirrored here where it is
    // actually reached for; `listen` keeps the two readouts honest.
    R(folder, settings.global, 'animationSpeed', 0.1, 3, 0.01, 'playback rate').listen();

    // Which clip each ability throws lives in that ability's own folder, under
    // "The cast"; these are the edges of the blend that lays it over the idle.
    const cast = folder.addFolder('Casting');
    R(cast, c, 'castBlendIn', 0.01, 1, 0.01, 'blend into cast');
    R(cast, c, 'castBlendOut', 0.01, 1.5, 0.01, 'blend back to idle');
    cast.add(c, 'turnToAim').name('turn to aim');
    R(cast, c, 'turnRate', 0.000001, 0.02, 0.000001, 'turn follow');

    // The procedural accent that rides on top of the clip. Zero both leans to
    // let the animation carry the cast on its own.
    const lunge = folder.addFolder('Lunge');
    R(lunge, c, 'castLean', 0, 1.2, 0.01, 'lunge lean');
    R(lunge, c, 'castRecoil', 0, 0.8, 0.005, 'lunge recoil');
    R(lunge, c, 'castSettle', 0.2, 8, 0.05, 'lunge settle');
  }

  dispose() {
    clearTimeout(this._settleTimer);
    this.gui.destroy();
  }
}
