/**
 * Exec Supervisor ZMQ Module
 *
 * Provides out-of-process exec management via ZeroMQ to offload child process
 * callbacks from the Gateway main event loop.
 */

// Types
export type {
  ControlRequest,
  ControlResponse,
  ExecSupervisorClientConfig,
  ExecSupervisorConfig,
  HealthResponse,
  JobEvent,
  JobRecord,
  JobState,
  JobStatus,
  KillResponse,
  OutputChunk,
  PollResponse,
  RingBufferEntry,
  SpawnRequest,
  SpawnResponse,
  StatusResponse,
  TerminationReason,
} from "./types.js";

// Protocol constants
export {
  DEFAULT_CHUNK_MERGE_INTERVAL_MS,
  DEFAULT_CLEANUP_INTERVAL_MS,
  DEFAULT_CONTROL_ADDRESS,
  DEFAULT_EVENT_ADDRESS,
  DEFAULT_FINISHED_JOB_RETENTION_MS,
  DEFAULT_MAX_CONCURRENT_JOBS,
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  DEFAULT_RECONNECT_INTERVAL_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_RING_BUFFER_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  EVENT_TOPIC_PREFIX,
  PROTOCOL_VERSION,
} from "./protocol.js";

// Client
export {
  createExecSupervisorClient,
  getExecSupervisorClient,
  resetExecSupervisorClient,
  type EventHandler,
  type ExecSupervisorClient,
  type SpawnOptions,
} from "./client.js";

// Dispatcher
export {
  formatModeStatus,
  getExecMode,
  getExecModeStatus,
  getZmqClient,
  initExecModeFromConfig,
  isZmqModeAvailable,
  setExecMode,
  type ExecMode,
  type ModeChangeResult,
  type ModeStatus,
} from "./dispatcher.js";

// Server (for standalone process)
export { startSupervisor } from "./server.js";
