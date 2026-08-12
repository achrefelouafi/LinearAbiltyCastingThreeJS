import {
  WebGLRenderTarget,
  MeshDepthMaterial,
  RGBADepthPacking,
  Vector2,
  Color,
  HalfFloatType
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GradeShader } from './GradeShader.js';
import { DistortionShader } from './DistortionShader.js';
import { LAYER, distortionWriters } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';

const DISTORTION_CLEAR = new Color(0.5, 0.5, 0.0);

/** `post.distortionScale` is clamped here: below this the warp visibly stairsteps. */
const MIN_DISTORTION_SCALE = 0.25;

/**
 * The full render pipeline.
 *
 * Per frame:
 *   1. depth prepass  — opaque WORLD layer into a packed-depth buffer, which
 *                       every VFX shader samples for soft intersections
 *   2. distortion     — DISTORTION layer into an offset buffer, *if anything is
 *                       writing to it*
 *   3. composer       — scene → refraction → bloom → tone map → grade
 *
 * Pass 1 runs at half resolution and pass 2 at `post.distortionScale` of it:
 * both are only ever read as smooth, low-frequency data, so full resolution
 * would be wasted fill rate.
 *
 * ## The distortion pass
 *
 * This used to be dead weight — the README carried "the distortion pass runs
 * with nothing writing to it, it costs a half-res clear per frame" as a known
 * rough edge. `vfx/Distortion.js` now writes to it, and the accounting works
 * both ways: `core/Layers.js#distortionWriters` counts the meshes currently
 * *visible* on the layer, and when that count is zero the clear, the draw and
 * the full-res resample are all skipped. An idle frame is therefore cheaper than
 * it was before the pass did anything.
 *
 * Three switches gate it, in order of how blunt they are:
 *
 *  - `post.enabled` — the whole stack, as before.
 *  - `post.distortionEnabled` — the refraction pass alone. This is the one to
 *    turn off on weak hardware; it removes a render target's worth of bandwidth
 *    and a dependent texture fetch per pixel.
 *  - `post.distortionScale` — the offset buffer's resolution as a fraction of
 *    the frame. 0.5 is the shipped value and what the buffer always was; 0.25 is
 *    the potato setting and is still perfectly smooth for heat and lensing,
 *    because nothing that writes here has an edge sharper than a metre.
 */
export class PostProcessing {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.gl = renderer.gl;
    this.scene = scene;
    this.camera = camera;

    const size = this.gl.getSize(new Vector2());
    const pixelRatio = this.gl.getPixelRatio();
    const width = Math.floor(size.x * pixelRatio);
    const height = Math.floor(size.y * pixelRatio);

    /** Device pixels of the frame, kept so the offset buffer can be re-scaled live. */
    this._pixelWidth = width;
    this._pixelHeight = height;
    this._distortionScale = 0.5;
    /** Set every `sync()`: whether pass 2 has anything to do this frame. */
    this._distortionActive = false;

