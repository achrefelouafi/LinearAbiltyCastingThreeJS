import { Mesh, Vector3 } from 'three';
import { Ability, AbilityPhase } from '../Ability.js';
import {
  createWildfirePlacement,
  createCellAttributes,
  createCellGeometry,
  createFlameGeometry,
  createCellMaterial,
  createFlameMaterial,
  setFlameGradient
} from '../../materials/WildfireMaterial.js';
import { VolumeHull, HullShape, Medium } from '../../vfx/VolumeHull.js';
import { GroundField, GroundMode, groundFieldParams } from '../../vfx/GroundField.js';
import { ParticleShape } from '../../particles/ParticleSystem.js';
import { RateEmitter } from '../../particles/ParticleEngine.js';
import { BurstMode } from '../../effects/BurstSphere.js';
import { LAYER } from '../../core/Layers.js';
import { frame } from '../../core/FrameUniforms.js';
import { settings } from '../../config/settings.js';
import { getColor } from '../../utils/color.js';
import { saturate, clamp, lerp, hash11, Easing } from '../../utils/math.js';

/** The largest lattice the buffers are built for. 30 × 30 = 900 cells. */
const MAX_GRID = 30;
const MAX_CELLS = MAX_GRID * MAX_GRID;

/** Cell states. Three is all an automaton like this needs. */
const UNBURNT = 0;
const BURNING = 1;
const SPENT = 2;

/**
 * The eight neighbours as `(dx, dy)` pairs, orthogonals first.
 *
 * Module scope and a typed array, because this is walked eight times per
 * burning cell per generation and an array literal in there would be the
 * allocation I3 forbids, several hundred times a second.
 */
const NEIGHBOURS = new Int8Array([1, 0, -1, 0, 0, 1, 0, -1, 1, 1, 1, -1, -1, 1, -1, -1]);
/** 1 / |offset|, so a diagonal's wind term is not √2 times an orthogonal's. */
const NEIGHBOUR_NORM = [1, 1, 1, 1, 0.7071, 0.7071, 0.7071, 0.7071];

/* Module-scope scratch. A running fire allocates nothing — I3. */
const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _centre = new Vector3();
const _front = new Vector3();
/** The scorch field's params bag, filled from settings every frame and reused. */
const _spot = groundFieldParams();

/** One lattice tap of value noise. A hash, so the map is reproducible per seed. */
function latticeValue(x, y, seed) {
  return hash11(x * 157.31 + y * 311.7 + seed * 13.7);
}

/**
 * Two-dimensional value noise on the fuel lattice.
 *
 * Written out here rather than borrowed from a shader chunk because the fuel
 * map is CPU state — the automaton has to *read* it to decide whether a cell
 * can catch — and a field that only the GPU can evaluate would leave the
 * simulation and the picture disagreeing about where the fuel is.
 */
function fuelNoise(x, y, seed) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  // Named for their corners rather than a, b, c, d: `c` is the settings alias
  // everywhere else in this file, and shadowing it here made the harness's
  // static cross-check lose track of which block the file reads.
  const n00 = latticeValue(x0, y0, seed);
  const n10 = latticeValue(x0 + 1, y0, seed);
  const n01 = latticeValue(x0, y0 + 1, seed);
  const n11 = latticeValue(x0 + 1, y0 + 1, seed);
  return lerp(lerp(n00, n10, sx), lerp(n01, n11, sx), sy);
}

