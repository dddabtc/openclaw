# Exec Supervisor (ZMQ)

The Exec Supervisor provides out-of-process execution management for the Gateway using ZeroMQ communication. This decouples child process stdout/stderr handling from the Gateway's main event loop, preventing high-concurrency exec workloads from blocking other Gateway operations.

## Background

OpenClaw's `exec` tool spawns child processes on behalf of the agent. In the default ("origin") mode, stdout/stderr callbacks are handled directly in the Gateway's main event loop. Under high concurrency (6+ parallel exec commands with frequent polling), this can saturate the event loop and cause responsiveness issues.

The ZMQ supervisor addresses this by:

1. Moving child process management to a separate process
2. Using ZeroMQ for efficient IPC
3. Batching output chunks to reduce event frequency
4. Providing per-job ring buffers for output storage

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          Gateway                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐       │
│  │  exec tool   │───▶│  dispatcher  │───▶│ ZMQ client   │       │
│  └──────────────┘    └──────────────┘    └──────────────┘       │
│                             │                    │               │
│                             │                    │ REQ/REP       │
│                             │                    │ PUB/SUB       │
│                     ┌───────┴───────┐            │               │
│                     │ mode=origin   │            │               │
│                     └───────┬───────┘            │               │
│                             │                    │               │
│                             ▼                    │               │
│                   ┌──────────────┐               │               │
│                   │ProcessSuper- │               │               │
│                   │visor (origin)│               │               │
│                   └──────────────┘               │               │
└─────────────────────────────────────────────────────────────────┘
                                                   │
                                                   ▼
                            ┌──────────────────────────────────────┐
                            │        exec-supervisor process       │
                            │  ┌────────────┐  ┌────────────────┐  │
                            │  │ REP socket │  │ PUB socket     │  │
                            │  │ (control)  │  │ (events)       │  │
                            │  └────────────┘  └────────────────┘  │
                            │        │                │            │
                            │        ▼                ▼            │
                            │  ┌────────────────────────────┐      │
                            │  │      Job Manager           │      │
                            │  │  ┌─────┐ ┌─────┐ ┌─────┐   │      │
                            │  │  │Job 1│ │Job 2│ │Job N│   │      │
                            │  │  └─────┘ └─────┘ └─────┘   │      │
                            │  └────────────────────────────┘      │
                            └──────────────────────────────────────┘
```

## Communication Protocol

### Control Plane (REQ/REP)

Used for synchronous operations:

- `spawn` - Start a new job
- `poll` - Get job output and status
- `kill` - Terminate a job
- `status` - Query job(s) status
- `health` - Check supervisor health

Default address: `tcp://127.0.0.1:18790`

### Event Plane (PUB/SUB)

Used for real-time event streaming:

- `job.started` - Job has started
- `job.stdout` - Stdout output chunk
- `job.stderr` - Stderr output chunk
- `job.exited` - Job exited normally
- `job.failed` - Job failed (timeout, error, etc.)

Default address: `tcp://127.0.0.1:18791`

Each event includes:

- `jobId` - Unique job identifier
- `seq` - Sequence number for ordering
- `ts` - Timestamp (ms since epoch)
- `kind` - Event type
- `payload` - Event-specific data

## Configuration

In `openclaw.yaml`:

```yaml
tools:
  exec:
    mode: origin # or "zmq"
```

## Runtime Mode Switching

Use the `/exec-mode` command to view or change the exec mode at runtime:

```
/exec-mode           # Show current mode and supervisor status
/exec-mode origin    # Switch to in-process mode
/exec-mode zmq       # Switch to ZMQ supervisor mode
```

Switching modes:

- Only affects new exec tasks; running tasks continue in their original mode
- Switching to `zmq` requires a healthy supervisor (health check is performed)
- Switching to `origin` always succeeds

## Running the Supervisor

The supervisor can be started standalone:

```bash
node dist/process/exec-supervisor/server.js [options]

Options:
  --control=<addr>    Control socket address (default: tcp://127.0.0.1:18790)
  --event=<addr>      Event socket address (default: tcp://127.0.0.1:18791)
  --max-jobs=<n>      Max concurrent jobs (default: 50)
  --ring-buffer=<n>   Ring buffer size in bytes (default: 2097152)
```

## Features

### Ring Buffer

Each job maintains a ring buffer (default 2MB) for stdout/stderr output. When the buffer fills, oldest entries are discarded. This prevents memory exhaustion from jobs with large output.

### Chunk Merging

Output is batched in 200ms windows before being sent to reduce event frequency and network overhead.

### Timeout Handling

Jobs support both overall timeout and no-output timeout:

- Overall timeout: Kill job if running too long
- No-output timeout: Kill job if no output for specified duration

### Deduplication

The Gateway client deduplicates events by `(jobId, seq)` to handle reconnection scenarios where events might be replayed.

## Implementation Files

- `src/process/exec-supervisor/server.ts` - Standalone supervisor process
- `src/process/exec-supervisor/client.ts` - Gateway-side ZMQ client
- `src/process/exec-supervisor/dispatcher.ts` - Mode switching logic
- `src/process/exec-supervisor/types.ts` - Protocol types
- `src/process/exec-supervisor/protocol.ts` - Protocol constants
