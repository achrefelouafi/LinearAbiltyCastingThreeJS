/**
 * config/abilities/index.js — the two maps that stop anything enumerating
 * fifty imports twice.
 *
 * Every ability owns one module in this directory holding exactly two exports:
 * its settings block (`<id>`) and its editor layout (`<id>Schema`). This file
 * imports each module once and re-publishes them as `ABILITY_SETTINGS` (id →
 * block) and `ABILITY_SCHEMAS` (id → schema). `config/settings.js` spreads the
 * first into the live tree; `abilities/registry.js` hangs the block off each
 * descriptor; the editor walks the second.
 *
 * These imports are **eager and must stay eager**. Fifty ability *classes* are
 * lazy — nothing constructs a mesh until a slot is selected — but the settings
 * tree has to be complete at module load, because the editor, the preset
 * system and the aim controller all need to see every block up front, and
 * `structuredClone(settings)` for `DEFAULT_SETTINGS` runs once at boot. Fifty
 * modules of plain numbers and `#rrggbb` strings cost nothing; a settings
 * module that imports anything beyond a constant is the mistake to avoid.
 *
 * Adding an ability: one import line, one entry in each map. Keep both maps in
 * the same order as `ABILITIES` in the registry, so a diff reads straight.
 */

import { ice, iceSchema } from './ice.js';
import { thunder, thunderSchema } from './thunder.js';
import { meteor, meteorSchema } from './meteor.js';
import { beam, beamSchema } from './beam.js';
import { snare, snareSchema } from './snare.js';
import { glacier, glacierSchema } from './glacier.js';

