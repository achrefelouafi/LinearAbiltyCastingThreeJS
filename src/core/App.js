import { Vector3, MathUtils } from 'three';

import { Renderer } from './Renderer.js';
import { Time } from './Time.js';
import { CameraRig } from './CameraRig.js';
import { frame } from './FrameUniforms.js';

import { Environment } from '../world/Environment.js';
import { Ground } from '../world/Ground.js';
import { DustMotes } from '../world/DustMotes.js';
import { ContactShadows } from '../world/ContactShadows.js';

import { AssetLoader } from '../loaders/AssetLoader.js';
import { CharacterController } from '../animation/CharacterController.js';

import { InputManager } from '../input/InputManager.js';
import { AimController } from '../input/AimController.js';

import { ParticleEngine } from '../particles/ParticleEngine.js';
import { LightPool } from '../effects/LightPool.js';
import { DecalSystem } from '../effects/GroundDecals.js';
import { FissureSystem } from '../effects/GroundFissures.js';
import { BurstSystem } from '../effects/BurstSphere.js';
import { CameraShake } from '../effects/CameraShake.js';
import { ScreenFlash } from '../effects/ScreenFlash.js';

import { AbilityManager } from '../abilities/AbilityManager.js';
import { PostProcessing } from '../postprocessing/PostProcessing.js';
import { sceneHooks } from '../vfx/SceneHooks.js';

import { HUD, LoadingScreen } from '../ui/HUD.js';
import { Editor } from '../ui/Editor.js';
import { Loadout } from '../ui/Loadout.js';
import { Spellbook } from '../ui/Spellbook.js';

import { settings, ELEMENTS } from '../config/settings.js';
import { getAbility } from '../abilities/registry.js';

const HDR_URL = './hdri/spruit_sunrise.hdr';

/**
 * Application root: owns every subsystem and the frame loop.
 *
 * The wiring is deliberately one-directional — App builds the systems, hands the
 * ability manager a context object of the shared services, and then does nothing
 * but order the per-frame updates. No subsystem reaches back into App.
 *
 * The interaction is a single loop: select and arm an ability (Q / E), swing the
 * ground arrow with the mouse, click to fire. `AimController` owns the targeting
 * and emits one `cast` event; App turns that into an ability, a heading for the
 * character and a cooldown.
 */
export class App {
  constructor(canvas) {
    this.canvas = canvas;
    this.time = new Time();
    this.elapsed = 0;
    this.paused = false;
    this._raf = 0;

    /**
     * Seconds left before each ability can be armed again. Per element, so
     * spending one slot never locks the other out.
     */
    this.cooldowns = new Map(ELEMENTS.map((element) => [element, 0]));

    /* ---- core ---- */
    this.renderer = new Renderer(canvas);
    this.rig = new CameraRig(canvas);
    this.camera = this.rig.camera;

    this.environment = new Environment(this.renderer, this.camera);
    this.scene = this.environment.scene;

    /* ---- world ---- */
    this.ground = new Ground(this.environment);
    this.dust = new DustMotes();
    this.contactShadows = new ContactShadows(this.renderer, { size: 2.6, height: 2.4, blur: 2.0 });

    this.scene.add(this.ground.mesh, this.dust.points, this.contactShadows.group);
    this.dust.setPixelRatio(this.renderer.gl.getPixelRatio());

    /* ---- shared VFX services ---- */
    this.particles = new ParticleEngine(this.scene);
    this.lights = new LightPool(this.scene);
    this.decals = new DecalSystem(this.scene);
    this.fissures = new FissureSystem(this.scene);
    this.bursts = new BurstSystem(this.scene);
    this.shake = new CameraShake(this.rig);
    this.flash = new ScreenFlash();

    this.abilities = new AbilityManager({
      scene: this.scene,
      camera: this.camera,
      environment: this.environment,
      particles: this.particles,
      lights: this.lights,
      decals: this.decals,
      fissures: this.fissures,
      bursts: this.bursts,
      shake: this.shake,
      flash: this.flash
    });

    /* ---- character ---- */
    this.character = new CharacterController(this.environment);
    this.scene.add(this.character.root);

    /* ---- the loadout: eight slots over fifty abilities ---- */
    // Built before the input manager and the HUD because both are views of it.
    this.loadout = new Loadout();

    /* ---- input & targeting ---- */
    this.input = new InputManager(canvas, { slotKeys: this.loadout.keys });
    this.aim = new AimController(this.camera);
    this.scene.add(this.aim.object3D);

    /* ---- post ---- */
    this.post = new PostProcessing(this.renderer, this.scene, this.camera);

    /* ---- the world an ability is allowed to borrow ---- */
    // `vfx/SceneHooks.js` is the only module that reaches out of an ability's
    // group and edits the scene itself. It is handed the four things it may
    // touch and nothing else; leaving any of them out disables exactly one
    // hook. Done here, before the first frame, so the floor's ageing patch is
    // composed into the material before `compileAsync()` sees it.
    sceneHooks.install({
      scene: this.scene,
      environment: this.environment,
      ground: this.ground,
      grade: this.post.gradePass.uniforms,
      renderer: this.renderer
    });

    /* ---- UI ---- */
    this.loading = new LoadingScreen();
    this.hud = new HUD(document.getElementById('hud'), this.loadout);
    this.editor = new Editor({
      onClear: () => this.clearEffects(),
      onToast: (message) => this.hud.showToast(message)
    });
    this.spellbook = new Spellbook(document.getElementById('spellbook'), {
      loadout: this.loadout,
      onSelect: (id) => this.armAbility(id),
      onBind: (slot, id) => this.bindSlot(slot, id),
      onToast: (message) => this.hud.showToast(message),
      onToggle: (open) => this.hud.setBookOpen(open)
    });

    this._bindEvents();
    // Whatever is in slot one, or — on a loadout somebody has emptied — the
    // first thing in the registry, so the app never boots with nothing armed.
    this.selectAbility(this.loadout.idAt(0) ?? ELEMENTS[0], { silent: true });

    this._focusPoint = new Vector3();
  }

