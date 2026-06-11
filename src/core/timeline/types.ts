/**
 * Serializable project / timeline model (doc §8.3, §9).
 *
 *   Project → Track[] → Clip[]
 *
 * Everything here is plain JSON-serializable data. Live media (decoders,
 * sinks, blobs) lives in the media registry, keyed by `sourceId` — never here.
 */

import { curveTimelineDuration, curveSourceOffset } from './speedmap';

/** Schema version for forward-compatible project files. */
export const PROJECT_SCHEMA_VERSION = 1;

/** Metadata about an imported media source. The actual bytes live out-of-band. */
export type SourceKind = 'video' | 'audio' | 'image';

export type SourceMeta = {
  id: string;
  /** Original file name, used to relink media when reloading a project. */
  name: string;
  durationSec: number;
  width: number;
  height: number;
  /** Frames per second if known from the file metadata. */
  fps: number | null;
  /** Codec string from the file, informational. */
  codec: string | null;
  /** Media kind, so persistence can restore with the right loader. */
  kind?: SourceKind;
};

export type ClipKind = 'video';

/**
 * A clip is a window into a source placed on the timeline.
 * - inPoint/outPoint: trim range inside the source (seconds).
 * - startInTimeline: where the clip starts on the timeline (seconds).
 * Clip duration is derived: outPoint - inPoint.
 */
/**
 * Per-clip placement on overlay tracks (logos / picture-in-picture).
 * - scale: multiplier on the natural contain-fit size (1 = fills the frame).
 * - xNorm/yNorm: center position, normalized to the canvas (0..1).
 * Ignored on the base track, which always shows full-frame.
 */
export type ClipTransform = { scale: number; xNorm: number; yNorm: number };

export const DEFAULT_TRANSFORM: ClipTransform = { scale: 1, xNorm: 0.5, yNorm: 0.5 };

export type Clip = {
  id: string;
  kind: ClipKind;
  sourceId: string;
  inPoint: number;
  outPoint: number;
  startInTimeline: number;
  /** Per-clip audio gain (0..2, default 1). */
  volume?: number;
  /** Mute this clip's audio. */
  muted?: boolean;
  /** Placement on overlay tracks (logos / PiP). */
  transform?: ClipTransform;
  /** Enter/exit animations (overlay clips: logos / PiP). */
  enter?: import('./anim').Anim;
  exit?: import('./anim').Anim;
  /** Playback speed multiplier (0.25..4, default 1). Affects timeline length. */
  speed?: number;
  /**
   * Variable-speed (time remapping) keyframes. When present, overrides `speed`.
   * Each point: `t` = position along the source range (0..1), `speed` = multiplier.
   */
  speedKeyframes?: SpeedKey[];
  /** Color/filter adjustments. */
  filters?: ClipFilters;
  /**
   * Fit within the output frame:
   * - 'contain' (default): whole frame visible, may letterbox.
   * - 'cover': fill the frame, cropping overflow (reframe). Use with `transform`
   *   to zoom/pan.
   */
  fit?: 'contain' | 'cover';
  /** Background fill behind a 'contain' clip (letterbox areas). */
  bg?: ClipBackground;
  /** Remove the background (person segmentation) from this clip. */
  removeBg?: boolean;
};

/** How letterbox areas are filled for a contain-fit base clip. */
export type ClipBackground = {
  type: 'black' | 'blur' | 'color';
  /** For type 'color'. */
  color?: string;
  /** For type 'blur': blur radius in px. */
  blur?: number;
};

/** Per-clip color adjustments, mapped to CSS canvas filters. */
export type ClipFilters = {
  brightness?: number; // 1 = normal
  contrast?: number; // 1 = normal
  saturate?: number; // 1 = normal
  sepia?: number; // 0..1 (warmth)
  grayscale?: number; // 0..1
  hueRotate?: number; // degrees
  blur?: number; // px
};

/** Build a CSS filter string from clip filters, or undefined when neutral. */
export function clipFilterCSS(f?: ClipFilters): string | undefined {
  if (!f) return undefined;
  const parts: string[] = [];
  if (f.brightness != null && f.brightness !== 1) parts.push(`brightness(${f.brightness})`);
  if (f.contrast != null && f.contrast !== 1) parts.push(`contrast(${f.contrast})`);
  if (f.saturate != null && f.saturate !== 1) parts.push(`saturate(${f.saturate})`);
  if (f.sepia) parts.push(`sepia(${f.sepia})`);
  if (f.grayscale) parts.push(`grayscale(${f.grayscale})`);
  if (f.hueRotate) parts.push(`hue-rotate(${f.hueRotate}deg)`);
  if (f.blur) parts.push(`blur(${f.blur}px)`);
  return parts.length ? parts.join(' ') : undefined;
}

export const clipGain = (clip: Clip): number => (clip.muted ? 0 : clip.volume ?? 1);

export type SpeedKey = { t: number; speed: number };

export const clipSpeed = (clip: Clip): number =>
  clip.speed && clip.speed > 0 ? clip.speed : 1;

export const hasSpeedCurve = (clip: Clip): boolean =>
  !!clip.speedKeyframes && clip.speedKeyframes.length >= 2;

export type TrackKind = 'video';

