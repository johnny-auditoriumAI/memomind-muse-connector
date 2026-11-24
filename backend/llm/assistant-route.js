/**
 * Assistant provider that routes every turn through the Muse bridge, see
 * ../../bridge/. This is the only assistant path this backend has.
 *
 *   reply({ conversationId, text, onDelta, signal, send }) -> { text, stopReason, pending? }
 *
 * `send` is this turn's live WebSocket send() closure; kept in the pending
 * store so a reply that arrives after this call has already timed out can
 * still reach the glasses if the connection is still open (see
 * pendingRequestStore.deliverLate), or be queued for the conversation's
 * next turn if it has closed. On timeout the result has `pending: true`:
 * the caller shows a delayed-reply message as a non-final reply and keeps
 * the socket open for the late answer. There is no streaming: one reply only.
 */
import { randomUUID } from 'node:crypto';

export function delayedReply(assistantName) {
  return `Still asking ${assistantName} - I'll let you know when they reply.`;
}
export function bridgeUnreachableReply(assistantName) {
  return `Could not reach ${assistantName} right now. Try again shortly.`;
}

export function createAssistantRoute({ bridgeClient, pendingStore, museSessionId, requestTimeoutMs, assistantName, log }) {
  return {
    async reply({ conversationId, text, signal, send }) {
      const requestId = randomUUID();
      const createdAt = new Date().toISOString();
      pendingStore.create(requestId, { send, conversationId });

      const waiterPromise = new Promise((resolve) => pendingStore.attachWaiter(requestId, resolve));
      let timeoutHandle;
      const timeoutPromise = new Promise((resolve) => {
        timeoutHandle = setTimeout(() => resolve({ timedOut: true }), requestTimeoutMs);
      });

      try {
        await bridgeClient.submitAssistRequest({
          requestId,
          sessionId: museSessionId,
          utterance: text,
          createdAt,
          signal,
        });
      } catch (error) {
        clearTimeout(timeoutHandle);
        pendingStore.markTimedOut(requestId);
        log('assistant-route.submit-failed', { requestId, message: error.message });
        return { text: bridgeUnreachableReply(assistantName), stopReason: 'bridge-error' };
      }

      const result = await Promise.race([waiterPromise, timeoutPromise]);
      clearTimeout(timeoutHandle);

      if (result?.timedOut) {
        pendingStore.markTimedOut(requestId);
        log('assistant-route.timeout', { requestId });
        return { text: delayedReply(assistantName), stopReason: 'delayed', pending: true };
      }
      log('assistant-route.replied', { requestId, status: result.status });
      return {
        text: result.status === 'ok' ? result.text : bridgeUnreachableReply(assistantName),
        stopReason: result.status === 'ok' ? 'end_turn' : 'error',
      };
    },
  };
}