/* ------------------------------------------------------------------ */
/* APPEND NEW IMPORTS BELOW THIS LINE                                  */
import { geyser, geyserSchema } from './geyser.js';
import { pistondrive, pistondriveSchema } from './pistondrive.js';
import { astralgate, astralgateSchema } from './astralgate.js';
import { entropy, entropySchema } from './entropy.js';
import { undertow, undertowSchema } from './undertow.js';
import { bonecage, bonecageSchema } from './bonecage.js';
import { rewind, rewindSchema } from './rewind.js';
import { torrent, torrentSchema } from './torrent.js';
import { broodburst, broodburstSchema } from './broodburst.js';
import { obsidian, obsidianSchema } from './obsidian.js';
import { waspfunnel, waspfunnelSchema } from './waspfunnel.js';
import { silence, silenceSchema } from './silence.js';
import { shrapnel, shrapnelSchema } from './shrapnel.js';
import { afterimage, afterimageSchema } from './afterimage.js';
import { refractcascade, refractcascadeSchema } from './refractcascade.js';
import { photonlattice, photonlatticeSchema } from './photonlattice.js';
import { featherfall, featherfallSchema } from './featherfall.js';
import { splatterbrand, splatterbrandSchema } from './splatterbrand.js';
import { sealscript, sealscriptSchema } from './sealscript.js';
import { hourglass, hourglassSchema } from './hourglass.js';
import { brinelock, brinelockSchema } from './brinelock.js';
import { blackice, blackiceSchema } from './blackice.js';
import { sawline, sawlineSchema } from './sawline.js';
import { spellbreak, spellbreakSchema } from './spellbreak.js';
import { firewalk, firewalkSchema } from './firewalk.js';
import { wildfire, wildfireSchema } from './wildfire.js';
import { scrollward, scrollwardSchema } from './scrollward.js';
import { bubblecage, bubblecageSchema } from './bubblecage.js';
import { carapace, carapaceSchema } from './carapace.js';
import { stasisfield, stasisfieldSchema } from './stasisfield.js';
import { unmake, unmakeSchema } from './unmake.js';
import { gearlock, gearlockSchema } from './gearlock.js';
import { quench, quenchSchema } from './quench.js';
import { anvilfall, anvilfallSchema } from './anvilfall.js';
import { solarlens, solarlensSchema } from './solarlens.js';
import { tiderush, tiderushSchema } from './tiderush.js';
import { locusttide, locusttideSchema } from './locusttide.js';
import { mycelium, myceliumSchema } from './mycelium.js';
import { godspear, godspearSchema } from './godspear.js';
import { mirage, mirageSchema } from './mirage.js';
import { origami, origamiSchema } from './origami.js';
import { sheetlightning, sheetlightningSchema } from './sheetlightning.js';
import { echostep, echostepSchema } from './echostep.js';
import { hivecolumn, hivecolumnSchema } from './hivecolumn.js';
import { dawnbreak, dawnbreakSchema } from './dawnbreak.js';
import { eclipse, eclipseSchema } from './eclipse.js';
import { inkbloom, inkbloomSchema } from './inkbloom.js';
import { avalanche, avalancheSchema } from './avalanche.js';
import { sumistroke, sumistrokeSchema } from './sumistroke.js';
import { webline, weblineSchema } from './webline.js';
import { shatterlance, shatterlanceSchema } from './shatterlance.js';
import { soulchain, soulchainSchema } from './soulchain.js';
import { skyfracture, skyfractureSchema } from './skyfracture.js';
import { sanguinepact, sanguinepactSchema } from './sanguinepact.js';
import { magma, magmaSchema } from './magma.js';
import { hemolance, hemolanceSchema } from './hemolance.js';
import { umbralspears, umbralspearsSchema } from './umbralspears.js';
import { nightfall, nightfallSchema } from './nightfall.js';
import { dragonbreath, dragonbreathSchema } from './dragonbreath.js';
import { grovecall, grovecallSchema } from './grovecall.js';
import { runeseal, runesealSchema } from './runeseal.js';
import { glyphstorm, glyphstormSchema } from './glyphstorm.js';
import { vinelash, vinelashSchema } from './vinelash.js';
import { bloomburst, bloomburstSchema } from './bloomburst.js';
import { stonespine, stonespineSchema } from './stonespine.js';
import { sinkhole, sinkholeSchema } from './sinkhole.js';
import { sporefall, sporefallSchema } from './sporefall.js';
/* ------------------------------------------------------------------ */
import { tectonic, tectonicSchema } from './tectonic.js';
import { boulder, boulderSchema } from './boulder.js';
import { rime, rimeSchema } from './rime.js';
import { singularity, singularitySchema } from './singularity.js';
import { cyclone, cycloneSchema } from './cyclone.js';
import { resonance, resonanceSchema } from './resonance.js';
import { petrify, petrifySchema } from './petrify.js';

import { prismlance, prismlanceSchema } from './prismlance.js';
import { arcanevolley, arcanevolleySchema } from './arcanevolley.js';
import { plaguebloom, plaguebloomSchema } from './plaguebloom.js';
import { aurora, auroraSchema } from './aurora.js';

import { starfall, starfallSchema } from './starfall.js';

import { chronofracture, chronofractureSchema } from './chronofracture.js';
import { voidrift, voidriftSchema } from './voidrift.js';
import { hail, hailSchema } from './hail.js';
import { sunspear, sunspearSchema } from './sunspear.js';
import { crimsontide, crimsontideSchema } from './crimsontide.js';
import { thornwake, thornwakeSchema } from './thornwake.js';
import { firewhip, firewhipSchema } from './firewhip.js';
import { railcoil, railcoilSchema } from './railcoil.js';
import { thunderclap, thunderclapSchema } from './thunderclap.js';
import { stormwall, stormwallSchema } from './stormwall.js';
import { pyroclasm, pyroclasmSchema } from './pyroclasm.js';
import { slipstream, slipstreamSchema } from './slipstream.js';
import { emberflock, emberflockSchema } from './emberflock.js';
import { chainarc, chainarcSchema } from './chainarc.js';
import { balllightning, balllightningSchema } from './balllightning.js';

