/**
 * ZMQ Exec Supervisor Protocol Constants
 */

/** Default control plane REP socket address */
export const DEFAULT_CONTROL_ADDRESS = "tcp://127.0.0.1:18790";

/** Default event plane PUB socket address */
export const DEFAULT_EVENT_ADDRESS = "tcp://127.0.0.1:18791";

/** Default max concurrent jobs */
export const DEFAULT_MAX_CONCURRENT_JOBS = 50;

/** Default ring buffer max bytes per job (2MB) */
export const DEFAULT_RING_BUFFER_MAX_BYTES = 2 * 1024 * 1024;

/** Default chunk merge interval in ms */
export const DEFAULT_CHUNK_MERGE_INTERVAL_MS = 200;

/** Default job timeout in ms (10 minutes) */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Default cleanup interval in ms (1 minute) */
export const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000;

/** Default finished job retention in ms (5 minutes) */
export const DEFAULT_FINISHED_JOB_RETENTION_MS = 5 * 60 * 1000;

/** Default request timeout in ms */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 1000;

/** Default reconnect interval in ms */
export const DEFAULT_RECONNECT_INTERVAL_MS = 1000;

/** Default max reconnect attempts */
export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;

/** Event topic prefix for PUB/SUB */
export const EVENT_TOPIC_PREFIX = "exec:";

/** Protocol version */
export const PROTOCOL_VERSION = 1;
