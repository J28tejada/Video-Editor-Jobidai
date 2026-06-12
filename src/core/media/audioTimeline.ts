/**
 * Builds a single AudioBuffer for the entire timeline by scheduling each clip's
 * source audio at its timeline position inside an OfflineAudioContext.
 *
 * The offline context handles resampling (sources at 44.1k/48k/etc. are mixed
 * to a fixed target rate) and gives silence for free where no audio is
 * scheduled. The resulting buffer is reused for both preview playback and
 * export, so the two always sound identical.
 */
import { clipEnd, clipGain, clipAudioSpeed, type Clip, type MusicItem, type Project, type SfxItem } from '../timeline/types';
import { totalDuration } from '../timeline/project';
import { getMedia } from './registry';
import { scheduleSynthSfx } from '../audio/sfx';
import type { WrappedAudioBuffer } from 'mediabunny';

export const AUDIO_TARGET_RATE = 48000;
export const AUDIO_TARGET_CHANNELS = 2;

const allClips = (project: Project): Clip[] => project.tracks.flatMap((t) => t.clips);

/** True if any clip, music item or sound effect on the timeline has audio. */
export function timelineHasAudio(project: Project): boolean {
  const clipAudio = allClips(project).some((c) => !!getMedia(c.sourceId)?.audioSink);
  const musicAudio = project.music.some((m) => !!getMedia(m.sourceId)?.audioSink);
  const sfxAudio = project.sfx.length > 0;
  return clipAudio || musicAudio || sfxAudio;
}

/** Schedule a one-shot sound effect (synthesized or imported sample). */
async function scheduleSfxItem(ctx: OfflineAudioContext, item: SfxItem): Promise<void> {
  if (item.synth) {
    scheduleSynthSfx(ctx, item.synth, item.startSec, item.volume, ctx.destination);
    return;
  }
  if (!item.sourceId) return;
  const media = getMedia(item.sourceId);
  if (!media?.audioSink) return;
  const gain = ctx.createGain();
  gain.gain.value = item.volume;
  gain.connect(ctx.destination);
  const dur = media.meta.durationSec;
  for await (const { buffer, timestamp } of media.audioSink.buffers(0, dur)) {
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(gain);
    try {
      node.start(item.startSec + timestamp, 0, buffer.duration);
    } catch {
      /* outside render window */
    }
  }
}

/** Merged time intervals where speech (video-clip audio) plays — for ducking. */
function speechIntervals(project: Project): [number, number][] {
  const spans: [number, number][] = [];
  for (const track of project.tracks) {
    for (const c of track.clips) {
      if (getMedia(c.sourceId)?.audioSink && clipGain(c) > 0) {
        spans.push([c.startInTimeline, clipEnd(c)]);
      }
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [s, e] of spans) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1] + 0.05) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged;
}