  /** The ability currently in the slot. */
  get element() {
    return this.abilities.selected;
  }

  /* ------------------------------------------------------------------ */

  _bindEvents() {
    this.renderer.onResize((width, height, pixelRatio) => {
      this.rig.resize(width, height);
      this.post.setSize(width, height, pixelRatio);
      this.dust.setPixelRatio(pixelRatio);
    });

    this.input.on('pointer:move', (pointer) => this.aim.point(pointer));
    this.input.on('pointer:confirm', (pointer) => {
      this.aim.point(pointer);
      this.aim.confirm();
    });
    this.input.on('action', (action, slot) => this._handleAction(action, slot));

    this.aim.on('cast', (origin, direction, distance) => this._cast(origin, direction, distance));
    this.aim.on('reject', () => this.hud.showToast('Too close — aim further out'));

    this.hud.onAbility = (element) => this.armAbility(element);
    this.hud.onInspect = (element) => this.inspectAbility(element);
    this.hud.onEmptySlot = (slot) => this.spellbook.open({ slot });
    this.hud.onBind = (slot, element) => this.bindSlot(slot, element);

    // The key table is a view of the loadout, so it is rebuilt with it. Today
    // the letters are fixed and this is a no-op; the day a slot's letter is
    // editable it is the only wiring that needs to already exist.
    this.loadout.on('change', () => this.input.setSlotKeys(this.loadout.keys));
  }

  _handleAction(action, slot) {
    switch (action) {
      case 'ability': {
        const element = this.loadout.idAt(slot);
        if (!element) {
          // An empty slot is an invitation, not an error: open the book with
          // that slot as the target so the key the player just pressed is the
          // key the next click binds.
          this.spellbook.open({ slot });
          break;
        }
        // Pressing the *same* key again puts an armed cast away, as it does in a
        // MOBA; pressing a different one swaps the slot without disarming.
        if (this.aim.isArmed && element === this.element) this.aim.cancel();
        else this.armAbility(element);
        break;
      }
      case 'toggleSpellbook':
        this.spellbook.toggle();
        break;
      case 'cancel':
        this.aim.cancel();
        break;
      case 'toggleHelp':
        this.hud.toggleHelp();
        break;
      case 'toggleEditor':
        this.editor.toggle();
        break;
      case 'clear':
        this.clearEffects();
        this.hud.showToast('Effects cleared');
        break;
      case 'togglePause':
        this.paused = !this.paused;
        this.hud.setPaused(this.paused);
        this.hud.showToast(this.paused ? 'Paused — the editor still applies' : 'Resumed');
        break;
      default:
        break;
    }
  }

