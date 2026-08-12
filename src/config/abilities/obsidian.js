/* ================================================================== */
/* OBSIDIAN BLOOM — stone, far cast                                    */
/* ================================================================== */
/**
 * Volcanic glass opening out of the floor in a ring of blades.
 *
 * Everything in the `The conchoidal fracture` folder below is **geometry**, not
 * shading, and that is the whole slot. Obsidian does not break along planes the
 * way quartz or feldspar do — it has no crystal structure to break along, so a
 * fracture in it is a smooth curved shell with concentric rib marks radiating
 * from wherever the blow landed. Every other rock in this sandbox is faceted;
 * this one has to be *curved*, and it has to be curved in the mesh, because the
 * read is the way a highlight slides across a face rather than jumping from one
 * facet to the next.
 *
 * So the sliders that matter here are not the colour pickers. They are `dish`
 * (how deeply a fracture scar bows in between its two arrises), `ripple` and
 * `ripplePitch` (the rib marks), and `dishBias` (where on the face the blow
 * landed, which is where the ribs are centred). Drag `dish` to zero with the
 * bloom standing and paused and you can watch it turn back into an ordinary
 * faceted crystal — that is the A/B for whether the trick is doing anything.
 *
 * The glass sliders are second-order by design: `glassRough` at 0.07 and
 * `envIntensity` above 1 do the rest, and `glint`/`glintSharp` add one tight
 * analytic lobe on top so the specular is a *point* rather than a smear even on
 * a stage with a soft probe.
 *
 * `zoneRadius` drives the ring, the glaze on the floor and where the flakes are
 * thrown from. That sharing is the design — the circle the indicator drew is the
 * circle the bloom happens in.
 */
