/** PCM16 LE helpers: WAV wrapping and peak normalization for STT input. */

export function pcmToWav(pcm, sampleRate, channels) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Scale so the peak sits at `targetDbfs`, never amplifying more than
 * `maxGainDb`. Studio mic input peaked around -28 dBFS, which is quiet for
 * Whisper. Returns a new buffer; silence is returned unchanged.
 */
export function normalizePeak(pcm, { targetDbfs = -3, maxGainDb = 24 } = {}) {
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
  if (peak === 0) return pcm;
  const gain = Math.min(10 ** (targetDbfs / 20) * 32767 / peak, 10 ** (maxGainDb / 20));
  if (gain <= 1) return pcm;
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(i) * gain))), i);
  }
  return out;
}

export function pcmDurationMs(byteLength, sampleRate, channels) {
  return (byteLength / 2 / channels / sampleRate) * 1000;
}
