import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPendingRequestStore } from '../bridge/pendingRequestStore.js';

test('resolveWaiter resolves an attached in-process waiter exactly once', () => {
  const store = createPendingRequestStore({ ttlMs: 60000 });
  store.create('r1', { send: () => {} });
  const results = [];
  store.attachWaiter('r1', (r) => results.push(r));

  const first = store.resolveWaiter('r1', { status: 'ok', text: 'hi' });
  const second = store.resolveWaiter('r1', { status: 'ok', text: 'again' });

  assert.equal(first, true);
  assert.equal(second, false, 'a second resolve must not re-fire the waiter');
  assert.deepEqual(results, [{ status: 'ok', text: 'hi' }]);
  assert.equal(store.status('r1'), 'delivered');
});

test('markTimedOut then deliverLate pushes to the live send() and marks delivered', () => {
  const store = createPendingRequestStore({ ttlMs: 60000 });
  const sent = [];
  store.create('r2', { send: (m) => sent.push(m) });
  store.attachWaiter('r2', () => {});
  store.markTimedOut('r2');

  const outcome = store.deliverLate('r2', { type: 'reply', text: 'late answer', final: true });

  assert.equal(outcome, 'delivered');
  assert.deepEqual(sent, [{ type: 'reply', text: 'late answer', final: true }]);
  assert.equal(store.status('r2'), 'delivered');
});

test('deliverLate with no live send() marks expired, never claims delivery', () => {
  const store = createPendingRequestStore({ ttlMs: 60000 });
  store.create('r3', { send: undefined });
  store.markTimedOut('r3');

  const outcome = store.deliverLate('r3', { type: 'reply', text: 'too late', final: true });

  assert.equal(outcome, 'expired');
  assert.equal(store.status('r3'), 'expired');
});

test('deliverLate on an already-delivered request is a duplicate, not re-delivered', () => {
  const store = createPendingRequestStore({ ttlMs: 60000 });
  const sent = [];
  store.create('r4', { send: (m) => sent.push(m) });
  store.attachWaiter('r4', () => {});
  store.resolveWaiter('r4', { status: 'ok', text: 'first' });

  const outcome = store.deliverLate('r4', { type: 'reply', text: 'duplicate', final: true });

  assert.equal(outcome, 'duplicate');
  assert.deepEqual(sent, [], 'duplicate delivery must not call send() again');
});

test('deliverLate on an unknown request_id reports unknown', () => {
  const store = createPendingRequestStore({ ttlMs: 60000 });
  assert.equal(store.deliverLate('nope', {}), 'unknown');
  assert.equal(store.has('nope'), false);
});

test('create rejects a duplicate request_id', () => {
  const store = createPendingRequestStore({ ttlMs: 60000 });
  store.create('r5', {});
  assert.throws(() => store.create('r5', {}));
});

test('prune drops only non-pending records past the TTL', () => {
  let t = 1000;
  const store = createPendingRequestStore({ ttlMs: 100, now: () => t });
  store.create('r6', {});
  store.attachWaiter('r6', () => {});
  store.resolveWaiter('r6', { status: 'ok', text: 'done' });
  store.create('r7', {}); // stays pending

  t += 1000;
  assert.equal(store.size(), 1, 'delivered record past TTL is pruned, pending one is kept');
  assert.equal(store.has('r7'), true);
});

test('deliverLate to a closed socket (send returns false) queues the reply for its conversation', () => {
  const store = createPendingRequestStore({ ttlMs: 60000 });
  store.create('r10', { send: () => false, conversationId: 'conv-a' });
  store.markTimedOut('r10');

  const outcome = store.deliverLate('r10', { type: 'reply', text: 'the answer', final: true });

  assert.equal(outcome, 'queued', 'a closed socket must never count as delivered');
  assert.equal(store.status('r10'), 'queued');
  assert.deepEqual(store.takeQueued('conv-a'), [{ type: 'reply', text: 'the answer', final: true }]);
  assert.deepEqual(store.takeQueued('conv-a'), [], 'a queued reply is shown once');
  assert.deepEqual(store.takeQueued('conv-b'), []);
  assert.equal(store.deliverLate('r10', { type: 'reply', text: 'again', final: true }), 'duplicate');
});

test('deliverLate to a closed socket with no conversation is expired, not delivered', () => {
  const store = createPendingRequestStore({ ttlMs: 60000 });
  store.create('r11', { send: () => false });
  store.markTimedOut('r11');

  assert.equal(store.deliverLate('r11', { type: 'reply', text: 'x', final: true }), 'expired');
});

test('queued replies are dropped after the TTL', () => {
  let clock = 0;
  const store = createPendingRequestStore({ ttlMs: 1000, now: () => clock });
  store.create('r12', { send: () => false, conversationId: 'conv-c' });
  store.markTimedOut('r12');
  store.deliverLate('r12', { type: 'reply', text: 'stale', final: true });

  clock = 5000;
  assert.deepEqual(store.takeQueued('conv-c'), []);
});
