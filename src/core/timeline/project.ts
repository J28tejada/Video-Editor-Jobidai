/**
 * Pure timeline operations. Every function returns a new Project (immutable),
 * which keeps undo/redo and React state updates trivial.
 *
 * Phase 0 uses a single video track whose clips are kept contiguous (no gaps)
 * via `relayoutTrack`. The model itself supports multiple tracks for Phase 1.
 */
import {
  PROJECT_SCHEMA_VERSION,
  clipDuration,
  clipEnd,
  clipSourceTime,
  overlayActiveAt,
  type Clip,
  type MusicItem,
  type Project,
  type SourceMeta,
  type TextOverlay,
  type Track,
  type Transition,
  type TransitionKind,
} from './types';

export const uid = (prefix: string): string =>
  `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

export function createProject(opts?: Partial<Pick<Project, 'name' | 'width' | 'height' | 'fps'>>): Project {
  const track: Track = { id: uid('track'), kind: 'video', role: 'base', clips: [] };
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: uid('proj'),
    name: opts?.name ?? 'Proyecto sin título',
    width: opts?.width ?? 1080,
    height: opts?.height ?? 1920, // vertical 9:16 by default (doc §1)
    fps: opts?.fps ?? 30,
    sources: [],
    tracks: [track],
    overlays: [],
    transitions: [],
    music: [],
    sfx: [],
  };
}

export const primaryTrack = (project: Project): Track => project.tracks[0];

/** Recompute startInTimeline so clips are packed contiguously in array order. */
export function relayoutTrack(track: Track): Track {
  let cursor = 0;
  const clips = track.clips.map((clip) => {
    const placed = { ...clip, startInTimeline: cursor };
    cursor += clipDuration(clip);
    return placed;
  });
  return { ...track, clips };
}

function pruneTransitions(project: Project): Project {
  // Transitions only live on the base track; drop any whose boundary is gone.
  const clips = primaryTrack(project).clips;
  const transitions = project.transitions.filter((tr) => {
    const idx = clips.findIndex((c) => c.id === tr.afterClipId);
    return idx !== -1 && idx < clips.length - 1;
  });
  return transitions.length === project.transitions.length
    ? project
    : { ...project, transitions };
}

/** Replace a track by id, re-laying-out base tracks and pruning transitions. */
function withTrack(project: Project, track: Track): Project {
  const normalized = track.role === 'base' ? relayoutTrack(track) : track;
  const tracks = project.tracks.map((t) => (t.id === normalized.id ? normalized : t));
  return pruneTransitions({ ...project, tracks });
}

export type ClipLocation = { track: Track; trackIndex: number; clip: Clip; clipIndex: number };

/** Find a clip across all tracks. */
export function findClip(project: Project, clipId: string): ClipLocation | null {
  for (let trackIndex = 0; trackIndex < project.tracks.length; trackIndex++) {
    const track = project.tracks[trackIndex];
    const clipIndex = track.clips.findIndex((c) => c.id === clipId);
    if (clipIndex !== -1) {
      return { track, trackIndex, clip: track.clips[clipIndex], clipIndex };
    }
  }
  return null;
}

export function upsertSource(project: Project, source: SourceMeta): Project {
  const exists = project.sources.some((s) => s.id === source.id);
  const sources = exists
    ? project.sources.map((s) => (s.id === source.id ? source : s))
    : [...project.sources, source];
  return { ...project, sources };
}

export function getSource(project: Project, sourceId: string): SourceMeta | undefined {
  return project.sources.find((s) => s.id === sourceId);
}

/** Append a full-length clip for a source to the end of the primary track. */
export function appendClipFromSource(project: Project, source: SourceMeta): Project {
  const withSource = upsertSource(project, source);
  const clip: Clip = {
    id: uid('clip'),
    kind: 'video',
    sourceId: source.id,
    inPoint: 0,
    outPoint: source.durationSec,
    startInTimeline: 0, // fixed by relayout
  };
  const track = primaryTrack(withSource);
  return withTrack(withSource, { ...track, clips: [...track.clips, clip] });
}

/** Place a clip from a source at a given time on a specific track (overlay). */
export function placeClipOnTrack(
  project: Project,
  trackId: string,
  source: SourceMeta,
  atTimeSec: number,
): Project {
  const withSource = upsertSource(project, source);
  const track = withSource.tracks.find((t) => t.id === trackId);
  if (!track) return withSource;
  const clip: Clip = {
    id: uid('clip'),
    kind: 'video',
    sourceId: source.id,
    inPoint: 0,
    outPoint: source.durationSec,
    startInTimeline: Math.max(0, atTimeSec),
  };
  return withTrack(withSource, { ...track, clips: [...track.clips, clip] });
}

/** Move an overlay clip to a new start time on the timeline (free positioning). */
export function moveClipStart(project: Project, clipId: string, newStartSec: number): Project {
  const loc = findClip(project, clipId);
  if (!loc || loc.track.role === 'base') return project; // base stays contiguous
  const clips = loc.track.clips.map((c) =>
    c.id === clipId ? { ...c, startInTimeline: Math.max(0, newStartSec) } : c,
  );
  return withTrack(project, { ...loc.track, clips });
}

/** Total timeline duration in seconds (across all tracks). */
export function totalDuration(project: Project): number {
  let max = 0;
  for (const track of project.tracks) {
    for (const c of track.clips) max = Math.max(max, clipEnd(c));
  }
  return max;
}

// ---- Track management ----

export function addOverlayTrack(project: Project): { project: Project; trackId: string } {
  const track: Track = { id: uid('track'), kind: 'video', role: 'overlay', clips: [] };
  return { project: { ...project, tracks: [...project.tracks, track] }, trackId: track.id };
}

export function removeTrack(project: Project, trackId: string): Project {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track || track.role === 'base') return project; // never remove the base
  return { ...project, tracks: project.tracks.filter((t) => t.id !== trackId) };
}

/** Find the clip covering a timeline time, plus the corresponding source time. */
export function clipAtTime(
  project: Project,
  timeSec: number,
): { clip: Clip; sourceTime: number } | null {
  const track = primaryTrack(project);
  for (const clip of track.clips) {
    if (timeSec >= clip.startInTimeline && timeSec < clipEnd(clip)) {
      return { clip, sourceTime: clipSourceTime(clip, timeSec) };
    }
  }
  // If exactly at/after the end, clamp to the last clip's final frame.
  const last = track.clips[track.clips.length - 1];
  if (last && timeSec >= clipEnd(last) && track.clips.length > 0) {
    return { clip: last, sourceTime: last.outPoint };
  }
  return null;
}

/**
 * Split a clip at a timeline time into two. Splits whichever track owns a clip
 * under the cursor; if `preferClipId` is given and under the cursor, that one.
 */
export function splitAt(project: Project, timeSec: number, preferClipId?: string): Project {
  // Choose the target track: the one owning preferClipId, else the base track.
  let track = primaryTrack(project);
  if (preferClipId) {
    const loc = findClip(project, preferClipId);
    if (loc) track = loc.track;
  }
  const idx = track.clips.findIndex(
    (c) => timeSec > c.startInTimeline && timeSec < clipEnd(c),
  );
  if (idx === -1) return project; // cursor not strictly inside a clip in this track

  const clip = track.clips[idx];
  const splitSourceTime = clipSourceTime(clip, timeSec);

  const left: Clip = { ...clip, outPoint: splitSourceTime };
  const right: Clip = {
    ...clip,
    id: uid('clip'),
    inPoint: splitSourceTime,
    startInTimeline: timeSec, // used as-is for overlay; relayout fixes base
  };

  const clips = [
    ...track.clips.slice(0, idx),
    left,
    right,
    ...track.clips.slice(idx + 1),
  ];
  return withTrack(project, { ...track, clips });
}

/**
 * Trim a clip's in/out points. On overlay tracks, trimming the head also moves
 * the clip's start so its content stays anchored in place.
 */
export function trimClip(
  project: Project,
  clipId: string,
  edge: 'in' | 'out',
  sourceTime: number,
): Project {
  const loc = findClip(project, clipId);
  if (!loc) return project;
  const minLen = 1 / project.fps;
  const isOverlay = loc.track.role === 'overlay';

  const clips = loc.track.clips.map((c) => {
    if (c.id !== clipId) return c;
    if (edge === 'in') {
      const inPoint = Math.max(0, Math.min(sourceTime, c.outPoint - minLen));
      if (isOverlay) {
        // Keep the content under the cursor: shift start by the trim delta.
        const delta = inPoint - c.inPoint;
        return { ...c, inPoint, startInTimeline: Math.max(0, c.startInTimeline + delta) };
      }
      return { ...c, inPoint };
    }
    const outPoint = Math.max(c.inPoint + minLen, sourceTime);
    return { ...c, outPoint };
  });
  return withTrack(project, { ...loc.track, clips });
}

/** Move a clip to a new index in its track order (reorder). Base track only. */
export function reorderClip(project: Project, clipId: string, toIndex: number): Project {
  const loc = findClip(project, clipId);
  if (!loc) return project;
  const clips = loc.track.clips.slice();
  const [moved] = clips.splice(loc.clipIndex, 1);
  const clamped = Math.max(0, Math.min(toIndex, clips.length));
  clips.splice(clamped, 0, moved);
  return withTrack(project, { ...loc.track, clips });
}

export function removeClip(project: Project, clipId: string): Project {
  const loc = findClip(project, clipId);
  if (!loc) return project;
  const clips = loc.track.clips.filter((c) => c.id !== clipId);
  return withTrack(project, { ...loc.track, clips });
}

/** Patch a clip's overlay transform (scale/position). */
export function setClipTransform(
  project: Project,
  clipId: string,
  patch: Partial<import('./types').ClipTransform>,
): Project {
  const loc = findClip(project, clipId);
  if (!loc) return project;
  const clips = loc.track.clips.map((c) => {
    if (c.id !== clipId) return c;
    const current = c.transform ?? { scale: 1, xNorm: 0.5, yNorm: 0.5 };
    return { ...c, transform: { ...current, ...patch } };
  });
  return withTrack(project, { ...loc.track, clips });
}

/** Change the output dimensions (aspect ratio). Overlays use normalized coords. */
export function setProjectFormat(project: Project, width: number, height: number): Project {
  return { ...project, width: Math.round(width), height: Math.round(height) };
}

/** Set a clip's background fill (letterbox areas): black / blur / color. */
export function setClipBg(
  project: Project,
  clipId: string,
  bg: import('./types').ClipBackground,
): Project {
  const loc = findClip(project, clipId);
  if (!loc) return project;
  const clips = loc.track.clips.map((c) => (c.id === clipId ? { ...c, bg } : c));
  return withTrack(project, { ...loc.track, clips });
}

/** Toggle background removal (person segmentation) for a clip. */
export function setClipRemoveBg(project: Project, clipId: string, removeBg: boolean): Project {
  const loc = findClip(project, clipId);
  if (!loc) return project;
  const clips = loc.track.clips.map((c) => (c.id === clipId ? { ...c, removeBg } : c));
  return withTrack(project, { ...loc.track, clips });
}

/** Set a clip's fit mode (contain/cover) for reframing. */
export function setClipFit(project: Project, clipId: string, fit: 'contain' | 'cover'): Project {
  const loc = findClip(project, clipId);
  if (!loc) return project;
  const clips = loc.track.clips.map((c) => (c.id === clipId ? { ...c, fit } : c));
  return withTrack(project, { ...loc.track, clips });
}

/** Patch a clip's color/filter adjustments. */
export function setClipFilters(
  project: Project,
  clipId: string,
  patch: Partial<import('./types').ClipFilters>,
): Project {
  const loc = findClip(project, clipId);
  if (!loc) return project;
  const clips = loc.track.clips.map((c) =>
    c.id === clipId ? { ...c, filters: { ...c.filters, ...patch } } : c,
  );
  return withTrack(project, { ...loc.track, clips });
}

/** Replace a clip's filters entirely (presets / reset). */
export function setClipFiltersAll(
  project: Project,
  clipId: string,
  filters: import('./types').ClipFilters | undefined,
): Project {
  const loc = findClip(project, clipId);
  if (!loc) return project;
  const clips = loc.track.clips.map((c) => (c.id === clipId ? { ...c, filters } : c));
  return withTrack(project, { ...loc.track, clips });
}

/** Set a clip's constant playback speed (clears any speed curve). */
export function setClipSpeed(project: Project, clipId: string, speed: number): Project {
  const loc = findClip(project, clipId);
  if (!loc) return project;
  const s = Math.max(0.25, Math.min(4, speed));
  const clips = loc.track.clips.map((c) =>
    c.id === clipId ? { ...c, speed: s, speedKeyframes: undefined } : c,
  );
  return withTrack(project, { ...loc.track, clips });
}

/** Set a clip's variable-speed curve (time remapping). Pass [] to clear. */
export function setClipSpeedCurve(
  project: Project,
  clipId: string,
  keys: import('./types').SpeedKey[],
): Project {
  const loc = findClip(project, clipId);
  if (!loc) return project;
  const keyframes = keys.length >= 2 ? [...keys].sort((a, b) => a.t - b.t) : undefined;
  const clips = loc.track.clips.map((c) =>
    c.id === clipId ? { ...c, speedKeyframes: keyframes } : c,
  );
  return withTrack(project, { ...loc.track, clips });
}

/** Patch a clip's enter/exit animations. */
export function setClipAnim(
  project: Project,
  clipId: string,
  patch: { enter?: import('./anim').Anim; exit?: import('./anim').Anim },
): Project {
  const loc = findClip(project, clipId);
  if (!loc) return project;
  const clips = loc.track.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c));
  return withTrack(project, { ...loc.track, clips });
}

/** Patch per-clip audio properties (volume/muted). */
export function setClipAudio(
  project: Project,
  clipId: string,
  patch: { volume?: number; muted?: boolean },
): Project {
  const loc = findClip(project, clipId);
  if (!loc) return project;
  const clips = loc.track.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c));
  return withTrack(project, { ...loc.track, clips });
}

/**
 * Replace base-track clips with speech-only sub-clips (silence removal).
 * `cuts` maps a clip id to the source ranges to keep; clips not listed are
 * left as-is. The base track is re-packed contiguously afterwards.
 */
export function applySilenceCuts(
  project: Project,
  cuts: { clipId: string; segments: { inPoint: number; outPoint: number }[] }[],
): Project {
  const track = primaryTrack(project);
  const byId = new Map(cuts.map((c) => [c.clipId, c.segments]));

  const clips: Clip[] = [];
  for (const clip of track.clips) {
    const segments = byId.get(clip.id);
    if (!segments || segments.length === 0) {
      clips.push(clip);
      continue;
    }
    for (const seg of segments) {
      clips.push({
        ...clip,
        id: uid('clip'),
        inPoint: seg.inPoint,
        outPoint: seg.outPoint,
        startInTimeline: 0, // fixed by relayout
      });
    }
  }
  return withTrack(project, { ...track, clips });
}

// ---- Text overlays ----

export function addOverlay(project: Project, atTimeSec: number): { project: Project; id: string } {
  const id = uid('txt');
  const dur = totalDuration(project);
  const start = Math.max(0, Math.min(atTimeSec, Math.max(0, dur - 0.5)));
  const overlay: TextOverlay = {
    id,
    text: 'Tu texto',
    startSec: start,
    endSec: Math.min(start + 3, dur > 0 ? dur : start + 3),
    xNorm: 0.5,
    yNorm: 0.85,
    fontSizeNorm: 0.06,
    color: '#ffffff',
    fontWeight: 800,
    background: 'rgba(0,0,0,0.5)',
    align: 'center',
  };
  return { project: { ...project, overlays: [...project.overlays, overlay] }, id };
}

export function updateOverlay(
  project: Project,
  id: string,
  patch: Partial<TextOverlay>,
): Project {
  const overlays = project.overlays.map((o) => (o.id === id ? { ...o, ...patch } : o));
  return { ...project, overlays };
}

export function removeOverlay(project: Project, id: string): Project {
  return { ...project, overlays: project.overlays.filter((o) => o.id !== id) };
}

/**
 * Apply a STYLE patch to every auto-caption overlay at once. Per-caption fields
 * (text, timing, words) must not be included in `patch`.
 */
export function patchAllCaptions(project: Project, patch: Partial<TextOverlay>): Project {
  const overlays = project.overlays.map((o) => (o.isCaption ? { ...o, ...patch } : o));
  return { ...project, overlays };
}

export function activeOverlays(project: Project, timeSec: number): TextOverlay[] {
  return project.overlays.filter((o) => overlayActiveAt(o, timeSec));
}

/** Replace all auto-caption overlays with a fresh set from subtitle segments. */
export function setCaptionOverlays(
  project: Project,
  segments: {
    text: string;
    startSec: number;
    endSec: number;
    words?: { text: string; start: number; end: number }[];
  }[],
): Project {
  const manual = project.overlays.filter((o) => !o.isCaption);
  const captions: TextOverlay[] = segments.map((s) => ({
    id: uid('cap'),
    text: s.text,
    startSec: s.startSec,
    endSec: s.endSec,
    xNorm: 0.5,
    yNorm: 0.82,
    fontSizeNorm: 0.055,
    color: '#ffffff',
    fontWeight: 800,
    background: 'rgba(0,0,0,0.55)',
    align: 'center',
    isCaption: true,
    words: s.words,
    highlightColor: '#ffe600',
  }));
  return { ...project, overlays: [...manual, ...captions] };
}

// ---- Transitions ----

/** Add or replace the transition after a clip. Returns project unchanged if it is the last clip. */
export function setTransitionAfter(
  project: Project,
  afterClipId: string,
  kind: TransitionKind,
  durationSec = 0.5,
): Project {
  const clips = primaryTrack(project).clips;
  const idx = clips.findIndex((c) => c.id === afterClipId);
  if (idx === -1 || idx >= clips.length - 1) return project;

  const others = project.transitions.filter((t) => t.afterClipId !== afterClipId);
  const transition: Transition = {
    id: uid('tr'),
    afterClipId,
    kind,
    durationSec,
  };
  return { ...project, transitions: [...others, transition] };
}

export function updateTransition(
  project: Project,
  id: string,
  patch: Partial<Transition>,
): Project {
  const transitions = project.transitions.map((t) => (t.id === id ? { ...t, ...patch } : t));
  return { ...project, transitions };
}

export function removeTransition(project: Project, id: string): Project {
  return { ...project, transitions: project.transitions.filter((t) => t.id !== id) };
}

export function transitionAfterClip(project: Project, clipId: string): Transition | undefined {
  return project.transitions.find((t) => t.afterClipId === clipId);
}

// ---- Background music ----

export function addMusic(
  project: Project,
  source: SourceMeta,
  atTimeSec = 0,
): { project: Project; id: string } {
  const withSource = upsertSource(project, source);
  const id = uid('mus');
  const item: MusicItem = {
    id,
    sourceId: source.id,
    startSec: Math.max(0, atTimeSec),
    inPoint: 0,
    outPoint: source.durationSec,
    volume: 0.15,
    fadeInSec: 1,
    fadeOutSec: 2,
    loop: true,
    duck: true,
    duckLevel: 0.25,
  };
  return { project: { ...withSource, music: [...withSource.music, item] }, id };
}

export function updateMusic(project: Project, id: string, patch: Partial<MusicItem>): Project {
  const music = project.music.map((m) => (m.id === id ? { ...m, ...patch } : m));
  return { ...project, music };
}

export function removeMusic(project: Project, id: string): Project {
  return { ...project, music: project.music.filter((m) => m.id !== id) };
}

// ---- Sound effects ----

export function addSynthSfx(
  project: Project,
  synth: string,
  atTimeSec: number,
  durationSec: number,
): { project: Project; id: string } {
  const id = uid('sfx');
  const item: import('./types').SfxItem = {
    id,
    startSec: Math.max(0, atTimeSec),
    volume: 0.8,
    durationSec,
    synth,
  };
  return { project: { ...project, sfx: [...project.sfx, item] }, id };
}

export function addSampleSfx(
  project: Project,
  source: SourceMeta,
  atTimeSec: number,
): { project: Project; id: string } {
  const withSource = upsertSource(project, source);
  const id = uid('sfx');
  const item: import('./types').SfxItem = {
    id,
    startSec: Math.max(0, atTimeSec),
    volume: 1,
    durationSec: source.durationSec,
    sourceId: source.id,
  };
  return { project: { ...withSource, sfx: [...withSource.sfx, item] }, id };
}

export function updateSfx(
  project: Project,
  id: string,
  patch: Partial<import('./types').SfxItem>,
): Project {
  return { ...project, sfx: project.sfx.map((s) => (s.id === id ? { ...s, ...patch } : s)) };
}

export function removeSfx(project: Project, id: string): Project {
  return { ...project, sfx: project.sfx.filter((s) => s.id !== id) };
}

// ---- Serialization (doc §8 acceptance: save/reload from JSON) ----

export function serializeProject(project: Project): string {
  return JSON.stringify(project, null, 2);
}

/**
 * Fill in defaults for fields added in later versions and re-pack base tracks.
 * Used by both file load and IndexedDB restore so older projects never crash.
 */
export function normalizeProject(data: Project): Project {
  const tracks = (data.tracks ?? []).map((t, i) => {
    const role = t.role ?? (i === 0 ? 'base' : 'overlay');
    const withRole: Track = { ...t, role, clips: t.clips ?? [] };
    return role === 'base' ? relayoutTrack(withRole) : withRole;
  });
  return {
    ...data,
    tracks: tracks.length > 0 ? tracks : createProject().tracks,
    sources: data.sources ?? [],
    overlays: data.overlays ?? [],
    transitions: data.transitions ?? [],
    music: data.music ?? [],
    sfx: data.sfx ?? [],
  };
}

export function deserializeProject(json: string): Project {
  const data = JSON.parse(json) as Project;
  if (typeof data.schemaVersion !== 'number') {
    throw new Error('Archivo de proyecto inválido: falta schemaVersion.');
  }
  if (data.schemaVersion > PROJECT_SCHEMA_VERSION) {
    throw new Error(
      `Proyecto creado con una versión más nueva (v${data.schemaVersion}).`,
    );
  }
  return normalizeProject(data);
}