/**
 * id → the live settings block.
 *
 * These are the *same objects* `settings.<id>` exposes — `settings.js` spreads
 * this map rather than copying it, so a controller bound through the registry
 * and a controller bound through `settings` mutate one object. That identity is
 * the whole reason the editor works on a standing effect.
 */
export const ABILITY_SETTINGS = {
  /* --- APPEND NEW BLOCKS BELOW THIS LINE --- */
  geyser,
  pistondrive,
  astralgate,
  entropy,
  undertow,
  bonecage,
  torrent,
  rewind,
  broodburst,
  obsidian,
  waspfunnel,
  silence,
  shrapnel,
  afterimage,
  refractcascade,
  photonlattice,
  featherfall,
  splatterbrand,
  sealscript,
  hourglass,
  brinelock,
  blackice,
  sawline,
  spellbreak,
  firewalk,
  wildfire,
  scrollward,
  bubblecage,
  carapace,
  stasisfield,
  unmake,
  gearlock,
  quench,
  anvilfall,
  solarlens,
  tiderush,
  mycelium,
  locusttide,
  mirage,
  godspear,
  origami,
  sheetlightning,
  echostep,
  hivecolumn,
  avalanche,
  dawnbreak,
  eclipse,
  inkbloom,
  sumistroke,
  webline,
  shatterlance,
  soulchain,
  skyfracture,
  sanguinepact,
  magma,
  hemolance,
  umbralspears,
  nightfall,
  dragonbreath,
  grovecall,
  runeseal,
  glyphstorm,
  vinelash,
  bloomburst,
  sporefall,
  tectonic,
  boulder,
  stonespine,
  sinkhole,
  rime,
  singularity,
  petrify,
  cyclone,
  resonance,
  prismlance,
  arcanevolley,
  plaguebloom,
  aurora,
  starfall,
  chronofracture,
  voidrift,
  hail,
  sunspear,
  crimsontide,
  thornwake,
  firewhip,
  railcoil,
  thunderclap,
  stormwall,
  pyroclasm,
  slipstream,
  emberflock,
  chainarc,
  balllightning,
  ice,
  thunder,
  meteor,
  beam,
  snare,
  glacier
};

/**
 * id → the editor layout.
 *
 * ### Schema format
 *
 * A schema is a plain object of `'Folder name': [entries]`. Key order is the
 * order the folders are built in; JS preserves insertion order for string keys,
 * so the layout is the source order and needs no `order:` field.
 *
 * A **nested folder** is declared with a slash in the name — `'The fire
 * trail/Silhouette'` becomes a sub-folder of `'The fire trail'`. The schema
 * stays a flat map, which keeps it greppable.
 *
 * An **entry** is one of:
 *
 * | form | means |
 * | --- | --- |
 * | `'key'` | bare key; the builder infers a range from the default and the key name |
 * | `['key', 'label']` | a control whose *type* comes from its value — a `#rrggbb` string gets a colour picker, a boolean a checkbox, `castAnim` the clip dropdown — with an authored label |
 * | `['key', min, max, step]` | a slider labelled with its own key |
 * | `['key', min, max, step, 'label']` | a slider, fully authored |
 * | `['prefix*', 'Title']` | a **gradient group**: the trailing `*` expands to `prefixA/B/C/D` in a sub-folder called `Title`, labelled birth / early / late / death |
 *
 * The two-element form is distinguished from the four/five-element one by
 * length, and never by guessing at the value.
 *
 * A schema is never *wrong*, only incomplete: any key in the block that no
 * folder mentions still gets a control, in a trailing "More" folder. That is
 * deliberate — a new slider added to a block during a tuning session appears in
 * the panel immediately, and gets filed properly later.
 *
 * The ranges in these schemas were tuned by dragging, not by rounding the
 * default. Several of them sit deliberately well above the shipped value
 * (`beam.coilGlow` ships at 8 with a maximum of 14) because a control pinned to
 * its own maximum can only ever come down.
 */
