/**
 * Plain HTTP routes shared on the same port as the WebSocket server:
 *   GET  /health         - process liveness only, no model/transcription call
 *   POST /v1/muse-reply  - the bridge delivering the assistant's answer back
 * No framework dependency; this project otherwise only uses `ws`.
 */
const MAX_BODY_BYTES = 16 * 1024;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(Object.assign(new Error('malformed JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function isAuthorized(req, secret) {
  if (!secret) return false;
  const header = req.headers.authorization || '';
  return header === `Bearer ${secret}`;
}

/** Schema + size validation for the bridge's POST /v1/muse-reply body. */
function validateMuseReply(body) {
  if (typeof body !== 'object' || body === null) return 'body must be a JSON object';
  if (typeof body.request_id !== 'string' || !body.request_id) return 'request_id is required';
  if (!['ok', 'error', 'timeout'].includes(body.status)) return 'status must be ok, error, or timeout';
  if (body.status === 'ok' && (typeof body.text !== 'string' || !body.text)) return 'text is required when status is ok';
  if (typeof body.text === 'string' && body.text.length > 2000) return 'text exceeds 2000 characters';
  return null;
}

export function createHttpHandler({ config, pendingStore, log }) {
  return async function handleHttpRequest(req, res) {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { status: 'ok', pendingRequests: pendingStore.size() });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/muse-reply') {
      if (!isAuthorized(req, config.backendReplySecret)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, error.statusCode || 400, { error: error.message });
        return;
      }
      const validationError = validateMuseReply(body);
      if (validationError) {
        sendJson(res, 400, { error: validationError });
        return;
      }

      const { request_id: requestId, status, text } = body;
      if (!pendingStore.has(requestId)) {
        log('muse-reply.unknown', { requestId });
        sendJson(res, 404, { error: 'unknown request_id' });
        return;
      }

      const resolvedWaiter = pendingStore.resolveWaiter(requestId, { status, text });
      if (resolvedWaiter) {
        log('muse-reply.delivered-live', { requestId, status });
        sendJson(res, 200, { request_id: requestId, delivered: true });
        return;
      }

      const outcome = pendingStore.deliverLate(requestId, { type: 'reply', text: text ?? '', final: true });
      log('muse-reply.late', { requestId, status, outcome });
      if (outcome === 'duplicate') {
        sendJson(res, 409, { error: 'request_id already delivered' });
        return;
      }
      sendJson(res, 200, { request_id: requestId, delivered: outcome === 'delivered', queued: outcome === 'queued' });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  };
}
