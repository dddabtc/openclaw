/**
 * ZMQ Exec Supervisor Types
 *
 * Protocol types for communication between Gateway and exec-supervisor.
 */

// =============================================================================
// Job State
// =============================================================================

export type JobState = "pending" | "running" | "exiting" | "exited" | "failed";

export type TerminationReason =
  | "exit"
  | "signal"
  | "timeout"
  | "no-output-timeout"
  | "manual-cancel"
  | "spawn-error";

// =============================================================================
// Control Plane (REQ/REP)
// =============================================================================

export type SpawnRequest = {
  type: "spawn";
  jobId: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  usePty?: boolean;
  timeoutMs?: number;
  noOutputTimeoutMs?: number;
  maxOutputBytes?: number;
};

export type PollRequest = {
  type: "poll";
  jobId: string;
  cursor?: number;
};

export type KillRequest = {
  type: "kill";
  jobId: string;
  signal?: NodeJS.Signals;
};

export type StatusRequest = {
  type: "status";
  jobId?: string;
};

export type HealthRequest = {
  type: "health";
};

/** v2: Subscribe request - client subscribes to job events */
export type SubscribeRequest = {
  type: "subscribe";
  jobId: string;
  /** Sequence number to start from (for backfill after reconnect) */
  fromSeq?: number;
};

/** v2: List active jobs (for recovery after reconnect) */
export type ListJobsRequest = {
  type: "list-jobs";
};

export type ControlRequest =
  | SpawnRequest
  | PollRequest
  | KillRequest
  | StatusRequest
  | HealthRequest
  | SubscribeRequest
  | ListJobsRequest;

// Response types

export type SpawnResponse = {
  type: "spawn";
  success: boolean;
  jobId: string;
  pid?: number;
  error?: string;
};

export type OutputChunk = {
  seq: number;
  ts: number;
  kind: "stdout" | "stderr";
  data: string;
};

export type PollResponse = {
  type: "poll";
  success: boolean;
  jobId: string;
  state: JobState;
  chunks: OutputChunk[];
  cursor: number;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | number | null;
  terminationReason?: TerminationReason;
  error?: string;
};

export type KillResponse = {
  type: "kill";
  success: boolean;
  jobId: string;
  error?: string;
};

export type JobStatus = {
  jobId: string;
  state: JobState;
  pid?: number;
  startedAtMs: number;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | number | null;
  terminationReason?: TerminationReason;
  outputBytes: number;
};

export type StatusResponse = {
  type: "status";
  success: boolean;
  jobs?: JobStatus[];
  job?: JobStatus;
  error?: string;
};

export type HealthResponse = {
  type: "health";
  success: boolean;
  uptime: number;
  activeJobs: number;
  totalJobsProcessed: number;
  memoryUsageMB: number;
  /** v2: Number of events dropped due to HWM */
  eventsDropped?: number;
};

/** v2: Subscribe response */
export type SubscribeResponse = {
  type: "subscribe";
  success: boolean;
  jobId: string;
  /** Current sequence number for the job */
  currentSeq?: number;
  /** Events since fromSeq (for backfill) */
  events?: JobEvent[];
  error?: string;
};

/** v2: List jobs response */
export type ListJobsResponse = {
  type: "list-jobs";
  success: boolean;
  jobs: Array<{
    jobId: string;
    state: JobState;
    lastSeq: number;
    startedAtMs: number;
  }>;
};

export type ControlResponse =
  | SpawnResponse
  | PollResponse
  | KillResponse
  | StatusResponse
  | HealthResponse
  | SubscribeResponse
  | ListJobsResponse;

// =============================================================================
// Event Plane (PUB/SUB)
// =============================================================================

export type JobStartedEvent = {
  kind: "job.started";
  jobId: string;
  seq: number;
  ts: number;
  pid?: number;
  command: string;
};

export type JobStdoutEvent = {
  kind: "job.stdout";
  jobId: string;
  seq: number;
  ts: number;
  data: string;
};

export type JobStderrEvent = {
  kind: "job.stderr";
  jobId: string;
  seq: number;
  ts: number;
  data: string;
};

