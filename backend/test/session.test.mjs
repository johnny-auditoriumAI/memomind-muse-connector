import { test } from 'node:test';
import assert from 'node:assert/strict';
import OpusScript from 'opusscript';
import { createAssistantSession, EMPTY_TRANSCRIPT_REPLY } from '../assistant.js';
import { createHistoryStore } from '../llm/history.js';
import { createMockAssistant } from '../llm/mock.js';
import { createMockSttStream, MOCK_TRANSCRIPT } from '../stt/mock.js';
import { cleanTranscript } from '../stt/whisper.js';

const config = { maxUtteranceMs: 30000, replyThrottleMs: 50, assistantName: 'Muse' };
const silentLog = () => {};

function opusChunk(sequence) {
  const encoder = new OpusScript(16000, 1, OpusScript.Application.VOIP);
  const packets = [0, 1].map(() => Buffer.from(encoder.encode(Buffer.alloc(640), 320)));
  encoder.delete();
  return [{ sequence, frameLengths: packets.map((p) => p.length), discontinuity: false }, Buffer.concat(packets)];
}

function harness({ assistant, createStt = () => createMockSttStream(), overrides = {} } = {}) {
  const sent = [];
  const history = createHistoryStore({ maxTurns: 6, ttlMs: 60000 });
  const session = createAssistantSession({
    send: (m) => sent.push(m),
    log: silentLog,
    config: { ...config, ...overrides },
    createStt,
    assistant: assistant ?? createMockAssistant({ history }),
  });
  return { sent, session, history };
}

const start = { type: 'start', sampleRate: 16000, codec: 'opus', channels: 1, conversationId: 'c1' };
const until = async (predicate, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 5));
  }
};
const summary = (sent) => sent.map((m) => (m.type === 'state' ? `state:${m.value}` : `${m.type}${m.final === false ? '~' : ''}`));

test('full turn: listening -> transcribing -> transcript -> thinking -> partial replies -> final reply -> idle', async () => {
  const { sent, session } = harness();
  session.onStart(start);
  session.onAudioChunk(...opusChunk(0));
  session.onStop();
  await until(() => sent.some((m) => m.type === 'state' && m.value === 'idle'));

  const types = summary(sent);
  assert.deepEqual(types.slice(0, 4), ['state:listening', 'state:transcribing', 'transcript', 'state:thinking']);
  assert.equal(sent[2].text, MOCK_TRANSCRIPT);
  assert.ok(types.includes('reply~'), 'expected throttled partial replies');
  const final = sent.find((m) => m.type === 'reply' && m.final === true);
  assert.equal(final.text, `(mock reply 1) You said: ${MOCK_TRANSCRIPT}`);
  assert.equal(types.at(-1), 'state:idle');
  // partials only ever grow and are prefixes of the final text
  for (const m of sent.filter((x) => x.type === 'reply' && x.final === false)) assert.ok(final.text.startsWith(m.text));
});

test('memory: second turn on the same conversationId sees the first', async () => {
  const { sent, session, history } = harness();
  session.onStart(start);
  session.onAudioChunk(...opusChunk(0));
  session.onStop();
  await until(() => sent.some((m) => m.type === 'state' && m.value === 'idle'));
  assert.equal(history.get('c1').length, 2);

  const second = harness({ assistant: createMockAssistant({ history }) });
  second.session.onStart(start);
  second.session.onAudioChunk(...opusChunk(0));
  second.session.onStop();
  await until(() => second.sent.some((m) => m.type === 'reply' && m.final === true));
  assert.match(second.sent.find((m) => m.type === 'reply' && m.final === true).text, /mock reply 2/);
});

test('no audio -> empty transcript -> "didn\'t catch that" reply, no assistant call', async () => {
  let called = false;
  const { sent, session } = harness({ assistant: { reply: async () => { called = true; return { text: 'x' }; } } });
  session.onStart(start);
  session.onStop();
  await until(() => sent.some((m) => m.type === 'state' && m.value === 'idle'));
  assert.equal(sent.find((m) => m.type === 'transcript').text, '');
  assert.equal(sent.find((m) => m.type === 'reply').text, EMPTY_TRANSCRIPT_REPLY);
  assert.equal(called, false);
});

test('bad chunks are skipped, not fatal', async () => {
  const { sent, session } = harness();
  session.onStart(start);
  session.onAudioChunk({ sequence: 0, frameLengths: [99] }, Buffer.alloc(3));
  session.onAudioChunk(...opusChunk(1));
  session.onStop();
  await until(() => sent.some((m) => m.type === 'reply' && m.final === true));
  assert.ok(!sent.some((m) => m.type === 'error'));
});

