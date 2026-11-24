import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapText, revealWindow, tailWindow, createTypewriter, layoutWindow, scrollBy } from '../../plugin/teleprompter.js';

// 10 px per character makes widths easy to reason about.
const measure = (s) => s.length * 10;
const lines = (text, width) => wrapText(text, width, measure).map((l) => text.slice(l.start, l.end));

test('word wrap never splits words that fit', () => {
  assert.deepEqual(lines('the quick brown fox jumps', 100), ['the quick', 'brown fox', 'jumps']);
});

test('long words are hard-split', () => {
  assert.deepEqual(lines('a supercalifragilistic word', 100), ['a', 'supercalif', 'ragilistic', 'word']);
});

test('explicit newlines and blank lines are kept', () => {
  assert.deepEqual(lines('one\n\ntwo', 100), ['one', '', 'two']);
  assert.deepEqual(lines('one\n', 100), ['one']);
  assert.deepEqual(lines('', 100), []);
});

test('every line fits the width', () => {
  const text = 'Lisbon has roughly 550,000 residents within the city proper, and about 2.9 million in the wider metro area.';
  for (const line of lines(text, 120)) assert.ok(measure(line) <= 120, line);
});

test('revealWindow shows the typed prefix and scrolls to the newest lines', () => {
  const text = 'aaa bbb ccc ddd eee';
  const opts = { maxLines: 2, maxWidth: 30, measure };
  assert.equal(revealWindow(text, 0, opts), '');
  assert.equal(revealWindow(text, 2, opts), 'aa');
  assert.equal(revealWindow(text, 5, opts), 'aaa\nb');
  assert.equal(revealWindow(text, 9, opts), 'bbb\nc'); // scrolled: "aaa" moved off the top
  assert.equal(revealWindow(text, text.length, opts), 'ddd\neee');
});

test('scrolling up pins the view; scrolling back to the bottom resumes following', () => {
  const text = 'l1 l2 l3 l4 l5 l6 l7'; // one 2-char word per line at width 30
  const layout = { maxLines: 3, maxWidth: 30, measure };
  const all = text.length;

  let scrollTop = null;
  let view = layoutWindow(text, all, layout, scrollTop);
  assert.equal(view.text, 'l5\nl6\nl7');
  assert.deepEqual([view.moreAbove, view.moreBelow], [true, false]);

  scrollTop = scrollBy(scrollTop, -3, view); // head up
  view = layoutWindow(text, all, layout, scrollTop);
  assert.equal(scrollTop, 1);
  assert.equal(view.text, 'l2\nl3\nl4');
  assert.deepEqual([view.moreAbove, view.moreBelow], [true, true]);

  scrollTop = scrollBy(scrollTop, -3, view); // clamps at the top
  view = layoutWindow(text, all, layout, scrollTop);
  assert.equal(view.text, 'l1\nl2\nl3');
  assert.equal(view.moreAbove, false);

  scrollTop = scrollBy(scrollTop, 3, view); // head down
  assert.equal(scrollTop, 3);
  scrollTop = scrollBy(scrollTop, 3, layoutWindow(text, all, layout, scrollTop)); // reaches bottom
  assert.equal(scrollTop, null);
});

test('a pinned view stays put while typing continues below it', () => {
  const text = 'l1 l2 l3 l4 l5 l6 l7';
  const layout = { maxLines: 3, maxWidth: 30, measure };
  assert.equal(layoutWindow(text, 14, layout, 0).text, 'l1\nl2\nl3');
  assert.equal(layoutWindow(text, text.length, layout, 0).text, 'l1\nl2\nl3');
  // nothing to scroll in a short reply
  const short = layoutWindow('hi', 2, layout, null);
  assert.equal(scrollBy(null, -3, short), null);
});

test('tailWindow keeps the last lines and marks the cut', () => {
  const opts = { maxLines: 2, maxWidth: 70, measure };
  assert.equal(tailWindow('short one', opts), 'short\none');
  const out = tailWindow('one two three four five six seven', opts);
  assert.ok(out.startsWith('… '));
  assert.ok(out.endsWith('seven'));
  assert.ok(out.split('\n').length <= 2);
  for (const line of out.split('\n')) assert.ok(measure(line) <= 70, line);
});

test('typewriter reveals at a steady pace regardless of arrival', () => {
  let t = 0;
  let scheduled;
  const seen = [];
  const tw = createTypewriter({
    charsPerSecond: 20,
    onChange: (n) => seen.push(n),
    setTimer: (fn) => { scheduled = fn; return 1; },
    clearTimer: () => { scheduled = undefined; },
    now: () => t,
  });
  tw.setTarget('hello world, this arrived all at once');
  t += 100; scheduled(); // 2 chars
  t += 100; scheduled(); // 4
  assert.deepEqual(seen, [2, 4]);
  tw.setTarget('hello world, this arrived all at once, and more');
  t += 500; scheduled(); // +10
  assert.equal(tw.revealed, 14);
  tw.finish();
  assert.equal(tw.revealed, tw.target.length);
  assert.equal(scheduled, undefined);
});

test('typewriter restarts for a new, unrelated reply', () => {
  let t = 0;
  let scheduled;
  const tw = createTypewriter({
    charsPerSecond: 100, onChange: () => {}, setTimer: (fn) => { scheduled = fn; return 1; },
    clearTimer: () => { scheduled = undefined; }, now: () => t,
  });
  tw.setTarget('first reply');
  t += 1000; scheduled();
  assert.equal(tw.revealed, 11);
  tw.setTarget('second');
  assert.equal(tw.revealed, 0);
});
