/* ================================================================== */
/* SINKHOLE — the ground goes down                                     */
/* ================================================================== */
/**
 * Everything else in the sandbox comes *up* out of the floor or sits *on* it.
 * This one takes the floor away.
 *
 * The hole is a real displaced surface — a radial mesh whose vertex shader
 * places every vertex in metres off a funnel profile and hands the fragment
 * stage a normal computed from that same profile by finite difference. That is
 * not a detail: a flat quad with a painted gradient survives exactly one camera
 * orbit before it reads as a sticker, and this ability has nothing else to sell.
 * `depth` and `wallCurve` between them are the whole silhouette — `wallCurve`
 * near 1 gives a shallow crater, near 3 a bell-mouthed shaft — and both of them
 * reshape a hole that has already finished opening.
 *
 * The floor of the hole is **never drawn**. The mesh converges on a single
 * vertex at the throat and the last half-metre of it is `colorVoid`, so there
 * is no surface down there to read a distance off and the eye gives up. The
 * calving chunks are never seen to land for the same reason: they fall to a
 * point well below the throat and the near wall eats them on the way.
 *
 * Four beats: the fractures spread over `crackTime`, the floor lets go over
 * `dropTime`, the dust blows out over the rim, and then `lifetime` seconds of
 * settle in which pebbles are still trickling in.
 */
