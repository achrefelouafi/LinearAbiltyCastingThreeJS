# The Roster — 44 new abilities

The sandbox shipped with six. This document specifies forty-four more, taking the same rules the
first six were built under and pushing them into techniques the original build never used.

**The rules that carry over, in order of importance:**

1. **Nothing is a texture.** Every mark on screen is a signed distance field, a noise field, a
   parametric path evaluated in a vertex shader, or procedural geometry generated on the CPU.
2. **No dimensions on the CPU.** A cast captures *dice rolls and timestamps only* — unitless
   fractions and the moment an event fired. Every metre, radian and second is resolved against
   `settings[id]` inside the update loop, which runs on a zero-length frame. Dragging a slider
   must reshape an effect that is already standing, with the clock stopped.
3. **One trick per ability.** Each entry below names the single technique that makes it read. If a
   new ability is a recolour of an old one it should not exist. Every one of these forty-four
   contributes a silhouette, a motion or a rendering trick that no other slot has.
4. **The beats.** `travel → impact → fade`, with an optional wind-up bought by refusing to let
   `advance()` leave the caster (this is how Nova Beam gets its fourth beat).
5. **Every colour is a picker, every dimension a slider.** Nothing is derived from another value
   unless the derivation *is* the point (the way `snare.zoneRadius` drives five consumers at once).

---

## Reading an entry

```
##  id · Name
    school · cast shape · key tech · beats
    THE TRICK — the one thing that makes it read.
    <the description a player would be given>
    Palette: ...
```

`cast shape` is `LINE` (arrow indicator) or `ZONE` (far-cast circle, needs `zoneRadius`).
`key tech` names modules from `docs/EXPANSION.md` §"The tech library".

---

# I · FROST — the school that already exists

Frost Lance and Glacial Crown ship in the build. These three take the palette somewhere the
crystals cannot.

## `rime` · Rimewalker
    frost · LINE · GroundField + GrowthField(plate) · travel → impact → fade
    THE TRICK — the ice is *thin*. Sheets, not spikes: curved plates a few centimetres thick that
    peel up off the floor like paper curling off a hot pan, translucent enough to see the plate
    behind them, catching the light on their lip and nowhere else.
    A freezing front runs the line and the floor glazes over behind it in interlocking plates. As
    each plate locks, its downwind edge lifts and curls; by the time the front reaches the target
    the path is a corridor of standing shards of sheet ice. It holds, then the curls snap off and
    the glaze sublimates from the caster's end forward.
    Palette: near-white with a green-blue body tint, `#dff6ff` / `#7ecbe0` / `#123b4a`.

## `hail` · Hailwrath
    frost · ZONE · Projectile(swarm) + GroundField · impact-only, staggered
    THE TRICK — there is no travelling front. The front is *vertical*: hailstones arrive out of the
    sky on staggered timers keyed off a spatial hash of where they land, so the zone fills from the
    boundary inward and no two casts fill it in the same order.
    A column of freezing air over the circle, and then it comes down — irregular stones that
    stretch as they fall, punch a white pock into the floor, throw chips and bounce once. The rate
    ramps up, peaks, and tails off; the pocks stay and slowly rime over.
    Palette: `#f2fbff` / `#9fd8ee` / `#2a5d75`.

## `shatterlance` · Shatterlance
    frost · LINE · GrowthField(single) + ShatterField · wind-up → travel → impact → fade
    THE TRICK — the wind-up is the ability. A single enormous ice lance assembles in the air out of
    converging shards, hangs there long enough for you to see it, then *goes* — and the impact is a
    ShatterField: the lance's own geometry breaks into two hundred instanced fragments that inherit
    the flight velocity and tumble.
    Palette: `#ffffff` / `#8fe3ff` / `#0d2f52`.

---

# II · FLAME

