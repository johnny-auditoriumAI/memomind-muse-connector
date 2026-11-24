/** Offline STT stand-in for tests: returns a fixed transcript if any audio arrived. */
export const MOCK_TRANSCRIPT = 'what time is it';

export function createMockSttStream() {
  let bytes = 0;
  return {
    write(pcm) { bytes += pcm.length; },
    async finish() { return bytes > 0 ? MOCK_TRANSCRIPT : ''; },
    close() {},
  };
}
