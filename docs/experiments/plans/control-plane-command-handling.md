# Control-plane command handling (`/stop`, `/status`)

Status: implementation + pressure-test aligned (2026-02)

## Why

Under load, command UX must stay responsive even when normal session/data-plane work is busy.
The command path now follows a control-plane-first design so `/stop` and `/status` do not queue behind LLM/tool work.

## Design goals

1. **Control/Data split**: command handling is not treated as normal chat business flow.
2. **Agent-scoped execution**: command queue/events are bound to agent state, not per-session lane.
3. **Adapter ingress isolation**: each adapter writes its own ingress command log file.
4. **Fast ACK**: `/stop` immediately replies with an ACK before abort dispatch.
5. **Durable tracing**: command lifecycle is persisted and replayable.
6. **Deterministic recovery**: non-terminal historical commands are marked as recovered on startup/path entry.

## Current flow (implemented)

### Strict command matching

Only full-match commands enter control plane:

```regex
^/(stop|status)(?:@[\w_]+)?$
```

No partial/contains matching.

### `/status` (fast path)

- Bypasses queue.
- Reads control state quickly.
- Replies directly with status summary (`Status#xxxxxx: ...`).

### `/stop` (two-stage)

1. Persist enqueue + state update.
2. Send immediate ACK (`Stopping... [#xxxxxx]`).
3. Dispatch fast abort.
4. Send final result (`Stopped ... [#xxxxxx]` or timeout/failure reason).

## Durable files / evidence points

Under `~/.openclaw` (or `OPENCLAW_STATE_DIR`):

```text
adapters/<adapter>/command-log.jsonl
agents/<agentId>/control-queue.jsonl
agents/<agentId>/control-events.jsonl
agents/<agentId>/control-state.json
```

Key event types to validate:

- `ENQUEUED`
- `ACK_SENT`
- `DONE` / `FAILED` / `TIMED_OUT` / `TIMED_OUT_RECOVERED`

## Performance targets (SLO)

- `/stop` ACK p95 < **200ms**
- `/status` p95 < **500ms**
- `/stop` total dispatch p95 < **2000ms**
- Burst test should show **no collective timeout explosion**

## Pressure-test method

Reference script:

- `scripts/control-plane-benchmark.ts`

Run:

```bash
node --import tsx scripts/control-plane-benchmark.ts
# optional rounds override (minimum 10 enforced by script)
ROUNDS=12 node --import tsx scripts/control-plane-benchmark.ts
```

Scenario (per round):

- `/stop` x5 + `/status` x5
- concurrent mixed workload
- repeated for >= 10 rounds

Output includes:

- per-round mean/p95/max
- overall mean/p95/max
- timeout counters
- collective-timeout-burst flag
- control-plane evidence (file deltas + event type counts)

## Notes

- This benchmark targets command-path logic and control-plane durability/latency, not external IM network jitter.
- If command-path instrumentation changes, update this doc and script together to keep acceptance criteria stable.