## `pyroclasm` · Pyroclasm
    flame · ZONE · VolumeHull(dome) + Distortion · impact → hold → fade
    THE TRICK — a raymarched ash dome that *collapses before it blows*. The volume is sampled in
    world space so the ash keeps its grain while the dome contracts, which is what sells the
    implosion; then the density inverts and it blasts outward through its own footprint.
    Palette: soot to ember, `#1a1210` / `#5c2a10` / `#ff7a2a` / `#ffd9a0`.

## `dragonbreath` · Wyrm's Breath
    flame · LINE · VolumeHull(cone) + GroundField · travel → sustain → fade
    THE TRICK — a real cone volume. Not a widening billboard: a raymarched cone whose density
    profile is thickest just off-axis and hollow down the middle, so orbiting it shows you the
    tongue of flame passing *through* itself. The floor beneath scorches progressively as an SDF
    that grows along the cone's ground intersection.
    Palette: `#fff2c0` / `#ffb03a` / `#e0400f` / `#2a0a04`.

## `firewhip` · Ashen Lash
    flame · LINE · Tube(whip) + Shell · travel → crack → fade
    THE TRICK — whip kinematics. The lash is a tube along a curve whose curvature travels from the
    handle to the tip; when the loop reaches the end the tip briefly exceeds the wave speed and a
    small shock ring pops off *at that point*, mid-air. The crack is a real event in the geometry,
    not a scheduled effect.
    Palette: `#ffe9b0` / `#ff8a2a` / `#8a1c05`.

## `emberflock` · Emberflight
    flame · LINE · Swarm + RibbonTrails · travel → impact → fade
    THE TRICK — flocking. Twenty-odd ember birds each carry their own trail; they cohere toward a
    shared lead point that runs the cast line, separate from each other, and bank into their turns
    (roll derived from lateral acceleration). At the target they collapse into one point and go up.
    Palette: `#ffd27a` / `#ff6a1f` / `#3d0d04`.

## `magma` · Magma Fount
    flame · ZONE · LiquidSurface + Projectile(blobs) · impact → sustain → cool
    THE TRICK — a real molten pool. A live heightfield on the floor with flow-mapped crust: the
    black skin cracks along the flow direction and the seams glow, and the crust re-forms where the
    surface is slow. Blobs arc out of the middle and land back in it, punching ripples into the
    same heightfield.
    Palette: `#ffe08a` / `#ff5a12` / `#7a1a04` / `#120806`.

## `sunspear` · Sunspear
    flame · LINE · Projectile(arc) + Distortion + Shell · travel(arc) → impact → fade
    THE TRICK — heat shimmer as a first-class effect. The javelin's wake writes into the
    distortion buffer, so the floor and the character genuinely warp behind it. On landing it opens
    a low sun-disc lying on the ground with corona filaments licking off its rim.
    Palette: `#ffffff` / `#ffe07a` / `#ff9a1f`.

---

# III · STORM

## `chainarc` · Chain Arc
    storm · LINE · ArcNetwork · travel(hops) → impact → fade
    THE TRICK — graph pathing. The bolt does not travel; it *hops*. A handful of nodes are placed
    down the line with lateral scatter, and the discharge lights one segment at a time with a small
    burst at each node. Re-rolling the node scatter live re-routes a chain already in the air.
    Palette: `#eaf6ff` / `#5fb0ff` / `#0b2f7a`.

## `thunderclap` · Thunderclap
    storm · ZONE · Shell(dome) + Distortion · impact → delayed boom → fade
    THE TRICK — the delay. The flash lands, and then nothing for a beat, and *then* the pressure
    front arrives as three concentric refraction rings that push through the distortion buffer and
    shove the dust. The gap is the whole effect; without it this is just another shockwave.
    Palette: `#ffffff` / `#cfe4ff` / `#3f6fd0`.

