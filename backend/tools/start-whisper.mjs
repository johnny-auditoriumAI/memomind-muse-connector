/**
 * Starts the local whisper.cpp server (CPU build) on 127.0.0.1 only.
 *   npm run whisper
 * WHISPER_MODEL (default base.en) picks ../whisper/models/ggml-<model>.bin.
 * WHISPER_PORT defaults to 8178, matching the default WHISPER_URL.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'whisper');
const exe = join(root, 'bin', 'Release', 'whisper-server.exe');
const model = join(root, 'models', `ggml-${process.env.WHISPER_MODEL || 'base.en'}.bin`);
const port = process.env.WHISPER_PORT || '8178';

for (const path of [exe, model]) {
  if (!existsSync(path)) {
    console.error(`missing ${path} (see the top-level README for whisper.cpp download/build steps)`);
    process.exit(1);
  }
}

const child = spawn(exe, ['-m', model, '--host', '127.0.0.1', '--port', port, '-t', '8', '-nt'], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill());
