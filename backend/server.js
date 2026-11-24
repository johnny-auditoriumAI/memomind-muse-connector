/**
 * Backend for the MemoMind Muse Connector glasses plugin: WebSocket
 * protocol plumbing only. Turn logic lives in assistant.js; STT in stt/,
 * the assistant model in llm/, configuration in config.js (.env).
 *
 * Protocol (see ../plugin/audio-protocol.js for the authoritative shapes):
 *   Upstream (plugin -> here):
 *     text   {"type":"start", "sampleRate", "codec", "channels", "conversationId", ...}
 *     text   {"type":"audio-meta", "sequence":N, "frameLengths":[...], ...}
 *     binary <raw Opus bytes for that chunk, never Base64>
 *     text   {"type":"stop"}
 *   Downstream (here -> plugin), text/JSON only:
 *     {"type":"transcript","text":"...","final":bool}
 *     {"type":"reply","text":"...","final":bool}
 *     {"type":"state","value":"listening|transcribing|thinking|waiting|idle"}
 *     {"type":"error","message":"..."}
 */
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { createAssistantSession } from './assistant.js';
import { createRecorder } from './recorder.js';
import { createSttFactory } from './stt/index.js';
import { checkWhisper } from './stt/whisper.js';
import { createAssistantRoute } from './llm/assistant-route.js';
import { createPendingRequestStore } from './muse-link/pendingRequestStore.js';
import { createBridgeClient } from './muse-link/bridgeClient.js';
import { createHttpHandler } from './muse-link/httpRoutes.js';

function log(event, data = {}) {
  const stamp = new Date().toISOString();
  console.log(`[${stamp}] ${event}`, JSON.stringify(data));
}

const createStt = createSttFactory(config);
const pendingStore = createPendingRequestStore({ ttlMs: config.assistantRecordTtlMs });
const bridgeClient = createBridgeClient({ bridgeUrl: config.bridgeUrl, bridgeInboundSecret: config.bridgeInboundSecret });

const assistant = createAssistantRoute({
  bridgeClient,
  pendingStore,
  museSessionId: config.museSessionId,
  requestTimeoutMs: config.assistantRequestTimeoutMs,
  assistantName: config.assistantName,
  log,
});

const httpServer = createServer(createHttpHandler({ config, pendingStore, log }));
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, request) => {
  log('connection.open', { remote: request.socket.remoteAddress });

  let pendingMeta;

  // Returns false once the socket has closed, so a late assistant-route
  // reply is never counted as delivered when nothing reached the glasses.
  const send = (message) => {
    if (ws.readyState !== ws.OPEN) return false;
    ws.send(JSON.stringify(message));
    return true;
  };

  const session = createAssistantSession({
    send,
    log,
    config,
    createStt,
    assistant,
    takeQueuedReplies: (conversationId) => pendingStore.takeQueued(conversationId),
  });
  const recorder = createRecorder(config.recordDir, log);

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (!pendingMeta) {
        log('protocol.error', { reason: 'binary frame with no preceding audio-meta' });
        send({ type: 'error', message: 'binary frame received without audio-meta' });
        return;
      }
      const meta = pendingMeta;
      pendingMeta = undefined;
      recorder?.onAudioChunk(meta, data);
      session.onAudioChunk(meta, data);
      return;
    }

    let message;
    try {
      message = JSON.parse(data.toString('utf8'));
    } catch {
      send({ type: 'error', message: 'malformed JSON control message' });
      return;
    }

    switch (message.type) {
      case 'start':
        pendingMeta = undefined;
        recorder?.onStart(message);
        session.onStart(message);
        break;
      case 'audio-meta':
        pendingMeta = message;
        break;
      case 'stop':
        recorder?.onStop();
        session.onStop();
        break;
      default:
        send({ type: 'error', message: `unknown control message type: ${message.type}` });
    }
  });

  ws.on('close', (code, reason) => {
    log('connection.close', { code, reason: reason.toString() });
    recorder?.onStop();
    session.onClose();
  });

  ws.on('error', (error) => {
    log('connection.error', { message: error.message });
  });
});

httpServer.listen(config.port, config.host, async () => {
  log('server.listening', {
    host: config.host,
    port: config.port,
    stt: config.sttProvider,
    bridgeUrl: config.bridgeUrl,
    recording: Boolean(config.recordDir),
  });
  if (config.sttProvider === 'whisper' && !(await checkWhisper(config.whisperUrl))) {
    log('server.warning', { message: `whisper-server not reachable at ${config.whisperUrl}; start it with "npm run whisper"` });
  }
});