## `balllightning` · Fulminant Orb
    storm · LINE · Shell + FilamentPaths(orbit) · travel(slow) → impact → fade
    THE TRICK — a caged orb. Filaments do not radiate outward, they *orbit* — great slow loops
    around a near-invisible shell, occasionally earthing to the floor beneath in a short spike.
    It travels slowly enough that you watch it come, which no other storm slot does.
    Palette: `#ffffff` / `#9fd0ff` / `#2f3fd0`.

## `stormwall` · Tempest Wall
    storm · LINE · Curtain + FilamentPaths · raise → hold → fall
    THE TRICK — geometry perpendicular to the cast. The line you aim is the wall's *normal*, not
    its length: a rain curtain rises across your heading, with its own lightning inside it and rain
    streaking down its face, and the floor under it goes wet and reflective.
    Palette: `#c8dcea` / `#5f7f9a` / `#101c2a`, lightning `#ffffff`.

## `railcoil` · Railcoil
    storm · LINE · Tube + FilamentPaths(helix) · wind-up → instant → decay
    THE TRICK — zero travel time. Coils collapse inward along the barrel during the wind-up, and
    when they meet the shot is simply *already there* — full length in one frame. Everything after
    is decay: an ionisation channel that cools from white through blue to nothing over a second and
    a half, sagging and breaking into segments as it dies.
    Palette: `#ffffff` / `#a8e0ff` / `#1a4fd0`.

---

# IV · STONE

## `stonespine` · Stone Spine
    stone · LINE · GrowthField(slab) · travel → impact → fade
    THE TRICK — plates, not spikes. Flat slabs of floor heave up and tilt like ice floes on a
    river, each one hinged along an edge rather than punched straight up, with the dirt underside
    visible on the lifted face and rubble sliding off the top.
    Palette: `#6b6357` / `#3a352e` / `#141210`.

## `sinkhole` · Sinkhole
    stone · ZONE · GroundField + Projectile(debris) · impact → collapse → settle
    THE TRICK — the ground goes *down*. An inverted fissure: the floor quad is displaced into a
    funnel, the lip cracks and calves inward, and debris falls into a hole that reads as depth
    because its walls are shaded from a fake normal and its floor is never drawn.
    Palette: `#4a4239` / `#221e19` / `#0a0908`.

## `tectonic` · Tectonic Slam
    stone · ZONE · Fissure + Shell(ring) · impact → propagate → settle
    THE TRICK — the fissures whip *outward on a clock*, five of them racing to the boundary at
    different speeds with the dust wave riding just behind each tip, so the footprint is drawn by
    motion rather than revealed all at once.
    Palette: `#8a7f6b` / `#463f34` / ember `#ff7a2a`.

## `boulder` · Rolling Ruin
    stone · LINE · Projectile(rolling) + GroundField · travel(roll) → impact → fade
    THE TRICK — it *rolls*. Real rolling: the boulder's rotation is derived from distance over
    radius, so it never skates, and it gouges a rut behind it whose depth follows the contact
    force. It shatters on arrival into its own asteroid geometry, sliced.
    Palette: `#6e6455` / `#39332b` / dust `#a89880`.

## `petrify` · Petrifying Gaze
    stone · LINE · GrowthField(facet) + VolumeHull(sand) · travel → hold → crumble
    THE TRICK — accretion then collapse. Grey facets *accrete out of the air* along the line —
    they grow inward toward the axis rather than up out of the floor — hold as a solid column, and
    then crumble: the facets shrink to nothing and are replaced, in place, by a raymarched fall of
    sand.
    Palette: `#9a948a` / `#565049` / `#221f1c`.

---

# V · VERDANT

## `thornwake` · Thornwake
    verdant · LINE · GrowthField(thorn) + FilamentPaths(link) · travel → impact → fade
    THE TRICK — the brambles *interlace*. Filaments are drawn between neighbouring thorn instances
    — each vine picks two instances by index and threads a sagging curve between them — so the
    field reads as one tangled mass rather than as scattered props.
    Palette: `#4a6b2a` / `#243d14` / thorn tips `#c8b06a`.

