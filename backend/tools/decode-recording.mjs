/**
 * Phase 0 check: decode a recorder.js session file to WAV, then (unless
 * --no-stt) send it to the local whisper-server and print the transcript.
 *
 *   node tools/decode-recording.mjs <recording.json> [--no-stt]
 *
 * Writes <recording>.wav next to the input. WHISPER_URL defaults to
 * http://127.0.0.1:8178.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import OpusScript from 'opusscript';

const [input, ...flags] = process.argv.slice(2);
if (!input) {
  console.error('usage: node tools/decode-recording.mjs <recording.json> [--no-stt]');
  process.exit(2);
}
const whisperUrl = process.env.WHISPER_URL || 'http://127.0.0.1:8178';

const recording = JSON.parse(readFileSync(input, 'utf8'));
const sampleRate = recording.start?.sampleRate ?? 16000;
const channels = recording.start?.channels ?? 1;

const decoder = new OpusScript(sampleRate, channels, OpusScript.Application.VOIP);
const pcmParts = [];
let frames = 0;
let discontinuities = 0;
let badChunks = 0;

for (const { meta, dataBase64 } of recording.chunks) {
  const bytes = Buffer.from(dataBase64, 'base64');
  const lengths = meta.frameLengths ?? [];
  if (lengths.reduce((a, b) => a + b, 0) !== bytes.length) {
    badChunks += 1;
    continue;
  }
  if (meta.discontinuity) discontinuities += 1;
  let offset = 0;
  for (const length of lengths) {
    pcmParts.push(Buffer.from(decoder.decode(bytes.subarray(offset, offset + length))));
    offset += length;
    frames += 1;
  }
}
decoder.delete();

const pcm = Buffer.concat(pcmParts);
const wav = Buffer.concat([wavHeader(pcm.length, sampleRate, channels), pcm]);
const wavPath = input.replace(/\.json$/i, '') + '.wav';
writeFileSync(wavPath, wav);

let peak = 0;
for (let i = 0; i < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
console.log(JSON.stringify({
  wav: wavPath, sampleRate, channels, chunks: recording.chunks.length, frames, badChunks,
  discontinuities, seconds: +(pcm.length / 2 / channels / sampleRate).toFixed(2),
  peakDbfs: peak ? +(20 * Math.log10(peak / 32768)).toFixed(1) : null,
}, null, 2));

if (!flags.includes('--no-stt')) {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'utterance.wav');
  form.append('response_format', 'json');
  form.append('temperature', '0');
  const started = performance.now();
  const response = await fetch(`${whisperUrl}/inference`, { method: 'POST', body: form });
  const body = await response.json();
  console.log(`whisper (${response.status}, ${Math.round(performance.now() - started)} ms): ${JSON.stringify(body.text?.trim() ?? body)}`);
}

function wavHeader(dataBytes, rate, ch) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataBytes, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(ch, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * ch * 2, 28);
  h.writeUInt16LE(ch * 2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(dataBytes, 40);
  return h;
}
