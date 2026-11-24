/**
 * Packs an RGBA buffer (as from CanvasRenderingContext2D.getImageData) into
 * GRAY_4: 4 bits per pixel, 16 brightness levels, even pixel in the high
 * nibble and odd pixel in the low nibble, row stride = ceil(width/2) bytes.
 * Matches gm.display.updateImage's wire format exactly (see
 * PhoneSDK/docs/web-plugin/developer-guide.md section 7.4). Pure function
 * (no DOM), so it's unit-testable without a real canvas.
 */
export function strideFor(width) {
  return Math.ceil(width / 2);
}

export function rgbaToGray4(rgba, width, height) {
  if (rgba.length !== width * height * 4) {
    throw new RangeError(`expected ${width * height * 4} RGBA bytes, got ${rgba.length}`);
  }
  const stride = strideFor(width);
  const bytes = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const luma = (rgba[p] * 54 + rgba[p + 1] * 183 + rgba[p + 2] * 19) / 256;
      const gray = Math.round(luma * (rgba[p + 3] / 255) * 15 / 255);
      const byteIndex = y * stride + (x >> 1);
      if (x & 1) bytes[byteIndex] |= gray; // odd pixel: low nibble
      else bytes[byteIndex] |= gray << 4; // even pixel: high nibble
    }
  }
  return bytes;
}

export function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
