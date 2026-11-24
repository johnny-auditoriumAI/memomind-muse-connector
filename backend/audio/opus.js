/**
 * Upstream audio -> PCM16. Each binary chunk from the plugin is one or more
 * consecutive Opus packets; the preceding audio-meta's `frameLengths` gives
 * every packet boundary, so no Opus parsing is needed to split them.
 */
import OpusScript from 'opusscript';

const OPUS_RATES = new Set([8000, 12000, 16000, 24000, 48000]);

/** Split one chunk into packets. Throws if frameLengths don't cover the bytes exactly. */
export function splitFrames(frameLengths, bytes) {
  if (!Array.isArray(frameLengths) || frameLengths.length === 0) {
    throw new Error('audio-meta has no frameLengths');
  }
  let total = 0;
  for (const length of frameLengths) {
    if (!Number.isInteger(length) || length <= 0) throw new Error(`invalid frame length ${length}`);
    total += length;
  }
  if (total !== bytes.length) {
    throw new Error(`frameLengths sum ${total} != chunk size ${bytes.length}`);
  }
  const frames = [];
  let offset = 0;
  for (const length of frameLengths) {
    frames.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  return frames;
}

export function createOpusDecoder({ sampleRate = 16000, channels = 1 } = {}) {
  if (!OPUS_RATES.has(sampleRate)) throw new Error(`unsupported Opus sample rate ${sampleRate}`);
  if (channels !== 1 && channels !== 2) throw new Error(`unsupported channel count ${channels}`);
  let decoder = new OpusScript(sampleRate, channels, OpusScript.Application.VOIP);

  return {
    sampleRate,
    channels,
    /** Decode one audio-meta + binary chunk into PCM16 LE. */
    decodeChunk(meta, bytes) {
      if (meta.discontinuity) this.reset();
      const pcm = splitFrames(meta.frameLengths, Buffer.from(bytes)).map((frame) => Buffer.from(decoder.decode(frame)));
      return Buffer.concat(pcm);
    },
    /** Dropped audio upstream: start the decoder state fresh. */
    reset() {
      decoder.delete();
      decoder = new OpusScript(sampleRate, channels, OpusScript.Application.VOIP);
    },
    close() {
      decoder?.delete();
      decoder = null;
    },
  };
}
