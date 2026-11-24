# Changelog

## v0.2.0

Muse-only: removed the direct-API Claude Haiku route and the
haiku/muse/wake-phrase routing choice. The Muse bridge is now the backend's
only assistant path.

- Removed `backend/llm/claude.js`, `backend/llm/mock.js` (the Haiku-mode
  mock LLM), `backend/llm/history.js` (per-conversation memory, which only
  existed to support Claude's multi-turn context), and
  `createWakePhraseAssistant`.
- Dropped `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`, `LLM_PROVIDER`,
  `ASSISTANT_ROUTE`, `ASSISTANT_WAKE_PHRASE` from config and
  `.env.example`; `BRIDGE_URL`/`MUSE_SESSION_ID`/the two bridge secrets are
  now required, not optional. Removed the `@anthropic-ai/sdk` dependency.
- README/quickstart now describe a single setup path (bridge + backend +
  plugin); speech-to-text (whisper.cpp or mock) is unchanged.
- Test coverage: 63 backend tests (4 Haiku/wake-phrase-only tests removed),
  59 bridge tests (bridge itself is unaffected).

## v0.1.0

Initial public release.

- `plugin/`: glasses HUD browser plugin (audio capture, bitmap HUD rendering,
  spoken replies).
- `backend/`: Node WebSocket backend; local whisper.cpp STT; Claude Haiku
  route plus an optional Muse-bridge route (`ASSISTANT_ROUTE=muse` or
  `wake-phrase`).
- `bridge/`: Python stdlib service forwarding assistant requests to a Muse
  Gadget SDK side chat, with status/approval relay back to the glasses.
- Assistant persona name is configurable via `ASSISTANT_NAME` (default
  `Muse`); all hosts/ports/paths are environment-driven.
- Top-level README, quickstart, and `setup/doctor.sh` preflight check.
- Test coverage: 67 backend tests, 59 bridge tests.
