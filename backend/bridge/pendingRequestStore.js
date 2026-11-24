/**
 * Correlates one outgoing assistant request (sent to the Muse bridge) with
 * the eventual POST /v1/muse-reply callback, and with the live glasses
 * WebSocket connection that is waiting on it (if still open).
 *
 * Lifecycle per request_id:
 *   pending   -> created when the turn sends the request to the bridge
 *   delivered -> a valid /v1/muse-reply arrived and was pushed to a
 *                still-open socket, or resolved the waiting turn directly
 *   queued    -> the reply arrived after the turn's socket closed; it is
 *                held for that conversation and shown at its next turn
 *   expired   -> timed out waiting, or the TTL passed with no reply
 * A request_id is only ever resolved once (duplicate /v1/muse-reply calls
 * for the same id are rejected, matching "duplicate protection").
 */
export function createPendingRequestStore({ ttlMs, now = () => Date.now() }) {
  /** @type {Map<string, {status: string, createdAt: number, waiter?: {resolve: Function}, send?: Function}>} */
  const records = new Map();
  /** conversationId -> [{message, queuedAt}] for replies whose socket had closed. */
  const outbox = new Map();

  function prune() {
    const cutoff = now() - ttlMs;
    for (const [id, record] of records) {
      if (record.status !== 'pending' && record.createdAt < cutoff) records.delete(id);
    }
    for (const [conversationId, items] of outbox) {
      const kept = items.filter((item) => item.queuedAt >= cutoff);
      if (kept.length) outbox.set(conversationId, kept);
      else outbox.delete(conversationId);
    }
  }

  return {
    /**
     * Registers a new request before it is sent to the bridge. `send` is the
     * WebSocket session's send() closure, kept so a late reply can still
     * reach the glasses if the connection is still open when it arrives.
     * `conversationId` lets a reply whose socket has closed be queued and
     * shown at that conversation's next turn instead of being lost.
     */
    create(requestId, { send, conversationId } = {}) {
      prune();
      if (records.has(requestId)) {
        throw new Error(`request_id already registered: ${requestId}`);
      }
      records.set(requestId, { status: 'pending', createdAt: now(), send, conversationId });
    },

    /**
     * Resolves a pending in-process waiter (the turn that is still inside
     * its foreground await), if one is registered. Returns true if a waiter
     * was resolved this way; false means the turn already timed out and the
     * caller should fall back to pushing directly onto the live socket.
     */
    resolveWaiter(requestId, result) {
      const record = records.get(requestId);
      if (!record || record.status !== 'pending' || !record.waiter) return false;
      record.status = 'delivered';
      record.waiter.resolve(result);
      return true;
    },

    /** Registers the in-process waiter; see resolveWaiter. */
    attachWaiter(requestId, resolve) {
      const record = records.get(requestId);
      if (record) record.waiter = { resolve };
    },

    /**
     * The turn's own foreground wait gave up (timeout). The request stays
     * registered (for dedup) so a late reply can still be pushed to the
     * live socket via deliverLate, but no in-process waiter remains.
     */
    markTimedOut(requestId) {
      const record = records.get(requestId);
      if (record && record.status === 'pending') {
        record.waiter = undefined;
      }
    },

    /**
     * Handles a validated POST /v1/muse-reply for a request that already
     * timed out in-process. Pushes the reply onto the live socket if it is
     * still open; `send` returns false once its socket has closed, and that
     * never counts as delivery. A reply that could not be sent is queued for
     * the request's conversation (see takeQueued), or marked expired if the
     * request has no conversation.
     * Returns 'delivered' | 'queued' | 'expired' | 'unknown' | 'duplicate'.
     */
    deliverLate(requestId, message) {
      const record = records.get(requestId);
      if (!record) return 'unknown';
      if (record.status !== 'pending') return 'duplicate';
      if (record.send && record.send(message) !== false) {
        record.status = 'delivered';
        return 'delivered';
      }
      if (record.conversationId) {
        const items = outbox.get(record.conversationId) ?? [];
        items.push({ message, queuedAt: now() });
        outbox.set(record.conversationId, items);
        record.status = 'queued';
        return 'queued';
      }
      record.status = 'expired';
      return 'expired';
    },

    /**
     * Removes and returns the replies queued for `conversationId`, oldest
     * first, so the next turn of that conversation can show them.
     */
    takeQueued(conversationId) {
      prune();
      const items = outbox.get(conversationId) ?? [];
      outbox.delete(conversationId);
      return items.map((item) => item.message);
    },

    status(requestId) {
      return records.get(requestId)?.status;
    },

    has(requestId) {
      return records.has(requestId);
    },

    size() {
      prune();
      return records.size;
    },
  };
}
