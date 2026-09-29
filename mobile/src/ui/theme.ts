export const colors = {
  bg: '#0b0d12',
  panel: '#12151c',
  panelHigh: '#1a1e27',
  border: '#262b36',
  text: '#f2f4f8',
  textDim: '#8a93a6',
  accent: '#6366f1',
  accentSoft: 'rgba(99,102,241,0.18)',
  playhead: '#ffffff',
  clip: '#232838',
  clipSelected: '#f5c542',
  textClip: '#8b5cf6',
  musicClip: '#0d9488',
  sfxClip: '#d97706',
  brollClip: '#7c3aed',
  danger: '#ef4444',
};

export const radius = { sm: 6, md: 10, lg: 16 };

/** Pixels per second of timeline at default zoom. */
export const PPS = 64;

export function formatTime(sec: number): string {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}:${rem.toFixed(1).padStart(4, '0')}`;
}
