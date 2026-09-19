import { writeFile } from "node:fs/promises";

const sampleRate = 22050;
const seconds = 6;
const crossfade = Math.floor(sampleRate * 0.5);
const total = sampleRate * seconds;

const samples = new Float64Array(total);
let white = 0;
let brown = 0;
let dripTimer = 0;
for (let i = 0; i < total; i++) {
  white = Math.random() * 2 - 1;
  brown = (brown + 0.02 * white) / 1.02;
  let sample = brown * 3.2 + white * 0.12;
  if (dripTimer-- <= 0) {
    dripTimer = Math.floor(sampleRate * (0.05 + Math.random() * 0.35));
    sample += (Math.random() * 2 - 1) * 0.35;
  }
  samples[i] = Math.max(-1, Math.min(1, sample));
}
for (let i = 0; i < crossfade; i++) {
  const fade = i / crossfade;
  samples[i] = samples[i] * fade + samples[total - crossfade + i] * (1 - fade);
}
const loopLength = total - crossfade;

const bytes = Buffer.alloc(44 + loopLength * 2);
bytes.write("RIFF", 0);
bytes.writeUInt32LE(36 + loopLength * 2, 4);
bytes.write("WAVE", 8);
bytes.write("fmt ", 12);
bytes.writeUInt32LE(16, 16);
bytes.writeUInt16LE(1, 20);
bytes.writeUInt16LE(1, 22);
bytes.writeUInt32LE(sampleRate, 24);
bytes.writeUInt32LE(sampleRate * 2, 28);
bytes.writeUInt16LE(2, 32);
bytes.writeUInt16LE(16, 34);
bytes.write("data", 36);
bytes.writeUInt32LE(loopLength * 2, 40);
for (let i = 0; i < loopLength; i++) {
  bytes.writeInt16LE(Math.round(samples[i] * 32000), 44 + i * 2);
}
await writeFile("extension/assets/rain.wav", bytes);
console.log(`wrote extension/assets/rain.wav (${Math.round(bytes.length / 1024)} KB, ${seconds}s loop)`);
