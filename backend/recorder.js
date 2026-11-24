/**
 * Dev-only session recorder. When RECORD_DIR is set, every listening turn
 * (start -> audio chunks -> stop/close) is written to
 * RECORD_DIR/<timestamp>.json as { start, chunks: [{ meta, dataBase64 }] }.
 * Base64 is fine on disk; the wire protocol stays binary.
 *
 * Feed a recording to tools/decode-recording.mjs to get a WAV and a
 * whisper transcript. Recordings contain your voice; the folder is
 * git-ignored.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function createRecorder(dir, log) {
  if (!dir) return null;
  mkdirSync(dir, { recursive: true });
  let current = null;

  function flush() {
    if (!current || current.chunks.length === 0) {
      current = null;
      return;
    }
    const file = join(dir, `${current.startedAt.replace(/[:.]/g, '-')}.json`);
    writeFileSync(file, JSON.stringify(current));
    log('recorder.saved', { file, chunks: current.chunks.length });
    current = null;
  }

  return {
    onStart(startMessage) {
      flush();
      current = { startedAt: new Date().toISOString(), start: startMessage, chunks: [] };
    },
    onAudioChunk(meta, bytes) {
      current?.chunks.push({ meta, dataBase64: Buffer.from(bytes).toString('base64') });
    },
    onStop: flush,
  };
}
