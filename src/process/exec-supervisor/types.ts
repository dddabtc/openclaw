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

export type ControlRequest =
  | SpawnRequest
  | PollRequest
  | KillRequest
  | StatusRequest
  | HealthRequest;

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
};

export type ControlResponse =
  | SpawnResponse
  | PollResponse
  | KillResponse
  | StatusResponse
  | HealthResponse;

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

export type JobEvent =
  | JobStartedEvent
  | JobStdoutEvent
  | JobStderrEvent
  | JobExitedEvent
  | JobFailedEvent;

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
};

// =============================================================================
// Client Config
// =============================================================================

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
};
