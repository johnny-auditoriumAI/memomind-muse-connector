import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHttpHandler } from '../muse-link/httpRoutes.js';
import { createPendingRequestStore } from '../muse-link/pendingRequestStore.js';

const silentLog = () => {};

function harness({ backendReplySecret = 'test-secret' } = {}) {
  const pendingStore = createPendingRequestStore({ ttlMs: 60000 });
  const server = createServer(createHttpHandler({ config: { backendReplySecret }, pendingStore, log: silentLog }));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ pendingStore, server, base: `http://127.0.0.1:${port}` });
    });
  });
}

test('GET /health reports ok without touching any model', async () => {
  const { server, base } = await harness();
  try {
    const res = await fetch(`${base}/health`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.status, 'ok');
  } finally {
    server.close();
  }
});

test('POST /v1/muse-reply without a valid bearer token is rejected', async () => {
  const { server, base } = await harness();
  try {
    const res = await fetch(`${base}/v1/muse-reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request_id: 'x', status: 'ok', text: 'hi' }),
    });
    assert.equal(res.status, 401);
  } finally {
    server.close();
  }
});

test('POST /v1/muse-reply for an unknown request_id is a 404, never claims delivery', async () => {
  const { server, base } = await harness();
  try {
    const res = await fetch(`${base}/v1/muse-reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-secret' },
      body: JSON.stringify({ request_id: 'unknown-id', status: 'ok', text: 'hi' }),
    });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test('POST /v1/muse-reply delivers to a waiting in-process turn', async () => {
  const { server, base, pendingStore } = await harness();
  try {
    pendingStore.create('req-1', { send: () => {} });
    const waiterResult = new Promise((resolve) => pendingStore.attachWaiter('req-1', resolve));

    const res = await fetch(`${base}/v1/muse-reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-secret' },
      body: JSON.stringify({ request_id: 'req-1', status: 'ok', text: 'the answer' }),
    });
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.delivered, true);
    assert.deepEqual(await waiterResult, { status: 'ok', text: 'the answer' });
  } finally {
    server.close();
  }
});

test('POST /v1/muse-reply twice for the same request_id: second call is a 409 duplicate', async () => {
  const { server, base, pendingStore } = await harness();
  try {
    pendingStore.create('req-2', { send: () => {} });
    pendingStore.attachWaiter('req-2', () => {});

    const payload = { request_id: 'req-2', status: 'ok', text: 'answer' };
    const first = await fetch(`${base}/v1/muse-reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-secret' },
      body: JSON.stringify(payload),
    });
    const second = await fetch(`${base}/v1/muse-reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-secret' },
      body: JSON.stringify(payload),
    });

    assert.equal(first.status, 200);
    assert.equal(second.status, 409);
  } finally {
    server.close();
  }
});

test('POST /v1/muse-reply rejects a malformed body with 400', async () => {
  const { server, base } = await harness();
  try {
    const res = await fetch(`${base}/v1/muse-reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-secret' },
      body: JSON.stringify({ status: 'ok', text: 'missing request_id' }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});
