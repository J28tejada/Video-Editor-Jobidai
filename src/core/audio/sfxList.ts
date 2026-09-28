/**
 * Catalogue of built-in synthesized sound effects. Pure data, shared by the
 * web synth (sfx.ts, Web Audio) and the mobile app (PCM → WAV).
 */
export type SynthName = 'whoosh' | 'swoosh' | 'pop' | 'ding' | 'click' | 'riser' | 'boom';

export const SYNTH_SFX: { name: SynthName; label: string; durationSec: number }[] = [
  { name: 'whoosh', label: 'Whoosh', durationSec: 0.45 },
  { name: 'swoosh', label: 'Swoosh', durationSec: 0.45 },
  { name: 'pop', label: 'Pop', durationSec: 0.14 },
  { name: 'ding', label: 'Ding', durationSec: 0.6 },
  { name: 'click', label: 'Click', durationSec: 0.06 },
  { name: 'riser', label: 'Riser', durationSec: 1.0 },
  { name: 'boom', label: 'Boom', durationSec: 0.7 },
];

export function synthDuration(name: string): number {
  return SYNTH_SFX.find((s) => s.name === name)?.durationSec ?? 0.4;
}
