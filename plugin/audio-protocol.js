/**
 * Upstream/downstream WebSocket protocol between this plugin and the
 * MemoMind One backend. Framing choice: JSON control messages (WebSocket
 * text frames) interleaved with raw binary frames (WebSocket binary
 * frames), never Base64. Full protocol documented in README.md.
 *
 * Upstream (plugin -> backend):
 *   text   {"type":"start","sampleRate":16000,"codec":"opus","channels":1,"frameDurationMs":20,
 *           "conversationId":"<uuid>"}   (sent after openCapture, from its resolvedOptions)
 *   text   {"type":"audio-meta","sequence":N,"timestampUs":N,"durationMs":N,
 *           "frameCount":N,"frameLengths":[...],"discontinuity":bool}
 *   binary <raw bytes of chunk.data, exactly chunk.data.byteLength long>
 *          (always immediately follows its own "audio-meta" message)
 *   text   {"type":"stop"}
 *
 * Downstream (backend -> plugin), text/JSON only:
 *   {"type":"transcript","text":"...","final":bool}
 *   {"type":"reply","text":"...","final":bool}   (final:false = streaming partial, full text so far;
 *                                                  absent = final, for older backends)
 *   {"type":"state","value":"listening|transcribing|thinking|waiting|idle"}  (waiting: assistant-route reply still on its way)
 *   {"type":"error","message":"..."}
 */

export function encodeStart({ sampleRate = 16000, codec = 'opus', channels = 1, frameDurationMs = 20, conversationId } = {}) {
  return JSON.stringify({ type: 'start', sampleRate, codec, channels, frameDurationMs, conversationId });
}

export function encodeStop() {
  return JSON.stringify({ type: 'stop' });
}

export function encodeAudioMeta(chunk) {
  return JSON.stringify({
    type: 'audio-meta',
    sequence: chunk.sequence,
    timestampUs: chunk.timestampUs,
    durationMs: chunk.durationMs,
    frameCount: chunk.frameCount,
    frameLengths: Array.from(chunk.frameLengths ?? []),
    discontinuity: Boolean(chunk.discontinuity),
  });
}

/** Parse one downstream text frame. Returns null for anything unrecognized. */
export function decodeDownstream(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!message || typeof message !== 'object') return null;
  switch (message.type) {
    case 'transcript':
      return { type: 'transcript', text: String(message.text ?? ''), final: Boolean(message.final) };
    case 'reply':
      return { type: 'reply', text: String(message.text ?? ''), final: message.final !== false };
    case 'state':
      return { type: 'state', value: String(message.value ?? '') };
    case 'error':
      return { type: 'error', message: String(message.message ?? 'Unknown backend error') };
    default:
      return null;
  }
}
