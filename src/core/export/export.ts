/**
 * Export pipeline (doc §8.6): compose timeline frames and encode to MP4 (H.264
 * by default) using WebCodecs via Mediabunny.
 *
 * For each output frame we resolve which clip is on screen, decode that source
 * frame, composite it, then hand the composited canvas to a CanvasSource which
 * encodes and muxes it. Backpressure is respected by awaiting source.add().
 */
import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  getFirstEncodableAudioCodec,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  type Quality,
  type VideoCodec,
} from 'mediabunny';
import type { Project } from '../timeline/types';
import { totalDuration } from '../timeline/project';
import {
  AUDIO_TARGET_CHANNELS,
  AUDIO_TARGET_RATE,
  buildTimelineAudioBuffer,
} from '../media/audioTimeline';
import { Canvas2DCompositor } from '../compositor/canvas2d';
import { renderTimelineFrame } from '../compositor/renderFrame';

export type ExportOptions = {
  codec: VideoCodec;
  /** Target output height in px (keeps aspect). Defaults to the project height. */
  resolutionHeight?: number;
  /** Video/audio quality. Defaults to high. */
  quality?: Quality;
  /** Output frame rate. Defaults to the project fps. */
  fps?: number;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
};

const evenize = (n: number): number => Math.max(2, Math.round(n / 2) * 2);

export type ExportResult = {
  blob: Blob;
  fileName: string;
  durationSec: number;
  frameCount: number;
};

export async function exportProject(
  project: Project,
  opts: ExportOptions,
): Promise<ExportResult> {
  const total = totalDuration(project);
  if (total <= 0) throw new Error('La línea de tiempo está vacía: nada que exportar.');

  const fps = opts.fps && opts.fps > 0 ? opts.fps : project.fps;
  const quality = opts.quality ?? QUALITY_HIGH;
  const frameCount = Math.max(1, Math.round(total * fps));

  // Scale output to the requested height, keeping aspect (even dimensions).
  const targetH = opts.resolutionHeight ?? project.height;
  const scale = targetH / project.height;
  const width = evenize(project.width * scale);
  const height = evenize(targetH);

  const compositor = new Canvas2DCompositor(width, height);

  // Build the timeline audio up front (also resolves the encodable codec).
  const audioBuffer = await buildTimelineAudioBuffer(project);
  const audioCodec = audioBuffer
    ? await getFirstEncodableAudioCodec(['aac', 'opus'], {
        numberOfChannels: AUDIO_TARGET_CHANNELS,
        sampleRate: AUDIO_TARGET_RATE,
      })
    : null;

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });

  const source = new CanvasSource(compositor.canvas, {
    codec: opts.codec,
    bitrate: quality,
  });
  output.addVideoTrack(source);

  const audioSource =
    audioBuffer && audioCodec
      ? new AudioBufferSource({ codec: audioCodec, bitrate: QUALITY_HIGH })
      : null;
  if (audioSource) output.addAudioTrack(audioSource);

  await output.start();

  // Feed the whole audio track once; the muxer interleaves with video.
  if (audioSource && audioBuffer) {
    await audioSource.add(audioBuffer);
  }

  try {
    const frameDur = 1 / fps;
    for (let i = 0; i < frameCount; i++) {
      if (opts.signal?.aborted) throw new DOMException('Export cancelado', 'AbortError');

      const t = i * frameDur;
      await renderTimelineFrame(compositor, project, t);

      await source.add(t, frameDur);
      opts.onProgress?.((i + 1) / frameCount);
    }

    await output.finalize();
  } catch (err) {
    await output.cancel().catch(() => {});
    compositor.dispose();
    throw err;
  }

  compositor.dispose();

  const buffer = output.target.buffer;
  if (!buffer) throw new Error('El export no produjo datos.');

  const blob = new Blob([buffer], { type: 'video/mp4' });
  const fileName = `${sanitize(project.name)}.mp4`;
  return { blob, fileName, durationSec: total, frameCount };
}

function sanitize(name: string): string {
  return name.replace(/[^\w.-]+/g, '_').slice(0, 64) || 'export';
}
