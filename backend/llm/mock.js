/** Offline assistant for tests and key-less runs: echoes the transcript, streamed in pieces. */
export function createMockAssistant({ history }) {
  return {
    async reply({ conversationId, text, onDelta, signal }) {
      const turn = history.get(conversationId).length / 2 + 1;
      const replyText = `(mock reply ${turn}) You said: ${text}`;
      for (const piece of replyText.match(/.{1,12}/g)) {
        if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        onDelta(piece);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      history.append(conversationId, text, replyText);
      return { text: replyText, stopReason: 'end_turn' };
    },
  };
}
