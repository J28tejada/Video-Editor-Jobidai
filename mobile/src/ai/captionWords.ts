/**
 * Whisper token segments → words on the timeline (pure, testable).
 */
import type { WordChunk } from '@ai/captionLines';
import { clipSpeed, type Clip } from '@timeline/types';

export const WHISPER_RATE = 16000;

/** Where each clip's audio sits inside the joined buffer (in samples). */
export type Piece = { clip: Clip; offset: number; length: number };

export type TokenSegment = { text: string; t0: number; t1: number };

/** Seconds into the joined audio → timeline seconds. */
export function toTimeline(pieces: Piece[], sec: number): number {
  const sample = sec * WHISPER_RATE;
  const piece = pieces.find((p) => sample < p.offset + p.length) ?? pieces[pieces.length - 1];
  const within = Math.max(0, Math.min(piece.length, sample - piece.offset)) / WHISPER_RATE;
  return piece.clip.startInTimeline + within / clipSpeed(piece.clip);
}

/**
 * One segment per token (maxLen = 1) → words. A token without a leading
 * space continues the previous word; bracketed tags ([MUSIC]…) are dropped.
 * Segment times are in 10 ms units, as whisper.cpp reports them.
 */
export function tokensToWords(segments: TokenSegment[], pieces: Piece[]): WordChunk[] {
  const words: WordChunk[] = [];
  for (const seg of segments) {
    const raw = seg.text;
    const text = raw.trim();
    if (!text || /^\[.*\]$/.test(text)) continue;
    const start = toTimeline(pieces, seg.t0 / 100);
    const end = toTimeline(pieces, seg.t1 / 100);
    const last = words[words.length - 1];
    if (last && !/^\s/.test(raw) && !/^[¿¡]/.test(text)) {
      last.text += text;
      last.end = Math.max(last.end, end);
    } else {
      words.push({ text, start, end: Math.max(end, start + 0.05) });
    }
  }
  return words;
}
