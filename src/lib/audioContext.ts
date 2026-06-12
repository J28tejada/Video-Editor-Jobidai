/**
 * Shared AudioContext singleton.
 *
 * iOS Safari requires AudioContext to be created AND resumed within a
 * synchronous user-gesture handler (click/touch). By calling unlockAudio()
 * directly inside the play button's onClick we satisfy that constraint.
 *
 * We store the resume Promise (_resumePromise) so that async callers can
 * await it — avoiding a race where the context is still 'suspended' by the
 * time Preview.tsx tries to schedule audio nodes.
 */
let _ctx: AudioContext | null = null;
let _resumePromise: Promise<void> = Promise.resolve();

/** Call synchronously from a click/touch handler to unlock audio on iOS. */
export function unlockAudio(): void {
  if (typeof AudioContext === 'undefined') return;
  if (!_ctx) {
    _ctx = new AudioContext();
  }
  if (_ctx.state !== 'running') {
    // Store the promise so waitForAudioContext() can await it.
    _resumePromise = _ctx.resume().then(() => {
      // Play a silent 1-sample buffer — the canonical iOS "audio unlock" trick.
      if (!_ctx || _ctx.state !== 'running') return;
      const silent = _ctx.createBuffer(1, 1, _ctx.sampleRate);
      const src = _ctx.createBufferSource();
      src.buffer = silent;
      src.connect(_ctx.destination);
      src.start(0);
    }).catch(() => {});
  }
}

/**
 * Returns the shared AudioContext after waiting for the gesture-triggered
 * resume to complete. Safe to call from async context.
 */
export async function waitForAudioContext(): Promise<AudioContext> {
  if (!_ctx) {
    _ctx = new AudioContext();
  }
  await _resumePromise;
  return _ctx;
}

/** Synchronous accessor — may still be suspended if unlockAudio() was never called. */
export function getSharedAudioContext(): AudioContext {
  if (!_ctx) {
    _ctx = new AudioContext();
  }
  return _ctx;
}
