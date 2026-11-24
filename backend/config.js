/**
 * All runtime configuration, read once from the environment (.env is loaded
 * by `node --env-file-if-exists=.env`, see package.json scripts). Secrets
 * only ever come from here, never from the plugin.
 */
const env = process.env;

export const config = {
  port: Number(env.PORT) || 8800,
  // 0.0.0.0 so a phone on the same LAN can reach it (the BLE client needs
  // this; the Web plugin simulator path works either way). Override with
  // HOST=127.0.0.1 in .env to go back to localhost-only.
  host: env.HOST || '0.0.0.0',
  recordDir: env.RECORD_DIR || '',

  sttProvider: env.STT_PROVIDER || 'whisper',
  whisperUrl: (env.WHISPER_URL || 'http://127.0.0.1:8178').replace(/\/+$/, ''),
  whisperTimeoutMs: Number(env.WHISPER_TIMEOUT_MS) || 15000,

  llmProvider: env.LLM_PROVIDER || (env.ANTHROPIC_API_KEY ? 'claude' : 'mock'),
  claudeModel: env.CLAUDE_MODEL || 'claude-haiku-5-5',
  claudeTimeoutMs: Number(env.CLAUDE_TIMEOUT_MS) || 20000,

  maxUtteranceMs: 30000,
  replyThrottleMs: 150,
  historyTurns: 6,
  historyTtlMs: 10 * 60 * 1000,

  // The display name for the Muse-backed assistant persona, shown in the
  // HUD and spoken in replies (e.g. "ASSISTANT'S reply", "Hey <name>").
  assistantName: env.ASSISTANT_NAME || 'Muse',

  // Routing. 'haiku' (default) never touches the bridge; 'muse' routes
  // every turn through the Muse bridge; 'wake-phrase' routes only turns
  // whose transcript starts with assistantWakePhrase, stripping it.
  assistantRoute: env.ASSISTANT_ROUTE || 'haiku',
  assistantWakePhrase: env.ASSISTANT_WAKE_PHRASE || `ask ${(env.ASSISTANT_NAME || 'Muse').toLowerCase()}`,
  // Reachable only over Tailscale; never a public address.
  bridgeUrl: (env.BRIDGE_URL || '').replace(/\/+$/, ''),
  // Sent BY this backend TO the bridge's /v1/assist.
  bridgeInboundSecret: env.BRIDGE_INBOUND_SECRET || '',
  // Required FROM the bridge on incoming POST /v1/muse-reply.
  backendReplySecret: env.BACKEND_REPLY_SECRET || '',
  museSessionId: env.MUSE_SESSION_ID || '',
  assistantRequestTimeoutMs: Number(env.ASSISTANT_REQUEST_TIMEOUT_MS) || 25000,
  // How long a delivered-but-undelivered (socket closed) reply is kept
  // before being treated as expired, for dedup/report purposes only.
  assistantRecordTtlMs: Number(env.ASSISTANT_RECORD_TTL_MS) || 10 * 60 * 1000,
};