## `bloomburst` · Bloomburst
    verdant · ZONE · GrowthField(petal) + VolumeHull(pollen) · grow → open → burst
    THE TRICK — unfurling. Each flower is a ring of petals whose bend parameter runs from fully
    closed to fully open, driven per instance off a staggered clock, so the field opens in a wave
    across the circle. Then every petal releases at once into a pollen volume.
    Palette: `#f2d0e8` / `#a84f8a` / pollen `#ffe89a`.

## `sporefall` · Sporefall
    verdant · ZONE · VolumeHull(slab, low) · seep → hold → disperse
    THE TRICK — a volume that *hugs the floor*. The density field is heavily flattened in Y and
    advected outward, so it pours across the ground and pools in the middle instead of billowing.
    Bioluminescent motes drift up out of it and die at head height.
    Palette: `#7ad0a0` / `#2a6b4a` / glow `#c8ff9a`.

## `vinelash` · Verdant Lash
    verdant · LINE · Tube(grow) + Swarm(leaves) · travel(grow) → snap → wither
    THE TRICK — it grows rather than flies. The tube's length is the front, its radius tapers to
    nothing at the tip, and leaves unfurl along it as it passes. At full extension it *snaps back*
    — the whole curve recoils on a spring and the leaves are stripped off.
    Palette: `#6ba83a` / `#2a4a18` / `#c8d86a`.

## `grovecall` · Grovecall
    verdant · ZONE · GrowthField(tree) + Curtain(light shaft) · grow → hold → fade
    THE TRICK — scale contrast. Six trunks with canopies grow to three metres in half a second on a
    wave around the ring, and light shafts fall through the canopy onto the floor as real geometry
    — tapered translucent volumes, not a post effect.
    Palette: bark `#4a3a28`, leaf `#5f8a2a`, shaft `#e8f0c0`.

---

# VI · VOID

## `voidrift` · Void Rift
    void · LINE · Portal + Distortion · tear → hold → close
    THE TRICK — a hole. A slit in space along the line: pure black interior with a parallax
    starfield behind it that moves against the camera at the wrong rate, a white-hot fracture rim,
    and a distortion ring around the edge that bends the floor into it.
    Palette: interior `#000000`, rim `#ffffff` / `#b07aff`.

## `singularity` · Singularity
    void · ZONE · Distortion(lens) + Swarm · form → pull → collapse
    THE TRICK — screen-space lensing. The distortion pass, which has been sitting unused, finally
    earns its keep: a radial UV displacement whose magnitude goes as 1/r² inside a falloff, so the
    floor grid, the character and every particle behind it bend around the well. Everything nearby
    spirals in on real angular-momentum paths, and then it inverts.
    Palette: `#0a0612` / `#6a3fd0` / event horizon `#ffffff`.

## `umbralspears` · Umbral Spears
    void · LINE · GrowthField(spear) · travel → impact → fade
    THE TRICK — anti-glow. In a scene tuned for bloom, these are the only objects that are
    *darker* than the floor: near-black spears with a thin violet rim and a soft shadow pooled at
    their base, rendered with a rim-only shading model so their silhouette is all you get.
    Palette: `#050308` / rim `#8a5fd0`.

## `nightfall` · Nightfall
    void · ZONE · VolumeHull(dome) + GroundField · close → hold → open
    THE TRICK — subtractive light. The dome multiplies rather than adds: it genuinely darkens what
    is behind it, the floor texture goes to near-black under it, and the only things visible inside
    are a slow starfield and the caster's own dynamic light struggling against it.
    Palette: `#000000` / `#0a0a18` / stars `#c0d0ff`.

## `soulchain` · Soul Tether
    void · LINE · FilamentPaths(chain) + GrowthField(link) · throw → hold → snap
    THE TRICK — discrete links. Not a smooth filament: real chain links, instanced tori threaded
    along a sagging catenary, each one rotated 90° from its neighbour and free to swing. The chain
    goes taut with a snap and the links jangle.
    Palette: ghost-iron `#7a8a9a` / glow `#9affe0`.