  /**
   * Put an ability in the slot. The aim indicator and the HUD both follow,
   * because `range` and `minRange` are the ability's, not the app's.
   *
   * Selecting is also where the ability's class is **warmed**: its module is
   * imported and one pooled instance is built, off the frame loop, behind the
   * arrow sweeping out. Ability classes are lazy so that fifty of them are not
   * constructed at boot, and this is the moment that buys back — selection
   * always precedes the click by at least a frame, usually by seconds. The
   * promise is deliberately dropped; a cast that somehow beats the import is
   * handled by `AbilityManager#cast` returning null.
   *
   * The editor follows the slot too. With fifty ability folders in the panel
   * the one worth looking at is almost always the one about to be cast, so
   * selecting opens that folder and scrolls it up — except on the silent
   * boot-time selection, where the panel must still come up fully collapsed.
   */
  selectAbility(element, options = {}) {
    if (!getAbility(element)) return;
    this.abilities.select(element);
    this.abilities.warm(element);
    this.aim.setElement(element);
    this.hud.setElement(element, options);
    this.spellbook.setSelected(element);
    this.editor.focusAbility(element, { open: !options.silent });
  }

  /**
   * Bind an ability to a loadout slot, from a drag or from the spellbook.
   *
   * Binding does not select: dragging a spell onto slot 7 while holding a
   * charged beam should not throw the beam away.
   */
  bindSlot(slot, element) {
    const ability = getAbility(element);
    if (!ability) return;
    if (!this.loadout.bind(slot, element)) {
      // The commonest refusal by far is "it is already in that slot" — a
      // shift-click on a spell that is already on the bar. Say so, because a
      // click that does nothing at all reads as a broken target.
      if (this.loadout.idAt(slot) === element) {
        this.hud.showToast(`${ability.label} is already on ${this.loadout.keyAt(slot)}`);
      }
      return;
    }
    this.abilities.warm(element);
    this.hud.showToast(`${ability.label} bound to ${this.loadout.keyAt(slot)}`);
  }

  /**
   * Open this ability's folder in the editor.
   *
   * Wired to the slot's *name*, not to selection. Jumping a 1900-line settings
   * tree to a new folder every time the player taps a different key is the kind
   * of helpfulness that makes a UI unusable, so it takes a deliberate click.
   * `focusAbility` is the editor's, and is feature-detected rather than
   * assumed: the schema-driven editor lands separately, and until it does the
   * click says where to look instead of throwing.
   */
  inspectAbility(element) {
    const ability = getAbility(element);
    if (!ability) return;
    if (typeof this.editor.focusAbility === 'function') {
      this.editor.focusAbility(element);
      this.hud.showToast(`${ability.label} — editor`);
    } else {
      this.hud.showToast(`${ability.label} — press G for the editor`);
    }
  }

  /** Select an ability and arm it, unless it is still cooling down. */
  armAbility(element = this.element) {
    if ((this.cooldowns.get(element) ?? 0) > 0) {
      this.hud.showToast('Not ready');
      return;
    }
    // Selecting before arming means the arrow is already drawn to the new
    // ability's range on the frame it appears.
    if (element !== this.element) this.selectAbility(element);
    this.aim.arm();
  }

  _cast(origin, direction, distance) {
    const element = this.element;
    this.abilities.cast(origin, direction, distance, element);
    this.cooldowns.set(element, Math.max(0, settings[element].cooldown));

    // Snap onto the shot and throw the body into it. Which clip that is belongs
    // to the ability, so each spell can be cast with its own gesture.
    this.character.setFacing(this.aim.facing);
    this.character.playCast(settings[element].castAnim);
    this.character.castLunge();
  }

  clearEffects() {
    this.aim.cancel();
    this.abilities.clear();
    this.particles.reset();
    this.decals.clear();
    this.fissures.clear();
    this.bursts.clear();
    this.lights.reset();
    this.shake.reset();
    this.flash.reset();
  }

  /* ------------------------------------------------------------------ */

  /** Load assets, warm the shader cache, then start the loop. */
  async load() {
    const assets = new AssetLoader();

    this.loading.setProgress(0.05, 'Loading environment…');
    const hdr = await assets.loadHDR(HDR_URL);
    await this.environment.loadEnvironment(hdr);
    frame.uEnvMap.value = this.environment.equirect;

    this.loading.setProgress(0.35, 'Loading floor…');
    await this.ground.loadTextures(assets);

    this.loading.setProgress(0.5, 'Loading character…');
    await this.character.load(assets);

    this.loading.setProgress(0.85, 'Compiling shaders…');
    // Compile everything up front so the first cast never stutters.
    await this.renderer.gl.compileAsync(this.scene, this.camera);

    this.loading.setProgress(1, 'Ready');
    this.loading.hide();

    this.start();
  }

