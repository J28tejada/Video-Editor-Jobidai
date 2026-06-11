/**
 * Compositor abstraction (doc §9). Phase 0 ships a Canvas 2D implementation.
 * Phase 1 can drop in a PixiJS/WebGL compositor behind the same interface
 * without touching playback/export call sites.
 */
export type FrameImage = CanvasImageSource;

/** A text overlay with normalized (0..1) geometry, resolved by the compositor. */
export type TextDraw = {
  text: string;
  xNorm: number;
  yNorm: number;
  fontSizeNorm: number;
  color: string;
  fontWeight: number;
  background: string | null;
  align: 'left' | 'center' | 'right';
  fontFamily?: string;
  /** Karaoke: the words on this line. When present, rendered word-by-word. */
  words?: { text: string }[];
  /** Index of the active (highlighted) word, or -1. */
  activeWordIndex?: number;
  /** Color for the active word in karaoke mode. */
  highlightColor?: string;
  /** Animation modifiers (enter/exit). */
  opacity?: number;
  animScale?: number;
  offsetXNorm?: number;
  offsetYNorm?: number;
  /** Text outline. */
  strokeColor?: string | null;
  strokeWidthNorm?: number;
  /** Neon glow. */
  glow?: boolean;
  glowColor?: string;
};

export type DrawFrameOptions = {
  /** Clear the canvas before drawing. Default true. */
  clear?: boolean;
  /** Fill color used when clearing. Default black. */
  clearColor?: string;
  /** Global alpha for the drawn frame, 0..1. Default 1. Enables blending. */
  alpha?: number;
  /**
   * Optional placement: `scale` multiplies the natural contain-fit size and
   * `xNorm`/`yNorm` set the center position (0..1). Used for logos / PiP.
   */
  transform?: { scale: number; xNorm: number; yNorm: number };
  /** CSS filter string applied to the drawn frame (color/blur). */
  filter?: string;
  /** Fit mode: 'contain' (default, letterbox) or 'cover' (fill + crop). */
  fit?: 'contain' | 'cover';
  /** Restrict drawing to this rectangle in canvas pixels (for wipe transitions). */
  clipRect?: { x: number; y: number; w: number; h: number };
};

export interface Compositor {
  readonly width: number;
  readonly height: number;
  /** The canvas that holds the composited output. */
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  /**
   * Draw a single source frame with contain-fit. By default clears to black
   * first; pass `{ clear: false, alpha }` to blend a frame on top (transitions).
   */
  drawFrame(frame: FrameImage | null, opts?: DrawFrameOptions): void;
  /** Draw a text overlay on top of the current frame. */
  drawText(draw: TextDraw): void;
  /** Release any GPU/context resources. */
  dispose(): void;
}