/**
 * - 'base': the bottom track. Clips are kept contiguous (no gaps) and support
 *   transitions; this is the main storyline.
 * - 'overlay': stacked above the base. Clips are positioned freely (gaps
 *   allowed) and composited on top — used for b-roll / picture-in-picture.
 */
export type TrackRole = 'base' | 'overlay';

export type Track = {
  id: string;
  kind: TrackKind;
  role: TrackRole;
  clips: Clip[];
};

/** Clip active at a timeline time within a single track (gaps allowed). */
export const activeClipInTrack = (track: Track, timeSec: number): Clip | null => {
  for (const clip of track.clips) {
    if (timeSec >= clip.startInTimeline && timeSec < clipEnd(clip)) return clip;
  }
  return null;
};

/**
 * A text overlay drawn on top of the video. Positions and size are normalized
 * (0..1) relative to the output canvas, so they stay correct at any resolution.
 */
export type TextOverlay = {
  id: string;
  text: string;
  /** Timeline visibility window, in seconds. */
  startSec: number;
  endSec: number;
  /** Center position, normalized to canvas (0..1). */
  xNorm: number;
  yNorm: number;
  /** Font size as a fraction of canvas height. */
  fontSizeNorm: number;
  color: string;
  fontWeight: number;
  /** Optional background box color behind the text, or null for none. */
  background: string | null;
  align: 'left' | 'center' | 'right';
  /** True when generated by auto-subtitles (so regeneration can replace them). */
  isCaption?: boolean;
  /** Per-word timings (seconds, absolute timeline) for karaoke highlighting. */
  words?: CaptionWord[];
  /** Color of the active (currently-spoken) word in karaoke mode. */
  highlightColor?: string;
  /** Enter/exit animations. */
  enter?: import('./anim').Anim;
  exit?: import('./anim').Anim;
  /** Text outline color (stroke), or null/undefined for none. */
  strokeColor?: string | null;
  /** Outline width as a fraction of font size (e.g. 0.1). */
  strokeWidthNorm?: number;
  /** Neon-style glow behind the text. */
  glow?: boolean;
  /** Glow color (defaults to the highlight color). */
  glowColor?: string;
};

export type CaptionWord = { text: string; start: number; end: number };

/**
 * Built-in kinds, or a GL transition referenced as `gl:<name>` (gl-transitions).
 */
export type TransitionKind =
  | 'crossfade'
  | 'fade'
  | 'slide'
  | 'wipe'
  | 'zoom'
  | 'blur'
  | (string & {});

/**
 * A transition straddling the cut after `afterClipId`. It is centered on the
 * boundary, spanning durationSec/2 into each neighbouring clip.
 */
export type Transition = {
  id: string;
  afterClipId: string;
  kind: TransitionKind;
  durationSec: number;
};

/** A background-music item: an audio-only source placed on the timeline. */
export type MusicItem = {
  id: string;
  sourceId: string;
  /** Placement on the timeline (seconds). */
  startSec: number;
  /** Trim into the source (seconds). */
  inPoint: number;
  outPoint: number;
  /** Base gain 0..1. */
  volume: number;
  fadeInSec: number;
  fadeOutSec: number;
  /** Repeat the source to fill until the timeline (video) ends. */
  loop: boolean;
  /** Lower the music while there is speech (video audio). */
  duck: boolean;
  /** Music gain multiplier during speech (0..1). */
  duckLevel: number;
};

/** A one-shot sound effect placed at a point on the timeline. */
export type SfxItem = {
  id: string;
  startSec: number;
  volume: number;
  durationSec: number;
  /** Built-in synthesized effect name (whoosh, pop…), if synthesized. */
  synth?: string;
  /** Imported audio source id, if a sample. */
  sourceId?: string;
};

export type Project = {
  schemaVersion: number;
  id: string;
  name: string;
  /** Output canvas dimensions. */
  width: number;
  height: number;
  fps: number;
  sources: SourceMeta[];
  tracks: Track[];
  overlays: TextOverlay[];
  transitions: Transition[];
  music: MusicItem[];
  sfx: SfxItem[];
};

export const overlayActiveAt = (o: TextOverlay, timeSec: number): boolean =>
  timeSec >= o.startSec && timeSec < o.endSec;

/** Timeline duration: source range compressed/expanded by playback speed. */
export const clipDuration = (clip: Clip): number =>
  hasSpeedCurve(clip)
    ? curveTimelineDuration(clip)
    : (clip.outPoint - clip.inPoint) / clipSpeed(clip);

/** Source time for a timeline time within a clip (accounts for speed/curve). */
export const clipSourceTime = (clip: Clip, timeSec: number): number =>
  hasSpeedCurve(clip)
    ? clip.inPoint + curveSourceOffset(clip, timeSec - clip.startInTimeline)
    : clip.inPoint + (timeSec - clip.startInTimeline) * clipSpeed(clip);

/** Average speed of a clip (source range / timeline duration) for audio. */
export const clipAudioSpeed = (clip: Clip): number => {
  const dur = clipDuration(clip);
  return dur > 0 ? (clip.outPoint - clip.inPoint) / dur : clipSpeed(clip);
};

export const clipEnd = (clip: Clip): number =>
  clip.startInTimeline + clipDuration(clip);
