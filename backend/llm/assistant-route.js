/**
 * Assistant provider that routes a turn through the Muse bridge instead of
 * calling Claude directly, see ../../bridge/.
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

/**
 * Wraps a primary assistant (normally Claude) with a wake-phrase check: a
 * transcript starting with `wakePhrase` (case-insensitive) is routed to
 * the assistant route with the phrase stripped; everything else goes to
 * `primary`.
 */
export function createWakePhraseAssistant({ wakePhrase, primary, assistantRoute }) {
  const prefix = wakePhrase.trim().toLowerCase();
  return {
    async reply(args) {
      const trimmed = args.text.trim();
      if (prefix && trimmed.toLowerCase().startsWith(prefix)) {
        // STT punctuates the phrase ("Ask Muse, what's..."), so drop the
        // separator it leaves behind as well.
        const rest = trimmed.slice(prefix.length).replace(/^[\s,.:;!?-]+/, '').trim();
        return assistantRoute.reply({ ...args, text: rest || trimmed });
      }
      return primary.reply(args);
    },
  };
}
