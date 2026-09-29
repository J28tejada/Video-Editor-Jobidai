/**
 * Clip color filters (the web editor's CSS-filter model) → one affine color
 * matrix the native engines apply in a single GPU pass.
 *
 * Every CSS filter function used by the editor (brightness, contrast,
 * saturate, sepia, grayscale, hue-rotate) is a linear map on sRGB, as defined
 * in the Filter Effects spec, so the whole chain composes into one 3×4 matrix.
 * Functions are applied in the same order as the web's `clipFilterCSS`.
 */
import type { ClipFilters } from '@timeline/types';

/** 3×4 row-major: [r', g', b'] = M · [r, g, b, 1]. */
export type Matrix34 = number[];

const IDENTITY: Matrix34 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

/** a ∘ b: apply b first, then a. */
function compose(a: Matrix34, b: Matrix34): Matrix34 {
  const out: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      let v = c === 3 ? a[r * 4 + 3] : 0;
      for (let k = 0; k < 3; k++) v += a[r * 4 + k] * b[k * 4 + c];
      out.push(v);
    }
  }
  return out;
}

const linear3 = (m: number[]): Matrix34 => [
  m[0], m[1], m[2], 0,
  m[3], m[4], m[5], 0,
  m[6], m[7], m[8], 0,
];

const brightness = (a: number): Matrix34 => [a, 0, 0, 0, 0, a, 0, 0, 0, 0, a, 0];

const contrast = (c: number): Matrix34 => {
  const o = (1 - c) / 2;
  return [c, 0, 0, o, 0, c, 0, o, 0, 0, c, o];
};

const saturate = (s: number): Matrix34 =>
  linear3([
    0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
  ]);

const grayscale = (g: number): Matrix34 => {
  const s = 1 - Math.min(1, Math.max(0, g));
  return linear3([
    0.2126 + 0.7874 * s, 0.7152 - 0.7152 * s, 0.0722 - 0.0722 * s,
    0.2126 - 0.2126 * s, 0.7152 + 0.2848 * s, 0.0722 - 0.0722 * s,
    0.2126 - 0.2126 * s, 0.7152 - 0.7152 * s, 0.0722 + 0.9278 * s,
  ]);
};

const sepia = (amount: number): Matrix34 => {
  const s = 1 - Math.min(1, Math.max(0, amount));
  return linear3([
    0.393 + 0.607 * s, 0.769 - 0.769 * s, 0.189 - 0.189 * s,
    0.349 - 0.349 * s, 0.686 + 0.314 * s, 0.168 - 0.168 * s,
    0.272 - 0.272 * s, 0.534 - 0.534 * s, 0.131 + 0.869 * s,
  ]);
};

const hueRotate = (deg: number): Matrix34 => {
  const a = (deg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return linear3([
    0.213 + cos * 0.787 - sin * 0.213, 0.715 - cos * 0.715 - sin * 0.715, 0.072 - cos * 0.072 + sin * 0.928,
    0.213 - cos * 0.213 + sin * 0.143, 0.715 + cos * 0.285 + sin * 0.14, 0.072 - cos * 0.072 - sin * 0.283,
    0.213 - cos * 0.213 - sin * 0.787, 0.715 - cos * 0.715 + sin * 0.715, 0.072 + cos * 0.928 + sin * 0.072,
  ]);
};

/** Null when the filters are neutral (no GPU pass needed). */
export function filtersToMatrix(f: ClipFilters | undefined): Matrix34 | null {
  if (!f) return null;
  const steps: Matrix34[] = [];
  if (f.brightness != null && f.brightness !== 1) steps.push(brightness(f.brightness));
  if (f.contrast != null && f.contrast !== 1) steps.push(contrast(f.contrast));
  if (f.saturate != null && f.saturate !== 1) steps.push(saturate(f.saturate));
  if (f.sepia) steps.push(sepia(f.sepia));
  if (f.grayscale) steps.push(grayscale(f.grayscale));
  if (f.hueRotate) steps.push(hueRotate(f.hueRotate));
  if (steps.length === 0) return null;
  // CSS applies left to right: the first function runs first.
  const m = steps.reduce((acc, step) => compose(step, acc), IDENTITY);
  return m.map((v) => Math.round(v * 1e5) / 1e5);
}

/** Apply a matrix to an sRGB color (0..1) — used for tests / swatches. */
export function applyMatrix(m: Matrix34, [r, g, b]: [number, number, number]): number[] {
  return [0, 1, 2].map((i) => m[i * 4] * r + m[i * 4 + 1] * g + m[i * 4 + 2] * b + m[i * 4 + 3]);
}
