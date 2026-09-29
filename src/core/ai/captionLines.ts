/**
 * Word timings → short caption lines (good for vertical social video).
 * Pure; shared by the web editor and the mobile app.
 */
export type WordChunk = { text: string; start: number; end: number };

export type CaptionSegment = {
  text: string;
  startSec: number;
  endSec: number;
  words: WordChunk[];
};

/** Group word chunks into short caption lines. */
export function groupWords(words: WordChunk[]): CaptionSegment[] {
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
