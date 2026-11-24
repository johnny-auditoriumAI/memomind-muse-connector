import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantRoute, createWakePhraseAssistant, delayedReply, bridgeUnreachableReply } from '../llm/assistant-route.js';
import { createPendingRequestStore } from '../bridge/pendingRequestStore.js';

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

test('wake-phrase: strips the phrase and routes to the assistant route; everything else goes to primary', async () => {
  const routeCalls = [];
  const primaryCalls = [];
  const assistantRoute = { async reply(args) { routeCalls.push(args.text); return { text: 'bridge reply', stopReason: 'end_turn' }; } };
  const primary = { async reply(args) { primaryCalls.push(args.text); return { text: 'haiku reply', stopReason: 'end_turn' }; } };
  const assistant = createWakePhraseAssistant({ wakePhrase: 'ask muse', primary, assistantRoute });

  const r1 = await assistant.reply({ text: 'Ask Muse what time the meeting is' });
  const r2 = await assistant.reply({ text: 'what is the weather' });

  assert.equal(r1.text, 'bridge reply');
  assert.deepEqual(routeCalls, ['what time the meeting is']);
  assert.equal(r2.text, 'haiku reply');
  assert.deepEqual(primaryCalls, ['what is the weather']);
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

test('wake phrase: punctuation STT puts after the phrase is stripped', async () => {
  const seen = [];
  const assistant = createWakePhraseAssistant({
    wakePhrase: 'ask muse',
    primary: { async reply() { return { text: 'haiku' }; } },
    assistantRoute: { async reply({ text }) { seen.push(text); return { text: 'bridge' }; } },
  });

  await assistant.reply({ text: "Ask Muse, what's on my calendar tomorrow?" });
  await assistant.reply({ text: 'ask muse: weather' });

  assert.deepEqual(seen, ["what's on my calendar tomorrow?", 'weather']);
});
