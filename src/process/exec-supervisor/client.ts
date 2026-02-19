/**
 * ZMQ Exec Supervisor Client
 *
 * Gateway-side client that communicates with the exec-supervisor process.
 * Features:
 * - REQ/REP for spawn/poll/kill/status/health
 * - PUB/SUB for real-time event streaming
 * - Automatic deduplication by jobId+seq
 * - Reconnection handling
 */

import * as zmq from "zeromq";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  DEFAULT_CONTROL_ADDRESS,
  DEFAULT_EVENT_ADDRESS,
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  DEFAULT_RECONNECT_INTERVAL_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  EVENT_TOPIC_PREFIX,
} from "./protocol.js";
import type {
  ControlRequest,
  ControlResponse,
  ExecSupervisorClientConfig,
  HealthResponse,
  JobEvent,
  KillResponse,
  OutputChunk,
  PollResponse,
  SpawnRequest,
  SpawnResponse,
  StatusResponse,
} from "./types.js";

const log = createSubsystemLogger("exec-supervisor/client");

// =============================================================================
// Types
// =============================================================================

export type EventHandler = (event: JobEvent) => void;

export type SpawnOptions = Omit<SpawnRequest, "type">;

export interface ExecSupervisorClient {
  /** Connect to the supervisor */
  connect(): Promise<void>;
  /** Disconnect from the supervisor */
  disconnect(): Promise<void>;
  /** Check if connected and healthy */
  isHealthy(): Promise<boolean>;
  /** Spawn a new job */
  spawn(opts: SpawnOptions): Promise<SpawnResponse>;
  /** Poll for job output */
  poll(jobId: string, cursor?: number): Promise<PollResponse>;
  /** Kill a running job */
  kill(jobId: string, signal?: NodeJS.Signals): Promise<KillResponse>;
  /** Get job status */
  status(jobId?: string): Promise<StatusResponse>;
  /** Get supervisor health */
  health(): Promise<HealthResponse>;
  /** Subscribe to events for a job */
  subscribe(jobId: string, handler: EventHandler): () => void;
  /** Get all output chunks with deduplication */
  getOutput(jobId: string, startSeq?: number): OutputChunk[];
}

// =============================================================================
// Deduplication State
// =============================================================================

type JobOutputState = {
  chunks: Map<number, OutputChunk>;
  maxSeq: number;
};

// =============================================================================
// Client Implementation
// =============================================================================