---

# VII · ARCANE

## `runeseal` · Runic Seal
    arcane · ZONE · GroundField(glyph SDF) · inscribe → ignite → discharge
    THE TRICK — procedural glyphs. Three nested rings of runes drawn as real signed-distance
    letterforms in metres — strokes, terminals, counters — that *draw themselves* stroke by stroke
    as the seal inscribes, counter-rotate at different rates, and then ignite from the inside out.
    This is the showpiece ground shader; it should stand up to being paused and stared at.
    Palette: `#ffd27a` / `#ff8a2a` / `#2a1a0a`.

## `prismlance` · Prism Lance
    arcane · LINE · Tube + ShatterField(prism) · charge → fire → split
    THE TRICK — dispersion. The beam strikes a floating prism at mid-span and leaves it as a fan of
    six coloured child beams that continue to the target at slightly different angles, converging
    again at the end. The prism itself is a real refracting solid with an env-mapped surface.
    Palette: white in, spectrum out.

## `chronofracture` · Chronofracture
    arcane · ZONE · ShatterField(pane) + Distortion · freeze → hold → shatter
    THE TRICK — panes that hold a still image. Sheets of frozen time hang in the air over the zone
    sampling the scene behind them through the distortion/refraction path, desaturated and offset,
    so each pane shows a *slightly older, colder* version of what is behind it. Then they break.
    Palette: `#d0e8ff` / `#6a8ab0` / fracture `#ffffff`.

## `starfall` · Starfall
    arcane · ZONE · Projectile(swarm) + Shell · call → rain → fade
    THE TRICK — staggered arrivals with a shared vanishing point. Every star comes from the same
    point high above and behind the caster, so their trails converge in the sky and diverge on the
    ground — the parallax is what makes the sky feel like it is above you.
    Palette: `#ffffff` / `#c0d8ff` / `#3a5fd0`.

## `arcanevolley` · Arcane Volley
    arcane · LINE · Projectile(homing) + RibbonTrails · charge → volley → converge
    THE TRICK — parametric homing. Seven bolts leave the hand on Lissajous paths whose amplitude
    decays to zero at the target, so they weave apart, cross each other, and all arrive at the same
    point at the same instant without any of it being simulated.
    Palette: `#e0c0ff` / `#8a5fd0` / `#2a1a4a`.

## `glyphstorm` · Glyphstorm
    arcane · LINE · Swarm(card) + GroundField · gather → storm → disperse
    THE TRICK — a blizzard of legible marks. Several hundred instanced quads each rendering one
    procedural glyph, camera-facing but edge-on when they turn, so the storm flickers between a
    wall of symbols and a scatter of bright lines.
    Palette: `#ffe8c0` / `#c08a3a` / `#2a1a0a`.

---

# VIII · BLOOD

## `crimsontide` · Crimson Tide
    blood · LINE · LiquidSurface + Swarm(droplet) · surge → break → drain
    THE TRICK — a real wave. A heightfield wave travels the line with a curling crest whose front
    face is thin enough to be translucent, breaking into droplets at the lip. It drains back into
    the floor leaving wet, reflective stone.
    Palette: `#8a0f18` / `#3a050a` / crest `#ff4a4a`.

## `hemolance` · Hemorrhage
    blood · LINE · Projectile(volley) + Shell · volley → impact → pool
    THE TRICK — needles. Extremely thin, extremely fast lances that arrive in a ripple rather than
    together, each one leaving a hairline mist trail that persists for a moment after the needle
    has gone — the trail outlives the projectile, which is what makes the volley read.
    Palette: `#c01a28` / `#5a0a10`.

