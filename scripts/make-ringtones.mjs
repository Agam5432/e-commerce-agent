// Renders the call window's ring sounds to WAV files (src/public/admin/sounds/). Real audio files, not a tone made on the
// fly in the page: a browser keeps playing a file in a background tab, on a Mac, in Safari, where a timer-driven beep is
// slowed down or silenced. Each file is one ring cycle (the sound, then the pause) and is played in a loop.
// Usage: node scripts/make-ringtones.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RATE = 22050;
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "public", "admin", "sounds");

function track(seconds) {
  const data = new Float32Array(Math.ceil(seconds * RATE));
  const osc = (type, phase) => {
    const p = phase - Math.floor(phase);
    if (type === "square") return p < 0.5 ? 1 : -1;
    if (type === "sawtooth") return 2 * p - 1;
    if (type === "triangle") return 4 * Math.abs(p - 0.5) - 1;
    return Math.sin(2 * Math.PI * phase);
  };
  // a held tone: fast attack, a hold, then a release (no clicks)
  const tone = (t, freq, dur, { type = "sine", gain = 0.3, attack = 0.01, release = 0.06, to = null } = {}) => {
    const start = Math.floor(t * RATE);
    const n = Math.floor(dur * RATE);
    let phase = 0;
    for (let i = 0; i < n && start + i < data.length; i += 1) {
      const x = i / RATE;
      const f = to == null ? freq : freq + (to - freq) * (x / dur);
      phase += f / RATE;
      const env = Math.min(1, x / Math.max(attack, 1e-4)) * Math.min(1, (dur - x) / Math.max(release, 1e-4));
      data[start + i] += osc(type, phase) * gain * Math.max(0, env);
    }
  };
  // a struck sound: loudest at the start, then it dies away
  const strike = (t, freq, dur, { type = "sine", gain = 0.3 } = {}) => {
    const start = Math.floor(t * RATE);
    const n = Math.floor(dur * RATE);
    for (let i = 0; i < n && start + i < data.length; i += 1) {
      const x = i / RATE;
      const env = Math.exp((-6.9 * x) / dur) * Math.min(1, x / 0.004);
      data[start + i] += osc(type, freq * x) * gain * env;
    }
  };
  return { data, tone, strike };
}

const SOUNDS = {
  // the ring of a real phone: two tones together
  "classic-phone": { seconds: 2.6, build: ({ tone }) => { for (const f of [440, 480]) tone(0, f, 1.0, { gain: 0.3, attack: 0.03, release: 0.1 }); } },
  "double-ring": { seconds: 2.6, build: ({ tone }) => { for (const s of [0, 0.55]) for (const f of [400, 450]) tone(s, f, 0.4, { gain: 0.3, attack: 0.02 }); } },
  "old-bell": { seconds: 2.2, build: ({ tone }) => { for (let i = 0; i < 16; i += 1) tone(i * 0.055, i % 2 ? 1500 : 1900, 0.05, { type: "square", gain: 0.12, attack: 0.004, release: 0.02 }); } },
  "soft-chime": { seconds: 2.8, build: ({ strike }) => { [523.25, 659.25, 783.99].forEach((f, i) => strike(i * 0.2, f, 1.1, { gain: 0.4 })); } },
  doorbell: { seconds: 3.0, build: ({ strike }) => { [[659.25, 0], [523.25, 0.55]].forEach(([f, s]) => { strike(s, f, 1.3, { gain: 0.42 }); strike(s, f * 2, 0.5, { gain: 0.1 }); }); } },
  harp: { seconds: 3.0, build: ({ strike }) => { [392, 493.88, 587.33, 783.99, 987.77].forEach((f, i) => { strike(i * 0.11, f, 1.0, { gain: 0.3 }); strike(i * 0.11, f * 2, 0.4, { gain: 0.06 }); }); } },
  marimba: { seconds: 2.4, build: ({ strike }) => { [587.33, 739.99, 880, 739.99].forEach((f, i) => { strike(i * 0.15, f, 0.45, { gain: 0.42 }); strike(i * 0.15, f * 4, 0.12, { gain: 0.08 }); }); } },
  "gentle-pulse": { seconds: 2.4, build: ({ tone }) => { tone(0, 660, 1.1, { type: "triangle", gain: 0.3, attack: 0.5, release: 0.5 }); tone(0, 990, 1.1, { gain: 0.09, attack: 0.5, release: 0.5 }); } },
  // not one of the choices: the sound for a callback that is due
  alert: { seconds: 2.0, build: ({ tone }) => { for (let i = 0; i < 3; i += 1) tone(i * 0.3, 700, 0.28, { type: "sawtooth", gain: 0.14, to: 1100, attack: 0.02, release: 0.04 }); } },
};

function wav(samples) {
  // bring the loudest point to about -3 dB, so every ring is equally loud and the page's volume slider does the rest
  let peak = 0;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  const scale = peak > 0 ? 0.7 / peak : 1;
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples.length * 2, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(RATE, 24);
  buffer.writeUInt32LE(RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v * scale)) * 32767), 44 + i * 2));
  return buffer;
}

fs.mkdirSync(OUT, { recursive: true });
for (const [name, { seconds, build }] of Object.entries(SOUNDS)) {
  const t = track(seconds);
  build(t);
  const file = path.join(OUT, `${name}.wav`);
  fs.writeFileSync(file, wav(t.data));
  console.log(`${name}.wav  ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
}