/** Schedule one background-music item (fades, ducking, optional looping). */
async function scheduleMusicItem(
  ctx: OfflineAudioContext,
  item: MusicItem,
  total: number,
  speech: [number, number][],
): Promise<void> {
  const media = getMedia(item.sourceId);
  if (!media?.audioSink) return;

  const segDur = Math.max(0.05, item.outPoint - item.inPoint);
  const musicStart = Math.max(0, item.startSec);
  const musicEnd = Math.min(total, item.loop ? total : musicStart + segDur);
  if (musicEnd <= musicStart) return;

  // Fade envelope carries the base volume (0..volume); duck multiplies it (0..1).
  const fadeGain = ctx.createGain();
  let tail: AudioNode = fadeGain;
  if (item.duck) {
    const duckGain = ctx.createGain();
    fadeGain.connect(duckGain);
    duckGain.connect(ctx.destination);
    tail = duckGain;
    // Ducking automation.
    duckGain.gain.setValueAtTime(1, musicStart);
    for (const [s, e] of speech) {
      const a = Math.max(s, musicStart);
      const b = Math.min(e, musicEnd);
      if (b <= a) continue;
      duckGain.gain.setValueAtTime(1, Math.max(musicStart, a - 0.12));
      duckGain.gain.linearRampToValueAtTime(item.duckLevel, a);
      duckGain.gain.setValueAtTime(item.duckLevel, b);
      duckGain.gain.linearRampToValueAtTime(1, Math.min(musicEnd, b + 0.15));
    }
  } else {
    fadeGain.connect(ctx.destination);
  }
  void tail;

  // Fade in/out.
  const fadeIn = Math.min(item.fadeInSec, (musicEnd - musicStart) / 2);
  const fadeOut = Math.min(item.fadeOutSec, (musicEnd - musicStart) / 2);
  fadeGain.gain.setValueAtTime(0, musicStart);
  fadeGain.gain.linearRampToValueAtTime(item.volume, musicStart + fadeIn);
  fadeGain.gain.setValueAtTime(item.volume, Math.max(musicStart + fadeIn, musicEnd - fadeOut));
  fadeGain.gain.linearRampToValueAtTime(0, musicEnd);

  // Decode the source segment once, then (re)schedule it to fill the window.
  const segBuffers: WrappedAudioBuffer[] = [];
  for await (const wb of media.audioSink.buffers(item.inPoint, item.outPoint)) {
    segBuffers.push(wb);
  }
  if (segBuffers.length === 0) return;

  for (let loop = 0; ; loop++) {
    const loopStart = musicStart + loop * segDur;
    if (loopStart >= musicEnd) break;
    for (const { buffer, timestamp } of segBuffers) {
      const bufStart = timestamp;
      const playFromSrc = Math.max(bufStart, item.inPoint);
      const playToSrc = Math.min(bufStart + buffer.duration, item.outPoint);
      const segLen = playToSrc - playFromSrc;
      if (segLen <= 0) continue;
      const when = loopStart + (playFromSrc - item.inPoint);
      if (when >= musicEnd) continue;
      const dur = Math.min(segLen, musicEnd - when);
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(fadeGain);
      try {
        node.start(when, playFromSrc - bufStart, dur);
      } catch {
        /* outside render window */
      }
    }
    if (!item.loop) break;
    if (loop > 5000) break; // safety
  }
}

export async function buildTimelineAudioBuffer(
  project: Project,
): Promise<AudioBuffer | null> {
  const total = totalDuration(project);
  if (total <= 0 || !timelineHasAudio(project)) return null;

  const length = Math.ceil(total * AUDIO_TARGET_RATE);
  const ctx = new OfflineAudioContext(AUDIO_TARGET_CHANNELS, length, AUDIO_TARGET_RATE);

  for (const clip of allClips(project)) {
    const media = getMedia(clip.sourceId);
    if (!media?.audioSink) continue;
    const gain = clipGain(clip);
    if (gain <= 0) continue; // muted/silent clip contributes nothing
    const speed = clipAudioSpeed(clip); // avg speed (handles speed curves)

    // Route this clip's audio through a per-clip gain node.
    const gainNode = ctx.createGain();
    gainNode.gain.value = gain;
    gainNode.connect(ctx.destination);

    // Try to decode via AudioBufferSink (WebCodecs path). On iOS < 16.4 or
    // browsers without WebCodecs audio support, this may throw or yield nothing.
    // In that case we fall back to the browser's native decodeAudioData().
    let audioScheduled = false;
    try {
      for await (const { buffer, timestamp } of media.audioSink.buffers(
        clip.inPoint,
        clip.outPoint,
      )) {
        audioScheduled = true;
        const bufStart = timestamp;
        const bufEnd = timestamp + buffer.duration;

        // Intersect this buffer with the clip's [inPoint, outPoint] window.
        const playFromSrc = Math.max(bufStart, clip.inPoint);
        const playToSrc = Math.min(bufEnd, clip.outPoint);
        const srcDur = playToSrc - playFromSrc;
        if (srcDur <= 0) continue;

        const offset = playFromSrc - bufStart; // into the source buffer
        // Timeline position compresses by `speed`; the source portion plays for
        // srcDur/speed wall-clock seconds when playbackRate = speed.
        const when = clip.startInTimeline + (playFromSrc - clip.inPoint) / speed;

        const node = ctx.createBufferSource();
        node.buffer = buffer;
        node.playbackRate.value = speed;
        node.connect(gainNode);
        try {
          node.start(when, offset, srcDur);
        } catch {
          // Scheduling outside the render window — safe to skip.
        }
      }
    } catch {
      // WebCodecs audio decoding failed — fall through to decodeAudioData().
      audioScheduled = false;
    }

    if (!audioScheduled) {
      // Native fallback: let the browser decode the entire file with its own
      // audio decoder (AAC, MP3, Opus …), then schedule the relevant segment.
      try {
        const arrayBuf = await media.file.arrayBuffer();
        const decoded = await ctx.decodeAudioData(arrayBuf);
        const clipDur = clip.outPoint - clip.inPoint;
        if (clipDur > 0 && decoded.duration > clip.inPoint) {
          const node = ctx.createBufferSource();
          node.buffer = decoded;
          node.playbackRate.value = speed;
          node.connect(gainNode);
          try {
            node.start(clip.startInTimeline, clip.inPoint, clipDur / speed);
          } catch {
            // outside render window
          }
        }
      } catch {
        // decodeAudioData also failed — this clip has no audio in the mix.
      }
    }
  }

  // ---- Background music (fades + ducking + loop) ----
  if (project.music.length > 0) {
    const speech = speechIntervals(project);
    for (const item of project.music) {
      await scheduleMusicItem(ctx, item, total, speech);
    }
  }

  // ---- Sound effects (one-shots) ----
  for (const item of project.sfx) {
    await scheduleSfxItem(ctx, item);
  }

  return ctx.startRendering();
}

