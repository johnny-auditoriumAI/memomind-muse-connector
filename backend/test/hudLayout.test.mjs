import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeHud, statusPresentation, transcriptLines, fitWithEllipsis, scrollbarFor,
  CONTENT_TOP, CONTENT_BOTTOM, REPLY, YOU, SECTION_GAP,
} from '../../plugin/hud-layout.js';

// 10 px per character at every size keeps widths easy to reason about:
// the text column is 510 px, so 51 characters per line.
const measureAt = () => (text) => text.length * 10;
const measure = measureAt();

const base = { status: 'Press button to talk', state: 'idle', transcript: '', clock: '14:05', measureAt };
const reply = (text, revealed = text.length, scrollTop = null) => ({ text, revealed, scrollTop });
const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

test('statusPresentation maps plugin statuses to icon + friendly label', () => {
  assert.deepEqual(statusPresentation('LISTENING'), { icon: 'mic', label: 'Listening' });
  assert.deepEqual(statusPresentation('WAITING FOR REPLY…'), { icon: 'hourglass', label: 'Waiting for reply…' });
  assert.deepEqual(statusPresentation('THINKING…'), { icon: 'dots', label: 'Thinking…' });
  assert.deepEqual(statusPresentation('ERROR: backend disconnected'), { icon: 'warning', label: 'Backend disconnected' });
  assert.deepEqual(statusPresentation('Press button to talk'), { icon: 'ready', label: 'Ready' });
  assert.equal(statusPresentation('Microphone not available', 'unavailable').icon, 'warning');
  assert.equal(statusPresentation('SOMETHING NEW').label, 'Something new');
});

test('empty screen shows the placeholder only', () => {
  const hud = computeHud({ ...base, reply: reply('') });
  assert.equal(hud.placeholder, true);
  assert.equal(hud.you, null);
  assert.equal(hud.reply, null);
  assert.equal(hud.header.clock, '14:05');
});

test('while listening the transcript keeps its newest two lines, marked as cut', () => {
  const hud = computeHud({ ...base, status: 'LISTENING', transcript: words(30), reply: reply('') });
  assert.equal(hud.you.lines.length, YOU.maxLines);
  assert.ok(hud.you.lines[0].startsWith('…'));
  assert.ok(hud.you.lines[1].endsWith('word29'));
});

test('once a reply arrives, the transcript collapses to its opening line and the reply gets the room', () => {
  const hud = computeHud({ ...base, transcript: words(30), reply: reply('Hello there.') });
  assert.equal(hud.you.lines.length, 1);
  assert.ok(hud.you.lines[0].startsWith('word0'));
  assert.ok(hud.you.lines[0].endsWith('…'));
  assert.equal(hud.reply.top, CONTENT_TOP + YOU.lineHeight + SECTION_GAP);
  assert.equal(hud.reply.maxLines, Math.floor((CONTENT_BOTTOM - hud.reply.top) / REPLY.lineHeight));
  assert.ok(hud.reply.maxLines >= 10, `expected at least 10 reply lines, got ${hud.reply.maxLines}`);
  assert.deepEqual(hud.reply.lines, ['Hello there.']);
});

test('every line fits the text column (no overflow off the right edge)', () => {
  const hud = computeHud({ ...base, transcript: words(5), reply: reply(words(80)) });
  for (const line of [...hud.you.lines, ...hud.reply.lines]) assert.ok(measure(line) <= 510, line);
});

test('long replies follow the typing by default and show a scrollbar', () => {
  const hud = computeHud({ ...base, transcript: 'hi', reply: reply(words(120)) });
  const { window, maxLines } = hud.reply;
  assert.ok(window.totalLines > maxLines);
  assert.equal(window.first, window.maxFirst);
  assert.ok(hud.reply.scrollbar);
  assert.equal(hud.reply.scrollbar.thumbTop + hud.reply.scrollbar.thumbHeight, CONTENT_BOTTOM);
});

test('scrolling to the top pins the scrollbar thumb to the top of its track', () => {
  const hud = computeHud({ ...base, transcript: 'hi', reply: reply(words(120), undefined, 0) });
  assert.equal(hud.reply.window.first, 0);
  assert.equal(hud.reply.scrollbar.thumbTop, hud.reply.scrollbar.trackTop);
});

test('a reply that fits has no scrollbar', () => {
  assert.equal(scrollbarFor({ totalLines: 3, first: 0, maxFirst: 0 }, 10, 80), null);
});

test('only the revealed part of the reply is drawn while typing', () => {
  const hud = computeHud({ ...base, transcript: 'hi', reply: reply('Hello there friend', 5) });
  assert.deepEqual(hud.reply.lines, ['Hello']);
});

test('fitWithEllipsis trims to width', () => {
  assert.equal(fitWithEllipsis('short', 100, measure), 'short');
  const out = fitWithEllipsis('abcdefghijklmnop', 60, measure);
  assert.ok(measure(out) <= 60);
  assert.ok(out.endsWith('…'));
});

test('transcriptLines returns everything when it fits', () => {
  assert.deepEqual(transcriptLines('just a little', { maxLines: 2, keepStart: false }, measure), ['just a little']);
});
