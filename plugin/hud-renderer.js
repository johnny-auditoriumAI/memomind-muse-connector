/**
 * Browser-only: draws the assistant HUD (geometry from hud-layout.js) onto a
 * 600x350 canvas, packs it to GRAY_4 and pushes it to the glasses. Transport
 * is the same fallback chain as memomind-todoist (one atomic LZ4 frame, then
 * per-band LZ4, then raw GRAY_4), but with 50 px bands: while a reply types
 * out only the band holding the current line changes, so each update is one
 * small band instead of half the screen.
 *
 * GRAY_4 is grayscale; the optics render every level as black-to-green, so
 * "white" here is full-brightness green on the glasses. The user's words are
 * drawn dim and the reply bright, so the two never look alike.
 */
import {
  SCREEN, HEADER, GUTTER, CONTENT_BOTTOM, YOU, REPLY, LABEL_FONT, SCROLLBAR,
} from './hud-layout.js';
import { rgbaToGray4, bytesToBase64 } from './gray4.js';
import { splitFrame, dirtyTiles } from './frame-tiles.js';
import { compressLz4 } from './lz4.js';

const BRIGHT = '#fff';
const TEXT = '#c8c8c8';
const DIM = '#8a8a8a';
const FAINT = '#3c3c3c';
const BG = '#000';
const FONT = 'system-ui, sans-serif';
export const BAND_HEIGHT = 50;

export function fontFor(px, bold = false) {
  return `${bold ? 'bold ' : ''}${px}px ${FONT}`;
}

/** measureAt(px) for hud-layout, backed by the same font the renderer draws. */
export function createMeasurer() {
  const ctx = document.createElement('canvas').getContext('2d');
  const cache = new Map();
  return (px) => {
    if (!cache.has(px)) {
      cache.set(px, (text) => {
        ctx.font = fontFor(px);
        return ctx.measureText(text).width;
      });
    }
    return cache.get(px);
  };
}

function setText(ctx, px, color, { bold = false, align = 'left', baseline = 'middle' } = {}) {
  ctx.font = fontFor(px, bold);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
}

// --- header icons (all centred on cx, cy, ~18 px) ---

function drawMic(ctx, cx, cy, color) {
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(cx - 4, cy - 10, 8, 13, 4);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy - 1, 7, 0, Math.PI);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx, cy + 6);
  ctx.lineTo(cx, cy + 10);
  ctx.moveTo(cx - 4, cy + 10);
  ctx.lineTo(cx + 4, cy + 10);
  ctx.stroke();
}

function drawWave(ctx, cx, cy, color) {
  ctx.fillStyle = color;
  [5, 11, 16, 9, 4].forEach((h, i) => ctx.fillRect(cx - 9 + i * 4, cy - h / 2, 2, h));
}

function drawDots(ctx, cx, cy, color) {
  ctx.fillStyle = color;
  for (const dx of [-7, 0, 7]) {
    ctx.beginPath();
    ctx.arc(cx + dx, cy, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawHourglass(ctx, cx, cy, color) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - 6, cy - 9);
  ctx.lineTo(cx + 6, cy - 9);
  ctx.lineTo(cx - 6, cy + 9);
  ctx.lineTo(cx + 6, cy + 9);
  ctx.closePath();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - 4, cy + 8);
  ctx.lineTo(cx + 4, cy + 8);
  ctx.lineTo(cx, cy + 3);
  ctx.closePath();
  ctx.fill();
}

function drawReady(ctx, cx, cy, color) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, 8, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fill();
}

function drawWarning(ctx, cx, cy, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 9);
  ctx.lineTo(cx + 9, cy + 8);
  ctx.lineTo(cx - 9, cy + 8);
  ctx.closePath();
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fillRect(cx - 1, cy - 3, 2, 6);
  ctx.fillRect(cx - 1, cy + 4, 2, 2);
}

const ICONS = { mic: drawMic, wave: drawWave, dots: drawDots, hourglass: drawHourglass, ready: drawReady, warning: drawWarning };

function drawHeader(ctx, header) {
  const cy = HEADER.height / 2;
  (ICONS[header.icon] ?? drawReady)(ctx, HEADER.iconX, cy, BRIGHT);
  setText(ctx, 18, BRIGHT, { bold: true });
  const clockWidth = header.clock ? ctx.measureText(header.clock).width + 24 : 0;
  ctx.fillText(fitText(ctx, header.label, HEADER.clockRight - clockWidth - HEADER.labelX), HEADER.labelX, cy);
  if (header.clock) {
    setText(ctx, 16, DIM, { align: 'right' });
    ctx.fillText(header.clock, HEADER.clockRight, cy);
  }
  ctx.fillStyle = FAINT;
  ctx.fillRect(HEADER.ruleInset, HEADER.height, SCREEN.width - HEADER.ruleInset * 2, 1);
}

function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let end = text.length;
  while (end > 0 && ctx.measureText(`${text.slice(0, end)}…`).width > maxWidth) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
}

function drawLabel(ctx, text, y, color) {
  setText(ctx, LABEL_FONT, color, { bold: true });
  ctx.fillText(text, GUTTER.labelX, y);
}

function drawYou(ctx, you) {
  drawLabel(ctx, 'YOU', you.top + YOU.lineHeight / 2, DIM);
  setText(ctx, YOU.font, DIM);
  you.lines.forEach((line, i) => ctx.fillText(line, GUTTER.textX, you.top + YOU.lineHeight * (i + 0.5)));
}