export const ABILITY_SCHEMAS = {
  /* --- APPEND NEW SCHEMAS BELOW THIS LINE --- */
  geyser: geyserSchema,
  pistondrive: pistondriveSchema,
  astralgate: astralgateSchema,
  entropy: entropySchema,
  undertow: undertowSchema,
  bonecage: bonecageSchema,
  rewind: rewindSchema,
  torrent: torrentSchema,
  broodburst: broodburstSchema,
  obsidian: obsidianSchema,
  waspfunnel: waspfunnelSchema,
  silence: silenceSchema,
  shrapnel: shrapnelSchema,
  afterimage: afterimageSchema,
  refractcascade: refractcascadeSchema,
  featherfall: featherfallSchema,
  photonlattice: photonlatticeSchema,
  splatterbrand: splatterbrandSchema,
  sealscript: sealscriptSchema,
  hourglass: hourglassSchema,
  brinelock: brinelockSchema,
  blackice: blackiceSchema,
  spellbreak: spellbreakSchema,
  sawline: sawlineSchema,
  firewalk: firewalkSchema,
  wildfire: wildfireSchema,
  scrollward: scrollwardSchema,
  bubblecage: bubblecageSchema,
  carapace: carapaceSchema,
  stasisfield: stasisfieldSchema,
  gearlock: gearlockSchema,
  quench: quenchSchema,
  unmake: unmakeSchema,
  anvilfall: anvilfallSchema,
  solarlens: solarlensSchema,
  tiderush: tiderushSchema,
  locusttide: locusttideSchema,
  mycelium: myceliumSchema,
  godspear: godspearSchema,
  mirage: mirageSchema,
  origami: origamiSchema,
  sheetlightning: sheetlightningSchema,
  echostep: echostepSchema,
  avalanche: avalancheSchema,
  hivecolumn: hivecolumnSchema,
  inkbloom: inkbloomSchema,
  dawnbreak: dawnbreakSchema,
  eclipse: eclipseSchema,
  sumistroke: sumistrokeSchema,
  webline: weblineSchema,
  shatterlance: shatterlanceSchema,
  soulchain: soulchainSchema,
  skyfracture: skyfractureSchema,
  sanguinepact: sanguinepactSchema,
  magma: magmaSchema,
  hemolance: hemolanceSchema,
  umbralspears: umbralspearsSchema,
  nightfall: nightfallSchema,
  dragonbreath: dragonbreathSchema,
  grovecall: grovecallSchema,
  runeseal: runesealSchema,
  glyphstorm: glyphstormSchema,
  vinelash: vinelashSchema,
  bloomburst: bloomburstSchema,
  sporefall: sporefallSchema,
  tectonic: tectonicSchema,
  boulder: boulderSchema,
  stonespine: stonespineSchema,
  sinkhole: sinkholeSchema,
  rime: rimeSchema,
  singularity: singularitySchema,
  petrify: petrifySchema,
  cyclone: cycloneSchema,
  resonance: resonanceSchema,
  prismlance: prismlanceSchema,
  arcanevolley: arcanevolleySchema,
  plaguebloom: plaguebloomSchema,
  aurora: auroraSchema,
  chronofracture: chronofractureSchema,
  starfall: starfallSchema,
  voidrift: voidriftSchema,
  hail: hailSchema,
  sunspear: sunspearSchema,
  crimsontide: crimsontideSchema,
  thornwake: thornwakeSchema,
  firewhip: firewhipSchema,
  railcoil: railcoilSchema,
  thunderclap: thunderclapSchema,
  stormwall: stormwallSchema,
  pyroclasm: pyroclasmSchema,
  slipstream: slipstreamSchema,
  emberflock: emberflockSchema,
  chainarc: chainarcSchema,
  balllightning: balllightningSchema,
  ice: iceSchema,
  thunder: thunderSchema,
  meteor: meteorSchema,
  beam: beamSchema,
  snare: snareSchema,
  glacier: glacierSchema
};
