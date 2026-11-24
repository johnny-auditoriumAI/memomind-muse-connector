import { test } from 'node:test';
import assert from 'node:assert/strict';
import { speechChunks } from '../../plugin/speech.js';

test('short replies are one utterance', () => {
  assert.deepEqual(speechChunks('Loud and clear.'), ['Loud and clear.']);
});

test('sentences are grouped up to the limit, never split mid-sentence when they fit', () => {
  const chunks = speechChunks('One two three. Four five six. Seven eight nine.', 30);
  assert.deepEqual(chunks, ['One two three. Four five six.', 'Seven eight nine.']);
  for (const chunk of chunks) assert.ok(chunk.length <= 30);
});

test('a single sentence longer than the limit is split on spaces', () => {
  const sentence = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
  const chunks = speechChunks(sentence, 50);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 50, chunk);
  assert.equal(chunks.join(' '), sentence);
});

test('text without final punctuation and extra whitespace is kept', () => {
  assert.deepEqual(speechChunks('  Done.\n\nNext thing  '), ['Done. Next thing']);
});

test('empty text speaks nothing', () => {
  assert.deepEqual(speechChunks('   '), []);
});
