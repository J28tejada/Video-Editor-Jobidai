/**
 * Analyze one source for the agent: transcript with word timings (Whisper on
 * the phone), shot changes (native frame differences) and a short visual
 * description of each shot (keyframes sent to the backend).
 */
import { File } from 'expo-file-system';

import type { SourceIndex } from '@agent/context';
import { detectShots } from '@agent/understanding';
import type { SourceMeta } from '@timeline/types';
import VideoEngine from '../../modules/video-engine';
import { describeFrames } from '../agent/client';
import { agentConfigured } from '../agent/config';
import { transcribeSource } from '../ai/captions';
import { isModelDownloaded } from '../ai/whisperModel';

export type AnalyzeProgress = (label: string) => void;

const MAX_DESCRIBED_SHOTS = 12;

export async function analyzeSource(
  source: SourceMeta,
  uri: string,
  opts: { language: string; signal?: AbortSignal; onProgress?: AnalyzeProgress },
): Promise<SourceIndex> {
  const { onProgress, signal } = opts;
  const index: SourceIndex = { sourceId: source.id };

  // 1. Transcript.
  index.words = await transcribeSource(uri, source.durationSec, {
    model: isModelDownloaded('small') ? 'small' : 'base',
    language: opts.language,
    signal,
    onProgress: (p) =>
      onProgress?.(
        p.stage === 'download'
          ? `Descargando modelo de voz… ${Math.round(p.value * 100)}%`
          : p.stage === 'audio'
            ? `Escuchando "${source.name}"…`
            : `Transcribiendo "${source.name}"… ${Math.round(p.value * 100)}%`,
      ),
  });
  if (source.kind === 'audio') return index;

  // 2. Shots.
  onProgress?.(`Detectando planos de "${source.name}"…`);
  const interval = source.durationSec > 180 ? 1 : 0.5;
  const scores = await VideoEngine.measureShotChangesAsync(uri, interval, 400);
  index.shots = detectShots(scores.times, scores.scores, source.durationSec);

  // 3. What each shot shows (needs the backend; skipped offline).
  if (agentConfigured() && index.shots.length) {
    onProgress?.(`Mirando los planos de "${source.name}"…`);
    try {
      const shots = pickShots(index.shots, MAX_DESCRIBED_SHOTS);
      const thumbs = await VideoEngine.generateThumbnailsAsync(
        uri,
        shots.map((s) => (s.start + s.end) / 2),
        256,
      );
      const frames: { id: string; jpegBase64: string }[] = [];
      for (let i = 0; i < shots.length; i++) {
        if (!thumbs[i]) continue;
        frames.push({ id: String(index.shots.indexOf(shots[i])), jpegBase64: await new File(thumbs[i]).base64() });
      }
      if (frames.length) {
        const described = await describeFrames(frames, signal);
        for (const d of described) {
          const shot = index.shots[Number(d.id)];
          if (shot) shot.description = d.description;
        }
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      // Descriptions are a bonus; keep the transcript and shots.
    }
  }
  return index;
}

/** At most `n` shots, preferring the longest, in time order. */
function pickShots<T extends { start: number; end: number }>(shots: T[], n: number): T[] {
  if (shots.length <= n) return shots;
  return [...shots]
    .sort((a, b) => b.end - b.start - (a.end - a.start))
    .slice(0, n)
    .sort((a, b) => a.start - b.start);
}
