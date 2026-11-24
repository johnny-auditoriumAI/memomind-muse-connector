# Changelog

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
