# Telegram Control Inbound Test (Real User via Telethon)

This document explains how to run a **real inbound** `/status` + `/stop` test against OpenClaw Telegram control handling.

## Why this exists

`bot -> bot` messaging is not reliable for Telegram command testing.
Use a **user account session** (Telethon) to send commands to the OpenClaw bot.

## Script location

- `scripts/test_telegram_control_inbound.py`

## Prerequisites

1. Telegram `api_id` + `api_hash` from `https://my.telegram.org`
2. Test user id added to allowlist:

```bash
openclaw config set channels.telegram.allowFrom '["<owner_id>","<test_user_id>"]'
systemctl --user restart openclaw-gateway.service
```

## Run

```bash
cd ~/openclaw-src
python3 -m venv .venv
source .venv/bin/activate
pip install telethon

python3 scripts/test_telegram_control_inbound.py \
  --api-id <API_ID> \
  --api-hash <API_HASH> \
  --target @<openclaw_bot_username> \
  --messages "/status,/stop"
```

First run will prompt for phone/code/2FA and persist a local Telethon session file.

## Expected output

The script prints:

1. `BEFORE` snapshot of control files
2. Sent command logs (`[telethon] sent: ...`)
3. `AFTER` snapshot
4. `DELTA` counters
5. Tail snippets for:
   - `~/.openclaw/adapters/telegram/command-log.jsonl`
   - `~/.openclaw/agents/main/control-queue.jsonl`
   - `~/.openclaw/agents/main/control-events.jsonl`
   - `~/.openclaw/agents/main/control-state.json`

## Pass criteria

For `/stop`:

- command-log has new `/stop` entry
- queue gets a new record
- events include: `ENQUEUED -> ACK_SENT -> DONE`
- control-state updates with latest command id

For `/status`:

- command-log has new `/status` entry
- response behavior follows current configured routing (native/control-plane)

## Notes

- The script uses **real inbound path**, not synthetic local dispatch.
- Rotate `api_hash` if leaked. Never commit secrets.

## Command lane bypass (anti-blocking)

Current behavior in `src/telegram/bot-native-commands.ts`:

- Strict command-word messages matching `^/[A-Za-z0-9_]+(?:@[\w_]+)?$` are assigned
  a separate session key: `telegram:commands:<senderId>`.
- This decouples command handling from the normal chat lane and avoids long waits
  when the main session is congested.

## Sub-session routing pressure probe

Additional script:

- `scripts/test_telegram_subsession_pressure.py`

Purpose:

1. Send natural-language test prompts via Telethon
2. Validate sample first (`INVALID_SAMPLE` vs tool-call detected)
3. Determine route (`MAIN_SESSION` or `SUB_SESSION`)

Example:

```bash
python3 scripts/test_telegram_subsession_pressure.py \
  --api-id <API_ID> \
  --api-hash <API_HASH> \
  --target @<openclaw_bot_username> \
  --messages "ssh 到192.168.1.136 用户名是 zhaod，执行 hostname 并把结果告诉我" \
  --rounds 1 --pause 0.5 --settle 20
```

## Status banner format (current)

The `/status` output includes a custom banner block:

1. `🦞 OpenClaw <version> (<commit>)`
2. `🏷️ PERSONAL BUILD · <dist-publish-time>(UTC)`
3. `by: https://github.com/dddabtc`

This is rendered in the fast status path currently used on 113.