// ---- Cache for preview playback (rebuild only when the edit changes) ----

/** Cheap signature of everything that affects the timeline audio. */
export function timelineAudioSignature(project: Project): string {
  const clips = allClips(project)
    .map((c) => {
      const linked = getMedia(c.sourceId)?.audioSink ? 'a' : '_';
      return `${c.sourceId}:${linked}:${c.inPoint.toFixed(3)}:${c.outPoint.toFixed(3)}:${c.startInTimeline.toFixed(3)}:${clipGain(c)}:${clipAudioSpeed(c).toFixed(3)}`;
    })
    .join('|');
  const music = project.music
    .map(
      (m) =>
        `${m.sourceId}:${m.startSec.toFixed(2)}:${m.inPoint.toFixed(2)}:${m.outPoint.toFixed(2)}:${m.volume}:${m.fadeInSec}:${m.fadeOutSec}:${m.loop ? 'L' : '_'}:${m.duck ? m.duckLevel : 'n'}`,
    )
    .join('|');
  const sfx = project.sfx
    .map((s) => `${s.synth ?? s.sourceId}:${s.startSec.toFixed(2)}:${s.volume}`)
    .join('|');
  // Total affects looped music length, so include it.
  return `${clips}#${music}#${sfx}#${totalDuration(project).toFixed(2)}`;
}

let cache: { sig: string; buffer: AudioBuffer | null } | null = null;
let inflight: { sig: string; promise: Promise<AudioBuffer | null> } | null = null;

/** Whether the timeline audio for the current edit is already built & cached. */
export function isTimelineAudioReady(project: Project): boolean {
  return cache !== null && cache.sig === timelineAudioSignature(project);
}

/** Build-or-return the cached timeline audio buffer for the current edit. */
export function getCachedTimelineAudio(project: Project): Promise<AudioBuffer | null> {
  const sig = timelineAudioSignature(project);
  if (cache && cache.sig === sig) return Promise.resolve(cache.buffer);
  if (inflight && inflight.sig === sig) return inflight.promise;

  const promise = buildTimelineAudioBuffer(project).then((buffer) => {
    cache = { sig, buffer };
    inflight = null;
    return buffer;
  });
  inflight = { sig, promise };
  return promise;
}
