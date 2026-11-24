import { test } from 'node:test';
import assert from 'node:assert/strict';
import OpusScript from 'opusscript';
import { splitFrames, createOpusDecoder } from '../audio/opus.js';
import { pcmToWav, normalizePeak, pcmDurationMs } from '../audio/wav.js';

test('splitFrames splits on frameLengths', () => {
  const frames = splitFrames([2, 3], Buffer.from([1, 2, 3, 4, 5]));
  assert.deepEqual(frames.map((f) => [...f]), [[1, 2], [3, 4, 5]]);
});

test('splitFrames rejects mismatched, empty, and invalid lengths', () => {
  assert.throws(() => splitFrames([2, 2], Buffer.alloc(5)), /sum 4 != chunk size 5/);
  assert.throws(() => splitFrames([], Buffer.alloc(0)), /no frameLengths/);
  assert.throws(() => splitFrames(undefined, Buffer.alloc(1)), /no frameLengths/);
  assert.throws(() => splitFrames([0, 1], Buffer.alloc(1)), /invalid frame length/);
});

test('decoder round-trips two 20 ms frames to 640 samples', () => {
  const encoder = new OpusScript(16000, 1, OpusScript.Application.VOIP);
  const packets = [0, 1].map(() => Buffer.from(encoder.encode(Buffer.alloc(640), 320)));
  encoder.delete();
  const decoder = createOpusDecoder({ sampleRate: 16000, channels: 1 });
  const pcm = decoder.decodeChunk(
    { frameLengths: packets.map((p) => p.length), discontinuity: false },
    Buffer.concat(packets),
  );
  assert.equal(pcm.length, 2 * 320 * 2);
  // discontinuity resets the decoder and still decodes
  assert.equal(decoder.decodeChunk({ frameLengths: [packets[0].length], discontinuity: true }, packets[0]).length, 640);
  decoder.close();
});

test('decoder rejects unsupported formats', () => {
  assert.throws(() => createOpusDecoder({ sampleRate: 44100, channels: 1 }), /sample rate/);
  assert.throws(() => createOpusDecoder({ sampleRate: 16000, channels: 3 }), /channel count/);
});

test('pcmToWav writes a valid 16-bit PCM header', () => {
  const wav = pcmToWav(Buffer.alloc(320), 16000, 1);
  assert.equal(wav.length, 44 + 320);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4), 36 + 320);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt32LE(28), 32000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 320);
});

test('normalizePeak boosts quiet audio, caps gain, leaves silence alone', () => {
  const quiet = Buffer.alloc(4);
  quiet.writeInt16LE(1000, 0);
  quiet.writeInt16LE(-500, 2);
  const boosted = normalizePeak(quiet, { targetDbfs: -6, maxGainDb: 40 });
  assert.ok(Math.abs(boosted.readInt16LE(0) - 16422) <= 1);
  assert.ok(Math.abs(boosted.readInt16LE(2) + 8211) <= 1);

  const capped = normalizePeak(quiet, { targetDbfs: -3, maxGainDb: 6 });
  assert.ok(Math.abs(capped.readInt16LE(0) - 1995) <= 1);

  const silence = Buffer.alloc(8);
  assert.equal(normalizePeak(silence), silence);
});

test('pcmDurationMs', () => {
  assert.equal(pcmDurationMs(32000, 16000, 1), 1000);
});
