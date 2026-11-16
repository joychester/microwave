// Tiny WebAudio synth: no audio files, everything generated. Off by default.
let ctx: AudioContext | null = null;
let enabled = false;

export function setSoundEnabled(on: boolean) {
  enabled = on;
  if (on) ensure();
}

function ensure(): AudioContext | null {
  try {
    if (!ctx) ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(freq: number, start: number, dur: number, type: OscillatorType = 'sine', gain = 0.12, slideTo?: number) {
  const c = ensure();
  if (!c) return;
  const t0 = c.currentTime + start;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(c.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

function noise(start: number, dur: number, gain = 0.15) {
  const c = ensure();
  if (!c) return;
  const len = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = 900;
  const g = c.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(c.destination);
  src.start(c.currentTime + start);
}

export type Sfx = 'alarm' | 'warn' | 'breaker' | 'scaleUp' | 'scaleDown' | 'crash' | 'recover' | 'tick' | 'go' | 'win' | 'lose' | 'click';

const lastPlayed: Partial<Record<Sfx, number>> = {};

export function play(s: Sfx) {
  if (!enabled) return;
  const now = performance.now();
  if ((lastPlayed[s] ?? 0) > now - 250) return; // de-duplicate bursts
  lastPlayed[s] = now;
  switch (s) {
    case 'alarm': tone(880, 0, 0.16, 'square', 0.06); tone(660, 0.18, 0.16, 'square', 0.06); tone(880, 0.36, 0.16, 'square', 0.06); break;
    case 'warn': tone(520, 0, 0.12, 'triangle', 0.08); tone(520, 0.16, 0.12, 'triangle', 0.08); break;
    case 'breaker': tone(180, 0, 0.18, 'sawtooth', 0.07, 90); break;
    case 'scaleUp': tone(440, 0, 0.09, 'triangle', 0.08); tone(660, 0.08, 0.12, 'triangle', 0.08); break;
    case 'scaleDown': tone(660, 0, 0.09, 'triangle', 0.06); tone(440, 0.08, 0.12, 'triangle', 0.06); break;
    case 'crash': noise(0, 0.45, 0.22); tone(120, 0, 0.35, 'sine', 0.12, 50); break;
    case 'recover': tone(523, 0, 0.1, 'sine', 0.08); tone(784, 0.09, 0.16, 'sine', 0.08); break;
    case 'tick': tone(740, 0, 0.08, 'sine', 0.1); break;
    case 'go': tone(1046, 0, 0.25, 'sine', 0.12); break;
    case 'win': [523, 659, 784, 1046].forEach((f, i) => tone(f, i * 0.11, 0.3, 'triangle', 0.1)); break;
    case 'lose': [392, 330, 262, 196].forEach((f, i) => tone(f, i * 0.16, 0.35, 'sawtooth', 0.06)); break;
    case 'click': tone(1200, 0, 0.03, 'square', 0.03); break;
  }
}
