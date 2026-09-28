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
};

export type EngineComposition = {
  width: number;
  height: number;
  fps: number;
  clips: EngineClip[];
  texts: EngineText[];
};

export type MediaInfo = {
  durationSec: number;
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
