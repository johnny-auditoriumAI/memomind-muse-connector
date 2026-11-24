# MemoMind to Muse bridge

Runs on a dedicated Ubuntu mini PC. Bridges the MemoMind glasses assistant
(Windows backend, `memomind-one-assistant/server`, port 8800) to a Muse Gadget
SDK side chat, over Tailscale, for an asynchronous "assist" mode.

```text
MemoMind glasses -> Android app -> Windows backend :8800 -> Tailscale
  -> this bridge -> Muse Gadget SDK -> Muse side chat -> reply file on disk
  -> this bridge -> Windows backend -> reply on glasses
```

Keep the existing Claude Haiku route as the default, low-latency mode. Ask
The Muse route is for turns that need Muse's context/tools and can tolerate an
asynchronous reply (seconds to minutes, not "immediately").

## What's implemented here (local work, no deployment done)

Pure Python stdlib, no pip dependencies beyond what `musegadget` itself
needs (see `requirements.txt`, intentionally empty).

- `bridge/config.py` - reads all settings from the environment (see
  `deploy/memomind-muse-bridge.env.example`). Refuses to start if
  `BRIDGE_BIND_HOST` is `0.0.0.0`/`::` (must be the mini PC's Tailscale
  address, never public).
- `bridge/state.py` - `PendingRequestStore`: durable, JSON-file-backed
  (atomic temp-file + rename), so a bridge restart mid-request never loses
  or duplicates a delivery. `create()` and `mark_delivered()` are both
  idempotent by `request_id`.
- `bridge/server.py` - `POST /v1/assist` (bearer auth via
  `BRIDGE_INBOUND_SECRET`, schema/size/timestamp-skew validation, duplicate
  `request_id` is accepted idempotently rather than erroring) and
  `GET /health`. Stdlib `http.server.ThreadingHTTPServer`.
- `bridge/musegadget.py` - resolves the `musegadget` binary via `PATH`
  (never an assumed path) and shells out to
  `musegadget send-user-msg [--session-id ID] TEXT`. The glasses transcript
  is always passed as a single argv string, never through a shell, so it
  can never be interpreted as a command.
- `bridge/delivery.py` - `ReplyForwarder` polls `REPLY_DIR` for the reply
  file contract below, validates it, forwards it to the Windows backend's
  `POST /v1/muse-reply`, and only then deletes the file; a forward failure
  rolls the request back to pending and leaves the file for the next scan.
  `ExpirySweeper` expires requests Muse never answered after
  `ASSIST_EXPIRE_SECONDS` and tells the Windows backend so the glasses
  session isn't left hanging forever.
- `bridge/health.py` - `HealthMonitor` polls the Windows backend's
  `/health` and alerts via `musegadget send-user-msg` only on a
  healthy<->unavailable transition. Down-alerts and recovery-alerts each
  have their own cooldown, so a clean down/up pair is always reported in
  full even if the recovery is quick, while genuine rapid flapping is
  throttled.
- `bridge/app.py` - wires it all together: the HTTP server on the main
  thread, a delivery-scan loop and a health-check loop on daemon threads,
  graceful shutdown on SIGTERM/SIGINT (systemd sends SIGTERM on stop).

Logs include `request_id`/`status`/timing only, never the full utterance
text (the utterance itself is only ever written to the durable state file
under `/var/lib/memomind-muse-bridge`, owned by `musebridge`).

### Reply-file contract

Muse (or whoever answers in the side chat) writes, using a temp filename
plus atomic rename:

```text
/var/lib/memomind-muse-bridge/replies/<request_id>.json
{
  "request_id": "uuid",
  "status": "ok",
  "text": "Reply to show on the glasses",
  "created_at": "ISO-8601 timestamp"
}
```

While the request is pending the assistant can also write, in the same directory
(the assist message tells it how):

```text
<request_id>.status.json        {"type":"status","request_id":"uuid","text":"Reviewing drafts"}
<request_id>.approval-<n>.json  {"type":"approval","request_id":"uuid","approval_id":"<n>",
                                 "question":"Open amazon.com to compare prices?"}
```

- A **status** (at most 120 chars) is forwarded to the Windows backend's
  `POST /v1/muse-event` and shown in the glasses header. Best effort: it is
  dropped if the backend is unreachable.
- An **approval** (question at most 500 chars, `approval_id` letters, digits,
  `-`, `_`) is forwarded the same way and shown on the glasses as Yes / No.
  It is retried until the backend takes it. The glasses user's answer comes back to
  `POST /v1/approval-answer` `{"request_id","approval_id","approved":bool}`
  (bearer `BRIDGE_INBOUND_SECRET`), and the bridge sends the assistant
  `[MemoMind approval] request_id=… approval_id=… answer=APPROVED|DENIED`
  in the side chat.
- Both count as activity: `ASSIST_EXPIRE_SECONDS` runs from the latest
  status, question or answer, not from when the request was created.

These are the assistant's own questions, written through this contract. Muse's
built-in permission prompts are not visible to the gadget SDK, so they still
appear only in the Muse app.

### Automated test coverage

- `python -m unittest discover -s tests` covers every module above (state
  durability/restart-safety, dedup, the HTTP routes, the reply-file
  validation and retry-on-failure path, expiry, and the health monitor's
  transition/cooldown logic).
- The `backend/` additions (`backend/muse-link/*`, `backend/llm/assistant-route.js`)
  are tested together with this bridge's contract: the Node side's
  `/v1/muse-reply` schema matches exactly what `ReplyForwarder` sends.