/**
 * WILDFIRE — spread as a cellular automaton.
 *
 * A far cast. A dart of fire flies to the aimed circle, and where it lands a
 * handful of cells catch. From there the fire **spreads**: generation by
 * generation across a lattice, each burning cell rolling against its eight
 * neighbours, skewed by a wind, refusing ground with no fuel in it, throwing
 * the occasional ember over the top of whatever is in the way, and — because a
 * burnt cell keeps what the burn did not eat — sometimes catching again behind
 * its own front.
 *
 * ## THE TRICK — it is a simulation, not a curve
 *
 * Every other expanding effect in this sandbox is a radius with a ragged edge:
 * `grow` goes from 0 to 1 and a smoothstep does the rest. That is the right
 * answer for a shockwave and it is the wrong answer for fire, because the thing
 * that makes a fire front read as a fire front is that it is **not a function
 * of the radius**. It arrives at two points at different times for reasons that
 * are visible on the floor: the fuel ran out here, the wind pushed there, an
 * ember landed forty cells ahead and started a second fire that the first one
 * later joined.
 *
 * So `_generation()` below is the ability. It is about sixty lines, it runs at
 * `tickRate` generations a second, and everything the player sees is a *report*
 * of the array it maintains:
 *
 *  - the **scar** is one instanced quad per cell that has caught, so the
 *    unburnt islands are genuinely missing geometry rather than a darker patch
 *    of a texture;
 *  - the **flames** are one instanced billboard per cell, collapsed to nothing
 *    unless that cell is burning right now, so the front is wherever the state
 *    array says it is;
 *  - the **pall** is a single raymarched volume placed on the centroid of the
 *    burning cells and sized to their extent, so it follows the front around
 *    the islands instead of sitting over the middle of the circle;
 *  - a **spot fire** drops a scorch mark where its ember landed.
 *
 * ### What went wrong first
 *
 * The first version spread from a *queue* — every cell that caught pushed its
 * neighbours — and it filled the circle in two seconds flat with a boundary
 * that was, embarrassingly, a diamond. Two things were missing. There was no
 * generation boundary, so a cell lit early in the loop lit its neighbour later
 * in the same loop and the fire advanced at the speed of the iteration order;
 * and with a per-neighbour probability of 1 the reachable set of a Moore
 * neighbourhood *is* a diamond, no matter how the fuel is arranged. Both are
 * fixed here: a cell whose ignition timestamp is this generation is skipped,
 * and the catch is a roll against `spread × fuel`, so the boundary is a random
 * process rather than a metric ball.
 *
 * The second version had fuel but no `fuelFloor`, which meant every cell caught
 * eventually and the islands were merely *late* rather than unburnt. A late
 * island is invisible. It needs to be a hole.
 *
 * ## What a cast captures
 *
 * The fuel map (unitless, rolled once — it is the terrain), each cell's state,
 * and the timestamp it caught. The lattice *pitch* is
 * `2 · zoneRadius / grid` re-resolved every frame, so dragging the radius over
 * a paused fire rescales the whole burn with its pattern intact.
 *
 * The one thing that is deliberately not retroactive is the rule table itself:
 * a generation that has already happened is history, and `spread` takes effect
 * on the next one. Everything with a unit is live.
 *
 * ## Cost
 *
 * Four drawables — the scar, the flames, the pall, the scorch field — plus two
 * shared particle systems, and one dynamic light riding the front. The two
 * instanced meshes carry `grid²` instances each and cost one draw call each
 * whatever that number is.
 */
