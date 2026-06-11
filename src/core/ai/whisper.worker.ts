/// <reference lib="webworker" />
/**
 * Web Worker that runs Whisper (Transformers.js) off the main thread so the UI
 * stays responsive during model download and inference. Uses WebGPU when
 * available, otherwise falls back to WASM.
 *
 * Protocol:
 *   main → worker: { type:'transcribe', audio: Float32Array, sampleRate, language? }
 *   worker → main: { type:'progress', stage, value?, message? }
 *                  { type:'result', chunks: WordChunk[] }
 *                  { type:'error', message }
 */
import { pipeline, env, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';

// Always fetch models from the HF hub (no local model files bundled).
env.allowLocalModels = false;

export type WordChunk = { text: string; start: number; end: number };

type TranscribeMsg = {
  type: 'transcribe';
  audio: Float32Array;
  sampleRate: number;
  language?: string;
  model?: string;
};

const DEFAULT_MODEL = 'Xenova/whisper-small';

// One cached pipeline per model id (switching quality reloads the model).
const transcribers = new Map<string, Promise<AutomaticSpeechRecognitionPipeline>>();

function hasWebGPU(): boolean {
  return typeof (navigator as unknown as { gpu?: unknown }).gpu !== 'undefined';
}

function getTranscriber(modelId: string): Promise<AutomaticSpeechRecognitionPipeline> {
  const cached = transcribers.get(modelId);
  if (cached) return cached;
  const device = hasWebGPU() ? 'webgpu' : 'wasm';
  const dtype = device === 'webgpu' ? 'fp32' : 'q8';

  const promise = pipeline('automatic-speech-recognition', modelId, {
    device,
    dtype,
    progress_callback: (info: { status?: string; file?: string; progress?: number }) => {
      if (info.status === 'progress' && typeof info.progress === 'number') {
        post({
          type: 'progress',
          stage: 'model',
          value: info.progress / 100,
          message: `Descargando modelo… ${Math.round(info.progress)}%`,
        });
      } else if (info.status === 'ready') {
        post({ type: 'progress', stage: 'model', value: 1, message: 'Modelo listo' });
      }
    },
  }) as Promise<AutomaticSpeechRecognitionPipeline>;
  transcribers.set(modelId, promise);
  return promise;
}

function post(msg: unknown, transfer?: Transferable[]): void {
  (self as unknown as Worker).postMessage(msg, transfer ?? []);
}

self.onmessage = async (e: MessageEvent<TranscribeMsg>) => {
  const msg = e.data;
  if (msg.type !== 'transcribe') return;

  try {
    post({ type: 'progress', stage: 'model', message: 'Cargando modelo…' });
    const transcriber = await getTranscriber(msg.model ?? DEFAULT_MODEL);

    post({ type: 'progress', stage: 'inference', message: 'Transcribiendo…' });
    const output = await transcriber(msg.audio, {
      return_timestamps: 'word',
      chunk_length_s: 30,
      stride_length_s: 5,
      // Force transcription (not translation). When language is undefined,
      // Whisper auto-detects; pass a language to avoid wrong detection.
      task: 'transcribe',
      language: msg.language,
    });

    const single = Array.isArray(output) ? output[0] : output;
    type RawChunk = { text: string; timestamp: [number, number] };
    const rawChunks = (single.chunks ?? []) as RawChunk[];
    const chunks: WordChunk[] = rawChunks
      .filter((c) => Array.isArray(c.timestamp))
      .map((c) => ({
        text: (c.text ?? '').trim(),
        start: c.timestamp[0] ?? 0,
        end: c.timestamp[1] ?? c.timestamp[0] ?? 0,
      }))
      .filter((c) => c.text.length > 0 && c.end > c.start);

    post({ type: 'result', chunks });
  } catch (err) {
    post({ type: 'error', message: (err as Error).message ?? String(err) });
  }
};
