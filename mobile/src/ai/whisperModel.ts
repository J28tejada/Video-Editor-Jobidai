/**
 * Whisper (whisper.cpp) models for on-device captions. Downloaded once on
 * first use and kept in the documents directory.
 */
import { Directory, File, Paths } from 'expo-file-system';
import { initWhisper, type WhisperContext } from 'whisper.rn/index';

export type ModelId = 'base' | 'small';

export const MODELS: Record<ModelId, { label: string; file: string; sizeMB: number }> = {
  base: { label: 'Rápido', file: 'ggml-base-q5_1.bin', sizeMB: 57 },
  small: { label: 'Preciso', file: 'ggml-small-q5_1.bin', sizeMB: 181 },
};

const BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';

const modelsDir = () => new Directory(Paths.document, 'models');

function modelFile(id: ModelId): File {
  return new File(modelsDir(), MODELS[id].file);
}

export function isModelDownloaded(id: ModelId): boolean {
  return modelFile(id).exists;
}

/** Download the model if needed; resolves with its file. */
export async function ensureModel(
  id: ModelId,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<File> {
  const file = modelFile(id);
  if (file.exists) return file;
  const dir = modelsDir();
  if (!dir.exists) dir.create({ intermediates: true });

  // Download to a temporary name so a cancelled/failed download is never
  // mistaken for a complete model.
  const partial = new File(dir, `${MODELS[id].file}.part`);
  if (partial.exists) partial.delete();
  const task = File.createDownloadTask(BASE_URL + MODELS[id].file, partial, {
    onProgress: ({ bytesWritten, totalBytes }) => {
      const total = totalBytes > 0 ? totalBytes : MODELS[id].sizeMB * 1024 * 1024;
      onProgress?.(Math.min(1, bytesWritten / total));
    },
    signal,
  });
  const downloaded = await task.downloadAsync();
  if (!downloaded) throw new Error('Descarga interrumpida.');
  downloaded.move(file);
  return file;
}

let cached: { id: ModelId; context: WhisperContext } | null = null;

/** Loaded model context (kept in memory between runs). */
export async function whisperContext(id: ModelId): Promise<WhisperContext> {
  if (cached?.id === id) return cached.context;
  if (cached) {
    await cached.context.release();
    cached = null;
  }
  const file = modelFile(id);
  const context = await initWhisper({ filePath: file.uri });
  cached = { id, context };
  return context;
}