    /* ---- auxiliary buffers ---- */
    this.depthTarget = new WebGLRenderTarget(Math.floor(width / 2), Math.floor(height / 2));
    this.depthTarget.texture.generateMipmaps = false;
    this.depthMaterial = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });

    // No depth attachment: the emitters are depth-test-off by construction and
    // do their own occlusion against the prepass, so a depth buffer here would
    // be a per-frame clear of memory nothing ever reads.
    this.distortionTarget = new WebGLRenderTarget(Math.floor(width / 2), Math.floor(height / 2), {
      type: HalfFloatType,
      depthBuffer: false
    });
    this.distortionTarget.texture.generateMipmaps = false;

    frame.uSceneDepth.value = this.depthTarget.texture;
    frame.uCameraNear.value = camera.near;
    frame.uCameraFar.value = camera.far;
    frame.uResolution.value.set(width, height);

    /* ---- composer ---- */
    this.composer = new EffectComposer(this.gl);
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(size.x, size.y);

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    this.distortionPass = new ShaderPass(DistortionShader);
    this.distortionPass.uniforms.tDistortion.value = this.distortionTarget.texture;
    this.composer.addPass(this.distortionPass);

    this.bloomPass = new UnrealBloomPass(
      new Vector2(size.x, size.y),
      settings.post.bloomStrength,
      settings.post.bloomRadius,
      settings.post.bloomThreshold
    );
    this.composer.addPass(this.bloomPass);

    // Tone mapping + sRGB conversion happen here; everything before is linear HDR.
    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);

    this.gradePass = new ShaderPass(GradeShader);
    this.gradePass.uniforms.uFlashColor.value = new Color(1, 1, 1);
    this.gradePass.renderToScreen = true;
    this.composer.addPass(this.gradePass);

    this._clearColor = new Color();
  }

  /** Opaque depth for soft particles. */
  _renderDepth() {
    const gl = this.gl;
    const scene = this.scene;
    const camera = this.camera;

    const previousBackground = scene.background;
    const previousOverride = scene.overrideMaterial;
    const mask = camera.layers.mask;
    gl.getClearColor(this._clearColor);
    const previousAlpha = gl.getClearAlpha();

    scene.background = null;
    scene.overrideMaterial = this.depthMaterial;
    camera.layers.set(LAYER.WORLD);

    gl.setRenderTarget(this.depthTarget);
    gl.setClearColor(0xffffff, 1); // "infinitely far"
    gl.clear();
    gl.render(scene, camera);

    scene.background = previousBackground;
    scene.overrideMaterial = previousOverride;
    camera.layers.mask = mask;
    gl.setClearColor(this._clearColor, previousAlpha);
  }

  /**
   * Re-size the offset buffer when `post.distortionScale` moves.
   *
   * A live slider that reallocates a render target is normally a bad idea, but
   * this one is dragged once on a machine that is struggling and then never
   * again, and gating it behind a dimension compare means the reallocation only
   * happens on the frame the value actually changes.
   */
  _syncDistortionScale(scale) {
    const clamped = Math.min(1, Math.max(MIN_DISTORTION_SCALE, scale || 0.5));
    if (clamped === this._distortionScale) return;
    this._distortionScale = clamped;
    this.distortionTarget.setSize(
      Math.max(2, Math.floor(this._pixelWidth * clamped)),
      Math.max(2, Math.floor(this._pixelHeight * clamped))
    );
  }

  /** Screen-space refraction offsets. */
  _renderDistortion() {
    const gl = this.gl;
    const scene = this.scene;
    const camera = this.camera;

    const previousBackground = scene.background;
    const mask = camera.layers.mask;
    gl.getClearColor(this._clearColor);
    const previousAlpha = gl.getClearAlpha();

    scene.background = null;
    camera.layers.set(LAYER.DISTORTION);

    gl.setRenderTarget(this.distortionTarget);
    gl.setClearColor(DISTORTION_CLEAR, 0); // 0.5 = "no offset", alpha 0 = no coverage
    gl.clear();
    gl.render(scene, camera);

    scene.background = previousBackground;
    camera.layers.mask = mask;
    gl.setClearColor(this._clearColor, previousAlpha);
    gl.setRenderTarget(null);
  }

  /** Push editor values into the passes. Called once per frame. */
  sync(elapsed, flash) {
    const post = settings.post;

    this.bloomPass.strength = post.bloomStrength;
    this.bloomPass.radius = post.bloomRadius;
    this.bloomPass.threshold = post.bloomThreshold;
    this.bloomPass.enabled = post.enabled && post.bloomStrength > 0.001;

    const u = this.gradePass.uniforms;
    u.uTime.value = elapsed;
    u.uAberration.value = post.enabled ? post.chromaticAberration : 0;
    u.uVignette.value = post.enabled ? post.vignette : 0;
    u.uContrast.value = post.enabled ? post.contrast : 1;
    u.uSaturation.value = post.enabled ? post.saturation : 1;
    u.uTemperature.value = post.enabled ? post.temperature : 0;
    u.uLift.value = post.lift;
    u.uGain.value = post.gain;
    u.uGrain.value = post.enabled ? post.grain : 0;
    u.uFlashStrength.value = flash.strength;
    u.uFlashColor.value.copy(flash.color);

    /* ---- the refraction pass ---- */
    // `global.distortion` is applied here and only here. Emitters write a bare
    // direction and magnitude; folding the two master gains in at the writing
    // end would let one ability apply them twice and another not at all.
    const warp =
      post.enabled && post.distortionEnabled !== false
        ? post.distortion * settings.global.distortion
        : 0;

    this._syncDistortionScale(post.distortionScale);
    this.distortionPass.uniforms.uScale.value = warp;

    // Nothing visible on the layer means the clear, the draw and the resample
    // are all skipped — see `core/Layers.js#distortionWriters`.
    this._distortionActive = warp > 0.00005 && distortionWriters.count > 0;
    this.distortionPass.enabled = this._distortionActive;
  }

  render() {
    this._renderDepth();
    if (this._distortionActive) this._renderDistortion();
    // Tone mapping is applied by OutputPass: three automatically disables the
    // in-material tone mapping while rendering into the composer's targets.
    this.composer.render();
    this.gl.setRenderTarget(null);
  }

  setSize(width, height, pixelRatio) {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
    this.bloomPass.setSize(width, height);

    const w = Math.floor(width * pixelRatio);
    const h = Math.floor(height * pixelRatio);
    this._pixelWidth = w;
    this._pixelHeight = h;
    this.depthTarget.setSize(Math.max(2, Math.floor(w / 2)), Math.max(2, Math.floor(h / 2)));
    this.distortionTarget.setSize(
      Math.max(2, Math.floor(w * this._distortionScale)),
      Math.max(2, Math.floor(h * this._distortionScale))
    );
    frame.uResolution.value.set(w, h);
  }

  dispose() {
    this.depthTarget.dispose();
    this.distortionTarget.dispose();
    this.depthMaterial.dispose();
    this.composer.dispose();
  }
}
