import type { ImageSegmenter, MPMask } from "@mediapipe/tasks-vision";

import wasmLoaderPath from "@mediapipe/tasks-vision/vision_wasm_internal.js?url";
import wasmBinaryPath from "@mediapipe/tasks-vision/vision_wasm_internal.wasm?url";

/**
 * Webcam background replacement. Runs MediaPipe's selfie segmenter over the
 * camera frame for a per-pixel person mask, then composites the masked person
 * over either a blurred copy of the frame or a replacement image.
 *
 * Runs on-device: the model ships with the app and nothing is uploaded. Owns an
 * output canvas that callers read from (the recorder composites it, the preview
 * bubble blits it).
 */

export type BackgroundMode = "none" | "blur" | "image";

export interface BackgroundSettings {
  mode: BackgroundMode;
  /** Gaussian radius in px for `blur` mode. */
  blurRadius: number;
  /** Object/data URL for `image` mode. */
  imageSrc: string | null;
  /** Mask feathering in px - softens the cut-out edge. */
  edgeSoftness: number;
}

export const DEFAULT_BACKGROUND: BackgroundSettings = {
  mode: "none",
  blurRadius: 14,
  imageSrc: null,
  edgeSoftness: 4,
};

/** Model input is 256x256, so processing above this width buys nothing. */
const MAX_PROCESS_WIDTH = 640;
/** Segmentation cadence. Between runs the previous mask is reused. */
const SEGMENT_INTERVAL_MS = 40;
/** Frames used to auto-detect which way round the model's mask polarity runs. */
const CALIBRATION_FRAMES = 12;

