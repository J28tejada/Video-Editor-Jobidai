/**
 * On-device auto-captions with Whisper.
 *
 * The base clips' own audio is decoded (source ranges, 16 kHz mono) and
 * joined into one buffer, remembering where each clip starts, so Whisper
 * hears the whole edit at once. Word timestamps are mapped back to the
 * timeline through each clip's start and speed, then grouped into short lines
 * with the same rules as the web editor.
 */
import { groupWords, type CaptionSegment } from '@ai/captionLines';
import { primaryTrack } from '@timeline/project';
import { clipGain, type Project } from '@timeline/types';
import { tokensToWords, type Piece } from './captionWords';
import { decodeMono, toPcm16 } from './pcm';
import { ensureModel, whisperContext, type ModelId } from './whisperModel';

export type CaptionProgress =
  | { stage: 'download'; value: number }
  | { stage: 'audio'; value: number }
  | { stage: 'transcribe'; value: number };

export type CaptionOptions = {
  model: ModelId;
  /** Whisper language code ('es', 'en', 'pt', …) or 'auto'. */
  language: string;
  onProgress?: (p: CaptionProgress) => void;
  signal?: AbortSignal;
};

export async function generateCaptions(
  project: Project,
  resolveUri: (sourceId: string) => string | null,
  opts: CaptionOptions,
): Promise<CaptionSegment[]> {
  const { onProgress, signal } = opts;
  await ensureModel(opts.model, (value) => onProgress?.({ stage: 'download', value }), signal);
  throwIfAborted(signal);

  // 1. Audio of the edit (clips with audible sound only).
  const clips = primaryTrack(project).clips.filter((c) => clipGain(c) > 0);
  const chunks: Float32Array[] = [];
  const pieces: Piece[] = [];
  let offset = 0;
  for (let i = 0; i < clips.length; i++) {
    onProgress?.({ stage: 'audio', value: i / Math.max(1, clips.length) });
    const uri = resolveUri(clips[i].sourceId);
    if (!uri) continue;
    const samples = await decodeMono(uri, clips[i].inPoint, clips[i].outPoint);
    throwIfAborted(signal);
    if (samples.length === 0) continue;
    chunks.push(samples);
    pieces.push({ clip: clips[i], offset, length: samples.length });
    offset += samples.length;
  }
  if (offset === 0) return [];
  const joined = new Float32Array(offset);
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.length;
  }

  // 2. Whisper, one segment per token so every word gets its own timing.
  const context = await whisperContext(opts.model);
  const job = context.transcribeData(toPcm16(joined).buffer as ArrayBuffer, {
    language: opts.language,
    tokenTimestamps: true,
    maxLen: 1,
    onProgress: (value: number) => onProgress?.({ stage: 'transcribe', value: value / 100 }),
  });
  const abort = () => void job.stop();
  signal?.addEventListener('abort', abort);
  let result;
  try {
    result = await job.promise;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
  throwIfAborted(signal);
  if (result.isAborted) return [];

  // 3. Tokens → words on the timeline → short lines.
  return groupWords(tokensToWords(result.segments, pieces));
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    const e = new Error('Cancelado');
    e.name = 'AbortError';
    throw e;
  }
}
