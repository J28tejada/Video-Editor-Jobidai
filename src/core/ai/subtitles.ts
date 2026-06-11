/**
 * Orchestrates on-device subtitle generation:
 *   timeline AudioBuffer → 16 kHz mono Float32 → Whisper worker → caption lines.
 *
 * Word-level timestamps are grouped into short caption lines (good for vertical
 * social video) that the caller turns into editable text overlays.
 */
import type { Project } from '../timeline/types';
import { buildTimelineAudioBuffer } from '../media/audioTimeline';
import type { WordChunk } from './whisper.worker';

const WHISPER_RATE = 16000;

export type CaptionSegment = {
  text: string;
  startSec: number;
  endSec: number;
  words: WordChunk[];
};

export type SubtitleProgress = {
  stage: 'audio' | 'model' | 'inference' | 'done';
  value?: number;
  message?: string;
};

export type SubtitleOptions = {
  language?: string; // e.g. 'spanish'; undefined = auto-detect
  model?: string; // Whisper model id; undefined = worker default
  onProgress?: (p: SubtitleProgress) => void;
  signal?: AbortSignal;
};

/** Downmix + resample the timeline audio to 16 kHz mono for Whisper. */
async function toWhisperAudio(project: Project): Promise<Float32Array | null> {
  const timeline = await buildTimelineAudioBuffer(project);
  if (!timeline) return null;

  const length = Math.ceil(timeline.duration * WHISPER_RATE);
  if (length <= 0) return null;

  const ctx = new OfflineAudioContext(1, length, WHISPER_RATE);
  const src = ctx.createBufferSource();
  src.buffer = timeline; // stereo → mono downmix happens automatically
  src.connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0).slice();
}

/** Group word chunks into short caption lines. */
function groupWords(words: WordChunk[]): CaptionSegment[] {
  const MAX_CHARS = 28;
  const MAX_DURATION = 2.5;
  const segments: CaptionSegment[] = [];

  let buffer: WordChunk[] = [];
  const flush = () => {
    if (buffer.length === 0) return;
    segments.push({
      text: buffer.map((w) => w.text).join(' ').replace(/\s+([,.!?])/g, '$1'),
      startSec: buffer[0].start,
      endSec: buffer[buffer.length - 1].end,
      words: buffer,
    });
    buffer = [];
  };

  for (const word of words) {
    const tentative = [...buffer, word];
    const text = tentative.map((w) => w.text).join(' ');
    const duration = word.end - tentative[0].start;
    buffer.push(word);
    const endsSentence = /[.!?]$/.test(word.text);
    if (text.length >= MAX_CHARS || duration >= MAX_DURATION || endsSentence) {
      flush();
    }
  }
  flush();
  return segments;
}

export async function generateSubtitles(
  project: Project,
  opts: SubtitleOptions = {},
): Promise<CaptionSegment[]> {
  opts.onProgress?.({ stage: 'audio', message: 'Preparando audio…' });
  const audio = await toWhisperAudio(project);
  if (!audio) throw new Error('No hay audio en la línea de tiempo para transcribir.');
  if (opts.signal?.aborted) throw new DOMException('Cancelado', 'AbortError');

  const worker = new Worker(new URL('./whisper.worker.ts', import.meta.url), {
    type: 'module',
  });

  try {
    const chunks = await new Promise<WordChunk[]>((resolve, reject) => {
      const onAbort = () => {
        worker.terminate();
        reject(new DOMException('Cancelado', 'AbortError'));
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      worker.onmessage = (e: MessageEvent) => {
        const m = e.data;
        if (m.type === 'progress') {
          opts.onProgress?.({ stage: m.stage, value: m.value, message: m.message });
        } else if (m.type === 'result') {
          resolve(m.chunks as WordChunk[]);
        } else if (m.type === 'error') {
          reject(new Error(m.message));
        }
      };
      worker.onerror = (e) => reject(new Error(e.message || 'Error en el worker de IA'));

      // Transfer the audio buffer to avoid a copy.
      worker.postMessage(
        {
          type: 'transcribe',
          audio,
          sampleRate: WHISPER_RATE,
          language: opts.language,
          model: opts.model,
        },
        [audio.buffer],
      );
    });

    opts.onProgress?.({ stage: 'done', value: 1 });
    return groupWords(chunks);
  } finally {
    worker.terminate();
  }
}
