/**
 * Live playback clock — shared between the Preview playback loop (writer) and
 * the Timeline (reader).
 *
 * During playback the Preview's rAF loop knows the precise current time every
 * frame. Routing that through React state (seek()) is throttled to keep
 * re-renders cheap on mobile, which makes the timeline scroll look choppy even
 * when the video itself is smooth. Instead the Preview writes the live time
 * here every frame and the Timeline reads it in its own rAF loop to scroll
 * imperatively at the full display rate — no React re-render involved.
 */
let _time = 0;
let _active = false;

/** Begin a live playback session anchored at `t` seconds. */
export function beginLivePlayback(t: number): void {
  _time = t;
  _active = true;
}

/** Update the live playback time (call once per animation frame). */
export function setLivePlaybackTime(t: number): void {
  _time = t;
}

/** End the live playback session (scroll falls back to React state). */
export function endLivePlayback(): void {
  _active = false;
}

/** Current live playback time in seconds. */
export function getLivePlaybackTime(): number {
  return _time;
}

/** Whether a live playback session is currently driving the clock. */
export function isLivePlayback(): boolean {
  return _active;
}