function drawReply(ctx, reply) {
  const textBottom = reply.top + Math.max(1, reply.lines.length) * REPLY.lineHeight;
  drawLabel(ctx, 'REPLY', reply.top + REPLY.lineHeight / 2, BRIGHT);
  // Accent bar ties the reply to its label and separates it from "YOU".
  ctx.fillStyle = TEXT;
  ctx.fillRect(GUTTER.textX - 10, reply.top + 3, 2, textBottom - reply.top - 6);
  setText(ctx, REPLY.font, BRIGHT);
  reply.lines.forEach((line, i) => ctx.fillText(line, GUTTER.textX, reply.top + REPLY.lineHeight * (i + 0.5)));
  if (reply.scrollbar) {
    const { trackTop, trackHeight, thumbTop, thumbHeight } = reply.scrollbar;
    ctx.fillStyle = FAINT;
    ctx.fillRect(SCROLLBAR.x, trackTop, SCROLLBAR.width, trackHeight);
    ctx.fillStyle = TEXT;
    ctx.fillRect(SCROLLBAR.x, thumbTop, SCROLLBAR.width, thumbHeight);
  }
}

function drawPlaceholder(ctx) {
  const cx = SCREEN.width / 2;
  const cy = (HEADER.height + CONTENT_BOTTOM) / 2 - 10;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(2.2, 2.2);
  drawMic(ctx, 0, 0, DIM);
  ctx.restore();
  setText(ctx, 17, DIM, { align: 'center' });
  ctx.fillText('Press the button and ask anything', cx, cy + 46);
}

export function drawHud(ctx, hud) {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, SCREEN.width, SCREEN.height);
  drawHeader(ctx, hud.header);
  if (hud.you) drawYou(ctx, hud.you);
  if (hud.reply) drawReply(ctx, hud.reply);
  if (hud.placeholder) drawPlaceholder(ctx);
}

let frameCanvas;

/** Draws the HUD and returns its packed GRAY_4 bytes. */
export function renderHudFrame(hud) {
  if (!frameCanvas) {
    frameCanvas = document.createElement('canvas');
    frameCanvas.width = SCREEN.width;
    frameCanvas.height = SCREEN.height;
  }
  const ctx = frameCanvas.getContext('2d', { willReadFrequently: true });
  drawHud(ctx, hud);
  const { data } = ctx.getImageData(0, 0, SCREEN.width, SCREEN.height);
  return rgbaToGray4(data, SCREEN.width, SCREEN.height);
}

/** Paints GRAY_4 bytes as green-on-black: exactly what the glasses receive. */
export function paintPreview(canvas, frame, width = SCREEN.width, height = SCREEN.height) {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(width, height);
  const stride = Math.ceil(width / 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const byte = frame[y * stride + (x >> 1)];
      const level = (x & 1) ? (byte & 0x0f) : (byte >> 4);
      const p = (y * width + x) * 4;
      image.data[p] = 0;
      image.data[p + 1] = level * 17;
      image.data[p + 2] = 0;
      image.data[p + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
}

const UNSUPPORTED = ['METHOD_NOT_FOUND', 'CAPABILITY_UNAVAILABLE', 'TIMEOUT'];

/**
 * Sends frames to the glasses, resending only bands that changed since the
 * last successful present. Remembers which transports the firmware lacks.
 */
export function createPresenter(gm) {
  let presented = new Map();
  let atomicAvailable = typeof gm.display.beginFrame === 'function';
  let lz4Available = typeof gm.display.updateImageLz4 === 'function';
  let nextFrameId = 1;

  async function sendTile(tile, compressed) {
    const geometry = { x: tile.x, y: tile.y, width: tile.width, height: tile.height, stride: tile.stride };
    if (lz4Available) {
      try {
        await gm.display.updateImageLz4({ ...geometry, decodedSize: tile.bytes.length, dataBase64: bytesToBase64(compressed) });
        return;
      } catch (error) {
        if (!UNSUPPORTED.includes(error.code)) throw error;
        lz4Available = false;
      }
    }
    await gm.display.updateImage({ ...geometry, dataBase64: bytesToBase64(tile.bytes) });
  }

  async function sendAtomic(updates) {
    const frameId = nextFrameId;
    nextFrameId = nextFrameId >= 0xffffffff ? 1 : nextFrameId + 1;
    try {
      await gm.display.beginFrame({ frameId, tileCount: updates.length });
    } catch (error) {
      if (!UNSUPPORTED.includes(error.code)) throw error;
      atomicAvailable = false;
      return false;
    }
    for (let tileIndex = 0; tileIndex < updates.length; tileIndex++) {
      const { tile, compressed } = updates[tileIndex];
      await gm.display.updateFrameImageLz4({
        frameId,
        tileIndex,
        x: tile.x,
        y: tile.y,
        width: tile.width,
        height: tile.height,
        stride: tile.stride,
        decodedSize: tile.bytes.length,
        dataBase64: bytesToBase64(compressed),
      });
    }
    return true;
  }

  return {
    /** @returns {Promise<{tilesSent: number, mode: string}>} */
    async present(frame) {
      const tiles = splitFrame(frame, SCREEN.width, SCREEN.height, BAND_HEIGHT);
      const updates = dirtyTiles(tiles, presented).map((tile) => ({ tile, compressed: compressLz4(tile.bytes) }));
      if (!updates.length) return { tilesSent: 0, mode: 'unchanged' };
      try {
        let mode = null;
        if (updates.length > 1 && atomicAvailable && lz4Available && (await sendAtomic(updates))) mode = 'atomic-lz4';
        if (!mode) {
          for (const { tile, compressed } of updates) await sendTile(tile, compressed);
          mode = lz4Available ? 'lz4' : 'raw';
        }
        for (const { tile } of updates) presented.set(tile.y, tile.bytes);
        return { tilesSent: updates.length, mode };
      } catch (error) {
        // Unknown device state after a partial send: resend everything next time.
        presented = new Map();
        throw error;
      }
    },
    reset() {
      presented = new Map();
    },
  };
}
