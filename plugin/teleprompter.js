/**
 * Text layout for the glasses display. The Host clips text that doesn't fit
 * a box and has no scrolling, so the plugin does its own word wrapping and
 * sends only the lines that should be visible, joined with "\n".
 *
 * Pure functions (no DOM): `measure(text) -> px` is injected, so the same
 * code runs in the plugin (canvas measureText) and in Node tests.
 */

/**
 * Greedy word wrap. Returns line ranges into `text` ({ start, end }, end
 * exclusive, trailing spaces excluded) so callers can map a revealed
 * character count onto lines. Words wider than a line are hard-split.
 */
export function wrapText(text, maxWidth, measure) {
  const lines = [];
  let paragraphStart = 0;
  for (const paragraph of text.split('\n')) {
    let lineStart = -1;
    let lineEnd = -1;
    const pushLine = () => {
      if (lineStart >= 0) lines.push({ start: lineStart, end: lineEnd });
      lineStart = -1;
    };
    const placeWordOnNewLine = (wordStart, wordEnd) => {
      let start = wordStart;
      // hard-split until the remainder fits on one line
      while (measure(text.slice(start, wordEnd)) > maxWidth) {
        let end = start + 1;
        while (end < wordEnd && measure(text.slice(start, end + 1)) <= maxWidth) end += 1;
        lines.push({ start, end });
        start = end;
      }
      lineStart = start;
      lineEnd = wordEnd;
    };

    for (const match of paragraph.matchAll(/\S+/g)) {
      const wordStart = paragraphStart + match.index;
      const wordEnd = wordStart + match[0].length;
      if (lineStart < 0) {
        placeWordOnNewLine(wordStart, wordEnd);
      } else if (measure(text.slice(lineStart, wordEnd)) <= maxWidth) {
        lineEnd = wordEnd;
      } else {
        pushLine();
        placeWordOnNewLine(wordStart, wordEnd);
      }
    }
    if (lineStart >= 0) pushLine();
    else lines.push({ start: paragraphStart, end: paragraphStart }); // blank paragraph
    paragraphStart += paragraph.length + 1;
  }
  // Drop trailing blank lines (e.g. text ending in "\n").
  while (lines.length > 1 && lines.at(-1).start === lines.at(-1).end) lines.pop();
  return text.length === 0 ? [] : lines;
}

/**
 * Visible window over the first `revealed` characters of `text`.
 * `scrollTop` is the first visible line, or null to follow the typing
 * position (always show the newest lines). Returns the text to draw plus the
 * numbers needed to scroll and to show "more above/below".
 */
export function layoutWindow(text, revealed, { maxLines, maxWidth, measure }, scrollTop = null) {
  const lines = revealed <= 0 ? [] : wrapText(text, maxWidth, measure)
    .filter((line) => line.start < revealed)
    .map((line) => text.slice(line.start, Math.min(line.end, revealed)));
  const maxFirst = Math.max(0, lines.length - maxLines);
  const first = scrollTop === null ? maxFirst : Math.max(0, Math.min(scrollTop, maxFirst));
  return {
    text: lines.slice(first, first + maxLines).join('\n'),
    first,
    maxFirst,
    totalLines: lines.length,
    moreAbove: first > 0,
    moreBelow: first < maxFirst,
  };
}

/**
 * The last `maxLines` lines of `text` with only the first `revealed`
 * characters shown: a teleprompter that follows the typing position.
 */
export function revealWindow(text, revealed, layout) {
  return layoutWindow(text, revealed, layout).text;
}

/**
 * New scrollTop after scrolling `deltaLines` (negative = up). Returns null
 * (follow typing) once the bottom is reached, so a scrolled-up reader rejoins
 * the live text by scrolling back down.
 */
export function scrollBy(scrollTop, deltaLines, { first, maxFirst }) {
  const current = scrollTop === null ? first : scrollTop;
  const next = Math.max(0, Math.min(current + deltaLines, maxFirst));
  return next >= maxFirst ? null : next;
}

/** Last `maxLines` lines of `text`, with "…" marking that earlier text was cut. */
export function tailWindow(text, { maxLines, maxWidth, measure }) {
  const ellipsis = '… ';
  const lines = wrapText(text, maxWidth, measure);
  if (lines.length <= maxLines) return lines.map((l) => text.slice(l.start, l.end)).join('\n');
  // Re-wrap the kept tail with room for the ellipsis so the first line still fits.
  const tail = text.slice(lines[lines.length - maxLines].start);
  const rewrapped = wrapText(tail, maxWidth - measure(ellipsis), measure).slice(-maxLines);
  return ellipsis + rewrapped.map((l) => tail.slice(l.start, l.end)).join('\n');
}

/**
 * Reveals target text at a steady characters-per-second pace, independent
 * of how fast it streams in. Call `setTarget` as text arrives; `onChange`
 * fires with the revealed character count on each step.
 */
export function createTypewriter({ charsPerSecond, tickMs = 60, onChange, setTimer = setInterval, clearTimer = clearInterval, now = () => Date.now() }) {
  let target = '';
  let revealed = 0;
  let budget = 0;
  let timer;
  let lastTick = 0;

  function stop() {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  }

  function tick() {
    const t = now();
    budget += ((t - lastTick) / 1000) * charsPerSecond;
    lastTick = t;
    const backlog = target.length - revealed;
    if (backlog <= 0) {
      budget = 0;
      stop();
      return;
    }
    const step = Math.min(backlog, Math.floor(budget));
    if (step <= 0) return;
    budget -= step;
    revealed += step;
    onChange(revealed);
    if (revealed >= target.length) stop();
  }

  return {
    setTarget(text) {
      // A target that doesn't extend what's shown (new reply) restarts typing.
      if (!text.startsWith(target.slice(0, revealed))) revealed = 0;
      target = text;
      if (revealed > target.length) revealed = target.length;
      if (timer === undefined && revealed < target.length) {
        lastTick = now();
        timer = setTimer(tick, tickMs);
      }
    },
    /** Show everything immediately (e.g. errors, or skipping the animation). */
    finish() {
      stop();
      revealed = target.length;
      onChange(revealed);
    },
    reset() {
      stop();
      target = '';
      revealed = 0;
      budget = 0;
      onChange(0);
    },
    get revealed() { return revealed; },
    get target() { return target; },
  };
}