const MODEL_PATH = `${
  import.meta.env.BASE_URL.endsWith("/")
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`
}models/selfie_segmenter.tflite`;

export interface GradientSpec {
  id: string;
  label: string;
  /** Colour stops, painted as a diagonal linear gradient. */
  stops: readonly string[];
}

export const GRADIENT_BACKGROUNDS: readonly GradientSpec[] = [
  { id: "dusk", label: "Dusk", stops: ["#1e1b4b", "#4c1d95", "#9333ea"] },
  { id: "slate", label: "Slate", stops: ["#0f172a", "#1e293b", "#334155"] },
  { id: "ember", label: "Ember", stops: ["#7c2d12", "#c2410c", "#f59e0b"] },
  { id: "mint", label: "Mint", stops: ["#064e3b", "#0f766e", "#5eead4"] },
  { id: "studio", label: "Studio", stops: ["#111827", "#374151", "#111827"] },
] as const;

/**
 * Paints a gradient to an offscreen canvas and returns it as a data URL, so
 * preset backgrounds go through the same `image` path as user uploads and the
 * app needs no bundled image assets.
 */
export function renderGradientBackground(spec: GradientSpec): string {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  spec.stops.forEach((color, i) => {
    gradient.addColorStop(i / Math.max(1, spec.stops.length - 1), color);
  });
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

export type BackgroundStatus = "idle" | "loading" | "ready" | "unsupported";

export class BackgroundProcessor {
  /** Output canvas - always holds the latest processed camera frame. */
  readonly canvas: HTMLCanvasElement;

  private readonly ctx: CanvasRenderingContext2D;
  private readonly maskCanvas: HTMLCanvasElement;
  private readonly maskCtx: CanvasRenderingContext2D;
  private maskImage: ImageData | null = null;

  private segmenter: ImageSegmenter | null = null;
  private loadPromise: Promise<void> | null = null;
  private statusValue: BackgroundStatus = "idle";

  private backgroundImage: HTMLImageElement | null = null;
  private backgroundImageSrc: string | null = null;

  private lastSegmentAt = 0;
  private lastVideoTime = -1;
  private hasMask = false;

  /** Set once by `calibratePolarity`; guards against an inverted mask convention. */
  private invertMask = false;
  private calibrationFrames = 0;
  private calibrationVotes = 0;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 640;
    this.canvas.height = 480;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    this.ctx = ctx;

    this.maskCanvas = document.createElement("canvas");
    const maskCtx = this.maskCanvas.getContext("2d");
    if (!maskCtx) throw new Error("2D canvas context unavailable");
    this.maskCtx = maskCtx;
  }

  get status(): BackgroundStatus {
    return this.statusValue;
  }

  static isSupported(): boolean {
    return typeof WebAssembly === "object" && typeof document !== "undefined";
  }

  /**
   * Loads the segmentation model. Safe to call repeatedly - the work happens once.
   * Only called when the user actually picks a background, so the ~3 MB of wasm
   * plus model never loads for people recording without one.
   */
  async load(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    if (!BackgroundProcessor.isSupported()) {
      this.statusValue = "unsupported";
      return;
    }

    this.statusValue = "loading";
    this.loadPromise = (async () => {
      const { ImageSegmenter: Segmenter } = await import("@mediapipe/tasks-vision");
      const fileset = { wasmLoaderPath, wasmBinaryPath };

      const create = (delegate: "GPU" | "CPU") =>
        Segmenter.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_PATH, delegate },
          runningMode: "VIDEO",
          outputConfidenceMasks: true,
          outputCategoryMask: false,
        });

      try {
        this.segmenter = await create("GPU");
      } catch {
        this.segmenter = await create("CPU");
      }
      this.statusValue = "ready";
    })().catch((err) => {
      this.statusValue = "unsupported";
      this.loadPromise = null;
      throw err;
    });

    return this.loadPromise;
  }

  /**
   * Renders one frame and returns the output canvas.
   * Falls back to a plain copy of the video whenever segmentation is unavailable,
   * so callers can always read from `this.canvas` unconditionally.
   */
  render(video: HTMLVideoElement, settings: BackgroundSettings): HTMLCanvasElement {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      return this.canvas;
    }

    const scale = Math.min(1, MAX_PROCESS_WIDTH / vw);
    const width = Math.round(vw * scale);
    const height = Math.round(vh * scale);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    const { ctx } = this;
    const useSegmentation = settings.mode !== "none" && this.segmenter !== null;

    if (!useSegmentation) {
      ctx.globalCompositeOperation = "source-over";
      ctx.filter = "none";
      ctx.drawImage(video, 0, 0, width, height);
      return this.canvas;
    }

    this.updateMask(video);

    if (!this.hasMask) {
      ctx.globalCompositeOperation = "source-over";
      ctx.filter = "none";
      ctx.drawImage(video, 0, 0, width, height);
      return this.canvas;
    }

    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = "none";
    ctx.clearRect(0, 0, width, height);

    // 1. The person: the frame, keyed by the (feathered) mask.
    ctx.drawImage(video, 0, 0, width, height);
    ctx.globalCompositeOperation = "destination-in";
    ctx.filter = settings.edgeSoftness > 0 ? `blur(${settings.edgeSoftness}px)` : "none";
    ctx.drawImage(this.maskCanvas, 0, 0, width, height);

    // 2. The background, painted underneath what survived.
    ctx.globalCompositeOperation = "destination-over";
    ctx.filter = "none";
    this.drawBackground(video, settings, width, height);

    ctx.restore();
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = "none";
    return this.canvas;
  }

  private drawBackground(
    video: HTMLVideoElement,
    settings: BackgroundSettings,
    width: number,
    height: number,
  ): void {
    const { ctx } = this;

    if (settings.mode === "blur") {
      ctx.filter = `blur(${settings.blurRadius}px)`;
      // Overscan slightly: a blurred draw feathers to transparent at the edges,
      // which would otherwise leave a translucent frame around the picture.
      const pad = settings.blurRadius * 2;
      ctx.drawImage(video, -pad, -pad, width + pad * 2, height + pad * 2);
      ctx.filter = "none";
      return;
    }

    const image = this.resolveBackgroundImage(settings.imageSrc);
    if (image && image.complete && image.naturalWidth > 0) {
      // cover-fit
      const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
      const dw = image.naturalWidth * scale;
      const dh = image.naturalHeight * scale;
      ctx.drawImage(image, (width - dw) / 2, (height - dh) / 2, dw, dh);
    } else {
      // Image still decoding - a blur keeps the background from flashing through.
      ctx.filter = `blur(${settings.blurRadius}px)`;
      ctx.drawImage(video, 0, 0, width, height);
      ctx.filter = "none";
    }
  }

  private resolveBackgroundImage(src: string | null): HTMLImageElement | null {
    if (!src) return null;
    if (src !== this.backgroundImageSrc) {
      this.backgroundImageSrc = src;
      const image = new Image();
      image.crossOrigin = "anonymous";
      image.src = src;
      this.backgroundImage = image;
    }
    return this.backgroundImage;
  }

  /** Runs the segmenter (rate-limited) and paints the result into `maskCanvas`. */
  private updateMask(video: HTMLVideoElement): void {
    const segmenter = this.segmenter;
    if (!segmenter) return;

    const now = performance.now();
    const frameIsNew = video.currentTime !== this.lastVideoTime;
    if (this.hasMask && (!frameIsNew || now - this.lastSegmentAt < SEGMENT_INTERVAL_MS)) {
      return;
    }
    this.lastSegmentAt = now;
    this.lastVideoTime = video.currentTime;

    let result: { confidenceMasks?: MPMask[]; close(): void } | null = null;
    try {
      result = segmenter.segmentForVideo(video, now);
      const masks = result.confidenceMasks;
      if (!masks || masks.length === 0) return;
      // Two-class output is [background, person]; single-class output is [person].
      const mask = masks.length > 1 ? masks[1] : masks[0];
      this.paintMask(mask);
      this.hasMask = true;
    } catch {
      // A transient inference failure should not kill the preview loop.
    } finally {
      result?.close();
    }
  }

  private paintMask(mask: MPMask): void {
    const width = mask.width;
    const height = mask.height;
    const values = mask.getAsFloat32Array();

    if (this.calibrationFrames < CALIBRATION_FRAMES) {
      this.calibratePolarity(values, width, height);
    }

    if (this.maskCanvas.width !== width || this.maskCanvas.height !== height) {
      this.maskCanvas.width = width;
      this.maskCanvas.height = height;
      this.maskImage = null;
    }

    // Reused across frames - a fresh 256x256 ImageData per frame is ~6 MB/s of
    // garbage at this cadence.
    let image = this.maskImage;
    if (!image) {
      image = this.maskCtx.createImageData(width, height);
      this.maskImage = image;
    }
    const data = image.data;
    const invert = this.invertMask;
    for (let i = 0, p = 0; i < values.length; i++, p += 4) {
      const v = invert ? 1 - values[i] : values[i];
      data[p] = 255;
      data[p + 1] = 255;
      data[p + 2] = 255;
      data[p + 3] = v * 255;
    }
    this.maskCtx.putImageData(image, 0, 0);
  }

  /**
   * Decides once whether the mask marks the person or the background.
   *
   * MediaPipe's channel ordering for single-label selfie models is undocumented,
   * and an inverted mask cuts out the person instead of the background. The
   * subject is centred on a selfie camera, so a mask whose centre reads lower
   * than its border is inverted. Majority vote over the first frames.
   */
  private calibratePolarity(values: Float32Array, width: number, height: number): void {
    const x0 = Math.floor(width * 0.3);
    const x1 = Math.floor(width * 0.7);
    const y0 = Math.floor(height * 0.3);
    const y1 = Math.floor(height * 0.7);

    let centreSum = 0;
    let centreCount = 0;
    let borderSum = 0;
    let borderCount = 0;

    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        const v = values[y * width + x];
        if (x >= x0 && x < x1 && y >= y0 && y < y1) {
          centreSum += v;
          centreCount++;
        } else if (x < width * 0.1 || x > width * 0.9 || y < height * 0.1) {
          borderSum += v;
          borderCount++;
        }
      }
    }

    if (centreCount === 0 || borderCount === 0) return;
    const centre = centreSum / centreCount;
    const border = borderSum / borderCount;

    this.calibrationFrames++;
    // Only count frames with a clear verdict; an empty scene votes for neither.
    if (Math.abs(centre - border) > 0.15) {
      this.calibrationVotes += border > centre ? 1 : -1;
    }
    this.invertMask = this.calibrationVotes > 0;
  }

  /** Forces polarity re-detection - call when the camera device changes. */
  resetCalibration(): void {
    this.calibrationFrames = 0;
    this.calibrationVotes = 0;
    this.invertMask = false;
    this.hasMask = false;
  }

  dispose(): void {
    this.segmenter?.close();
    this.segmenter = null;
    this.loadPromise = null;
    this.statusValue = "idle";
    this.hasMask = false;
  }
}