export type JobExitedEvent = {
  kind: "job.exited";
  jobId: string;
  seq: number;
  ts: number;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | number | null;
  reason: TerminationReason;
};

export type JobFailedEvent = {
  kind: "job.failed";
  jobId: string;
  seq: number;
  ts: number;
  error: string;
  reason: TerminationReason;
};

/** v2: Gap marker event - indicates events were dropped due to HWM */
export type JobGapEvent = {
  kind: "job.gap";
  jobId: string;
  seq: number;
  ts: number;
  /** Number of events that were dropped */
  droppedCount: number;
  /** First dropped sequence number */
  fromSeq: number;
  /** Last dropped sequence number */
  toSeq: number;
};

export type JobEvent =
  | JobStartedEvent
  | JobStdoutEvent
  | JobStderrEvent
  | JobExitedEvent
  | JobFailedEvent
  | JobGapEvent;

// =============================================================================
// Ring Buffer Entry
// =============================================================================

export type RingBufferEntry = {
  seq: number;
  ts: number;
  kind: "stdout" | "stderr" | "started" | "exited" | "failed";
  data: string;
};

// =============================================================================
// Job Record
// =============================================================================

export type JobRecord = {
  jobId: string;
  command: string;
  cwd?: string;
  pid?: number;
  state: JobState;
  startedAtMs: number;
  lastActivityAtMs: number;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | number | null;
  terminationReason?: TerminationReason;
  ringBuffer: RingBufferEntry[];
  ringBufferBytes: number;
  nextSeq: number;
};

// =============================================================================
// Supervisor Config
// =============================================================================

export type ExecSupervisorConfig = {
  /** Control plane REP socket address (default: tcp://127.0.0.1:18790) */
  controlAddress?: string;
  /** Event plane PUB socket address (default: tcp://127.0.0.1:18791) */
  eventAddress?: string;
  /** Max concurrent jobs (default: 50) */
  maxConcurrentJobs?: number;
  /** Ring buffer size per job in bytes (default: 2MB) */
  ringBufferMaxBytes?: number;
  /** Chunk merge interval in ms (default: 200) */
  chunkMergeIntervalMs?: number;
  /** Default timeout for jobs in ms (default: 600000 = 10 min) */
  defaultTimeoutMs?: number;
  /** Cleanup interval for finished jobs in ms (default: 60000) */
  cleanupIntervalMs?: number;
  /** How long to keep finished jobs before cleanup in ms (default: 300000 = 5 min) */
  finishedJobRetentionMs?: number;
  /** v2: High water mark for event publishing (default: 1000) */
  eventHwm?: number;
  /** v2: Path to journal file (default: /tmp/exec-supervisor-journal.json) */
  journalPath?: string;
  /** v2: Journal flush interval in ms (default: 5000) */
  journalFlushIntervalMs?: number;
};

// =============================================================================
// v2: Journal Types
// =============================================================================

/** Journal entry for a job */
export type JournalEntry = {
  jobId: string;
  command: string;
  cwd?: string;
  startedAtMs: number;
  state: JobState;
  lastSeq: number;
  pid?: number;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | number | null;
  terminationReason?: TerminationReason;
};

/** Journal file structure */
export type JournalFile = {
  version: number;
  updatedAtMs: number;
  jobs: JournalEntry[];
};

// =============================================================================
// Client Config
// =============================================================================

/** v2: Subscribe mode for receiving events */
export type SubscribeMode = "poll" | "push";

export type ExecSupervisorClientConfig = {
  /** Control plane REQ socket address (default: tcp://127.0.0.1:18790) */
  controlAddress?: string;
  /** Event plane SUB socket address (default: tcp://127.0.0.1:18791) */
  eventAddress?: string;
  /** Request timeout in ms (default: 30000) */
  requestTimeoutMs?: number;
  /** Reconnect interval in ms (default: 1000) */
  reconnectIntervalMs?: number;
  /** Max reconnect attempts (default: 10) */
  maxReconnectAttempts?: number;
  /** v2: Subscribe mode (default: poll) */
  subscribeMode?: SubscribeMode;
  /** v2: Enable gap detection and auto-backfill (default: true in push mode) */
  autoBackfill?: boolean;
};
