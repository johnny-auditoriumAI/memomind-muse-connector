/**
 * STT provider factory. Every provider returns the same stream shape:
 *   write(pcm16Buffer)          buffer or forward decoded audio
 *   finish(): Promise<string>   end of utterance -> full transcript ('' if nothing)
 *   close()                     abort without waiting
 */
import { createWhisperStream } from './whisper.js';
import { createMockSttStream } from './mock.js';

export function createSttFactory(config) {
  switch (config.sttProvider) {
    case 'whisper':
      return ({ sampleRate, channels }) => createWhisperStream({
        sampleRate, channels, whisperUrl: config.whisperUrl, timeoutMs: config.whisperTimeoutMs,
      });
    case 'mock':
      return () => createMockSttStream();
    default:
      throw new Error(`unknown STT_PROVIDER "${config.sttProvider}"`);
  }
}
