/**
 * Media loading via Mediabunny: File -> Input -> metadata + frame access.
 *
 * Decode is on-demand and per-frame through a CanvasSink (doc §3: with
 * WebCodecs we decode the frame rather than "seek", which is far faster).
 * Frames come out as canvases already converted from YUV to RGB by Mediabunny.
 */
import {
  ALL_FORMATS,
  AudioBufferSink,
  BlobSource,
  CanvasSink,
  Input,
  type InputAudioTrack,
  type InputVideoTrack,
  type WrappedCanvas,
} from 'mediabunny';
import type { SourceMeta } from '../timeline/types';
import { uid } from '../timeline/project';

export type LoadedMedia = {
  meta: SourceMeta;
  file: File;
  input: Input | null;
  /** Null for audio-only / image sources. */
  videoTrack: InputVideoTrack | null;
  /** Null for audio-only / image sources. */
  sink: CanvasSink | null;
  /** Primary audio track, if the file has one. */
  audioTrack: InputAudioTrack | null;
  /** Lazily-created sink for reading decoded audio buffers. */
  audioSink: AudioBufferSink | null;
  /** Decoded still image for image sources (logos / stills). */
  image: ImageBitmap | null;
};

/** Default on-timeline duration (seconds) for a newly placed image. */
export const IMAGE_DEFAULT_DURATION = 5;

/** Load a still image (PNG/JPG/WebP…) as a media source. */
export async function loadImageFile(file: File): Promise<LoadedMedia> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`No se pudo leer la imagen "${file.name}".`);
  }
  const meta: SourceMeta = {
    id: uid('src'),
    name: file.name,
    durationSec: IMAGE_DEFAULT_DURATION,
    width: bitmap.width,
    height: bitmap.height,
    fps: null,
    codec: null,
    kind: 'image',
  };
  return {
    meta,
    file,
    input: null,
    videoTrack: null,
    sink: null,
    audioTrack: null,
    audioSink: null,
    image: bitmap,
  };
}

/** Load an audio-only file (background music). Requires an audio track. */
export async function loadAudioFile(file: File): Promise<LoadedMedia> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  if (!(await input.canRead())) {
    throw new Error(`No se pudo leer el formato del archivo "${file.name}".`);
  }
  const audioTrack = await input.getPrimaryAudioTrack();
  if (!audioTrack) {
    throw new Error(`"${file.name}" no contiene una pista de audio.`);
  }
  const metaDuration = await input.getDurationFromMetadata();
  const durationSec =
    metaDuration && metaDuration > 0 ? metaDuration : await input.computeDuration();
  const codec = await audioTrack.getCodec();

  const meta: SourceMeta = {
    id: uid('src'),
    name: file.name,
    durationSec,
    width: 0,
    height: 0,
    fps: null,
    codec,
    kind: 'audio',
  };
  return {
    meta,
    file,
    input,
    videoTrack: null,
    sink: null,
    audioTrack,
    audioSink: new AudioBufferSink(audioTrack),
    image: null,
  };
}

/**
 * Load a video file: probe metadata and prepare a frame sink.
 * Throws a user-readable error if the file has no decodable video track.
 */
export async function loadMediaFile(file: File): Promise<LoadedMedia> {
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(file),
  });

  if (!(await input.canRead())) {
    throw new Error(`No se pudo leer el formato del archivo "${file.name}".`);
  }

  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) {
    throw new Error(`"${file.name}" no contiene una pista de video.`);
  }

  const audioTrack = await input.getPrimaryAudioTrack();

  // Prefer the fast metadata duration; fall back to the (expensive) full scan
  // only when metadata has none. computeDuration() probes every packet and is
  // the main cause of slow imports, so we avoid it on the hot path.
  const [width, height, metaDuration, codec] = await Promise.all([
    videoTrack.getDisplayWidth(),
    videoTrack.getDisplayHeight(),
    input.getDurationFromMetadata(),
    videoTrack.getCodec(),
  ]);
  const durationSec =
    metaDuration && metaDuration > 0 ? metaDuration : await input.computeDuration();

  const meta: SourceMeta = {
    id: uid('src'),
    name: file.name,
    durationSec,
    width,
    height,
    fps: null,
    codec,
    kind: 'video',
  };

  // Pool of canvases reused round-robin to keep VRAM constant during scrubbing.
  const sink = new CanvasSink(videoTrack, {
    width,
    height,
    fit: 'fill',
    poolSize: 2,
  });

  const audioSink = audioTrack ? new AudioBufferSink(audioTrack) : null;

  return { meta, file, input, videoTrack, sink, audioTrack, audioSink, image: null };
}

/** Decode the frame at a given source time (seconds). Null if before first frame. */
export async function getFrameAt(
  media: LoadedMedia,
  sourceTimeSec: number,
): Promise<WrappedCanvas | null> {
  if (!media.sink) return null;
  const clamped = Math.max(0, Math.min(sourceTimeSec, media.meta.durationSec));
  return media.sink.getCanvas(clamped);
}
