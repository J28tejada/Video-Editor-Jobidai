/** Native audio decoding → mono PCM for silence detection and Whisper. */
import { File } from 'expo-file-system';

import VideoEngine from '../../modules/video-engine';

export const ANALYSIS_RATE = 16000;

/**
 * Decode [startSec, endSec] of a file's audio (source time) to mono float32
 * at 16 kHz. Returns an empty array when the file has no audio.
 */
export async function decodeMono(uri: string, startSec: number, endSec: number): Promise<Float32Array> {
  const out = await VideoEngine.extractAudioAsync(uri, startSec, endSec, ANALYSIS_RATE);
  const file = new File(out);
  try {
    const bytes = await file.bytes();
    // Copy into an aligned buffer (the native file is little-endian float32,
    // the same byte order as the phone's CPU).
    const aligned = new Uint8Array(bytes.byteLength - (bytes.byteLength % 4));
    aligned.set(bytes.subarray(0, aligned.byteLength));
    return new Float32Array(aligned.buffer);
  } finally {
    try {
      file.delete();
    } catch {
      /* best effort */
    }
  }
}

/** Float32 [-1, 1] → signed 16-bit PCM (what whisper.rn's transcribeData reads). */
export function toPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    out[i] = v < 0 ? v * 32768 : v * 32767;
  }
  return out;
}