export function createExecSupervisorClient(
  userConfig?: ExecSupervisorClientConfig,
): ExecSupervisorClient {
  const config: Required<ExecSupervisorClientConfig> = {
    controlAddress: userConfig?.controlAddress ?? DEFAULT_CONTROL_ADDRESS,
    eventAddress: userConfig?.eventAddress ?? DEFAULT_EVENT_ADDRESS,
    requestTimeoutMs: userConfig?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    reconnectIntervalMs: userConfig?.reconnectIntervalMs ?? DEFAULT_RECONNECT_INTERVAL_MS,
    maxReconnectAttempts: userConfig?.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS,
  };

  let controlSocket: zmq.Request | null = null;
  let eventSocket: zmq.Subscriber | null = null;
  let connected = false;
  let reconnecting = false;
  let reconnectAttempts = 0;

  // Event handlers per job
  const eventHandlers = new Map<string, Set<EventHandler>>();

  // Output deduplication per job
  const jobOutputs = new Map<string, JobOutputState>();

  // Request queue for serialization
  let requestLock: Promise<void> = Promise.resolve();

  // =============================================================================
  // Output Deduplication
  // =============================================================================

  function ensureJobOutput(jobId: string): JobOutputState {
    let state = jobOutputs.get(jobId);
    if (!state) {
      state = { chunks: new Map(), maxSeq: -1 };
      jobOutputs.set(jobId, state);
    }
    return state;
  }

  function addChunk(jobId: string, chunk: OutputChunk): boolean {
    const state = ensureJobOutput(jobId);
    if (state.chunks.has(chunk.seq)) {
      return false; // Duplicate
    }
    state.chunks.set(chunk.seq, chunk);
    if (chunk.seq > state.maxSeq) {
      state.maxSeq = chunk.seq;
    }
    return true;
  }

  function addChunksFromPoll(jobId: string, chunks: OutputChunk[]): OutputChunk[] {
    const newChunks: OutputChunk[] = [];
    for (const chunk of chunks) {
      if (addChunk(jobId, chunk)) {
        newChunks.push(chunk);
      }
    }
    return newChunks;
  }

  // =============================================================================
  // Event Handling
  // =============================================================================

  async function runEventLoop() {
    if (!eventSocket) {
      return;
    }

    try {
      for await (const [topic, msg] of eventSocket) {
        try {
          const topicStr = topic.toString();
          if (!topicStr.startsWith(EVENT_TOPIC_PREFIX)) {
            continue;
          }

          const event = JSON.parse(msg.toString()) as JobEvent;
          const jobId = event.jobId;

          // Deduplicate and store output events
          if (event.kind === "job.stdout" || event.kind === "job.stderr") {
            const chunk: OutputChunk = {
              seq: event.seq,
              ts: event.ts,
              kind: event.kind === "job.stdout" ? "stdout" : "stderr",
              data: event.data,
            };
            addChunk(jobId, chunk);
          }

          // Notify handlers
          const handlers = eventHandlers.get(jobId);
          if (handlers) {
            for (const handler of handlers) {
              try {
                handler(event);
              } catch (err) {
                log.warn(`Event handler error for job ${jobId}: ${String(err)}`);
              }
            }
          }
        } catch (err) {
          log.warn(`Failed to parse event: ${String(err)}`);
        }
      }
    } catch (err) {
      if (connected) {
        log.warn(`Event loop error: ${String(err)}`);
        void handleDisconnect();
      }
    }
  }

  // =============================================================================
  // Request/Response
  // =============================================================================

  async function sendRequest<T extends ControlResponse>(req: ControlRequest): Promise<T> {
    // Serialize requests
    const prevLock = requestLock;
    let releaseLock: () => void = () => {};
    requestLock = new Promise((resolve) => {
      releaseLock = resolve;
    });

    try {
      await prevLock;

      if (!controlSocket || !connected) {
        throw new Error("Not connected to supervisor");
      }

      const reqStr = JSON.stringify(req);
      await controlSocket.send(reqStr);

      // Wait for response with timeout
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Request timeout")), config.requestTimeoutMs);
      });

      const responsePromise = (async () => {
        const [msg] = await controlSocket.receive();
        return JSON.parse(msg.toString()) as T;
      })();

      return await Promise.race([responsePromise, timeoutPromise]);
    } finally {
      releaseLock();
    }
  }

  // =============================================================================
  // Reconnection
  // =============================================================================

  async function handleDisconnect() {
    if (reconnecting) {
      return;
    }
    reconnecting = true;
    connected = false;

    while (reconnectAttempts < config.maxReconnectAttempts) {
      reconnectAttempts++;
      log.info(
        `Reconnecting to supervisor (attempt ${reconnectAttempts}/${config.maxReconnectAttempts})...`,
      );

      try {
        // Close existing sockets
        if (controlSocket) {
          controlSocket.close();
          controlSocket = null;
        }
        if (eventSocket) {
          eventSocket.close();
          eventSocket = null;
        }

        // Create new sockets
        controlSocket = new zmq.Request();
        eventSocket = new zmq.Subscriber();

        controlSocket.connect(config.controlAddress);
        eventSocket.connect(config.eventAddress);

        // Re-subscribe to all watched jobs
        for (const jobId of eventHandlers.keys()) {
          eventSocket.subscribe(`${EVENT_TOPIC_PREFIX}${jobId}`);
        }

        // Test connection with health check
        const health = await sendRequest<HealthResponse>({ type: "health" });
        if (health.success) {
          connected = true;
          reconnecting = false;
          reconnectAttempts = 0;
          log.info("Reconnected to supervisor");

          // Restart event loop
          void runEventLoop();
          return;
        }
      } catch (err) {
        log.warn(`Reconnect attempt ${reconnectAttempts} failed: ${String(err)}`);
      }

      await new Promise((resolve) => setTimeout(resolve, config.reconnectIntervalMs));
    }

    reconnecting = false;
    log.error("Failed to reconnect to supervisor after max attempts");
  }

  // =============================================================================
  // Public API
  // =============================================================================

  const client: ExecSupervisorClient = {
    async connect() {
      if (connected) {
        return;
      }

      controlSocket = new zmq.Request();
      eventSocket = new zmq.Subscriber();

      controlSocket.connect(config.controlAddress);
      eventSocket.connect(config.eventAddress);

      connected = true;
      reconnectAttempts = 0;
      log.info(`Connected to supervisor at ${config.controlAddress}`);

      // Start event loop
      void runEventLoop();
    },

    async disconnect() {
      connected = false;

      if (controlSocket) {
        controlSocket.close();
        controlSocket = null;
      }
      if (eventSocket) {
        eventSocket.close();
        eventSocket = null;
      }

      eventHandlers.clear();
      jobOutputs.clear();
      log.info("Disconnected from supervisor");
    },

    async isHealthy() {
      if (!connected) {
        return false;
      }
      try {
        const health = await sendRequest<HealthResponse>({ type: "health" });
        return health.success;
      } catch {
        return false;
      }
    },

    async spawn(opts: SpawnOptions) {
      const res = await sendRequest<SpawnResponse>({
        type: "spawn",
        ...opts,
      });

      // Initialize output state for the job
      if (res.success) {
        ensureJobOutput(opts.jobId);
      }

      return res;
    },

    async poll(jobId: string, cursor?: number) {
      const res = await sendRequest<PollResponse>({
        type: "poll",
        jobId,
        cursor,
      });

      // Deduplicate chunks
      if (res.success && res.chunks.length > 0) {
        const newChunks = addChunksFromPoll(jobId, res.chunks);
        return { ...res, chunks: newChunks };
      }

      return res;
    },

    async kill(jobId: string, signal?: NodeJS.Signals) {
      return await sendRequest<KillResponse>({
        type: "kill",
        jobId,
        signal,
      });
    },

    async status(jobId?: string) {
      return await sendRequest<StatusResponse>({
        type: "status",
        jobId,
      });
    },

    async health() {
      return await sendRequest<HealthResponse>({ type: "health" });
    },

    subscribe(jobId: string, handler: EventHandler) {
      // Add handler
      let handlers = eventHandlers.get(jobId);
      if (!handlers) {
        handlers = new Set();
        eventHandlers.set(jobId, handlers);

        // Subscribe to events for this job
        if (eventSocket) {
          eventSocket.subscribe(`${EVENT_TOPIC_PREFIX}${jobId}`);
        }
      }
      handlers.add(handler);

      // Return unsubscribe function
      return () => {
        handlers?.delete(handler);
        if (handlers?.size === 0) {
          eventHandlers.delete(jobId);
          if (eventSocket) {
            eventSocket.unsubscribe(`${EVENT_TOPIC_PREFIX}${jobId}`);
          }
        }
      };
    },

    getOutput(jobId: string, startSeq = 0) {
      const state = jobOutputs.get(jobId);
      if (!state) {
        return [];
      }

      const chunks: OutputChunk[] = [];
      for (const [seq, chunk] of state.chunks) {
        if (seq >= startSeq) {
          chunks.push(chunk);
        }
      }

      // Sort by seq
      chunks.sort((a, b) => a.seq - b.seq);
      return chunks;
    },
  };

  return client;
}

// =============================================================================
// Singleton
// =============================================================================

let singleton: ExecSupervisorClient | null = null;

export function getExecSupervisorClient(): ExecSupervisorClient {
  if (!singleton) {
    singleton = createExecSupervisorClient();
  }
  return singleton;
}

export function resetExecSupervisorClient(): void {
  if (singleton) {
    void singleton.disconnect();
    singleton = null;
  }
}