Not covered by automated tests: the real `musegadget` CLI invocation, real
Tailscale connectivity, or an actual systemd run - these need a real Linux
host with the Muse Gadget SDK installed. See the top-level README's
quickstart and `setup/doctor.sh`.

### Two real bugs found and fixed during development

1. **Health monitor cooldown**: the first version used one shared cooldown
   timer for both directions, so a quick recovery right after a down alert
   could be silently suppressed - leaving the chat saying "backend down"
   with no follow-up, forever, until the next flap. Fixed by tracking
   separate cooldowns for down-alerts and recovery-alerts, so a clean
   down/up pair always reports both ends; only repeated alerts of the
   *same* direction (genuine flapping) are throttled.
2. A test bug (not a bridge bug) initially masked the real
   `on_new_request(request_id, session_id, utterance)` 3-argument callback
   shape with a 1-argument `list.append` stand-in.

## Environment variables

See `deploy/memomind-muse-bridge.env.example` for the full list with
defaults. The required ones with no default: `BRIDGE_BIND_HOST`,
`BRIDGE_BIND_PORT`, `WINDOWS_BACKEND_URL`, `MUSE_SESSION_ID`,
`BRIDGE_INBOUND_SECRET`, `BACKEND_REPLY_SECRET`, `REPLY_DIR`.

## Windows backend changes (separate repo: memomind-one-assistant)

Add these to `memomind-one-assistant/server/.env` once the bridge is
deployed (not needed to just run Haiku, which stays the default):

```text
ASSISTANT_ROUTE=wake-phrase        # haiku (default) | muse | wake-phrase
ASSISTANT_WAKE_PHRASE=ask muse    # only used when ASSISTANT_ROUTE=wake-phrase
BRIDGE_URL=http://<mini-pc-tailscale-ip>:8900
BRIDGE_INBOUND_SECRET=<same value as the bridge's BRIDGE_INBOUND_SECRET>
BACKEND_REPLY_SECRET=<same value as the bridge's BACKEND_REPLY_SECRET>
MUSE_SESSION_ID=<dedicated side-chat id>
ASSISTANT_REQUEST_TIMEOUT_MS=25000  # how long one glasses turn waits before saying "still asking"
```

`BRIDGE_INBOUND_SECRET` and `BACKEND_REPLY_SECRET` must be the exact same
values on both machines (they authenticate the two directions of the
request/reply loop) - generate them once, put them in both `.env` files,
never commit either file.

## Deploying

```bash
# From your workstation, copy the project to the always-on Linux host
# (adjust the host/path to match your own setup - see the setup checklist
# below for what needs to exist on that host first):
rsync -av --exclude '.git' ./ musebridge-admin@<linux-host>:~/memomind-muse-bridge/

# On the mini PC:
cd ~/memomind-muse-bridge
bash deploy/deploy.sh
# then fill in /etc/memomind-muse-bridge.env and:
sudo systemctl enable --now memomind-muse-bridge
sudo systemctl status memomind-muse-bridge --no-pager
sudo journalctl -u memomind-muse-bridge -n 100 --no-pager
```

`deploy/deploy.sh` creates the `musebridge` account if missing (refuses to
continue if it already has sudo), installs the app to
`/opt/memomind-muse-bridge`, creates `/var/lib/memomind-muse-bridge` (+
`replies/`) owned by `musebridge`, installs the systemd unit, and reloads
systemd. It does **not** start the service (secrets must be filled in
first) and does **not** touch musegadget/Tailscale/pairing.

## Setup checklist

See the top-level README for the full quickstart; in short, before this
bridge can run for real:

1. **Linux host preflight** - Ubuntu 22.04+, Bluetooth 5.2/BLE, internet,
   accurate clock; create the `musebridge` account (or let `deploy.sh` do
   it); install `bluez`/`python3-venv`/`netcat-openbsd` if missing.
2. **Fetch a Muse SDK token** from
   https://gadgets.muse.ai/settings/sdk-tokens and run the official
   installer with `--run-as musebridge` (keeps the token out of this
   bridge entirely; it never sees or needs it).
3. **Pair the gadget** from the Muse phone app, on a trusted network.
4. **Tailscale**: install and `sudo tailscale up` on the Linux host, confirm
   it joins the same tailnet as the backend machine and phone, note its
   Tailscale IP for `BRIDGE_BIND_HOST`.
5. **Copy this project over and run `deploy/deploy.sh`**, then fill in
   `/etc/memomind-muse-bridge.env` (two generated secrets, `MUSE_SESSION_ID`,
   `WINDOWS_BACKEND_URL`).
6. **Backend firewall**: restrict the inbound rule for port 8800 to the
   Tailscale interface/addresses (plus LAN only if needed). Do not expose
   it publicly.
7. **Start the bridge**, confirm `systemctl status` is active and
   `journalctl` is free of repeating auth/permission/reconnect errors.
8. **Add the backend `.env` values** above and restart it; verify `/health`
   on both machines, then `tailscale ping`/`nc -vz` between them.
9. **Reboot verification**: reboot the Linux host, confirm `musegadget` and
   `memomind-muse-bridge` both come back up automatically.
10. **On-glasses test**: health alert on backend stop/restart produces
    exactly one alert each; an assist request reaches the side chat and a
    reply file produces exactly one reply on the glasses; a restart
    mid-request doesn't lose/duplicate it; an expired request shows a clear
    delayed/unavailable state; full path works away from home on mobile
    data through Tailscale.
