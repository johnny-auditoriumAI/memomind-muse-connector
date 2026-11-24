/**
 * End-to-end protocol check against a running backend (any providers):
 * sends 1 s of Opus-encoded tone in the plugin's chunk format, then checks
 * the downstream sequence: state listening -> transcribing -> transcript
 * (final) -> reply (final). Two turns on one conversationId, so memory is
 * exercised too.
 *
 *   node smoke-test.mjs [ws://127.0.0.1:8800]
 *
 * With STT_PROVIDER=mock on the server this needs no whisper-server; a real
 * whisper may transcribe a pure tone as empty, which still passes (the
 * backend then replies "didn't catch that"). Either way the reply always
 * goes through the Muse bridge, so BRIDGE_URL/MUSE_SESSION_ID must be set
 * and reachable.
 */
import OpusScript from 'opusscript';
import { runTurn } from './tools/replay.mjs';

const url = process.argv[2] || 'ws://127.0.0.1:8800';
const encoder = new OpusScript(16000, 1, OpusScript.Application.VOIP);
const chunks = [];
for (let sequence = 0; sequence < 25; sequence += 1) {
  const packets = [0, 1].map((f) => {
    const pcm = Buffer.alloc(640);
    for (let i = 0; i < 320; i += 1) {
      const t = ((sequence * 2 + f) * 320 + i) / 16000;
      pcm.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * 440 * t)), i * 2);
    }
    return Buffer.from(encoder.encode(pcm, 320));
  });
  chunks.push({
    meta: { type: 'audio-meta', sequence, timestampUs: sequence * 40000, durationMs: 40, frameCount: 2,
      frameLengths: packets.map((p) => p.length), discontinuity: false },
    dataBase64: Buffer.concat(packets).toString('base64'),
  });
}
encoder.delete();

const start = { type: 'start', sampleRate: 16000, codec: 'opus', channels: 1, frameDurationMs: 20,
  conversationId: `smoke-${Date.now()}` };

let failed = false;
for (const turn of [1, 2]) {
  const received = await runTurn({ url, start, chunks, timeoutMs: 30000 });
  const types = received.map((m) => (m.type === 'state' ? `state:${m.value}` : `${m.type}${m.final === false ? '(partial)' : ''}`));
  const finalReply = received.find((m) => m.type === 'reply' && m.final !== false);
  const ok = types[0] === 'state:listening'
    && types.includes('state:transcribing')
    && received.some((m) => m.type === 'transcript' && m.final === true)
    && Boolean(finalReply);
  console.log(`turn ${turn}: ${ok ? 'PASS' : 'FAIL'}  ${types.join(' -> ')}`);
  console.log(`  reply: ${JSON.stringify(finalReply?.text ?? received.at(-1))}`);
  failed ||= !ok;
}
process.exit(failed ? 1 : 0);
