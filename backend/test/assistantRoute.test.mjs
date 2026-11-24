import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantRoute, delayedReply, bridgeUnreachableReply } from '../llm/assistant-route.js';
import { createPendingRequestStore } from '../muse-link/pendingRequestStore.js';

const silentLog = () => {};
const NAME = 'Muse';

test('assistant-route: resolves with the bridge reply when it arrives before the timeout', async () => {
  const pendingStore = createPendingRequestStore({ ttlMs: 60000 });
  let capturedRequestId;
  const bridgeClient = {
    async submitAssistRequest({ requestId }) {
      capturedRequestId = requestId;
      // Simulate the bridge's POST /v1/muse-reply arriving almost immediately.
      queueMicrotask(() => pendingStore.resolveWaiter(requestId, { status: 'ok', text: 'hi there' }));
    },
  };
  const route = createAssistantRoute({
    bridgeClient,
    pendingStore,
    museSessionId: 'side-chat-1',
    requestTimeoutMs: 1000,
    assistantName: NAME,
    log: silentLog,
  });

  const result = await route.reply({ text: 'what is the plan', send: () => {} });

  assert.equal(result.text, 'hi there');
  assert.equal(result.stopReason, 'end_turn');
  assert.ok(capturedRequestId);
  assert.equal(pendingStore.status(capturedRequestId), 'delivered');
});

test('assistant-route: times out with the delayed reply, and a later bridge reply still reaches a live send()', async () => {
  const pendingStore = createPendingRequestStore({ ttlMs: 60000 });
  let capturedRequestId;
  const bridgeClient = { async submitAssistRequest({ requestId }) { capturedRequestId = requestId; } };
  const route = createAssistantRoute({
    bridgeClient,
    pendingStore,
    museSessionId: 'side-chat-1',
    requestTimeoutMs: 15,
    assistantName: NAME,
    log: silentLog,
  });
  const sent = [];

  const result = await route.reply({ text: 'slow question', send: (m) => sent.push(m) });

  assert.equal(result.text, delayedReply(NAME));
  assert.equal(result.stopReason, 'delayed');

  // The bridge's reply callback arrives after the turn already gave up.
  const resolvedLive = pendingStore.resolveWaiter(capturedRequestId, { status: 'ok', text: 'ignored, no waiter' });
  assert.equal(resolvedLive, false, 'the turn already timed out; no in-process waiter remains');
  const outcome = pendingStore.deliverLate(capturedRequestId, { type: 'reply', text: 'late answer', final: true });
  assert.equal(outcome, 'delivered');
  assert.deepEqual(sent, [{ type: 'reply', text: 'late answer', final: true }]);
});

test('assistant-route: a bridge submit failure returns immediately without waiting out the timeout', async () => {
  const pendingStore = createPendingRequestStore({ ttlMs: 60000 });
  const bridgeClient = { async submitAssistRequest() { throw new Error('ECONNREFUSED'); } };
  const route = createAssistantRoute({
    bridgeClient,
    pendingStore,
    museSessionId: 'side-chat-1',
    requestTimeoutMs: 20000,
    assistantName: NAME,
    log: silentLog,
  });

  const result = await route.reply({ text: 'hello', send: () => {} });

  assert.equal(result.text, bridgeUnreachableReply(NAME));
  assert.equal(result.stopReason, 'bridge-error');
});

test('assistant-route: a timeout is marked pending and records the conversation for a queued late reply', async () => {
  const pendingStore = createPendingRequestStore({ ttlMs: 60000 });
  let capturedRequestId;
  const bridgeClient = { async submitAssistRequest({ requestId }) { capturedRequestId = requestId; } };
  const route = createAssistantRoute({
    bridgeClient, pendingStore, museSessionId: 'side-chat-1', requestTimeoutMs: 15, assistantName: NAME, log: silentLog,
  });

  const result = await route.reply({ conversationId: 'conv-x', text: 'slow', send: () => false });

  assert.equal(result.pending, true);
  assert.equal(pendingStore.deliverLate(capturedRequestId, { type: 'reply', text: 'late', final: true }), 'queued');
  assert.deepEqual(pendingStore.takeQueued('conv-x'), [{ type: 'reply', text: 'late', final: true }]);
});
