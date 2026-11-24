/**
 * In-memory conversation history keyed by the plugin's conversationId.
 * Survives the plugin's per-turn WebSocket reconnects; lost on backend
 * restart (by design for v1). Only completed user/assistant text pairs are
 * stored, so a failed or refused turn leaves no half-turn behind.
 */
export function createHistoryStore({ maxTurns, ttlMs, now = () => Date.now() }) {
  const conversations = new Map();

  function prune() {
    const cutoff = now() - ttlMs;
    for (const [id, entry] of conversations) {
      if (entry.updatedAt < cutoff) conversations.delete(id);
    }
  }

  return {
    /** Messages array (user/assistant alternating) for this conversation. */
    get(conversationId) {
      prune();
      return conversations.get(conversationId)?.turns.flatMap(({ user, assistant }) => [
        { role: 'user', content: user },
        { role: 'assistant', content: assistant },
      ]) ?? [];
    },
    append(conversationId, user, assistant) {
      prune();
      const entry = conversations.get(conversationId) ?? { turns: [], updatedAt: 0 };
      entry.turns.push({ user, assistant });
      if (entry.turns.length > maxTurns) entry.turns.splice(0, entry.turns.length - maxTurns);
      entry.updatedAt = now();
      conversations.set(conversationId, entry);
    },
    size() {
      prune();
      return conversations.size;
    },
  };
}
