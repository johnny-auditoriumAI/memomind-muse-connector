# MemoMind Muse Connector

Connects a MemoMind smart-glasses plugin to a [Muse Gadget SDK](https://gadgets.muse.ai/)
side chat, so the glasses can ask an assistant something and get a reply even
when the answer takes longer than a normal voice turn (seconds to minutes,
with progress and yes/no approvals shown on the glasses in the meantime).

```text
glasses plugin  --ws-->  Node backend  --http-->  Python bridge  --->  Muse side chat
   (plugin/)               (backend/)                (bridge/)
```

- **`plugin/`** - the browser-based glasses plugin: records audio, shows the
  HUD (status, transcript, reply), plays replies back as speech.
- **`backend/`** - a Node WebSocket server the plugin connects to. Decodes
  audio, runs local speech-to-text, and answers either directly (fast Claude
  Haiku route) or by forwarding the turn to the bridge (Muse route).
- **`bridge/`** - a small Python service, meant to run on an always-on host
  reachable over Tailscale, that forwards assistant requests to a Muse side
  chat and relays replies/status/approvals back to the backend.

Each piece can run independently. The Haiku route (`backend/` + `plugin/`)
works with no bridge at all; the bridge only matters once you want turns
routed to Muse.

## Quickstart (Haiku route only, no bridge)

1. `cd backend && npm install`
2. `cp .env.example .env` and fill in `ANTHROPIC_API_KEY` (or leave it blank
   to use the mock LLM and skip straight to trying the plugin).
3. Get a local `whisper.cpp` server binary + model (see
   `backend/tools/start-whisper.mjs`), or set `STT_PROVIDER=mock` in `.env`
   to skip that too.
4. `npm run whisper` (unless using the mock STT), then `npm start`.
5. Side-load `plugin/` into the Muse app as a web plugin (see the Muse
   Gadget SDK docs for how your device expects plugins to be delivered),
   point its backend URL setting at `ws://<backend-host>:8800`.

Run `backend`'s tests any time with `npm test` (`cd backend`).

## Adding the Muse bridge route

1. Set up the bridge on its own host per `bridge/README.md`'s setup
   checklist (Muse SDK token, gadget pairing, Tailscale, systemd service).
2. Generate two secrets (`openssl rand -hex 32` each) and put the same
   values in both `backend/.env` (`BRIDGE_INBOUND_SECRET`,
   `BACKEND_REPLY_SECRET`) and the bridge's env file.
3. In `backend/.env`, set `BRIDGE_URL`, `MUSE_SESSION_ID`, and either
   `ASSISTANT_ROUTE=muse` (every turn goes through Muse) or
   `ASSISTANT_ROUTE=wake-phrase` (only turns starting with
   `ASSISTANT_WAKE_PHRASE`, e.g. "ask muse", go through Muse; everything
   else stays on the fast Haiku route).
4. Restart the backend, confirm `GET /health` on both the backend and the
   bridge, then test an end-to-end turn from the glasses.

Run the bridge's tests any time with `python -m unittest discover -s tests`
(`cd bridge`).

## Naming

`ASSISTANT_NAME` (default `Muse`) is the only place the assistant's display
name lives - it drives the HUD label, the spoken "`<name>` replied" prefix,
and the default wake phrase ("ask `<name>`"). Change it in `backend/.env`.

## Preflight check

`setup/doctor.sh` checks that the tools this project needs (Node, Python,
`whisper.cpp`, the two `.env` files) are present before you try to run
anything end to end.

## Status

Built and exercised with automated tests (67 backend, 59 bridge) and local
runs; the Muse-side chat and musegadget CLI steps need a real Muse Gadget
SDK install to verify, as noted in `bridge/README.md`.
