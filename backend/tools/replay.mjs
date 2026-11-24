/**
 * Plays a recorded turn (recorder.js format) into a running backend exactly
 * as the plugin would, and prints every downstream message.
 *
 *   node tools/replay.mjs <recording.json> [--url ws://127.0.0.1:8800] [--conversation <id>] [--realtime]
 *
 * --realtime paces chunks at their real duration (default: as fast as possible).
 * Exits 0 when a final reply arrives, 1 on error/timeout.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';

export function runTurn({ url, start, chunks, realtime = false, timeoutMs = 45000, onMessage = () => {} }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const received = [];
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`timed out; received ${JSON.stringify(received)}`));
    }, timeoutMs);

    ws.on('open', async () => {
      ws.send(JSON.stringify(start));
      for (const { meta, dataBase64 } of chunks) {
        ws.send(JSON.stringify(meta));
        ws.send(Buffer.from(dataBase64, 'base64'));
        if (realtime) await new Promise((r) => setTimeout(r, meta.durationMs ?? 40));
      }
      ws.send(JSON.stringify({ type: 'stop' }));
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(data.toString('utf8'));
      received.push({ ...message, at: Date.now() });
      onMessage(message);
      const done = (message.type === 'reply' && message.final !== false) || message.type === 'error';
      if (done) {
        clearTimeout(timer);
        ws.close();
        resolve(received);
      }
    });
    ws.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const file = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
  if (!file) {
    console.error('usage: node tools/replay.mjs <recording.json> [--url ws://...] [--conversation id] [--realtime]');
    process.exit(2);
  }
  const recording = JSON.parse(readFileSync(file, 'utf8'));
  const start = { ...recording.start, conversationId: option('--conversation', `replay-${Date.now()}`) };
  const started = Date.now();
  try {
    const received = await runTurn({
      url: option('--url', 'ws://127.0.0.1:8800'),
      start,
      chunks: recording.chunks,
      realtime: args.includes('--realtime'),
      onMessage: (m) => console.log(`+${String(Date.now() - started).padStart(5)}ms`, JSON.stringify(m)),
    });
    process.exit(received.at(-1).type === 'error' ? 1 : 0);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
