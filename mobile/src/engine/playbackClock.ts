/**
 * Live playback clock shared by the preview (writer) and the timeline, time
 * label and text layer (readers).
 *
 * The native engine reports its position ~30×/s. Between reports the clock
 * extrapolates from the last one, so readers polling it from
 * requestAnimationFrame move smoothly at the display rate without routing
 * every frame through React state (same approach as the web editor).
 */
let baseTime = 0;
let baseAt = 0;
let playing = false;
let maxTime = Infinity;

type Listener = () => void;
const listeners = new Set<Listener>();

/** Anchor the clock to a position reported by the engine. */
export function syncClock(time: number, isPlaying: boolean): void {
  const wasPlaying = playing;
  baseTime = time;
  baseAt = performance.now();
  playing = isPlaying;
  if (wasPlaying !== isPlaying) listeners.forEach((l) => l());
}

/** Upper bound for extrapolation (timeline duration). */
export function setClockDuration(duration: number): void {
  maxTime = duration;
}

export function clockTime(): number {
  if (!playing) return baseTime;
  // Timeline time advances at 1× wall-clock regardless of clip speed.
  const t = baseTime + (performance.now() - baseAt) / 1000;
  return Math.min(t, maxTime);
}

export function clockPlaying(): boolean {
  return playing;
}

/** Notified when playing starts/stops (not on every tick). */
export function subscribeClock(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