test('max utterance duration auto-finishes; later chunks and stop are ignored', async () => {
  const { sent, session } = harness({ overrides: { maxUtteranceMs: 80 } });
  session.onStart(start);
  session.onAudioChunk(...opusChunk(0));
  assert.ok(!sent.some((m) => m.value === 'transcribing'));
  session.onAudioChunk(...opusChunk(1)); // reaches 80 ms
  assert.ok(sent.some((m) => m.value === 'transcribing'));
  session.onAudioChunk(...opusChunk(2));
  session.onStop();
  await until(() => sent.some((m) => m.type === 'state' && m.value === 'idle'));
  assert.equal(sent.filter((m) => m.value === 'transcribing').length, 1);
});

test('socket close mid-reply aborts the assistant and sends nothing more', async () => {
  let sawAbort = false;
  const assistant = {
    reply: ({ signal, onDelta }) => new Promise((_, reject) => {
      onDelta('Hel');
      signal.addEventListener('abort', () => { sawAbort = true; reject(new Error('aborted')); });
    }),
  };
  const { sent, session } = harness({ assistant });
  session.onStart(start);
  session.onAudioChunk(...opusChunk(0));
  session.onStop();
  await until(() => sent.some((m) => m.value === 'thinking'));
  const before = sent.length;
  session.onClose();
  await until(() => sawAbort);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!sent.slice(before).some((m) => m.type === 'reply' || m.type === 'error'));
});

test('STT failure surfaces a display-sized error, then idle', async () => {
  const createStt = () => ({ write() {}, async finish() { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }, close() {} });
  const { sent, session } = harness({ createStt });
  session.onStart(start);
  session.onAudioChunk(...opusChunk(0));
  session.onStop();
  await until(() => sent.some((m) => m.type === 'state' && m.value === 'idle'));
  assert.equal(sent.find((m) => m.type === 'error').message, 'Speech recognition is not running');
});

test('rejects a second start mid-turn and non-opus codecs', () => {
  const { sent, session } = harness();
  session.onStart({ ...start, codec: 'pcm' });
  assert.match(sent.at(-1).message, /Unsupported codec/);
  session.onStart(start);
  session.onStart(start);
  assert.match(sent.at(-1).message, /already in progress/);
});

test('cleanTranscript drops non-speech tags only', () => {
  assert.equal(cleanTranscript(' [BLANK_AUDIO]\n'), '');
  assert.equal(cleanTranscript('(wind blowing) '), '');
  assert.equal(cleanTranscript(' Hello   there.\n'), 'Hello there.');
  assert.equal(cleanTranscript('[MUSIC] play it again'), '[MUSIC] play it again');
});

test('history keeps the last N turns and expires idle conversations', () => {
  let now = 0;
  const history = createHistoryStore({ maxTurns: 2, ttlMs: 1000, now: () => now });
  history.append('a', 'u1', 'a1');
  history.append('a', 'u2', 'a2');
  history.append('a', 'u3', 'a3');
  assert.deepEqual(history.get('a').map((m) => m.content), ['u2', 'a2', 'u3', 'a3']);
  now = 1500;
  assert.deepEqual(history.get('a'), []);
  assert.equal(history.size(), 0);
});

test('assistant-route pending: holding text is non-final, state goes to waiting, and idle is not sent', async () => {
  const assistant = { async reply() { return { text: 'Still asking Muse', stopReason: 'delayed', pending: true }; } };
  const { sent, session } = harness({ assistant });
  session.onStart(start);
  session.onAudioChunk(...opusChunk(0));
  session.onStop();
  await until(() => sent.some((m) => m.type === 'state' && m.value === 'waiting'));
  await new Promise((r) => setTimeout(r, 20));

  const types = summary(sent);
  assert.deepEqual(types.slice(-2), ['reply~', 'state:waiting']);
  assert.equal(sent.at(-2).text, 'Still asking Muse');
  assert.ok(!types.includes('state:idle'), '"idle" would end the turn on the plugin');
  assert.ok(!sent.some((m) => m.type === 'reply' && m.final === true));
});

test('queued late replies are shown as non-final text when the conversation starts its next turn', () => {
  const sent = [];
  const session = createAssistantSession({
    send: (m) => sent.push(m),
    log: silentLog,
    config,
    createStt: () => createMockSttStream(),
    assistant: createMockAssistant({ history: createHistoryStore({ maxTurns: 6, ttlMs: 60000 }) }),
    takeQueuedReplies: (id) => (id === 'c1' ? [{ type: 'reply', text: 'Nuggets at 1 AM', final: true }] : []),
  });

  session.onStart(start);

  assert.deepEqual(sent, [
    { type: 'state', value: 'listening' },
    { type: 'reply', text: 'Muse replied: Nuggets at 1 AM', final: false },
  ]);
});
