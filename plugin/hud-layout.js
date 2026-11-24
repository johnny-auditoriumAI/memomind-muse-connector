/**
 * Pure geometry + content for the full-screen assistant HUD (600x350 GRAY_4
 * bitmap). No DOM: text widths come from an injected `measureAt(px)` that
 * returns a `measure(text) -> px` function, so the plugin uses real canvas
 * font metrics (the exact font it then draws with) and Node tests use a
 * fake. Because we draw the pixels ourselves, wrapping here is exactly what
 * appears on the glasses - no guessing at the firmware's text renderer.
 *
 *   +------------------------------------------------------+
 *   | (icon) Listening                              14:05  |  header
 *   |------------------------------------------------------|
 *   | YOU   what the user said (dim, 2 lines; 1 once       |
 *   |       the reply starts)                              |
 *   |REPLY| the reply, bright, as many lines as fit,       #|  scrollbar
 *   |     | typed out and scrollable with head motion      #|
 *   +------------------------------------------------------+
 */
import { wrapText, layoutWindow } from './teleprompter.js';

export const SCREEN = { width: 600, height: 350 };

export const HEADER = { height: 36, iconX: 30, labelX: 50, clockRight: 584, ruleInset: 16 };
export const GUTTER = { labelX: 16, textX: 68 };
export const CONTENT_RIGHT = 578;
export const CONTENT_TOP = 46;
export const CONTENT_BOTTOM = 344;
export const SECTION_GAP = 10;

export const YOU = { font: 17, lineHeight: 22, maxLines: 2, maxLinesWithReply: 1 };
export const REPLY = { font: 19, lineHeight: 24 };
export const LABEL_FONT = 12;
export const SCROLLBAR = { x: 588, width: 3 };

const TEXT_WIDTH = CONTENT_RIGHT - GUTTER.textX;

/**
 * Header icon + label for the plugin's status text. Statuses are the
 * plugin's existing strings ('LISTENING', 'WAITING FOR REPLY…', 'ERROR: x');
 * anything unrecognised is shown as-is in sentence case.
 */
export function statusPresentation(status = '', state = 'idle') {
  const text = status.trim();
  const upper = text.toUpperCase();
  if (upper.startsWith('ERROR')) {
    const detail = text.replace(/^ERROR:\s*/i, '');
    return { icon: 'warning', label: detail ? detail.charAt(0).toUpperCase() + detail.slice(1) : 'Error' };
  }
  if (state === 'unavailable') return { icon: 'warning', label: text || 'Microphone unavailable' };
  const known = {
    LISTENING: { icon: 'mic', label: 'Listening' },
    'TRANSCRIBING…': { icon: 'wave', label: 'Transcribing…' },
    'THINKING…': { icon: 'dots', label: 'Thinking…' },
    'WAITING FOR REPLY…': { icon: 'hourglass', label: 'Waiting for reply…' },
    'CONNECTING…': { icon: 'dots', label: 'Connecting…' },
    'RECONNECTING…': { icon: 'dots', label: 'Reconnecting…' },
  }[upper];
  if (known) return known;
  if (!text || /press button to talk/i.test(text)) return { icon: 'ready', label: 'Ready' };
  return { icon: 'ready', label: sentenceCase(text) };
}

function sentenceCase(text) {
  if (text !== text.toUpperCase()) return text;
  const lower = text.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** Longest prefix of `text` that fits `maxWidth` with a trailing ellipsis. */
export function fitWithEllipsis(text, maxWidth, measure) {
  if (measure(text) <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(`${text.slice(0, mid).trimEnd()}…`) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo).trimEnd()}…`;
}

/** Wrapped transcript lines: the newest `maxLines` while the user is still
 * the focus, or just the opening line once the reply takes over. */
export function transcriptLines(text, { maxLines, keepStart }, measure) {
  const lines = wrapText(text, TEXT_WIDTH, measure).map(({ start, end }) => text.slice(start, end));
  if (lines.length <= maxLines) return lines;
  if (keepStart) {
    const head = lines.slice(0, maxLines);
    head[maxLines - 1] = fitWithEllipsis(`${head[maxLines - 1]} …`, TEXT_WIDTH, measure);
    return head;
  }
  const tail = lines.slice(-maxLines);
  tail[0] = fitWithEllipsis(`…${tail[0]}`, TEXT_WIDTH, measure);
  return tail;
}

/**
 * Everything the renderer needs for one frame.
 * @param {object} input
 * @param {string} input.status       plugin status text
 * @param {string} input.state        plugin state (idle|listening|processing|…)
 * @param {string} input.transcript   what the user said ('' if none yet)
 * @param {{text: string, revealed: number, scrollTop: number|null}} input.reply
 * @param {string} input.clock        e.g. '14:05'
 * @param {(px: number) => (text: string) => number} input.measureAt
 */
export function computeHud({ status, state, transcript, reply, clock, measureAt }) {
  const header = { ...statusPresentation(status, state), clock };
  const hasReply = reply.text.trim().length > 0;
  const transcriptText = transcript.trim();

  let top = CONTENT_TOP;
  let you = null;
  if (transcriptText) {
    const lines = transcriptLines(
      transcriptText,
      { maxLines: hasReply ? YOU.maxLinesWithReply : YOU.maxLines, keepStart: hasReply },
      measureAt(YOU.font),
    );
    you = { top, lines };
    top += lines.length * YOU.lineHeight + SECTION_GAP;
  }

  let replyLayout = null;
  if (hasReply) {
    const maxLines = Math.max(1, Math.floor((CONTENT_BOTTOM - top) / REPLY.lineHeight));
    const window = layoutWindow(
      reply.text,
      reply.revealed,
      { maxLines, maxWidth: TEXT_WIDTH, measure: measureAt(REPLY.font) },
      reply.scrollTop,
    );
    replyLayout = {
      top,
      maxLines,
      lines: window.text ? window.text.split('\n') : [],
      window,
      scrollbar: scrollbarFor(window, maxLines, top),
    };
  }

  // No "press the button" invitation under an error or a missing mic.
  return { header, you, reply: replyLayout, placeholder: !you && !replyLayout && header.icon !== 'warning' };
}

/** Scrollbar thumb for the reply, or null when everything fits. */
export function scrollbarFor(window, maxLines, top) {
  if (window.totalLines <= maxLines) return null;
  const trackTop = top + 2;
  const trackHeight = CONTENT_BOTTOM - trackTop;
  const thumbHeight = Math.max(16, Math.round(trackHeight * (maxLines / window.totalLines)));
  const travel = trackHeight - thumbHeight;
  const thumbTop = trackTop + (window.maxFirst ? Math.round(travel * (window.first / window.maxFirst)) : 0);
  return { trackTop, trackHeight, thumbTop, thumbHeight };
}

export function formatClock(now) {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}