## `sanguinepact` · Sanguine Pact
    blood · ZONE · GroundField + VolumeHull(mist) + FilamentPaths(orbit) · draw → hold → seal
    THE TRICK — orbiting droplets. A pool on the floor sends up a slow mist column, and around it
    beads of blood climb in real orbits — instanced spheres on inclined ellipses with proper
    perspective — that flatten into the ring as the pact seals.
    Palette: `#7a0a14` / `#c81a28` / mist `#4a1018`.

## `plaguebloom` · Plague Bloom
    blood · ZONE · VolumeHull(boil) + GroundField(pustule) · seep → boil → burst
    THE TRICK — boiling. The gas volume's density is driven by a cellular field whose cells
    *inflate and pop* on individual timers, so the cloud has visible internal events rather than
    just drifting noise. The floor grows matching pustules that burst in sync.
    Palette: `#9aa83a` / `#4a5a18` / `#c8d86a`.

---

# IX · AETHER

## `cyclone` · Cyclone
    aether · ZONE · Tube(funnel) + FilamentPaths(spiral) + Swarm · form → hold → dissipate
    THE TRICK — the funnel profile. Radius follows a real vortex profile (tight throat, flared
    skirt at the floor, flared mouth at the top) and everything else — the debris ribbons, the dust
    skirt, the ground scour — is placed against that one function, so dragging the profile moves
    all of it together.
    Palette: `#c0c8d0` / `#6a7480` / `#20262c`.

## `slipstream` · Slipstream
    aether · LINE · Distortion(blade) + Tube(thin) · travel → cut → fade
    THE TRICK — almost nothing is drawn. A vacuum blade is a plane of pure refraction with a
    hairline bright edge; you see it because the world behind it slides, not because it has colour.
    The most restrained slot in the sandbox, and the proof that the distortion pass works.
    Palette: edge `#ffffff`, everything else is the scene bent.

## `resonance` · Resonant Chord
    aether · LINE · Shell(ring train) + Distortion · strike → ring → decay
    THE TRICK — standing waves. Rings travel out along the line at fixed spacing and *reflect* off
    the far end, so the outbound and returning trains interfere and you can see the nodes: places
    on the line where the air is still and places where it is violently compressed.
    Palette: `#d0f0ff` / `#5fa0c0` / `#102030`.

## `aurora` · Aurora Veil
    aether · ZONE · Curtain · rise → ripple → fade
    THE TRICK — curtains. Vertical sheets with a vertex-shader ripple travelling along their length
    and an emission that falls off with height on a different curve than the alpha, which is the
    thing that makes real aurora read as *light in air* rather than as a hanging ribbon.
    Palette: `#5fffc0` / `#3a9aff` / `#c05fff`.

## `skyfracture` · Sky Fracture
    aether · LINE · FilamentPaths(crack) + GroundField + Shell · flash → delay → fall
    THE TRICK — the reflection. A white fracture opens high above the cast line, and its *shadow
    and reflection* appear on the floor before anything else happens — you read the shape on the
    ground first, then the sky splits, then the pressure arrives. Reverse-ordered cause and effect.
    Palette: `#ffffff` / `#c0d0ff` / `#1a2a4a`.

---

## Slot summary

| # | school | line | zone |
| --- | --- | --- | --- |
| 3 | frost | rime, shatterlance | hail |
| 6 | flame | dragonbreath, firewhip, emberflock, sunspear | pyroclasm, magma |
| 5 | storm | chainarc, balllightning, stormwall, railcoil | thunderclap |
| 5 | stone | stonespine, boulder, petrify | sinkhole, tectonic |
| 5 | verdant | thornwake, vinelash | bloomburst, sporefall, grovecall |
| 5 | void | voidrift, umbralspears, soulchain | singularity, nightfall |
| 6 | arcane | prismlance, arcanevolley, glyphstorm | runeseal, chronofracture, starfall |
| 4 | blood | crimsontide, hemolance | sanguinepact, plaguebloom |
| 5 | aether | slipstream, resonance, skyfracture | cyclone, aurora |

**26 line casts, 18 far casts.** Plus the six that shipped: **50 abilities.**
