#!/usr/bin/env python3
"""
Real inbound control command smoke test via Telethon (user session, NOT bot token).

Usage:
  python scripts/test_telegram_control_inbound.py \
    --api-id 123456 \
    --api-hash abcdef... \
    --target @your_openclaw_bot \
    --state-dir ~/.openclaw

Optional:
  --messages "/status,/stop"
  --pause 1.0
  --session-file scripts/.telethon_openclaw_test

What it does:
1) Captures before-counts of control-plane files
2) Sends commands to OpenClaw Telegram bot as a real user account
3) Waits briefly and captures after-counts
4) Prints deltas + tail snippets
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
from typing import Dict, List

from telethon import TelegramClient

TRACK_FILES = [
    "adapters/telegram/command-log.jsonl",
    "agents/main/control-queue.jsonl",
    "agents/main/control-events.jsonl",
    "agents/main/control-state.json",
]


def file_info(path: Path) -> Dict[str, object]:
    if not path.exists():
        return {"exists": False, "lines": 0, "size": 0}
    size = path.stat().st_size
    if path.suffix == ".json" and path.name == "control-state.json":
        return {"exists": True, "lines": 1, "size": size}
    try:
        with path.open("r", encoding="utf-8") as f:
            lines = sum(1 for _ in f)
    except Exception:
        lines = 0
    return {"exists": True, "lines": lines, "size": size}


def snapshot(state_dir: Path) -> Dict[str, Dict[str, object]]:
    return {rel: file_info(state_dir / rel) for rel in TRACK_FILES}


def tail(path: Path, n: int = 8) -> List[str]:
    if not path.exists():
        return ["<missing>"]
    try:
        lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
        return lines[-n:] if lines else ["<empty>"]
    except Exception as e:
        return [f"<read error: {e}>"]


async def send_commands(api_id: int, api_hash: str, session_file: str, target: str, messages: List[str], pause: float) -> None:
    client = TelegramClient(session_file, api_id, api_hash)
    await client.start()  # first run will prompt for phone/code/2FA
    me = await client.get_me()
    print(f"[telethon] logged in as user_id={me.id}")
    print(f"[telethon] planned messages: {messages!r}")
    for m in messages:
        text = m.strip()
        if not text:
            continue
        await client.send_message(target, text)
        print(f"[telethon] sent: {text!r}")
        await asyncio.sleep(pause)
    await client.disconnect()


def print_delta(before: Dict[str, Dict[str, object]], after: Dict[str, Dict[str, object]]) -> None:
    print("\n=== DELTA ===")
    for rel in TRACK_FILES:
        b = before[rel]
        a = after[rel]
        print(
            f"{rel}: exists {b['exists']} -> {a['exists']}, "
            f"lines {b['lines']} -> {a['lines']}, size {b['size']} -> {a['size']}"
        )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api-id", type=int, required=True)
    ap.add_argument("--api-hash", required=True)
    ap.add_argument("--target", required=True, help="@bot_username or numeric peer id")
    ap.add_argument("--state-dir", default="~/.openclaw")
    ap.add_argument("--messages", default="/status,/stop")
    ap.add_argument("--pause", type=float, default=1.0)
    ap.add_argument("--settle", type=float, default=3.0, help="wait seconds after sending before sampling after-state")
    ap.add_argument("--session-file", default="scripts/.telethon_openclaw_test")
    args = ap.parse_args()

    state_dir = Path(os.path.expanduser(args.state_dir)).resolve()
    before = snapshot(state_dir)
    print("=== BEFORE ===")
    print(json.dumps(before, ensure_ascii=False, indent=2))

    messages = [m.strip() for m in args.messages.split(",") if m.strip()]
    asyncio.run(send_commands(args.api_id, args.api_hash, args.session_file, args.target, messages, args.pause))
    asyncio.run(asyncio.sleep(args.settle))

    after = snapshot(state_dir)
    print("\n=== AFTER ===")
    print(json.dumps(after, ensure_ascii=False, indent=2))
    print_delta(before, after)

    print("\n=== TAILS ===")
    for rel in TRACK_FILES:
        p = state_dir / rel
        print(f"\n--- {rel} ---")
        for line in tail(p, n=8):
            print(line)


if __name__ == "__main__":
    main()
