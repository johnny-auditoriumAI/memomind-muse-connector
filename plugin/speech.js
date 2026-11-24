/**
 * Pure helper for spoken replies (no DOM, unit tested). Long replies are
 * spoken as a queue of sentence-sized utterances: Android's TTS engine and
 * Chrome both misbehave on very long single utterances.
 */
export const SPEECH_CHUNK_CHARS = 220;

/** Splits text into utterances of at most maxChars, preferring sentence ends, then spaces. */
export function speechChunks(text, maxChars = SPEECH_CHUNK_CHARS) {
  const sentences = text.replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [];
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && (current + sentence).length > maxChars) {
      chunks.push(current.trim());
      current = '';
    }
    current += sentence;
    while (current.length > maxChars) {
      const space = current.lastIndexOf(' ', maxChars);
      const cut = space > 0 ? space : maxChars;
      chunks.push(current.slice(0, cut).trim());
      current = current.slice(cut);
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