export const obsidian = {
  /* --- the cast --- */
  range: 26.0, // maximum cast distance, metres
  minRange: 4.0, // closer than this and the cast is refused
  zoneRadius: 6.5, // the footprint the indicator draws, metres
  speed: 44.0, // how fast the heat front runs out to the zone, metres/second
  cooldown: 1.5, // seconds
  castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws
  holdTime: 2.2, // seconds the bloom stands once it is fully out
  fadeTime: 1.1, // seconds from the break to gone

  /* --- the bloom --- */
  shards: 72, // blades planted per cast (capped at 120)
  clusterShare: 0.16, // 0..1 of them held back for the knot at the centre
  clusterRadius: -1, // metres; < 0 derives it from the inner radius
  bloomTime: 0.55, // seconds the ring takes to open from the centre out
  riseStagger: 0.3, // seconds of scatter on when a blade is released
  ringInner: 0.12, // inner edge of the band, × zoneRadius
  ringOuter: 1.0, // outer edge, × zoneRadius
  radialCurve: 0.9, // <1 crowds the blades toward the rim
  radialJitter: 0.35, // metres of radial wander
  angleJitter: 0.22, // radians of bearing wander

  /* --- the silhouette of one blade --- */
  heightNear: 0.55, // metres tall at the centre
  bladeHeight: 2.5, // ... and at the rim
  heightCurve: 0.85, // how late the ramp climbs
  heightJitter: 0.45, // ± fraction
  crown: 0.25, // 0..1 how much shorter the flank blades are
  crownPower: 1.4, // how sharply that dome falls off
  peak: 1.0, // extra height multiplier at the rim
  rubble: 0.16, // 0..1 chance a blade is demoted to a broken stub
  rubbleScale: 0.32, // height multiplier for those
  rubbleSpread: 1.3, // radius multiplier for those
  bladeRadius: 0.3, // metres, half-width at the centre
  bladeRadius2: 0.42, // ... and at the rim
  radiusCurve: 0.7, // how that ramps
  radiusJitter: 0.4, // ± fraction
  lean: 0.42, // radians the blades tip outward from the centre
  leanJitter: 0.5, // ± fraction
  leanRamp: 1.0, // 0 leans everything equally, 1 only the rim
  leanOutward: 1.0, // weight of "out from the centre" in the lean
  leanForward: 0.0, // weight of "away from the caster" — 0: a bloom has no front
  twist: 1.0, // 0..1 of a full turn of random yaw
  tilt: 0.16, // radians of extra random tip, any bearing

  /* --- how a blade arrives --- */
  riseTime: 0.2, // seconds from buried to full height
  riseOvershoot: 0.3, // how far past full height the punch carries
  settle: 0.42, // seconds the overshoot damps out over
  springRate: 17, // radians/second of that ring
  emergeSink: 0.9, // fraction of its height a blade is buried at emerge = 0
  birthScale: 0.82, // footprint scale the moment it breaks the surface
  birthFade: 0.45, // seconds the heat flash on a new blade decays over
  breachAt: 0.22, // emergence fraction that throws the chips
  sinkDepth: 0.5, // extra metres a withdrawing blade drops

  /* --- THE CONCHOIDAL FRACTURE --- */
  /**
   * These twelve rebuild the mesh when they move (`syncGeometry` hashes them),
   * so they are the expensive folder and the only one worth the cost. See the
   * class comment on `ObsidianAbility` for what each of them is doing to the
   * surface.
   */
  faceSides: 6, // fracture faces around the blade, 4–9
  faceRings: 5, // divisions up one face — the curve's vertical resolution
  faceArc: 3, // divisions across one face — the curve's lateral resolution
  tipTaper: 0.14, // blade half-width at the shoulder, fraction of the base
  tipCurve: 1.7, // >1 keeps the blade wide then narrows it late
  tipRise: 0.15, // fraction of the height given to the terminal point
  bulge: 0.22, // how much the blade swells at mid-height
  dish: 0.3, // how deeply a fracture scar bows in, fraction of the radius
  dishBias: 0.18, // where up the face the blow landed, 0..1
  dishStretch: 1.35, // >1 makes the scar an ellipse taller than it is wide
  ripple: 0.045, // rib-mark amplitude, fraction of the radius
  ripplePitch: 2.6, // ribs per unit distance from the initiation point
  shear: 0.32, // radians the blade twists over its own height
  chip: 0.3, // ± fraction of per-bearing radius jitter

  /* --- the glass --- */
  colorGlass: '#14121c', // the body — near black, faintly violet
  colorDeep: '#050408', // the interior, where the banding is densest
  colorSheen: '#b9c4ff', // every reflection: fresnel rim and specular lobe
  colorBleed: '#7a2410', // light that gets through a thin edge — obsidian is red
  colorHeat: '#ff7326', // molten, on a blade that has just arrived
  glassRough: 0.07, // low: this is the number that makes it glass
  glassMetal: 0.0, // a dielectric. Metalness here reads as hematite, not glass
  envIntensity: 1.7, // how hard the probe shows in the surface
  glassOpacity: 1.0,
  fresnel: 0.85, // strength of the grazing-angle sheen
  fresnelPower: 4.5, // how tightly it hugs the silhouette
  glint: 2.4, // the sharp specular lobe
  glintSharp: 220, // its exponent — high is a point, low is a smear
  bleed: 0.6, // how much light comes through the thin end
  bleedPower: 2.2, // how quickly "thin" runs out toward the base
  heat: 3.2, // the arrival glow
  heatBand: 2.4, // how tightly that glow hugs the base
  banding: 0.45, // 0..1 flow banding, in world space
  bandScale: 2.2, // bands per metre
  emission: 0.04, // the standing glow. Deliberately almost nothing

  /* --- the break --- */
  breakTime: 0.16, // seconds the blades take to go, once they go
  flakes: 90, // fragments thrown at the break
  flakeSize: 0.19, // metres
  flakeJitter: 0.6, // ± fraction
  flakeSpawnRadius: 0.5, // metres of scatter about a flake's anchor
  flakeSpawnHeight: 1.2, // metres the anchor sits above the floor
  flakeSpeed: 5.6, // metres/second
  flakeSpeedJitter: 0.65, // ± fraction
  flakeSpread: 0.42, // 0 throws them all one way, 1 is fully random
  flakeUp: 0.55, // how much +Y is folded into the throw
  flakeGravity: -20.0, // metres/second²
  flakeDrag: 0.75, // 1/second
  flakeSpin: 11.0, // radians/second of tumble
  flakeSpinJitter: 0.8, // ± fraction
  flakeLife: 1.5, // seconds a flake lives
  flakeShrink: 0.5, // 0..1 of its size lost by the end
  flakeShrinkPower: 1.7, // how late that bites
  flakeFloor: 0.02, // metres, the floor a flake settles on
  flakeFloorSpin: 0.2, // fraction of the tumble kept once grounded
  colorFlakeA: '#1a1724', // the lit face of a flake
  colorFlakeB: '#07060c', // its shaded face
  colorFlakeEdge: '#c7d0ff', // its rim — the razor edge catching the key
  colorFlakeScene: '#20202c', // what shows through, when a scene copy exists
  flakeOpacity: 1.0,
  flakeGlow: 0.5,
  flakeRim: 1.5,
  flakeRimPower: 3.0,
  flakeShade: 0.75,
  flakeAmbient: 0.2,
  flakeFadeStart: 0.62, // 0..1 of life before a flake starts to go
  flakeSoft: 0.3, // metres of soft fade against geometry
  flakeSceneMix: 0.0, // refraction, when `frame.uSceneColor` ever exists
  flakeRefract: 0.4,
  flakeSaturation: 0.35,

  /* --- the vitrified floor --- */
  glazeSpan: 1.15, // the glaze's radius, × zoneRadius
  glazeHeight: 0.012, // metres above the floor
  glazeEdge: 0.5, // metres of feather on the spreading front
  glazeRagged: 0.34, // how far that front wanders
  glazeRaggedScale: 0.6, // lobes per metre
  glazeWarp: 0.55, // metres of domain warp on those lobes
  glazeRelief: 0.55, // how hard the height field tilts the fake normal
  glazeNormalStep: 0.06, // metres between the height taps
  glazeAmbient: 0.18, // floor on the diffuse term
  glazeWrap: 0.4, // wraps the terminator round the back
  glazeSpecular: 1.3, // high: this is glass on the floor
  glazeGloss: 90, // Blinn exponent — a hard, small highlight
  glazeParallax: 0.3, // metres of view-driven offset
  glazeDetail: 0.7, // 0..1 interior detail
  glazeFlow: 0.12, // metres/second the sheen crawls
  glazeSharp: 0.7, // 0..1 how hard-edged the glaze is
  glazeEmissive: 1.0, // multiplier on the glowing terms
  glazeOpacity: 0.9,
  colorGlazeBase: '#0d0c12', // the vitrified stone itself
  colorGlazeEdge: '#8f9ccb', // its sheen
  colorGlazeGlow: '#ff6a24', // the heat still in it
  colorGlazeDeep: '#030306', // the deepest part of the pour

  /* --- chips, ash and glints --- */
  /**
   * Each system is coloured by a four-stop gradient over the particle's own
   * lifetime, `A` at birth through `D` as it dies. Spelled out rather than
   * derived from the glass palette, so the chips can be made to cool through
   * orange while the blades stay black.
   */
  breachChips: 9, // chips thrown as one blade breaks the surface
  breakChips: 120, // ... and at the break
  chipSize: 0.07,
  chipSpeed: 6.5,
  chipLifetime: 1.4,
  chipGravity: -19.0,
  colorChipA: '#ffb060',
  colorChipB: '#4a3a44',
  colorChipC: '#1a1720',
  colorChipD: '#0b0a10',
  breachAsh: 5, // puffs of ash as one blade breaks the surface
  breakAsh: 60, // ... and at the break
  ashSize: 0.9,
  ashSpeed: 1.5,
  ashLifetime: 2.6,
  ashRise: 0.7, // upward drift, metres/second
  ashOpacity: 0.2,
  colorAshA: '#4c4650',
  colorAshB: '#3a3540',
  colorAshC: '#26232c',
  colorAshD: '#14131a',
  glintRate: 26, // sparkles/second off the standing glass
  glintSize: 0.06,
  glintSpeed: 0.5,
  glintLifetime: 0.55,
  glintRise: 0.35,
  colorGlintA: '#ffffff',
  colorGlintB: '#c7d0ff',
  colorGlintC: '#6a72b8',
  colorGlintD: '#14162e',

  /* --- shake --- */
  bloomShake: 0.3, // the jolt as the ring opens
  bloomShakeTime: 0.5, // seconds it decays over
  breakShake: 0.42, // the jolt at the break
  breakShakeTime: 0.35,
  rumble: 0.05, // continuous shake while the ring is still opening

  /* --- dynamic light --- */
  // Orange, not violet: the light in this ability is the magma the glass came
  // out of, and it is gone within a second of the bloom finishing.
  lightIntensity: 22,
  lightRadius: 14,
  lightColor: '#ff7a30'
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Obsidian Bloom.
 *
 * `The conchoidal fracture` is the folder that makes this slot what it is and
 * it is the one that costs something to drag — every control in it rebuilds
 * three meshes. That is deliberate: a curve you can only get by rebuilding is
 * still worth having, and the alternative (baking the curvature into a normal
 * map) is a texture, which invariant I2 does not allow and which would fall
 * apart at the silhouette anyway.
 */
export const obsidianSchema = {
  'The cast': [
    ['range', 4, 60, 0.1, 'max range'],
    ['minRange', 0, 15, 0.1, 'min range'],
    ['zoneRadius', 1.5, 20, 0.1, 'zone radius'],
    ['speed', 5, 200, 1, 'front speed'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['holdTime', 0.1, 10, 0.05, 'hold time'],
    ['fadeTime', 0.1, 6, 0.01, 'fade time'],
    ['castAnim', 'cast animation']
  ],
  'The conchoidal fracture': [
    ['dish', 0, 0.9, 0.005, 'scar depth'],
    ['dishBias', 0, 1, 0.01, 'where the blow landed'],
    ['dishStretch', 0.3, 4, 0.01, 'scar stretch'],
    ['ripple', 0, 0.2, 0.002, 'rib amplitude'],
    ['ripplePitch', 0.2, 10, 0.05, 'ribs / unit'],
    ['faceSides', 4, 9, 1, 'fracture faces'],
    ['faceRings', 3, 8, 1, 'rings per face'],
    ['faceArc', 2, 6, 1, 'arc per face'],
    ['tipTaper', 0.02, 0.6, 0.005, 'shoulder width'],
    ['tipCurve', 0.4, 4, 0.01, 'taper curve'],
    ['tipRise', 0.02, 0.5, 0.005, 'terminal point'],
    ['bulge', 0, 0.8, 0.005, 'mid-height swell'],
    ['shear', -1.5, 1.5, 0.01, 'twist over height'],
    ['chip', 0, 1, 0.01, 'bearing jitter']
  ],
  'The bloom': [
    ['shards', 1, 120, 1, 'blades'],
    ['clusterShare', 0, 1, 0.01, 'centre knot share'],
    ['clusterRadius', -1, 8, 0.05, 'centre knot radius'],
    ['bloomTime', 0.05, 4, 0.01, 'open time'],
    ['riseStagger', 0, 2, 0.01, 'release scatter'],
    ['ringInner', 0, 1, 0.01, 'inner edge × radius'],
    ['ringOuter', 0.05, 1.5, 0.01, 'outer edge × radius'],
    ['radialCurve', 0.2, 3, 0.01, 'radial crowding'],
    ['radialJitter', 0, 3, 0.01, 'radial wander'],
    ['angleJitter', 0, 1.5, 0.01, 'bearing wander'],
    ['rumble', 0, 0.5, 0.005, 'opening rumble']
  ],
  'One blade': [
    ['heightNear', 0.05, 6, 0.01, 'height at centre'],
    ['bladeHeight', 0.1, 10, 0.05, 'height at rim'],
    ['heightCurve', 0.1, 4, 0.01, 'height curve'],
    ['heightJitter', 0, 1, 0.01, 'height jitter'],
    ['crown', 0, 1, 0.01, 'crown'],
    ['crownPower', 0.2, 4, 0.01, 'crown falloff'],
    ['peak', 0.2, 3, 0.01, 'rim swell'],
    ['rubble', 0, 1, 0.01, 'broken stubs'],
    ['rubbleScale', 0.05, 1, 0.01, 'stub height'],
    ['rubbleSpread', 0.5, 3, 0.01, 'stub spread'],
    ['bladeRadius', 0.02, 2, 0.01, 'width at centre'],
    ['bladeRadius2', 0.02, 2, 0.01, 'width at rim'],
    ['radiusCurve', 0.1, 3, 0.01, 'width curve'],
    ['radiusJitter', 0, 1, 0.01, 'width jitter'],
    ['lean', -1.4, 1.4, 0.01, 'outward lean'],
    ['leanJitter', 0, 1, 0.01, 'lean jitter'],
    ['leanRamp', 0, 1, 0.01, 'lean ramp'],
    ['leanOutward', 0, 2, 0.01, 'lean outward'],
    ['leanForward', -2, 2, 0.01, 'lean downrange'],
    ['twist', 0, 1, 0.01, 'random yaw'],
    ['tilt', 0, 1, 0.01, 'random tip']
  ],
  'The eruption': [
    ['riseTime', 0.02, 2, 0.01, 'rise time'],
    ['riseOvershoot', 0, 1.5, 0.01, 'overshoot'],
    ['settle', 0.05, 3, 0.01, 'settle'],
    ['springRate', 1, 40, 0.5, 'spring rate'],
    ['emergeSink', 0, 1.5, 0.01, 'buried depth'],
    ['birthScale', 0.1, 1.5, 0.01, 'birth scale'],
    ['birthFade', 0.02, 3, 0.01, 'heat flash decay'],
    ['breachAt', 0.02, 1, 0.01, 'breach point'],
    ['sinkDepth', 0, 4, 0.05, 'withdraw depth']
  ],
  'The glass': [
    ['glassRough', 0.01, 1, 0.005, 'roughness'],
    ['glassMetal', 0, 1, 0.01, 'metalness'],
    ['envIntensity', 0, 5, 0.01, 'probe strength'],
    ['glassOpacity', 0, 1, 0.01, 'opacity'],
    ['fresnel', 0, 3, 0.01, 'grazing sheen'],
    ['fresnelPower', 0.5, 12, 0.1, 'sheen tightness'],
    ['glint', 0, 8, 0.01, 'specular lobe'],
    ['glintSharp', 8, 600, 1, 'specular sharpness'],
    ['bleed', 0, 3, 0.01, 'edge transmission'],
    ['bleedPower', 0.2, 8, 0.05, 'transmission falloff'],
    ['heat', 0, 10, 0.01, 'arrival heat'],
    ['heatBand', 0.2, 8, 0.05, 'heat band'],
    ['banding', 0, 1, 0.01, 'flow banding'],
    ['bandScale', 0.1, 10, 0.05, 'bands / metre'],
    ['emission', 0, 1, 0.005, 'standing glow'],
    ['colorGlass', 'glass body'],
    ['colorDeep', 'interior'],
    ['colorSheen', 'reflection'],
    ['colorBleed', 'transmission'],
    ['colorHeat', 'molten']
  ],
  'The break': [
    ['breakTime', 0.02, 1.5, 0.01, 'break time'],
    ['flakes', 0, 192, 1, 'flakes'],
    ['flakeSize', 0.02, 1, 0.005, 'flake size'],
    ['flakeJitter', 0, 1, 0.01, 'size jitter'],
    ['flakeSpawnRadius', 0, 4, 0.05, 'spawn scatter'],
    ['flakeSpawnHeight', 0, 6, 0.05, 'spawn height'],
    ['flakeSpeed', 0, 25, 0.1, 'throw speed'],
    ['flakeSpeedJitter', 0, 1, 0.01, 'speed jitter'],
    ['flakeSpread', 0, 1, 0.01, 'throw spread'],
    ['flakeUp', 0, 1, 0.01, 'upward bias'],
    ['flakeGravity', -60, 0, 0.5, 'gravity'],
    ['flakeDrag', 0, 4, 0.01, 'drag'],
    ['flakeSpin', 0, 30, 0.1, 'tumble'],
    ['flakeSpinJitter', 0, 1, 0.01, 'tumble jitter'],
    ['flakeLife', 0.1, 6, 0.05, 'lifetime'],
    ['flakeShrink', 0, 1, 0.01, 'shrink'],
    ['flakeShrinkPower', 0.2, 5, 0.05, 'shrink curve'],
    ['flakeFloor', 0, 2, 0.01, 'floor'],
    ['flakeFloorSpin', 0, 1, 0.01, 'grounded tumble'],
    ['flakeOpacity', 0, 1, 0.01, 'opacity'],
    ['flakeGlow', 0, 4, 0.01, 'glow'],
    ['flakeRim', 0, 5, 0.01, 'rim'],
    ['flakeRimPower', 0.2, 8, 0.05, 'rim tightness'],
    ['flakeShade', 0, 2, 0.01, 'shading depth'],
    ['flakeAmbient', 0, 1, 0.01, 'ambient'],
    ['flakeFadeStart', 0, 1, 0.01, 'fade start'],
    ['flakeSoft', 0.02, 2, 0.01, 'soft intersection'],
    ['flakeSceneMix', 0, 1, 0.01, 'scene mix'],
    ['flakeRefract', 0, 2, 0.01, 'refraction'],
    ['flakeSaturation', 0, 2, 0.01, 'scene saturation'],
    ['colorFlakeA', 'lit face'],
    ['colorFlakeB', 'shaded face'],
    ['colorFlakeEdge', 'razor edge'],
    ['colorFlakeScene', 'scene tint']
  ],
  'The vitrified floor': [
    ['glazeSpan', 0.2, 3, 0.01, 'span × radius'],
    ['glazeHeight', 0.002, 0.2, 0.002, 'height'],
    ['glazeEdge', 0.02, 3, 0.01, 'front feather'],
    ['glazeRagged', 0, 1.5, 0.01, 'front wander'],
    ['glazeRaggedScale', 0.05, 4, 0.01, 'lobes / metre'],
    ['glazeWarp', 0, 3, 0.01, 'domain warp'],
    ['glazeRelief', 0, 3, 0.01, 'relief'],
    ['glazeNormalStep', 0.01, 0.4, 0.005, 'normal step'],
    ['glazeAmbient', 0, 1, 0.01, 'ambient'],
    ['glazeWrap', 0, 1, 0.01, 'terminator wrap'],
    ['glazeSpecular', 0, 4, 0.01, 'specular'],
    ['glazeGloss', 2, 200, 1, 'gloss'],
    ['glazeParallax', 0, 2, 0.01, 'parallax'],
    ['glazeDetail', 0, 1, 0.01, 'detail'],
    ['glazeFlow', -2, 2, 0.01, 'sheen flow'],
    ['glazeSharp', 0, 1, 0.01, 'edge hardness'],
    ['glazeEmissive', 0, 4, 0.01, 'emissive'],
    ['glazeOpacity', 0, 1, 0.01, 'opacity'],
    ['colorGlazeBase', 'glaze'],
    ['colorGlazeEdge', 'sheen'],
    ['colorGlazeGlow', 'heat'],
    ['colorGlazeDeep', 'deep']
  ],
  'Chips, ash & glints': [
    ['breachChips', 0, 60, 1, 'chips per blade'],
    ['breakChips', 0, 400, 1, 'chips at the break'],
    ['chipSize', 0.005, 0.4, 0.005, 'chip size'],
    ['chipSpeed', 0, 25, 0.1, 'chip speed'],
    ['chipLifetime', 0.1, 5, 0.05, 'chip lifetime'],
    ['chipGravity', -50, 0, 0.5, 'chip gravity'],
    ['breachAsh', 0, 40, 1, 'ash per blade'],
    ['breakAsh', 0, 300, 1, 'ash at the break'],
    ['ashSize', 0.05, 4, 0.05, 'ash size'],
    ['ashSpeed', 0, 8, 0.05, 'ash speed'],
    ['ashLifetime', 0.2, 8, 0.05, 'ash lifetime'],
    ['ashRise', -2, 4, 0.01, 'ash rise'],
    ['ashOpacity', 0, 1, 0.005, 'ash opacity'],
    ['glintRate', 0, 200, 1, 'glint rate'],
    ['glintSize', 0.005, 0.3, 0.005, 'glint size'],
    ['glintSpeed', 0, 5, 0.05, 'glint speed'],
    ['glintLifetime', 0.05, 3, 0.01, 'glint lifetime'],
    ['glintRise', -2, 4, 0.01, 'glint rise'],
    ['colorChip*', 'Chip colour'],
    ['colorAsh*', 'Ash colour'],
    ['colorGlint*', 'Glint colour']
  ],
  'Shake & dynamic light': [
    ['bloomShake', 0, 2, 0.01, 'opening jolt'],
    ['bloomShakeTime', 0.05, 3, 0.01, 'opening decay'],
    ['breakShake', 0, 2, 0.01, 'break jolt'],
    ['breakShakeTime', 0.05, 3, 0.01, 'break decay'],
    ['lightIntensity', 0, 120, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 50, 0.1, 'light radius'],
    ['lightColor', 'light colour']
  ]
};