export class WildfireAbility extends Ability {
  constructor(context) {
    super('wildfire', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    this.placement = createWildfirePlacement();
    this.attributes = createCellAttributes(MAX_CELLS, MAX_GRID);

    this.cellGeometry = createCellGeometry(this.attributes);
    this.cellMaterial = createCellMaterial(this.placement);
    this.cellMesh = new Mesh(this.cellGeometry, this.cellMaterial);
    this.cellMesh.frustumCulled = false;
    this.cellMesh.matrixAutoUpdate = false;
    this.cellMesh.layers.set(LAYER.VFX);
    this.cellMesh.renderOrder = 7;
    this.group.add(this.cellMesh);

    this.flameGeometry = createFlameGeometry(this.attributes);
    this.flameMaterial = createFlameMaterial(this.placement);
    this.flameMesh = new Mesh(this.flameGeometry, this.flameMaterial);
    this.flameMesh.frustumCulled = false;
    this.flameMesh.matrixAutoUpdate = false;
    this.flameMesh.layers.set(LAYER.VFX);
    this.flameMesh.renderOrder = 12;
    this.group.add(this.flameMesh);

    /** The haze over the front. Follows the burning cells — see `_syncPall()`. */
    this.pall = new VolumeHull({
      hull: HullShape.CYLINDER,
      medium: Medium.FLAME,
      prefix: 'pall',
      maxSteps: 40,
      renderOrder: 13
    });
    this.group.add(this.pall.mesh);

    /**
     * Where the spot fires landed. `POCK` takes a list of unitless hits and
     * unions a bowl and a rim for each, which is exactly what an ember dropped
     * on stone leaves behind — and because the hits are fractions of the
     * radius, they re-place themselves when the zone is resized.
     */
    this.scorch = new GroundField(this.group, {
      mode: GroundMode.POCK,
      marks: 14,
      additive: false,
      name: 'Wildfire:scorch'
    });
    this.scorch.setVisible(false);

    /* ---- the automaton's state. Allocated once, at construction ---- */
    /** 0 unburnt, 1 burning, 2 spent. */
    this._state = new Uint8Array(MAX_CELLS);
    /** Fuel remaining in each cell, 0..1. The terrain, and what a burn eats. */
    this._fuel = new Float32Array(MAX_CELLS);
    /** Lattice width for this cast — a count, captured at spawn. */
    this._grid = MAX_GRID;
    /** Cells in play, `grid²`. */
    this._cells = 0;
    /** Seconds of unspent simulation time. */
    this._clock = 0;
    /** How many cells are burning right now, and where they are. */
    this._burning = 0;
    this._centroidX = 0;
    this._centroidY = 0;
    this._extent = 0;
    /** One dice roll per cast: the fuel map and the volume's grain. */
    this._seed = 0;
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Embers off the front. Additive and curled — hot, and going up.
    this.motes = particles.get('wildfire.motes', {
      capacity: 2400,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.35
    });
    this.motes.uniforms.uDrag.value = 1.2;
    this.motes.uniforms.uEndSize.value = 0.2;
    this.motes.uniforms.uSizeIn.value = 0.05;
    this.motes.uniforms.uFadeIn.value = 0.07;
    this.motes.uniforms.uFadeOut.value = 0.4;

    // The pall that gets off the burnt ground. Non-additive so it occludes.
    this.smoke = particles.get('wildfire.smoke', {
      capacity: 2000,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.2
    });
    this.smoke.uniforms.uDrag.value = 1.9;
    this.smoke.uniforms.uEndSize.value = 3.4;
    this.smoke.uniforms.uSizeIn.value = 0.12;
    this.smoke.uniforms.uFadeIn.value = 0.18;
    this.smoke.uniforms.uFadeOut.value = 0.32;

    this.moteEmitter = new RateEmitter();
    this.smokeEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  /** Cells currently burning — the honest readout of what this is drawing. */
  get instanceCount() {
    return this._burning;
  }

  /** The fire spreads freely... */
  get impactDuration() {
    return Math.max(0.1, settings.wildfire.holdTime * settings.global.lifetime);
  }

  /** ...and then runs out of anywhere to go. */
  get fadeDuration() {
    return Math.max(0.1, settings.wildfire.smoulderTime);
  }

  /** Fire gutters, on its own clock. */
  lightShimmer() {
    const c = settings.wildfire;
    const step = Math.floor(this.age * Math.max(1, c.lightFlickerSpeed));
    const noise = Math.abs(Math.sin(step * 78.233) * 43758.5453) % 1;
    return 1 - saturate(c.lightFlicker) * noise;
  }

  /* ------------------------------------------------------------------ */
  /* The lattice — counts here, metres only where they are resolved       */
  /* ------------------------------------------------------------------ */

  /** Metres between cell centres, right now. */
  _pitch() {
    return (2 * Math.max(0.2, settings.wildfire.zoneRadius)) / this._grid;
  }

  /** The middle of the zone: the far end of the aimed line. */
  _centrePoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /**
   * Where cell `index` is, in world space.
   *
   * A mirror of `cellCentre()` in the vertex shader, down to the jitter, which
   * is why the jitter is an attribute of dice rolls rather than a hash the two
   * sides would have to agree on to five decimal places.
   */
  _cellPoint(index, out) {
    const c = settings.wildfire;
    const pitch = this._pitch();
    const jitter = this.attributes.aJitter.array;
    const cell = this.attributes.aCell.array;
    const half = (this._grid - 1) * 0.5;
    const x = (cell[index * 2] - half) * pitch + jitter[index * 2] * pitch * c.cellJitter;
    const y = (cell[index * 2 + 1] - half) * pitch + jitter[index * 2 + 1] * pitch * c.cellJitter;
    this._centrePoint(out);
    out.addScaledVector(this.side, x).addScaledVector(this.direction, y);
    out.y = c.cellLift;
    return out;
  }

  /** The wind, in the lattice's own frame. `x` is lateral, `y` is downrange. */
  _windX() {
    const c = settings.wildfire;
    return Math.sin(c.windAngle) * c.windBias;
  }

  _windY() {
    const c = settings.wildfire;
    return Math.cos(c.windAngle) * c.windBias;
  }

  /* ------------------------------------------------------------------ */
  /* The automaton                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Roll the terrain.
   *
   * Two octaves of value noise on the lattice, clipped to the disc, biased and
   * clamped. The result is *the map*: a cast that finds a rich patch downwind
   * burns very differently from one that lands on gravel, and that difference
   * is visible on the floor for the whole burn.
   *
   * Rolled once per cast rather than resolved per frame, and that is
   * deliberate: this is a dice roll, not a dimension. `fuelScale` and
   * `fuelBias` therefore apply to the *next* cast, which is the same contract
   * a seed has.
   */
  _rollFuel() {
    const c = settings.wildfire;
    const g = this._grid;
    const scale = Math.max(0.2, c.fuelScale) / g;
    for (let y = 0; y < g; y++) {
      for (let x = 0; x < g; x++) {
        const i = y * g + x;
        const u = (x / (g - 1)) * 2 - 1;
        const v = (y / (g - 1)) * 2 - 1;
        if (u * u + v * v > 1) {
          // Outside the circle there is nothing to burn, so the fire stops at
          // the indicator without anything having to clamp it.
          this._fuel[i] = 0;
          continue;
        }
        const coarse = fuelNoise(x * scale, y * scale, this._seed);
        const fine = fuelNoise(x * scale * 2.7 + 11.3, y * scale * 2.7 - 7.1, this._seed + 3);
        this._fuel[i] = saturate(coarse * 0.68 + fine * 0.32 + c.fuelBias);
      }
    }
  }

  /** Light a cell, now. The one place `aIgnite` is written. */
  _catch(index, now) {
    const ignite = this.attributes.aIgnite.array;
    const fuel = this.attributes.aFuel.array;
    this._state[index] = BURNING;
    fuel[index] = this._fuel[index];
    ignite[index] = now;
    this.attributes.aIgnite.needsUpdate = true;
    this.attributes.aFuel.needsUpdate = true;
  }

  /**
   * One generation.
   *
   * Reads the rule table live, so the *next* generation always obeys the
   * sliders as they are now. Allocation-free: two integer loops and a typed
   * array of neighbour offsets.
   *
   * @param {number} now   the ability's age, the timestamp an ignition records
   * @param {number} gate  0..1 — the fade closes the spread down without
   *                       stopping the burn, so the fire runs out rather than
   *                       being switched off
   */
  _generation(now, gate) {
    const c = settings.wildfire;
    const g = this._grid;
    const state = this._state;
    const ignite = this.attributes.aIgnite.array;
    const held = this.attributes.aFuel.array;

    // The same product the cell shader burns on — `settings.global.lifetime`
    // included — or the simulation and the picture disagree about when a cell
    // goes out, and the flames outlive their own embers.
    const burnTime = Math.max(0.05, c.burnTime * settings.global.lifetime);
    const spread = saturate(c.spread) * saturate(gate);
    const windX = this._windX();
    const windY = this._windY();
    const floor = c.fuelFloor;

    for (let y = 0; y < g; y++) {
      for (let x = 0; x < g; x++) {
        const i = y * g + x;
        if (state[i] !== BURNING) continue;
        // The generation boundary. A cell lit during *this* generation carries
        // this timestamp, and skipping it is what stops the fire advancing at
        // the speed of the loop rather than at the speed of the rules.
        if (ignite[i] === now) continue;

        /* ---- does it light its neighbours? ---- */
        for (let n = 0; n < 8; n++) {
          const dx = NEIGHBOURS[n * 2];
          const dy = NEIGHBOURS[n * 2 + 1];
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= g || ny >= g) continue;

          const j = ny * g + nx;
          if (state[j] === BURNING) continue;

          const fuel = this._fuel[j];
          if (fuel < floor) continue;

          let p = spread * fuel;
          if (n >= 4) p *= c.diagonalBias;
          // The wind is a dot product, normalised so a diagonal step is not
          // rewarded for being longer. Downwind gets a bonus and upwind pays
          // for it, which is what turns the burn oval.
          p *= 1 + (dx * windX + dy * windY) * NEIGHBOUR_NORM[n];
          if (state[j] === SPENT) {
            if (fuel < c.reburnFloor) continue;
            p *= c.reburnChance;
          }
          if (Math.random() < p) this._catch(j, now);
        }

        /* ---- does it throw an ember over the top? ---- */
        if (Math.random() < c.spotChance * saturate(gate)) this._spotFire(x, y, now);

        /* ---- has it burnt out? ---- */
        const burn = Math.max(held[i], 0.05) * burnTime;
        if (now - ignite[i] >= burn) {
          state[i] = SPENT;
          // What the burn did not eat is still there, and is what lets the
          // front come back over its own ground later.
          this._fuel[i] *= 1 - saturate(c.consume);
        }
      }
    }
  }

  /**
   * An ember carried downwind, landing two to `spotRange` cells away.
   *
   * This is the rule that stops the burn being connected. A spot fire lands on
   * the far side of an island, starts a second front, and the two fronts meet
   * somewhere neither of them started — which is the shape nothing built out of
   * a growing radius can make.
   */
  _spotFire(x, y, now) {
    const c = settings.wildfire;
    const g = this._grid;
    const windX = this._windX();
    const windY = this._windY();

    // With no wind an ember goes anywhere; with wind it goes downwind, with a
    // splay wide enough that a run of them does not draw a line.
    const bearing =
      Math.abs(windX) + Math.abs(windY) < 1e-3
        ? Math.random() * Math.PI * 2
        : Math.atan2(windY, windX) + (Math.random() - 0.5) * 1.7;
    const reach = 2 + Math.floor(Math.random() * Math.max(1, Math.round(c.spotRange)));
    const nx = Math.round(x + Math.cos(bearing) * reach);
    const ny = Math.round(y + Math.sin(bearing) * reach);
    if (nx < 0 || ny < 0 || nx >= g || ny >= g) return;

    const j = ny * g + nx;
    if (this._state[j] === BURNING || this._fuel[j] < c.fuelFloor) return;
    this._catch(j, now);

    // A scorch where it landed. Unitless: fractions of the radius, a timestamp
    // and a strength, so the mark re-places itself when the zone is resized.
    const half = (g - 1) * 0.5;
    this.scorch.mark(
      clamp((nx - half) / half, -1, 1),
      clamp((ny - half) / half, -1, 1),
      frame.uTime.value,
      1
    );
  }

  /**
   * Advance the simulation by real time.
   *
   * **Only when the clock is running.** A zero-length frame does not step the
   * automaton, which is what makes the pause honest: press **P** and the fire
   * holds the generation it is on while every metre and colour stays live under
   * the sliders. It also keeps the harness's stability probe meaningful — a
   * simulation that ticked on a paused frame would report every slider as
   * responsive for the wrong reason.
   */
  _advance(dt, gate) {
    if (dt <= 0) return;
    const step = 1 / Math.max(1, settings.wildfire.tickRate);
    this._clock += dt;
    // Bounded: a huge dt (a tab coming back from the background) must not spend
    // a second of CPU catching up on generations nobody watched.
    let budget = 6;
    while (this._clock >= step && budget-- > 0) {
      this._clock -= step;
      this._generation(this.age, gate);
    }
    if (this._clock > step) this._clock = 0;
  }

  /**
   * Where the fire is, as counts and lattice coordinates.
   *
   * Everything downstream of this — the pall, the light, the ember emission —
   * asks the *state array* where to be, not the zone. That is what makes the
   * front the subject of the shot.
   */
  _measureFront() {
    const g = this._grid;
    const state = this._state;
    let count = 0;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < this._cells; i++) {
      if (state[i] !== BURNING) continue;
      count++;
      sx += i % g;
      sy += (i / g) | 0;
    }
    this._burning = count;
    if (count === 0) {
      this._extent = 0;
      return;
    }
    this._centroidX = sx / count;
    this._centroidY = sy / count;

    let extent = 0;
    for (let i = 0; i < this._cells; i++) {
      if (state[i] !== BURNING) continue;
      const dx = (i % g) - this._centroidX;
      const dy = ((i / g) | 0) - this._centroidY;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > extent) extent = d;
    }
    this._extent = extent;
  }

  /** A burning cell picked at random, or -1. The emitters' only question. */
  _randomBurning() {
    if (this._burning <= 0) return -1;
    let pick = Math.floor(Math.random() * this._burning);
    for (let i = 0; i < this._cells; i++) {
      if (this._state[i] !== BURNING) continue;
      if (pick-- <= 0) return i;
    }
    return -1;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    const c = settings.wildfire;

    this.moteEmitter.reset();
    this.smokeEmitter.reset();
    this.scorch.clearMarks();
    this.scorch.setVisible(false);

    this._seed = Math.random() * 100;
    // A count, not a dimension, and fixed for the cast: changing the lattice
    // width mid-burn would renumber every cell the automaton is holding.
    this._grid = clamp(Math.round(c.grid), 8, MAX_GRID);
    this._cells = this._grid * this._grid;
    this._clock = 0;
    this._burning = 0;
    this._centroidX = (this._grid - 1) * 0.5;
    this._centroidY = (this._grid - 1) * 0.5;
    this._extent = 0;

    // The lattice coordinate of a cell depends on the grid width, so it is
    // rewritten per cast. Writes into the array built at construction.
    const cell = this.attributes.aCell.array;
    const ignite = this.attributes.aIgnite.array;
    const fuel = this.attributes.aFuel.array;
    for (let i = 0; i < MAX_CELLS; i++) {
      cell[i * 2] = i % this._grid;
      cell[i * 2 + 1] = (i / this._grid) | 0;
      ignite[i] = -1;
      fuel[i] = 0;
      this._state[i] = UNBURNT;
      this._fuel[i] = 0;
    }
    this.attributes.aCell.needsUpdate = true;
    this.attributes.aIgnite.needsUpdate = true;
    this.attributes.aFuel.needsUpdate = true;

    this._rollFuel();
    this._sync(1);
    this._castFx();
  }

  /* ------------------------------------------------------------------ */
  /* The frame                                                           */
  /* ------------------------------------------------------------------ */

  _sync(fade) {
    this._centrePoint(_centre);
    this._measureFront();

    this.cellGeometry.instanceCount = this._cells;
    this.flameGeometry.instanceCount = this._cells;

    this._syncPlacement();
    this._syncCells(fade);
    this._syncFlames(fade);
    this._syncPall(fade);
    this._syncScorch(fade);
    this._syncParticles();
  }

  /** The lattice, the clock and where the zone is. Shared by both materials. */
  _syncPlacement() {
    const c = settings.wildfire;
    const p = this.placement;
    const pitch = this._pitch();
    p.uCentre.value.copy(_centre);
    p.uForward.value.copy(this.direction);
    p.uSideAxis.value.copy(this.side);
    p.uGrid.value = this._grid;
    p.uPitch.value = pitch;
    p.uJitter.value = pitch * c.cellJitter;
    p.uLift.value = c.cellLift;
    p.uNow.value = this.age;
  }

  _syncCells(fade) {
    const c = settings.wildfire;
    const g = settings.global;
    const u = this.cellMaterial.uniforms;

    u.uCellSize.value = this._pitch() * c.cellFill;
    u.uBlock.value = saturate(c.blockiness);
    u.uRough.value = c.cellRough * g.noiseStrength;
    u.uRoughScale.value = c.cellRoughScale * g.noiseFrequency;
    u.uCatchTime.value = c.catchTime;
    u.uBurnTime.value = c.burnTime * g.lifetime;
    u.uCharTime.value = c.charTime;
    u.uAshTime.value = c.ashTime;
    u.uVein.value = c.cellVein;
    u.uOpacity.value = c.cellOpacity * g.opacity;
    u.uGlow.value = c.cellGlow * g.glow;
    u.uFade.value = fade;
    u.uSoftFade.value = c.cellSoftFade;

    u.uColorFlash.value.copy(getColor(c.colorFlash));
    u.uColorEmber.value.copy(getColor(c.colorEmber));
    u.uColorChar.value.copy(getColor(c.colorChar));
    u.uColorAsh.value.copy(getColor(c.colorAsh));
  }

  _syncFlames(fade) {
    const c = settings.wildfire;
    const g = settings.global;
    const u = this.flameMaterial.uniforms;

    u.uHeight.value = c.flameHeight;
    u.uWidth.value = c.flameWidth;
    // The same two numbers the cell shader burns on, so a tongue cannot outlive
    // the ember under it.
    u.uCatchTime.value = c.catchTime;
    u.uBurnTime.value = c.burnTime * g.lifetime;
    u.uLean.value = c.flameLean;
    u.uWind.value.set(this._windX(), this._windY());
    u.uWaver.value = c.flameWaver;
    u.uWaverRate.value = c.flameWaverRate;

    u.uTaper.value = c.flameTaper;
    u.uBulge.value = c.flameBulge;
    u.uNoiseScale.value = c.flameNoiseScale * g.noiseFrequency;
    u.uNoiseSpeed.value = c.flameNoiseSpeed * g.noiseSpeed;
    u.uErosion.value = c.flameErosion * g.noiseStrength;
    u.uOpacity.value = c.flameOpacity * g.opacity;
    u.uGlow.value = c.flameGlow * g.glow;
    u.uFade.value = fade;
    u.uSoftFade.value = c.flameSoftFade;

    setFlameGradient(this.flameMaterial, c.colorFlameA, c.colorFlameB, c.colorFlameC, c.colorFlameD);
  }

  /** The volume, placed on the centroid of the burning cells and sized to them. */
  _syncPall(fade) {
    const c = settings.wildfire;
    const g = settings.global;

    if (this._burning <= 0) {
      this.pall.setFade(0).sync(c, g);
      return;
    }

    const pitch = this._pitch();
    const half = (this._grid - 1) * 0.5;
    _front
      .copy(_centre)
      .addScaledVector(this.side, (this._centroidX - half) * pitch)
      .addScaledVector(this.direction, (this._centroidY - half) * pitch);

    // Margin holds the flame that far inside the proxy, so the hull is sized up
    // by exactly that or the volume is sliced along a straight line at the wall.
    const k = Math.max(1, c.pallSlack) / Math.max(0.2, 1 - c.pallMargin);
    const radius = Math.max(pitch, (this._extent + 1) * pitch * c.pallSpread);
    const weight = saturate(this._burning / Math.max(1, c.pallCells));

    this.pall
      .place(_front)
      .setSize(radius * k, c.pallHeight * k, radius * k)
      .setFade(fade * weight)
      .sync(c, g);
  }

  _syncScorch(fade) {
    const c = settings.wildfire;
    const g = settings.global;

    _spot.centre = _centre;
    _spot.yaw = Math.atan2(this.direction.x, this.direction.z);
    _spot.height = c.spotHeight;
    _spot.radius = Math.max(0.2, c.zoneRadius);
    _spot.grow = 1;
    _spot.recede = 0;
    _spot.fade = fade;
    _spot.seed = this._seed;

    _spot.edge = c.spotEdge;
    _spot.ragged = c.spotRagged;
    _spot.raggedScale = c.spotRaggedScale;
    _spot.warp = c.spotWarp;

    _spot.relief = c.spotRelief;
    _spot.normalStep = c.spotNormalStep;
    _spot.ambient = c.spotAmbient;
    _spot.wrap = c.spotWrap;
    _spot.specular = c.spotSpecular;
    _spot.gloss = c.spotGloss;
    _spot.parallax = c.spotParallax;

    _spot.depth = c.spotDepth;
    _spot.lift = c.spotLift;
    _spot.markLife = c.spotMarkLife;
    _spot.markRadius = c.spotMarkRadius;

    _spot.additive = false;
    _spot.emissive = c.spotEmissive;
    _spot.opacity = c.spotOpacity;
    _spot.depthFade = c.spotDepthFade;
    _spot.colorBase = c.colorSpotBase;
    _spot.colorEdge = c.colorSpotEdge;
    _spot.colorGlow = c.colorSpotGlow;
    _spot.colorDeep = c.colorSpotDeep;

    _spot.noiseStrength = g.noiseStrength;
    _spot.noiseFrequency = g.noiseFrequency;
    _spot.noiseSpeed = g.noiseSpeed;
    _spot.opacityScale = g.opacity;

    this.scorch.update(_spot);
    this.scorch.setVisible(this.phase !== AbilityPhase.TRAVEL && fade > 0.004);
  }

  _syncParticles() {
    const c = settings.wildfire;
    const g = settings.global;

    this.motes.setGradient(
      getColor(c.colorMoteA),
      getColor(c.colorMoteB),
      getColor(c.colorMoteC),
      getColor(c.colorMoteD)
    );
    this.motes.uniforms.uGravity.value.set(0, c.moteRise, 0);
    this.motes.uniforms.uSizeScale.value = c.moteSize * g.particleSize * 7;
    this.motes.uniforms.uLifeScale.value = c.moteLifetime * 0.5 * g.particleLifetime;
    this.motes.uniforms.uSpeedScale.value = g.particleSpeed;
    this.motes.uniforms.uOpacity.value = g.opacity;
    this.motes.uniforms.uGlow.value = c.moteGlow * g.glow;
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;

    this.smoke.setGradient(
      getColor(c.colorSmokeA),
      getColor(c.colorSmokeB),
      getColor(c.colorSmokeC),
      getColor(c.colorSmokeD)
    );
    this.smoke.uniforms.uGravity.value.set(0, c.smokeRise, 0);
    this.smoke.uniforms.uSizeScale.value = c.smokeSize * g.particleSize;
    this.smoke.uniforms.uLifeScale.value = c.smokeLifetime * 0.5 * g.particleLifetime;
    this.smoke.uniforms.uSpeedScale.value = c.smokeSpeed * g.particleSpeed;
    this.smoke.uniforms.uOpacity.value = c.smokeOpacity * g.opacity;
    this.smoke.uniforms.uTurbulence.value = 0.35 * g.turbulence;
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /** The dart leaving the hand. */
  _castFx() {
    const c = settings.wildfire;
    const g = settings.global;

    _pos.copy(this.origin).addScaledVector(this.direction, c.handForward);
    _pos.y = c.handHeight;

    _emit.position = _pos;
    _emit.radius = 0.18;
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.8).setY(0.4).normalize();
    _emit.speed = c.moteSpeed * 3;
    _emit.speedVariance = 0.8;
    _emit.spread = 0.7;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.09;
    _emit.sizeVariance = 0.7;
    _emit.life = c.moteLifetime * 0.6;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.motes.emit(Math.round(18 * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.3 * g.explosionIntensity;
  }

  /** Embers and smoke, born on cells the automaton says are burning. */
  _frontFx(dt, scale) {
    const c = settings.wildfire;
    const g = settings.global;
    const time = frame.uTime.value;
    if (this._burning <= 0) return;

    const moteCount = Math.round(this.moteEmitter.tick(dt, c.moteRate * scale) * g.particleCount);
    if (moteCount > 0) {
      const pick = this._randomBurning();
      if (pick >= 0) {
        this._cellPoint(pick, _pos);
        _emit.position = _pos;
        _emit.radius = this._pitch() * 0.6;
        _emit.direction = _dir.set(this._windX() * 0.3, 1, this._windY() * 0.3).normalize();
        _emit.speed = c.moteSpeed;
        _emit.speedVariance = 0.85;
        _emit.spread = 0.8;
        _emit.inherit = null;
        _emit.anchor = null;
        _emit.size = 0.07;
        _emit.sizeVariance = 0.7;
        _emit.life = c.moteLifetime;
        _emit.lifeVariance = 0.5;
        _emit.spin = 0;
        _emit.tint = null;
        _emit.time = time;
        this.motes.emit(moteCount, _emit);
      }
    }

    const smokeCount = Math.round(this.smokeEmitter.tick(dt, c.smokeRate * scale) * g.particleCount);
    if (smokeCount > 0) {
      const pick = this._randomBurning();
      if (pick >= 0) {
        this._cellPoint(pick, _pos).setY(0.2);
        _emit.position = _pos;
        _emit.radius = this._pitch() * 1.5;
        _emit.direction = _dir.set(this._windX() * 0.4, 1, this._windY() * 0.4).normalize();
        _emit.speed = c.smokeSpeed;
        _emit.speedVariance = 0.7;
        _emit.spread = 0.9;
        _emit.inherit = null;
        _emit.anchor = null;
        _emit.size = 0.9;
        _emit.sizeVariance = 0.5;
        _emit.life = c.smokeLifetime;
        _emit.lifeVariance = 0.4;
        _emit.spin = 0.4;
        _emit.tint = null;
        _emit.time = time;
        this.smoke.emit(smokeCount, _emit);
      }
    }
  }

  /** The light rides the centroid of what is actually burning. */
  _placeLight() {
    const c = settings.wildfire;
    if (this._burning <= 0) {
      this._centrePoint(this.position);
      this.position.y = c.lightHeight;
      return;
    }
    const pitch = this._pitch();
    const half = (this._grid - 1) * 0.5;
    this._centrePoint(this.position)
      .addScaledVector(this.side, (this._centroidX - half) * pitch)
      .addScaledVector(this.direction, (this._centroidY - half) * pitch);
    this.position.y = c.lightHeight;
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._sync(1);
    // Nothing is burning yet; the light rides the dart.
    this.position.y = 0.6;
    this.ctx.shake.rumble(settings.wildfire.rumble * 0.4 * settings.global.cameraShake, dt);
  }

  /** The dart lands: a handful of cells catch, and the automaton takes over. */
  onImpact() {
    const c = settings.wildfire;
    const g = settings.global;
    const grid = this._grid;
    const half = (grid - 1) * 0.5;

    this._centrePoint(_centre);

    const seeds = Math.max(1, Math.round(c.seeds));
    for (let s = 0; s < seeds; s++) {
      // The first seed lands dead centre; the rest scatter, so a cast that
      // lands on a bare patch still has somewhere to start.
      const angle = Math.random() * Math.PI * 2;
      const reach = s === 0 ? 0 : Math.sqrt(Math.random()) * saturate(c.seedSpread) * half;
      const x = clamp(Math.round(half + Math.cos(angle) * reach), 0, grid - 1);
      const y = clamp(Math.round(half + Math.sin(angle) * reach), 0, grid - 1);
      const i = y * grid + x;
      // A seed ignores the fuel floor — something has to start, and a dart of
      // fire landing on gravel would still light the gravel.
      if (this._fuel[i] <= 0) this._fuel[i] = c.fuelFloor;
      this._catch(i, this.age);
    }

    _pos.copy(_centre).setY(0.35);
    this.ctx.bursts.spawn(BurstMode.FIRE, _pos, {
      radius: c.burstSize * 0.25,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.65,
      intensity: c.burstIntensity,
      opacity: 0.8,
      fresnel: 1.4,
      displace: 0.7,
      squash: 0.6,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    this.ctx.shake.add(
      c.landShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      22
    );
    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.landFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.8 * g.explosionIntensity;
  }

  onFade(dt, t) {
    // `t` runs 0..1 while the fire spreads freely, then 1..2 while it runs out.
    // The spread is closed down over the second half rather than switched off:
    // a fire that stops catching all at once reads as somebody turning a tap.
    const gate = t <= 1 ? 1 : 1 - Easing.inQuad(saturate(t - 1));
    const fade = t <= 1 ? 1 : 1 - Easing.inCubic(saturate(t - 1) * 0.85);

    this._advance(dt, gate);
    this._sync(fade);
    this._placeLight();
    this._frontFx(dt, fade);
    this.ctx.shake.rumble(settings.wildfire.rumble * fade * settings.global.cameraShake, dt);
  }

  onDestroy() {
    this._burning = 0;
    this._cells = 0;
    this._clock = 0;
    this.cellGeometry.instanceCount = 0;
    this.flameGeometry.instanceCount = 0;
    this.cellMaterial.uniforms.uFade.value = 0;
    this.flameMaterial.uniforms.uFade.value = 0;
    this.pall.setFade(0);
    this.scorch.setVisible(false);
    this.scorch.clearMarks();
  }

  dispose() {
    this.cellGeometry.dispose();
    this.flameGeometry.dispose();
    this.cellMaterial.dispose();
    this.flameMaterial.dispose();
    this.pall.dispose();
    this.scorch.dispose();
    super.dispose();
  }
}
