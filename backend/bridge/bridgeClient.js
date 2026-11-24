/**
 * Outgoing HTTP client: this backend calling the Muse bridge's
 * POST /v1/assist (see ../../bridge/README.md for the bridge side).
 * Reachable only over Tailscale; bridgeUrl is never a public address.
 */
export function createBridgeClient({ bridgeUrl, bridgeInboundSecret, fetchImpl = fetch }) {
  return {
    /** Throws on any non-2xx response or network error; caller decides how to surface that. */
    async submitAssistRequest({ requestId, sessionId, utterance, createdAt, signal }) {
      if (!bridgeUrl) throw new Error('BRIDGE_URL is not configured');
      const response = await fetchImpl(`${bridgeUrl}/v1/assist`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${bridgeInboundSecret}`,
        },
        body: JSON.stringify({
          request_id: requestId,
          session_id: sessionId,
          utterance,
          created_at: createdAt,
        }),
        signal,
      });
      if (!response.ok) {
        throw new Error(`bridge rejected assist request: HTTP ${response.status}`);
      }
    },
  };
}
