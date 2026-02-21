#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List

from telethon import TelegramClient


TOOL_CALL_HINTS = [
    '"recipient_name":"functions.',
    '"tool_calls"',
    '"function_call"',
    '"tool_use"',
    '"clientToolCall"',
    '"sessions_spawn"',
]


def read_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def line_count(path: Path) -> int:
    if not path.exists():
        return 0
    with path.open("r", encoding="utf-8", errors="ignore") as f:
        return sum(1 for _ in f)


def get_main_session_id(state_dir: Path) -> str:
    sessions_file = state_dir / "agents/main/sessions/sessions.json"
    data = read_json(sessions_file, {})
    if isinstance(data, dict):
        entry = data.get("agent:main:main")
        if isinstance(entry, dict):
            sid = entry.get("sessionId")
            if isinstance(sid, str) and sid:
                return sid
    return ""


def read_new_lines(path: Path, from_line: int) -> List[str]:
    if not path.exists():
        return []
    out: List[str] = []
    with path.open("r", encoding="utf-8", errors="ignore") as f:
        for idx, line in enumerate(f, start=1):
            if idx > from_line:
                out.append(line.rstrip("\n"))
    return out


def snapshot(state_dir: Path) -> Dict[str, Any]:
    cmd_log = state_dir / "adapters/telegram/command-log.jsonl"
    sessions_file = state_dir / "agents/main/sessions/sessions.json"

    sessions = read_json(sessions_file, {})
    keys: List[str] = []
    if isinstance(sessions, dict):
        if isinstance(sessions.get("sessions"), list):
            entries = sessions.get("sessions", [])
            keys = [e.get("key") for e in entries if isinstance(e, dict) and e.get("key")]
        else:
            keys = [k for k in sessions.keys() if isinstance(k, str)]
    sub_keys = [k for k in keys if ":subagent:" in k]

    sid = get_main_session_id(state_dir)
    main_jsonl = state_dir / "agents/main/sessions" / f"{sid}.jsonl" if sid else None
    main_lines = line_count(main_jsonl) if main_jsonl else 0

    return {
        "command_log_lines": line_count(cmd_log),
        "sessions_total": len(keys),
        "subsessions_total": len(sub_keys),
        "subsession_keys": sub_keys,
        "main_session_id": sid,
        "main_session_jsonl": str(main_jsonl) if main_jsonl else "",
        "main_session_lines": main_lines,
    }


async def send_messages(api_id: int, api_hash: str, session_file: str, target: str, messages: List[str], rounds: int, pause: float) -> None:
    client = TelegramClient(session_file, api_id, api_hash)
    await client.start()
    me = await client.get_me()
    print(f"[telethon] logged in as user_id={me.id}")
    print(f"[telethon] planned messages={messages!r}, rounds={rounds}")
    for r in range(rounds):
        for m in messages:
            text = m.strip()
            if not text:
                continue
            await client.send_message(target, text)
            print(f"[telethon] round={r+1} sent={text!r}")
            await asyncio.sleep(pause)
    await client.disconnect()


def detect_tool_call(new_main_lines: List[str]) -> Dict[str, Any]:
    joined = "\n".join(new_main_lines)
    matched = [h for h in TOOL_CALL_HINTS if h in joined]
    return {
        "tool_call_detected": len(matched) > 0,
        "matched_hints": matched,
    }


def determine_route(tool_call_detected: bool, new_subsessions: int, new_main_lines: List[str]) -> str:
    joined = "\n".join(new_main_lines)
    if not tool_call_detected:
        return "INVALID_SAMPLE"
    if new_subsessions > 0 or '"sessions_spawn"' in joined or ':subagent:' in joined:
        return "SUB_SESSION"
    return "MAIN_SESSION"


def print_summary(before: Dict[str, Any], after: Dict[str, Any], elapsed: float, new_main_lines: List[str]) -> None:
    before_set = set(before.get("subsession_keys", []))
    after_set = set(after.get("subsession_keys", []))
    new_sub = sorted(after_set - before_set)

    tool = detect_tool_call(new_main_lines)
    route = determine_route(tool["tool_call_detected"], len(new_sub), new_main_lines)

    print("\n=== SUMMARY ===")
    print(f"elapsed_sec={elapsed:.2f}")
    print(f"command_log_lines: {before['command_log_lines']} -> {after['command_log_lines']} (+{after['command_log_lines']-before['command_log_lines']})")
    print(f"sessions_total: {before['sessions_total']} -> {after['sessions_total']} (+{after['sessions_total']-before['sessions_total']})")
    print(f"subsessions_total: {before['subsessions_total']} -> {after['subsessions_total']} (+{after['subsessions_total']-before['subsessions_total']})")
    print(f"new_subsessions={len(new_sub)}")
    for k in new_sub[:20]:
        print(f"  - {k}")

    print("\n=== PHASE-1 (sample validity) ===")
    print(f"tool_call_detected={tool['tool_call_detected']}")
    print(f"matched_hints={tool['matched_hints']}")

    print("\n=== PHASE-2 (routing) ===")
    print(f"route={route}")

    print("\n=== MAIN SESSION NEW LINES (tail 8) ===")
    for line in new_main_lines[-8:]:
        print(line[:500])



def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api-id", type=int, required=True)
    ap.add_argument("--api-hash", required=True)
    ap.add_argument("--target", required=True)
    ap.add_argument("--messages", required=True)
    ap.add_argument("--rounds", type=int, default=1)
    ap.add_argument("--pause", type=float, default=0.5)
    ap.add_argument("--settle", type=float, default=10.0)
    ap.add_argument("--state-dir", default="~/.openclaw")
    ap.add_argument("--session-file", default="scripts/.telethon_openclaw_test")
    args = ap.parse_args()

    state_dir = Path(os.path.expanduser(args.state_dir)).resolve()
    messages = [m.strip() for m in args.messages.split(",") if m.strip()]
    if not messages:
        raise SystemExit("No valid messages in --messages")

    before = snapshot(state_dir)
    print("=== BEFORE ===")
    print(json.dumps(before, ensure_ascii=False, indent=2))

    started = time.time()
    asyncio.run(send_messages(args.api_id, args.api_hash, args.session_file, args.target, messages, args.rounds, args.pause))
    asyncio.run(asyncio.sleep(args.settle))
    elapsed = time.time() - started

    after = snapshot(state_dir)
    print("\n=== AFTER ===")
    print(json.dumps(after, ensure_ascii=False, indent=2))

    new_main_lines: List[str] = []
    if before.get("main_session_jsonl"):
        new_main_lines = read_new_lines(Path(before["main_session_jsonl"]), int(before.get("main_session_lines", 0)))

    print_summary(before, after, elapsed, new_main_lines)


if __name__ == "__main__":
    main()
