/**
 * Shared AudioContext singleton.
 *
 * iOS Safari requires AudioContext to be created AND resumed within a
 * synchronous user-gesture handler (click/touch). By calling unlockAudio()
 * directly inside the play button's onClick we satisfy that constraint, and
 * the pre-existing context can be reused for all subsequent playback.
 */
let _ctx: AudioContext | null = null;

/** Call synchronously from a click/touch handler to unlock audio on iOS. */
export function unlockAudio(): void {
  if (typeof AudioContext === 'undefined') return;
  if (!_ctx) {
    _ctx = new AudioContext();
  }
  if (_ctx.state !== 'running') {
    void _ctx.resume();
  }
}

/** Returns (or creates) the shared AudioContext. May be suspended on iOS until unlockAudio() is called. */
export function getSharedAudioContext(): AudioContext {
  if (!_ctx) {
    _ctx = new AudioContext();
  }
  return _ctx;
}
