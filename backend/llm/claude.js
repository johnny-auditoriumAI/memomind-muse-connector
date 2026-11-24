/**
 * Assistant replies from Claude, streamed. One call per user utterance:
 *   reply({ conversationId, text, onDelta, signal }) -> { text, stopReason }
 * The API key comes from ANTHROPIC_API_KEY (read by the SDK itself).
 */
import Anthropic from '@anthropic-ai/sdk';

// Frozen string (no dates/IDs) so the request prefix stays cacheable.
export const SYSTEM_PROMPT = `You are the voice assistant on MemoMind One smart glasses. The user spoke to you; their words were transcribed by speech recognition and may contain recognition errors, so infer the most likely meaning.

Your reply is shown as plain text on a small monochrome display, around 300 characters at most. Answer in one or two short sentences, under 250 characters. Lead with the answer itself, with no preamble. Use plain text only: no markdown, lists, emoji, or special symbols.

You have no internet access, tools, camera, or location. If a question needs live information such as weather, news, or the current time, say briefly that you can't check that yet. If what they said is unclear or missing context, ask them briefly to rephrase. Speak to the user directly and never mention the transcript or speech recognition.`;

export const REFUSAL_REPLY = "Sorry, I can't help with that.";

export function createClaudeAssistant({ model, timeoutMs, history, log }) {
  const client = new Anthropic({ timeout: timeoutMs });

  return {
    async reply({ conversationId, text, onDelta, signal }) {
      const stream = client.messages.stream({
        model,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        output_config: { effort: 'low' },
        cache_control: { type: 'ephemeral' },
        messages: [...history.get(conversationId), { role: 'user', content: text }],
      });
      const onAbort = () => stream.abort();
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        stream.on('text', (delta) => onDelta(delta));
        const message = await stream.finalMessage();
        log('claude.done', {
          model: message.model,
          stopReason: message.stop_reason,
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        });

        if (message.stop_reason === 'refusal') {
          log('claude.refusal', { category: message.stop_details?.category ?? null });
          return { text: REFUSAL_REPLY, stopReason: 'refusal' };
        }
        const replyText = message.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('')
          .trim();
        if (replyText) history.append(conversationId, text, replyText);
        return { text: replyText, stopReason: message.stop_reason };
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}

/** Maps SDK errors to a short message that fits the glasses display. */
export function describeClaudeError(error) {
  if (error instanceof Anthropic.APIUserAbortError) return null;
  if (error instanceof Anthropic.AuthenticationError) return 'Assistant API key is invalid';
  if (error instanceof Anthropic.RateLimitError) return 'Assistant is busy, try again';
  if (error instanceof Anthropic.InternalServerError) return 'Assistant is unavailable, try again';
  if (error instanceof Anthropic.APIConnectionError) return 'Cannot reach the assistant';
  if (error instanceof Anthropic.APIError) return `Assistant error (${error.status ?? 'unknown'})`;
  return 'Assistant failed';
}