export const sinkhole = {
  /* --- the cast --- */
  range: 24.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 95.0, // how fast the cast reaches the circle, metres/second
  zoneRadius: 5.0, // the rim of the hole, metres — drives everything below
  cooldown: 1.8, // seconds before the slot re-arms
  castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws
  crackTime: 0.4, // seconds the fractures spread before the floor lets go
  dropTime: 0.55, // seconds the floor takes to fall
  lifetime: 3.4, // seconds of settle after it has fallen
  sinkTime: 1.8, // seconds the hole takes to give the floor back

  /* --- the funnel (metres unless noted) --- */
  depth: 6.5, // floor to throat
  wallCurve: 2.4, // >1 steepens the throat and flares the mouth
  apron: 1.45, // how far past the rim the mesh reaches, × zoneRadius
  apronFade: 1.08, // where its alpha starts feathering out, × zoneRadius
  lip: 0.3, // spoil heaped just outside the rim
  rough: 0.75, // 0..1 grain on the walls, × depth
  roughScale: 1.1, // grain features per metre
  strata: 0.5, // 0..1 horizontal bedding banding down the walls
  strataScale: 1.4, // bands per metre
  throat: 0.16, // 0..1 of the radius the blackout at the bottom covers
  calve: 1.0, // 0..1 how far the lip wedges break inward
  calveCells: 14, // wedges the rim breaks into
  calveDrop: 0.95, // metres a calved wedge drops
  spokes: 56, // mesh resolution around (rebuilds nothing; fixed at boot)
  rings: 36, // mesh resolution outward

  /* --- how the hole is shaded --- */
  colorGround: '#4a4239', // the intact floor colour at the very rim
  colorWall: '#332c25', // the exposed wall
  colorDeep: '#221e19', // where the walls run out of light
  colorVoid: '#0a0908', // the throat, which is nothing at all
  colorLip: '#8a7d6a', // the broken lip and the specular catch
  ambient: 0.28, // floor on the diffuse term
  wrap: 0.42, // 0..1 wraps the terminator round the back of a wall
  specular: 0.25,
  gloss: 18.0, // Blinn exponent
  depthTint: 1.4, // how fast the walls run to `colorDeep` with depth
  grit: 0.5, // scree speckle on the walls
  gritScale: 9.0, // speckle features per metre
  rimLight: 0.6, // how hard the broken lip catches the key light
  opacity: 1.0,

  /* --- the cracked apron beyond the rim (GroundField, FUNNEL) --- */
  // The library's FUNNEL mode is a *flat* mark and stays outside the hole,
  // where flat is the truth: fracture lines and spoil on ground that has not
  // fallen yet. See the class comment for why it is not used for the pit.
  fieldEdge: 0.5, // metres of feather on the growth front
  fieldRagged: 0.34, // how far that front wanders, fraction of the radius
  fieldRaggedScale: 0.65, // lobes per metre
  fieldWarp: 0.6, // metres of domain warp on those lobes
  fieldRelief: 0.7, // how hard its height field tilts the fake normal
  fieldCell: 0.85, // metres — the size of a calved block
  fieldCellJitter: 0.9, // 0..1
  fieldSeam: 0.06, // metres — the fracture line between blocks
  fieldThickness: 0.12, // metres a block tips by
  fieldLift: 0.16, // metres of spoil slumped over the rim
  fieldDepth: 0.5, // metres of apparent dip on the flat mark
  fieldSharp: 0.6, // 0..1 profile sharpness
  fieldDetail: 0.7, // 0..1 grain
  fieldParallax: 0.3, // metres of view-driven offset on interior detail
  fieldOpacity: 0.95,
  colorFieldBase: '#3f382f',
  colorFieldEdge: '#8a7d6a',
  colorFieldGlow: '#6b5f4c',
  colorFieldDeep: '#12100d',

  /* --- the chunks that calve in and are never seen to land --- */
  debrisCount: 26, // live chunks, capped at 48
  debrisRadius: 0.32, // metres
  debrisSizeJitter: 0.55, // ± fraction
  debrisSpin: 5.0, // tumble, radians/second
  debrisFlash: 0.1, // seconds the birth flash decays over
  debrisBack: 0.0, // metres the launch point sits behind the hole centre
  debrisSpread: 1.05, // launch scatter, × zoneRadius
  debrisLaunchHeight: 0.3, // metres above the floor a chunk lets go at
  debrisSinkSpread: 0.42, // where they converge to, × zoneRadius
  debrisSinkDepth: 7.5, // metres below the floor they fall toward
  debrisPathCurve: 1.85, // >1 accelerates — this is the gravity
  debrisFlightTime: 1.1, // seconds one chunk is falling
  debrisSpeedJitter: 0.35, // ± fraction
  debrisLead: 0.05, // seconds before the first chunk goes
  debrisWindow: 1.9, // seconds the calving is spread over
  debrisFillBias: -1.0, // -1 calves inward from the rim, +1 outward from the middle
  debrisFillScatter: 0.55, // 0 pure radial order, 1 pure spatial hash
  debrisHashCell: 1.2, // metres — the lattice the calving order is hashed on
  colorDebris: '#3a332b', // one picker; the chunks are lit by the scene
  debrisRoughness: 0.95,

  /* --- the dust that blows out over the rim --- */
  dustRate: 90, // the slow updraft during the settle, particles/second
  dustSize: 1.2,
  dustSpeed: 1.2,
  dustLifetime: 2.8,
  dustOpacity: 0.36,
  dustRise: 0.5, // upward drift, metres/second
  dustTurbulence: 0.6,
  blastDust: 150, // the ring thrown outward the moment the floor lets go
  blastSpeed: 7.5, // metres/second that ring travels at
  blastLift: 0.35, // 0..1 of that speed aimed upward rather than outward
  colorDustA: '#9b9184',
  colorDustB: '#736a5e',
  colorDustC: '#453f37',
  colorDustD: '#1e1b17',

  /* --- pebbles still trickling in --- */
  pebbleRate: 55, // particles/second during the settle
  pebbleSize: 0.05,
  pebbleSpeed: 1.4,
  pebbleLifetime: 0.9, // short: they must die before they reach a bottom
  pebbleGravity: -14.0,
  pebbleBand: 0.22, // 0..1 of the radius inside the rim they let go from
  colorPebbleA: '#6b6357',
  colorPebbleB: '#453f37',
  colorPebbleC: '#282420',
  colorPebbleD: '#141210',

  /* --- the moment it lets go --- */
  burstSize: 3.4, // dust ball over the rim, metres
  burstIntensity: 1.0,
  shockRadius: 7.0, // the ring that snaps out across the floor, metres
  impactShake: 1.15,
  shakeDuration: 0.9,
  settleShake: 0.05, // continuous rumble through the settle
  rumble: 0.04, // ... and while the cast is still reaching the circle
  impactFlash: 0.05, // barely anything; a hole does not flash
  colorBurstA: '#8a7d6a',
  colorBurstB: '#544c40',
  colorBurstC: '#221e19',
  colorShockA: '#8a7d6a',
  colorShockB: '#c8bca6',
  colorFlash: '#6b5f4c',

  /* --- dynamic light --- */
  lightIntensity: 5.5,
  lightRadius: 11.0,
  lightColor: '#a08a68'
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Sinkhole.
 *
 * "The funnel" is the folder that matters. `depth` and `wallCurve` are the
 * silhouette; `calve`, `calveCells` and `calveDrop` are what stops the rim
 * being a circle; `throat` is how much of the bottom is simply not there. All
 * of them re-shape a hole that is already standing, paused included, because
 * every one of them is a uniform the vertex shader reads on the frame it draws.
 */
export const sinkholeSchema = {
  'The cast': [
    ['range', 3, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 10, 400, 1, 'reach speed'],
    ['zoneRadius', 1, 16, 0.05, 'hole radius'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation'],
    ['crackTime', 0.02, 3, 0.01, 'cracking time'],
    ['dropTime', 0.05, 3, 0.01, 'drop time'],
    ['lifetime', 0.2, 12, 0.05, 'settle time'],
    ['sinkTime', 0.1, 6, 0.05, 'close-over time']
  ],
  'The funnel': [
    ['depth', 0.5, 20, 0.05, 'depth'],
    ['wallCurve', 0.4, 5, 0.01, 'wall profile'],
    ['apron', 1.0, 2.5, 0.01, 'mesh reach × radius'],
    ['apronFade', 0.9, 2.4, 0.01, 'alpha fade × radius'],
    ['lip', 0, 1.5, 0.01, 'spoil at the rim'],
    ['rough', 0, 3, 0.01, 'wall grain'],
    ['roughScale', 0.1, 6, 0.01, 'grain / metre'],
    ['strata', 0, 1, 0.01, 'bedding bands'],
    ['strataScale', 0.1, 6, 0.01, 'bands / metre'],
    ['throat', 0.01, 0.6, 0.005, 'blackout radius'],
    ['calve', 0, 1, 0.01, 'lip calving'],
    ['calveCells', 3, 40, 1, 'lip wedges'],
    ['calveDrop', 0, 4, 0.01, 'wedge drop'],
    ['spokes', 12, 96, 1, 'mesh spokes'],
    ['rings', 8, 64, 1, 'mesh rings']
  ],
  'How the hole is shaded': [
    ['colorGround', 'floor at the rim'],
    ['colorWall', 'exposed wall'],
    ['colorDeep', 'deep wall'],
    ['colorVoid', 'the throat'],
    ['colorLip', 'broken lip'],
    ['ambient', 0, 1, 0.01, 'ambient floor'],
    ['wrap', 0, 1, 0.01, 'terminator wrap'],
    ['specular', 0, 2, 0.01, 'specular'],
    ['gloss', 1, 80, 0.5, 'gloss'],
    ['depthTint', 0.2, 4, 0.01, 'depth tint'],
    ['grit', 0, 2, 0.01, 'scree speckle'],
    ['gritScale', 0.5, 40, 0.1, 'speckle / metre'],
    ['rimLight', 0, 3, 0.01, 'lip catch'],
    ['opacity', 0, 1, 0.01, 'opacity']
  ],
  'The cracked apron': [
    ['fieldEdge', 0.02, 3, 0.01, 'front feather'],
    ['fieldRagged', 0, 1, 0.01, 'front raggedness'],
    ['fieldRaggedScale', 0.05, 4, 0.01, 'lobes / metre'],
    ['fieldWarp', 0, 3, 0.01, 'domain warp'],
    ['fieldRelief', 0, 3, 0.01, 'relief'],
    ['fieldCell', 0.05, 4, 0.01, 'block size'],
    ['fieldCellJitter', 0, 1, 0.01, 'block jitter'],
    ['fieldSeam', 0.005, 0.5, 0.005, 'fracture width'],
    ['fieldThickness', 0, 1, 0.01, 'block tip'],
    ['fieldLift', 0, 1, 0.01, 'spoil lift'],
    ['fieldDepth', 0, 3, 0.01, 'apparent dip'],
    ['fieldSharp', 0, 1, 0.01, 'profile sharpness'],
    ['fieldDetail', 0, 2, 0.01, 'grain'],
    ['fieldParallax', 0, 2, 0.01, 'parallax'],
    ['fieldOpacity', 0, 1, 0.01, 'opacity'],
    ['colorFieldBase', 'apron ground'],
    ['colorFieldEdge', 'apron edges'],
    ['colorFieldGlow', 'apron highlight'],
    ['colorFieldDeep', 'apron fissures']
  ],
  'The calving chunks': [
    ['debrisCount', 0, 48, 1, 'chunks'],
    ['debrisRadius', 0.02, 1.5, 0.01, 'chunk radius'],
    ['debrisSizeJitter', 0, 1.5, 0.01, 'size jitter'],
    ['debrisSpin', 0, 20, 0.1, 'tumble'],
    ['debrisFlash', 0.01, 1, 0.01, 'birth flash'],
    ['debrisBack', -6, 6, 0.05, 'launch offset'],
    ['debrisSpread', 0, 2, 0.01, 'launch spread × radius'],
    ['debrisLaunchHeight', -1, 3, 0.01, 'launch height'],
    ['debrisSinkSpread', 0, 1.5, 0.01, 'converge × radius'],
    ['debrisSinkDepth', 0.5, 25, 0.1, 'fall to depth'],
    ['debrisPathCurve', 0.5, 4, 0.01, 'fall acceleration'],
    ['debrisFlightTime', 0.1, 5, 0.01, 'fall time'],
    ['debrisSpeedJitter', 0, 1, 0.01, 'fall-time jitter'],
    ['debrisLead', 0, 3, 0.01, 'first chunk delay'],
    ['debrisWindow', 0, 6, 0.01, 'calving window'],
    ['debrisFillBias', -1, 1, 0.01, 'rim-in / middle-out'],
    ['debrisFillScatter', 0, 1, 0.01, 'order scatter'],
    ['debrisHashCell', 0.1, 6, 0.05, 'hash lattice'],
    ['debrisRoughness', 0.05, 1, 0.01, 'chunk roughness'],
    ['colorDebris', 'chunk colour']
  ],
  'Dust & pebbles': [
    ['dustRate', 0, 500, 1, 'dust rate'],
    ['dustSize', 0.05, 5, 0.01, 'dust size'],
    ['dustSpeed', 0, 10, 0.05, 'dust speed'],
    ['dustLifetime', 0.2, 10, 0.05, 'dust lifetime'],
    ['dustOpacity', 0, 1, 0.005, 'dust opacity'],
    ['dustRise', -2, 5, 0.01, 'dust rise'],
    ['dustTurbulence', 0, 3, 0.01, 'dust turbulence'],
    ['blastDust', 0, 600, 1, 'blast dust'],
    ['blastSpeed', 0, 30, 0.1, 'blast speed'],
    ['blastLift', 0, 1, 0.01, 'blast lift'],
    ['pebbleRate', 0, 400, 1, 'pebble rate'],
    ['pebbleSize', 0.005, 0.4, 0.005, 'pebble size'],
    ['pebbleSpeed', 0, 10, 0.05, 'pebble speed'],
    ['pebbleLifetime', 0.1, 4, 0.05, 'pebble lifetime'],
    ['pebbleGravity', -40, 0, 0.1, 'pebble gravity'],
    ['pebbleBand', 0.01, 1, 0.01, 'pebble band'],
    ['colorDust*', 'Dust colour'],
    ['colorPebble*', 'Pebble colour']
  ],
  'The moment it lets go': [
    ['burstSize', 0.2, 14, 0.05, 'dust ball size'],
    ['burstIntensity', 0, 4, 0.01, 'dust ball intensity'],
    ['shockRadius', 0.5, 30, 0.1, 'shockwave radius'],
    ['impactShake', 0, 3, 0.01, 'shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['settleShake', 0, 0.5, 0.005, 'settle rumble'],
    ['rumble', 0, 0.5, 0.005, 'reach rumble'],
    ['impactFlash', 0, 1, 0.005, 'screen flash'],
    ['colorBurstA', 'burst shell'],
    ['colorBurstB', 'burst body'],
    ['colorBurstC', 'burst core'],
    ['colorShockA', 'shockwave ring'],
    ['colorShockB', 'shockwave crest'],
    ['colorFlash', 'flash colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 60, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightColor', 'light colour']
  ]
};
