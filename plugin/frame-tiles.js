/**
 * Pure helpers for sending a full-screen GRAY_4 frame. A 600x350 frame is
 * 105,000 bytes, over the Scene Bridge's 81,901-byte single-payload limit
 * (PhoneSDK/docs/web-plugin/developer-guide.md section 7.1), so it goes out
 * as full-width horizontal bands. Bands that are byte-identical to what the
 * glasses already show are skipped - in steady state only the clock changes
 * each minute, so only the top band is resent.
 */
export const TILE_HEIGHT = 175;

/** Splits a packed GRAY_4 frame into full-width bands of up to tileHeight rows. */
export function splitFrame(frame, width, height, tileHeight = TILE_HEIGHT) {
  const stride = Math.ceil(width / 2);
  if (frame.length !== stride * height) {
    throw new RangeError(`expected ${stride * height} frame bytes, got ${frame.length}`);
  }
  const tiles = [];
  for (let y = 0; y < height; y += tileHeight) {
    const rows = Math.min(tileHeight, height - y);
    tiles.push({ x: 0, y, width, height: rows, stride, bytes: frame.subarray(y * stride, (y + rows) * stride) });
  }
  return tiles;
}

export function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The tiles that differ from what was last presented (keyed by y). */
export function dirtyTiles(tiles, presented) {
  return tiles.filter((tile) => !bytesEqual(presented.get(tile.y), tile.bytes));
}
