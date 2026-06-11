/**
 * Enter/exit animations shared by text overlays and overlay clips (logos/PiP).
 * Pure: given the element's time window and the current time, returns the
 * visual modifiers to apply (opacity, scale, normalized offset).
 */
export type AnimType = 'none' | 'fade' | 'pop' | 'slideUp' | 'slideDown' | 'slideLeft' | 'slideRight';

export type Anim = { type: AnimType; durationSec: number };

export type AnimState = {
  opacity: number;
  scale: number;
  offsetXNorm: number;
  offsetYNorm: number;
};

const IDENTITY: AnimState = { opacity: 1, scale: 1, offsetXNorm: 0, offsetYNorm: 0 };

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const easeOut = (p: number) => 1 - (1 - p) * (1 - p);

const SLIDE = 0.07; // normalized travel distance

/** Apply one animation at progress p (0 = fully animated/hidden, 1 = settled). */
function apply(state: AnimState, type: AnimType, pRaw: number): void {
  const p = easeOut(clamp01(pRaw));
  switch (type) {
    case 'fade':
      state.opacity *= p;
      break;
    case 'pop':
      state.opacity *= p;
      state.scale *= 0.5 + 0.5 * p;
      break;
    case 'slideUp':
      state.opacity *= p;
      state.offsetYNorm += (1 - p) * SLIDE; // starts below, slides up
      break;
    case 'slideDown':
      state.opacity *= p;
      state.offsetYNorm -= (1 - p) * SLIDE;
      break;
    case 'slideLeft':
      state.opacity *= p;
      state.offsetXNorm += (1 - p) * SLIDE;
      break;
    case 'slideRight':
      state.opacity *= p;
      state.offsetXNorm -= (1 - p) * SLIDE;
      break;
    case 'none':
      break;
  }
}

export function animState(
  startSec: number,
  endSec: number,
  enter: Anim | undefined,
  exit: Anim | undefined,
  timeSec: number,
): AnimState {
  if (!enter && !exit) return IDENTITY;
  const state: AnimState = { opacity: 1, scale: 1, offsetXNorm: 0, offsetYNorm: 0 };

  if (enter && enter.type !== 'none' && enter.durationSec > 0) {
    const p = (timeSec - startSec) / enter.durationSec;
    if (p < 1) apply(state, enter.type, p);
  }
  if (exit && exit.type !== 'none' && exit.durationSec > 0) {
    const p = (endSec - timeSec) / exit.durationSec;
    if (p < 1) apply(state, exit.type, p);
  }
  return state;
}
