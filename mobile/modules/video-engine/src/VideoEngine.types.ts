import type { StyleProp, ViewStyle } from 'react-native';

/**
 * Render description sent to the native engine.
 *
 * The JS side owns the editable project (the shared timeline model); the
 * engine only ever sees this flattened, render-ready form. Native code decodes,
 * composites and encodes — JS never touches frames.
 */
export type EngineClip = {
  id: string;
  /** file:// URI of the source video. */
  uri: string;
  /** Trim range inside the source, seconds. */
  inPoint: number;
  outPoint: number;
  /** Position on the timeline, seconds. Base clips are contiguous. */
  start: number;
  /** Constant playback speed (0.25..4). */
  speed: number;
  /** Audio gain 0..2 (0 = muted). */
  volume: number;
  /** contain = letterbox, cover = fill + crop. */
  fit: 'contain' | 'cover';
  /**
   * Color adjustment as a 3×4 row-major affine matrix on sRGB (0..1):
   * [r', g', b'] = M · [r, g, b, 1]. Null = no adjustment.
   */
  colorMatrix: number[] | null;
  /**
   * Zoom / reframe applied after fitting: the fitted frame is scaled by
   * `scale` and centered at (xNorm, yNorm) of the output. Null = centered, 1×.
   */
  transform: { scale: number; xNorm: number; yNorm: number } | null;
  /**
   * Animated zoom / reframe keyed by SOURCE seconds (linear, ends held).
   * Overrides `transform` while present.
   */
  transformKeys: { t: number; scale: number; xNorm: number; yNorm: number }[] | null;
  /** Display size of the source (rotation applied), for reframing math. */
  srcWidth: number;
  srcHeight: number;
};

export type EngineTransitionKind = 'crossfade' | 'fade' | 'slide';

/**
 * Transition across the cut between clips[index] and clips[index + 1],
 * centered on the cut: it starts `half` seconds before and ends `half` after.
 * Frames missing past a clip's source range are held (freeze frame).
 */
export type EngineTransition = {
  index: number;
  kind: EngineTransitionKind;
  half: number;
};

/** Text burned into the export. Geometry is normalized to the output frame. */
export type EngineText = {
  id: string;
  text: string;
  start: number;
  end: number;
  /** Center position, 0..1. */
  xNorm: number;
  yNorm: number;
  /** Font size as a fraction of the output height. */
  fontSizeNorm: number;
  color: string;
  fontWeight: number;
  background: string | null;
  align: 'left' | 'center' | 'right';
  /** Karaoke: word timings (timeline seconds); the active one is highlighted. */
  words?: { text: string; start: number; end: number }[];
  highlightColor?: string;
};

/** A point of a piecewise-linear gain envelope, on the timeline. */
export type GainPoint = { t: number; gain: number };

/**
 * An extra audio layer mixed over the clips' own sound: background music or a
 * sound effect. Fades, ducking and volume are all baked into `envelope` by the
 * JS side, so both platforms apply exactly the same mix.
 */
export type EngineAudio = {
  id: string;
  /** file:// URI of the audio (or video) file. */
  uri: string;
  /** Timeline position where the layer starts, seconds. */
  start: number;
  /** Timeline position where it stops (never past the composition end). */
  end: number;
  /** Source range for one pass, seconds. */
  inPoint: number;
  outPoint: number;
  /** Repeat the source range until `end`. */
  loop: boolean;
  /** Gain over time (0..1). Linear between points, held before/after. */
  envelope: GainPoint[];
};

export type EngineComposition = {
  width: number;
  height: number;
  fps: number;
  clips: EngineClip[];
  texts: EngineText[];
  audio: EngineAudio[];
  transitions: EngineTransition[];
};

export type MediaInfo = {
  durationSec: number;
  /** False for audio-only files (music, sound effects). */
  hasVideo: boolean;
  /** Display size (rotation already applied). */
  width: number;
  height: number;
  fps: number | null;
  hasAudio: boolean;
  codec: string | null;
};

export type ExportResult = { uri: string };

export type ExportProgressEvent = { progress: number };

export type VideoEngineModuleEvents = {
  onExportProgress: (event: ExportProgressEvent) => void;
};

export type ReadyEvent = { duration: number };
export type TimeUpdateEvent = { time: number; playing: boolean };
export type ErrorEvent = { message: string };

export type VideoEngineViewProps = {
  style?: StyleProp<ViewStyle>;
  /** JSON-encoded EngineComposition. Rebuilds the preview when it changes. */
  composition: string;
  onReady?: (event: { nativeEvent: ReadyEvent }) => void;
  onTimeUpdate?: (event: { nativeEvent: TimeUpdateEvent }) => void;
  onEnded?: (event: { nativeEvent: Record<string, never> }) => void;
  onError?: (event: { nativeEvent: ErrorEvent }) => void;
};

/** Imperative handle exposed through the view ref. */
export type VideoEngineViewRef = {
  play: () => Promise<void>;
  pause: () => Promise<void>;
  /** `exact` = frame-accurate (slower); false = fast keyframe-tolerant scrub. */
  seek: (time: number, exact: boolean) => Promise<void>;
};
