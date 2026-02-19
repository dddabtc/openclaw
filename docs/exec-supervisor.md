# Exec Supervisor (ZMQ)

The Exec Supervisor provides out-of-process execution management for the Gateway using ZeroMQ communication. This decouples child process stdout/stderr handling from the Gateway's main event loop, preventing high-concurrency exec workloads from blocking other Gateway operations.

## Protocol Version

Current protocol version: **2**

### v2 Features (new)

- **Push mode event delivery**: Real-time events via PUB/SUB socket
- **Local event buffering**: Client maintains per-job event buffer for low-latency access
- **Gap detection & auto-backfill**: Automatically detects and fills missing events
- **Job journal persistence**: Supervisor persists active job state for recovery
- **High water mark (HWM)**: Backpressure control to prevent memory exhaustion

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
                            │  ┌────────────────────────────────┐  │
                            │  │      Job Manager + Journal     │  │
                            │  │  ┌─────┐ ┌─────┐ ┌─────┐       │  │
                            │  │  │Job 1│ │Job 2│ │Job N│       │  │
                            │  │  └─────┘ └─────┘ └─────┘       │  │
                            │  └────────────────────────────────┘  │
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
- `subscribe` - (v2) Request backfill events from a sequence number
- `list-jobs` - (v2) List active jobs for recovery

Default address: `tcp://127.0.0.1:18790`

### Event Plane (PUB/SUB)

Used for real-time event streaming:

- `job.started` - Job has started
- `job.stdout` - Stdout output chunk
- `job.stderr` - Stderr output chunk
- `job.exited` - Job exited normally
- `job.failed` - Job failed (timeout, error, etc.)
- `job.gap` - (v2) Gap marker indicating dropped events due to HWM

Default address: `tcp://127.0.0.1:18791`

Each event includes:

- `jobId` - Unique job identifier
- `seq` - Sequence number for ordering
- `ts` - Timestamp (ms since epoch)
- `kind` - Event type
- `payload` - Event-specific data

## Subscribe Modes (v2)

The client supports two subscribe modes:

### Poll Mode (default)

- Client actively polls for job output using REQ/REP
- Traditional request-response pattern
- Higher latency but simpler

### Push Mode

- Client receives events via SUB socket in real-time
- Client maintains per-job event buffer
- `poll` operations read from local buffer
- Automatic gap detection and backfill
- Lower latency and reduced polling overhead

```typescript
// Set subscribe mode
client.setSubscribeMode("push");

// Get current mode
const mode = client.getSubscribeMode(); // "push" | "poll"
```

## Job Journal (v2)

The supervisor persists active job state to a journal file for recovery:

- Default path: `/tmp/exec-supervisor-journal.json`
- Flush interval: 5 seconds
- On restart, active jobs are recovered (marked as failed since processes are lost)
- On gateway reconnect, client can resubscribe and backfill from last known sequence

## Configuration

In `openclaw.yaml`:

```yaml
tools:
  exec:
    mode: origin # or "zmq"
```

### Supervisor Configuration Options

```typescript
{
  controlAddress?: string;       // Default: tcp://127.0.0.1:18790
  eventAddress?: string;         // Default: tcp://127.0.0.1:18791
  maxConcurrentJobs?: number;    // Default: 50
  ringBufferMaxBytes?: number;   // Default: 2MB
  chunkMergeIntervalMs?: number; // Default: 200ms
  defaultTimeoutMs?: number;     // Default: 10 minutes
  cleanupIntervalMs?: number;    // Default: 1 minute
  finishedJobRetentionMs?: number; // Default: 5 minutes
  eventHwm?: number;             // Default: 1000 (v2)
  journalPath?: string;          // Default: /tmp/exec-supervisor-journal.json (v2)
  journalFlushIntervalMs?: number; // Default: 5000 (v2)
}
```

### Client Configuration Options

```typescript
{
  controlAddress?: string;       // Default: tcp://127.0.0.1:18790
  eventAddress?: string;         // Default: tcp://127.0.0.1:18791
  requestTimeoutMs?: number;     // Default: 30 seconds
  reconnectIntervalMs?: number;  // Default: 1 second
  maxReconnectAttempts?: number; // Default: 10
  subscribeMode?: "poll" | "push"; // Default: poll (v2)
  autoBackfill?: boolean;        // Default: true (v2)
}
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

### High Water Mark (v2)

Event publishing uses HWM to prevent memory exhaustion:

- When queue exceeds HWM, oldest events are dropped
- Gap events are published to notify clients
- Clients can backfill missing events via `subscribe` request

### Journal Persistence (v2)

Active job state is persisted for recovery:

- Survives supervisor restarts (jobs marked as failed since processes are lost)
- Enables gateway reconnection without losing context
- Automatic cleanup of completed jobs

## Implementation Files

- `src/process/exec-supervisor/server.ts` - Standalone supervisor process
- `src/process/exec-supervisor/client.ts` - Gateway-side ZMQ client
- `src/process/exec-supervisor/dispatcher.ts` - Mode switching logic
- `src/process/exec-supervisor/types.ts` - Protocol types
- `src/process/exec-supervisor/protocol.ts` - Protocol constants

## Tests

- `src/process/exec-supervisor/server.test.ts` - Server unit tests
- `src/process/exec-supervisor/client.test.ts` - Client unit tests
- `src/process/exec-supervisor/dispatcher.test.ts` - Dispatcher tests
- `src/process/exec-supervisor/v2.test.ts` - v2 feature tests (push mode, journal, etc.)
- `src/process/exec-supervisor/perf.test.ts` - Performance tests
