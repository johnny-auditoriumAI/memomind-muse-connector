/**
 * Local whisper.cpp STT (batch). Buffers the utterance's PCM, then on
 * finish() sends it as a WAV to whisper-server's /inference endpoint.
 * whisper-server is started separately (`npm run whisper`) and listens on
 * 127.0.0.1 only. No interim results, so onPartial is never called.
 */
import { normalizePeak, pcmToWav } from '../audio/wav.js';

export function createWhisperStream({ sampleRate, channels, whisperUrl, timeoutMs }) {
  const parts = [];
  let closed = false;
  const controller = new AbortController();

  return {
    write(pcm) {
      if (!closed) parts.push(pcm);
    },
    async finish() {
      closed = true;
      const pcm = Buffer.concat(parts);
      if (pcm.length === 0) return '';
      const wav = pcmToWav(normalizePeak(pcm), sampleRate, channels);
      const form = new FormData();
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'utterance.wav');
      form.append('response_format', 'json');
      form.append('temperature', '0');
      const response = await fetch(`${whisperUrl}/inference`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
      });
      if (!response.ok) throw new Error(`whisper-server returned HTTP ${response.status}`);
      const body = await response.json();
      if (typeof body.text !== 'string') throw new Error('whisper-server response has no text');
      return cleanTranscript(body.text);
    },
    close() {
      closed = true;
      controller.abort();
    },
  };
}

/**
 * Whisper marks non-speech with bracketed tags such as "[BLANK_AUDIO]" or
 * "(wind blowing)". Treat a transcript made only of those as empty.
 */
export function cleanTranscript(text) {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  const withoutTags = trimmed.replace(/\[[^\]]*\]|\([^)]*\)/g, '').trim();
  return withoutTags ? trimmed : '';
}

export async function checkWhisper(whisperUrl) {
  try {
    const response = await fetch(`${whisperUrl}/`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}
