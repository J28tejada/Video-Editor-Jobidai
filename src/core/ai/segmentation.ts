/**
 * On-device background removal via MediaPipe Selfie Segmentation (runs on GPU).
 * Produces a person cutout (RGBA with transparent background) from a video
 * frame, used by the compositor when a clip has "remove background" enabled.
 */
import { FilesetResolver, ImageSegmenter, type MPMask } from '@mediapipe/tasks-vision';

const WASM_BASE =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';

let segmenterPromise: Promise<ImageSegmenter> | null = null;

/** Begin loading the segmenter (model + wasm). Safe to call repeatedly. */
export function ensureSegmenter(): Promise<ImageSegmenter> {
  if (segmenterPromise) return segmenterPromise;
  segmenterPromise = (async () => {
    const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
    return ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      runningMode: 'IMAGE',
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    });
  })();
  return segmenterPromise;
}

export function isSegmenterReady(): boolean {
  return segmenterPromise !== null;
}

// Scratch canvases reused across calls.
let maskCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;
let outCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;

function canvasOf(w: number, h: number, which: 'mask' | 'out'): HTMLCanvasElement | OffscreenCanvas {
  let c = which === 'mask' ? maskCanvas : outCanvas;
  if (!c || c.width !== w || c.height !== h) {
    c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : document.createElement('canvas');
    c.width = w;
    c.height = h;
    if (which === 'mask') maskCanvas = c;
    else outCanvas = c;
  }
  return c;
}

/**
 * Segment a frame and return a person-only cutout canvas (transparent bg), or
 * null if segmentation is unavailable. Synchronous segment call after the model
 * has loaded.
 */
export async function segmentCutout(
  frame: CanvasImageSource,
  fw: number,
  fh: number,
): Promise<HTMLCanvasElement | OffscreenCanvas | null> {
  if (!fw || !fh) return null;
  const segmenter = await ensureSegmenter();

  let result;
  try {
    // Our frames are canvases / ImageBitmaps (never SVG); cast to ImageSource.
    result = segmenter.segment(frame as unknown as HTMLCanvasElement);
  } catch {
    return null;
  }
  const mask: MPMask | undefined = result.confidenceMasks?.[0];
  if (!mask) {
    result.close?.();
    return null;
  }

  const mw = mask.width;
  const mh = mask.height;
  const data = mask.getAsFloat32Array();

  // Build a grayscale alpha mask image at the mask resolution.
  const mc = canvasOf(mw, mh, 'mask');
  const mctx = (mc as HTMLCanvasElement).getContext('2d') as CanvasRenderingContext2D;
  const img = mctx.createImageData(mw, mh);
  for (let i = 0; i < data.length; i++) {
    const a = Math.max(0, Math.min(255, Math.round(data[i] * 255)));
    img.data[i * 4 + 3] = a;
  }
  mctx.putImageData(img, 0, 0);
  result.close?.();

  // Compose: frame, then keep only where the (upscaled) mask is opaque.
  const out = canvasOf(fw, fh, 'out');
  const octx = (out as HTMLCanvasElement).getContext('2d') as CanvasRenderingContext2D;
  octx.clearRect(0, 0, fw, fh);
  octx.globalCompositeOperation = 'source-over';
  octx.drawImage(frame, 0, 0, fw, fh);
  octx.globalCompositeOperation = 'destination-in';
  octx.imageSmoothingEnabled = true;
  octx.drawImage(mc, 0, 0, fw, fh);
  octx.globalCompositeOperation = 'source-over';

  return out;
}