  start() {
    this.time.reset();
    const loop = () => {
      this._raf = requestAnimationFrame(loop);
      this.frame();
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this._raf);
  }

  /* ------------------------------------------------------------------ */

  frame() {
    const gl = this.renderer.gl;
    gl.info.reset();

    const raw = this.time.tick();
    const dt = this.paused ? 0 : raw * settings.global.timeScale;
    this.elapsed += dt;

    /* ---- shared uniforms ---- */
    frame.uTime.value = this.elapsed;
    frame.uDelta.value = dt;
    frame.uShaderIntensity.value = settings.global.shaderIntensity;
    frame.uGlobalGlow.value = settings.global.glow;
    frame.uCameraNear.value = this.camera.near;
    frame.uCameraFar.value = this.camera.far;

    /* ---- simulation ---- */
    this.renderer.syncSettings();

    this.environment.setFocus(this.character.position.x, this.character.position.z);
    this.environment.update();

    // Targeting runs on *real* time so the arrow keeps sweeping and animating
    // while the sandbox is paused — pausing freezes the effects, not the UI.
    this.aim.setOrigin(this.character.position);
    this.aim.update(raw);

    if (settings.character.turnToAim && this.aim.isArmed) {
      this.character.turnToward(this.aim.facing, settings.character.turnRate, raw);
    }
    this.character.update(dt);

    for (const [element, remaining] of this.cooldowns) {
      if (remaining > 0) this.cooldowns.set(element, Math.max(0, remaining - raw));
    }

    this.ground.update(this.elapsed);
    this.dust.update(this.elapsed, this.character.position);

    this.abilities.update(dt);
    this.particles.flush();
    this.decals.update(dt);
    this.fissures.update(dt);
    this.bursts.update(dt);
    this.lights.update(dt);

    /* ---- camera ---- */
    const focus = this.abilities.focus;
    if (focus) this.rig.lookAt(focus.position, MathUtils.clamp(1 - focus.u * 0.4, 0, 1));
    this.rig.setAnchor(this.character.position.x, 0, this.character.position.z);
    this.shake.update(raw);
    this.flash.update(raw);
    this.rig.update(raw);

    this.contactShadows.setPosition(this.character.position.x, this.character.position.z);
    this.contactShadows.render(this.scene);

    /* ---- render ---- */
    // Exactly one cascade shadow update per frame (see Renderer).
    gl.shadowMap.needsUpdate = true;
    this.post.sync(this.elapsed, this.flash);
    // The one place a borrowed hook lands on the world, and the only position
    // that works for all six: the environment has re-authored the key light
    // from settings, `post.sync()` has re-authored the grade, and nothing has
    // rendered yet — including the shadow map, which three refreshes inside the
    // first `gl.render()` below. Costs one integer compare when nothing is held.
    sceneHooks.apply();
    this.post.render();

    /* ---- readouts ---- */
    for (const element of ELEMENTS) {
      this.hud.setCooldown(element, this.cooldowns.get(element) ?? 0, settings[element].cooldown);
    }
    this.hud.setArmed(this.aim.isArmed);
    this.hud.update(raw, () => ({
      particles: this.particles.countLive(this.elapsed),
      calls: gl.info.render.calls,
      spikes: this.abilities.active.reduce((total, ability) => total + ability.instanceCount, 0),
      abilities: this.abilities.active.length
    }));
  }

  /* ------------------------------------------------------------------ */

  dispose() {
    this.stop();
    this.input.dispose();
    this.aim.dispose();
    this.abilities.dispose();
    this.particles.dispose();
    this.decals.dispose();
    this.fissures.dispose();
    this.bursts.dispose();
    this.lights.dispose();
    this.character.dispose();
    this.ground.dispose();
    this.dust.dispose();
    this.contactShadows.dispose();
    sceneHooks.uninstall();
    this.post.dispose();
    this.environment.dispose();
    this.spellbook.dispose();
    this.hud.dispose();
    this.editor.dispose();
    this.rig.dispose();
    this.renderer.dispose();
  }
}
