/**
 * Synthesized sound effects via Web Audio. Each generator schedules nodes into
 * a (possibly offline) AudioContext at a given start time, connected to the
 * provided destination. No asset files — everything is generated on device.
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

function makeNoise(ctx: BaseAudioContext, dur: number): AudioBufferSourceNode {
  const len = Math.max(1, Math.floor(dur * ctx.sampleRate));
  const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const node = ctx.createBufferSource();
  node.buffer = buffer;
  return node;
}

/** Schedule a synthesized SFX. Returns its approximate duration. */
export function scheduleSynthSfx(
  ctx: BaseAudioContext,
  name: string,
  startTime: number,
  volume: number,
  destination: AudioNode,
): number {
  const master = ctx.createGain();
  master.gain.value = volume;
  master.connect(destination);
  const t0 = Math.max(0, startTime);

  switch (name) {
    case 'whoosh':
    case 'swoosh': {
      const dur = 0.45;
      const noise = makeNoise(ctx, dur);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 1.2;
      const up = name === 'whoosh';
      bp.frequency.setValueAtTime(up ? 400 : 4000, t0);
      bp.frequency.exponentialRampToValueAtTime(up ? 4000 : 400, t0 + dur);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.exponentialRampToValueAtTime(1, t0 + dur * 0.4);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      noise.connect(bp).connect(env).connect(master);
      noise.start(t0);
      noise.stop(t0 + dur);
      return dur;
    }
    case 'pop': {
      const dur = 0.14;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(220, t0);
      osc.frequency.exponentialRampToValueAtTime(90, t0 + dur);
      const env = ctx.createGain();
      env.gain.setValueAtTime(1, t0);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(env).connect(master);
      osc.start(t0);
      osc.stop(t0 + dur);
      return dur;
    }
    case 'ding': {
      const dur = 0.6;
      for (const [freq, gain] of [
        [880, 1],
        [1760, 0.4],
      ] as const) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const env = ctx.createGain();
        env.gain.setValueAtTime(gain, t0);
        env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(env).connect(master);
        osc.start(t0);
        osc.stop(t0 + dur);
      }
      return dur;
    }
    case 'click': {
      const dur = 0.06;
      const noise = makeNoise(ctx, dur);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 2000;
      const env = ctx.createGain();
      env.gain.setValueAtTime(1, t0);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      noise.connect(hp).connect(env).connect(master);
      noise.start(t0);
      noise.stop(t0 + dur);
      return dur;
    }
    case 'riser': {
      const dur = 1.0;
      const noise = makeNoise(ctx, dur);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 2;
      bp.frequency.setValueAtTime(200, t0);
      bp.frequency.exponentialRampToValueAtTime(6000, t0 + dur);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.exponentialRampToValueAtTime(1, t0 + dur);
      noise.connect(bp).connect(env).connect(master);
      noise.start(t0);
      noise.stop(t0 + dur);
      return dur;
    }
    case 'boom': {
      const dur = 0.7;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(120, t0);
      osc.frequency.exponentialRampToValueAtTime(40, t0 + dur);
      const env = ctx.createGain();
      env.gain.setValueAtTime(1, t0);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(env).connect(master);
      osc.start(t0);
      osc.stop(t0 + dur);
      return dur;
    }
    default:
      return 0.4;
  }
}
