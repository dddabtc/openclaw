#!/usr/bin/env node
/**
 * ZMQ Exec Supervisor Server
 *
 * Standalone process that manages child process execution.
 * Communicates with Gateway via ZeroMQ:
 * - Control plane: REQ/REP for spawn/poll/kill/status/health
 * - Event plane: PUB/SUB for real-time events
 *
 * Usage: node src/process/exec-supervisor/server.ts [--control=<addr>] [--event=<addr>]
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as zmq from "zeromq";
import {
  DEFAULT_CHUNK_MERGE_INTERVAL_MS,
  DEFAULT_CLEANUP_INTERVAL_MS,
  DEFAULT_CONTROL_ADDRESS,
  DEFAULT_EVENT_ADDRESS,
  DEFAULT_FINISHED_JOB_RETENTION_MS,
  DEFAULT_MAX_CONCURRENT_JOBS,
  DEFAULT_RING_BUFFER_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  EVENT_TOPIC_PREFIX,
  PROTOCOL_VERSION,
} from "./protocol.js";
import type {
  ControlRequest,
  ControlResponse,
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
  SpawnResponse,
  StatusResponse,
  TerminationReason,
} from "./types.js";

// =============================================================================
// State
// =============================================================================

const jobs = new Map<string, JobRecord>();
const processes = new Map<string, ChildProcess>();
const pendingChunks = new Map<string, { stdout: string; stderr: string; lastFlush: number }>();
let startedAtMs = Date.now();
let totalJobsProcessed = 0;

// =============================================================================
// Sockets
// =============================================================================

let controlSocket: zmq.Reply | null = null;
let eventSocket: zmq.Publisher | null = null;

// =============================================================================
// Config
// =============================================================================

let config: Required<ExecSupervisorConfig> = {
  controlAddress: DEFAULT_CONTROL_ADDRESS,
  eventAddress: DEFAULT_EVENT_ADDRESS,
  maxConcurrentJobs: DEFAULT_MAX_CONCURRENT_JOBS,
  ringBufferMaxBytes: DEFAULT_RING_BUFFER_MAX_BYTES,
  chunkMergeIntervalMs: DEFAULT_CHUNK_MERGE_INTERVAL_MS,
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  cleanupIntervalMs: DEFAULT_CLEANUP_INTERVAL_MS,
  finishedJobRetentionMs: DEFAULT_FINISHED_JOB_RETENTION_MS,
};

// =============================================================================
// Logging
// =============================================================================

function log(level: "info" | "warn" | "error", msg: string) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [exec-supervisor] [${level}] ${msg}`);
}

// =============================================================================
// Ring Buffer Management
// =============================================================================

function appendToRingBuffer(
  job: JobRecord,
  kind: RingBufferEntry["kind"],
  data: string,
): RingBufferEntry {
  const entry: RingBufferEntry = {
    seq: job.nextSeq++,
    ts: Date.now(),
    kind,
    data,
  };
  const entryBytes = data.length;
  job.ringBuffer.push(entry);
  job.ringBufferBytes += entryBytes;

  // Trim oldest entries if over limit
  while (job.ringBufferBytes > config.ringBufferMaxBytes && job.ringBuffer.length > 1) {
    const removed = job.ringBuffer.shift();
    if (removed) {
      job.ringBufferBytes -= removed.data.length;
    }
  }

  job.lastActivityAtMs = entry.ts;
  return entry;
}

// =============================================================================
// Event Publishing
// =============================================================================

async function publishEvent(event: JobEvent) {
  if (!eventSocket) {
    return;
  }
  const topic = `${EVENT_TOPIC_PREFIX}${event.jobId}`;
  const payload = JSON.stringify(event);
  try {
    await eventSocket.send([topic, payload]);
  } catch (err) {
    log("error", `Failed to publish event: ${String(err)}`);
  }
}

// =============================================================================
// Chunk Merging
// =============================================================================

function flushPendingChunks(jobId: string) {
  const pending = pendingChunks.get(jobId);
  const job = jobs.get(jobId);
  if (!pending || !job) {
    return;
  }

  if (pending.stdout) {
    const entry = appendToRingBuffer(job, "stdout", pending.stdout);
    void publishEvent({
      kind: "job.stdout",
      jobId,
      seq: entry.seq,
      ts: entry.ts,
      data: pending.stdout,
    });
    pending.stdout = "";
  }

  if (pending.stderr) {
    const entry = appendToRingBuffer(job, "stderr", pending.stderr);
    void publishEvent({
      kind: "job.stderr",
      jobId,
      seq: entry.seq,
      ts: entry.ts,
      data: pending.stderr,
    });
    pending.stderr = "";
  }

  pending.lastFlush = Date.now();
}

function appendPendingChunk(jobId: string, kind: "stdout" | "stderr", data: string) {
  let pending = pendingChunks.get(jobId);
  if (!pending) {
    pending = { stdout: "", stderr: "", lastFlush: Date.now() };
    pendingChunks.set(jobId, pending);
  }

  if (kind === "stdout") {
    pending.stdout += data;
  } else {
    pending.stderr += data;
  }

  // Flush if enough time has passed
  if (Date.now() - pending.lastFlush >= config.chunkMergeIntervalMs) {
    flushPendingChunks(jobId);
  }
}

// =============================================================================
// Job Management
// =============================================================================

function getActiveJobCount(): number {
  let count = 0;
  for (const job of jobs.values()) {
    if (job.state === "pending" || job.state === "running") {
      count++;
    }
  }
  return count;
}

function finalizeJob(
  jobId: string,
  state: JobState,
  exitCode: number | null,
  exitSignal: NodeJS.Signals | number | null,
  reason: TerminationReason,
) {
  const job = jobs.get(jobId);
  if (!job) {
    return;
  }

  // Don't overwrite if already finalized
  if (job.state === "exited" || job.state === "failed") {
    return;
  }

  // Flush any pending chunks first
  flushPendingChunks(jobId);
  pendingChunks.delete(jobId);

  job.state = state;
  job.exitCode = exitCode;
  job.exitSignal = exitSignal;
  job.terminationReason = reason;
  job.lastActivityAtMs = Date.now();

  const entry = appendToRingBuffer(
    job,
    state === "failed" ? "failed" : "exited",
    JSON.stringify({ exitCode, exitSignal, reason }),
  );

  processes.delete(jobId);

  if (state === "failed") {
    void publishEvent({
      kind: "job.failed",
      jobId,
      seq: entry.seq,
      ts: entry.ts,
      error: reason,
      reason,
    });
  } else {
    void publishEvent({
      kind: "job.exited",
      jobId,
      seq: entry.seq,
      ts: entry.ts,
      exitCode,
      exitSignal,
      reason,
    });
  }
}

// =============================================================================
// Command Handlers
// =============================================================================

async function handleSpawn(req: ControlRequest & { type: "spawn" }): Promise<SpawnResponse> {
  const { jobId, command, cwd, env, timeoutMs, noOutputTimeoutMs } = req;

  // Check if job already exists
  if (jobs.has(jobId)) {
    return { type: "spawn", success: false, jobId, error: "Job already exists" };
  }

  // Check concurrent job limit
  if (getActiveJobCount() >= config.maxConcurrentJobs) {
    return { type: "spawn", success: false, jobId, error: "Max concurrent jobs reached" };
  }

  const now = Date.now();
  const job: JobRecord = {
    jobId,
    command,
    cwd,
    state: "pending",
    startedAtMs: now,
    lastActivityAtMs: now,
    ringBuffer: [],
    ringBufferBytes: 0,
    nextSeq: 0,
  };
  jobs.set(jobId, job);

  // Spawn the child process
  try {
    const effectiveEnv = { ...process.env, ...env };
    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/bash";
    const shellArgs = process.platform === "win32" ? ["/c", command] : ["-c", command];

    const child = spawn(shell, shellArgs, {
      cwd: cwd || process.cwd(),
      env: effectiveEnv,
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
    });

    if (!child.pid) {
      throw new Error("Failed to spawn process");
    }

    job.pid = child.pid;
    job.state = "running";
    processes.set(jobId, child);

    const startedEntry = appendToRingBuffer(job, "started", JSON.stringify({ pid: child.pid }));
    void publishEvent({
      kind: "job.started",
      jobId,
      seq: startedEntry.seq,
      ts: startedEntry.ts,
      pid: child.pid,
      command,
    });

    totalJobsProcessed++;

    // Set up output handlers
    child.stdout?.on("data", (data: Buffer) => {
      appendPendingChunk(jobId, "stdout", data.toString());
    });

    child.stderr?.on("data", (data: Buffer) => {
      appendPendingChunk(jobId, "stderr", data.toString());
    });

    // Set up exit handler
    child.on("close", (code, signal) => {
      const reason: TerminationReason = signal ? "signal" : "exit";
      finalizeJob(jobId, "exited", code, signal, reason);
    });

    child.on("error", (err) => {
      finalizeJob(jobId, "failed", null, null, "spawn-error");
      log("error", `Job ${jobId} error: ${err.message}`);
    });

    // Set up timeout
    const effectiveTimeoutMs = timeoutMs ?? config.defaultTimeoutMs;
    if (effectiveTimeoutMs > 0) {
      setTimeout(() => {
        const currentJob = jobs.get(jobId);
        if (currentJob && (currentJob.state === "pending" || currentJob.state === "running")) {
          const proc = processes.get(jobId);
          if (proc) {
            proc.kill("SIGKILL");
          }
          finalizeJob(jobId, "failed", null, "SIGKILL", "timeout");
        }
      }, effectiveTimeoutMs);
    }

    // Set up no-output timeout if specified
    if (noOutputTimeoutMs && noOutputTimeoutMs > 0) {
      const checkNoOutput = () => {
        const currentJob = jobs.get(jobId);
        if (!currentJob || currentJob.state === "exited" || currentJob.state === "failed") {
          return;
        }
        const elapsed = Date.now() - currentJob.lastActivityAtMs;
        if (elapsed >= noOutputTimeoutMs) {
          const proc = processes.get(jobId);
          if (proc) {
            proc.kill("SIGKILL");
          }
          finalizeJob(jobId, "failed", null, "SIGKILL", "no-output-timeout");
        } else {
          setTimeout(checkNoOutput, Math.min(noOutputTimeoutMs - elapsed + 100, 5000));
        }
      };
      setTimeout(checkNoOutput, noOutputTimeoutMs);
    }

    return { type: "spawn", success: true, jobId, pid: child.pid };
  } catch (err) {
    job.state = "failed";
    job.terminationReason = "spawn-error";
    log("error", `Failed to spawn job ${jobId}: ${String(err)}`);
    return { type: "spawn", success: false, jobId, error: String(err) };
  }
}

function handlePoll(req: ControlRequest & { type: "poll" }): PollResponse {
  const { jobId, cursor } = req;
  const job = jobs.get(jobId);

  if (!job) {
    return {
      type: "poll",
      success: false,
      jobId,
      state: "failed",
      chunks: [],
      cursor: 0,
      error: "Job not found",
    };
  }

  // Flush pending chunks before returning
  flushPendingChunks(jobId);

  // Get chunks after cursor
  const startSeq = cursor ?? 0;
  const chunks: OutputChunk[] = [];
  for (const entry of job.ringBuffer) {
    if (entry.seq >= startSeq && (entry.kind === "stdout" || entry.kind === "stderr")) {
      chunks.push({
        seq: entry.seq,
        ts: entry.ts,
        kind: entry.kind,
        data: entry.data,
      });
    }
  }

  const nextCursor = job.nextSeq;

  return {
    type: "poll",
    success: true,
    jobId,
    state: job.state,
    chunks,
    cursor: nextCursor,
    exitCode: job.exitCode,
    exitSignal: job.exitSignal,
    terminationReason: job.terminationReason,
  };
}

function handleKill(req: ControlRequest & { type: "kill" }): KillResponse {
  const { jobId, signal } = req;
  const job = jobs.get(jobId);
  const proc = processes.get(jobId);

  if (!job) {
    return { type: "kill", success: false, jobId, error: "Job not found" };
  }

  if (job.state === "exited" || job.state === "failed") {
    return { type: "kill", success: true, jobId }; // Already done
  }

  if (!proc) {
    return { type: "kill", success: false, jobId, error: "Process not found" };
  }

  const killSignal = signal ?? "SIGKILL";
  proc.kill(killSignal);
  job.state = "exiting";

  // The close handler will finalize
  return { type: "kill", success: true, jobId };
}

function handleStatus(req: ControlRequest & { type: "status" }): StatusResponse {
  const { jobId } = req;

  if (jobId) {
    const job = jobs.get(jobId);
    if (!job) {
      return { type: "status", success: false, error: "Job not found" };
    }
    const status: JobStatus = {
      jobId: job.jobId,
      state: job.state,
      pid: job.pid,
      startedAtMs: job.startedAtMs,
      exitCode: job.exitCode,
      exitSignal: job.exitSignal,
      terminationReason: job.terminationReason,
      outputBytes: job.ringBufferBytes,
    };
    return { type: "status", success: true, job: status };
  }

  // Return all jobs
  const jobStatuses: JobStatus[] = [];
  for (const job of jobs.values()) {
    jobStatuses.push({
      jobId: job.jobId,
      state: job.state,
      pid: job.pid,
      startedAtMs: job.startedAtMs,
      exitCode: job.exitCode,
      exitSignal: job.exitSignal,
      terminationReason: job.terminationReason,
      outputBytes: job.ringBufferBytes,
    });
  }
  return { type: "status", success: true, jobs: jobStatuses };
}

function handleHealth(): HealthResponse {
  const memUsage = process.memoryUsage();
  return {
    type: "health",
    success: true,
    uptime: Date.now() - startedAtMs,
    activeJobs: getActiveJobCount(),
    totalJobsProcessed,
    memoryUsageMB: Math.round(memUsage.heapUsed / 1024 / 1024),
  };
}

async function handleRequest(req: ControlRequest): Promise<ControlResponse> {
  switch (req.type) {
    case "spawn":
      return await handleSpawn(req);
    case "poll":
      return handlePoll(req);
    case "kill":
      return handleKill(req);
    case "status":
      return handleStatus(req);
    case "health":
      return handleHealth();
    default:
      return {
        type: "health",
        success: false,
        uptime: 0,
        activeJobs: 0,
        totalJobsProcessed: 0,
        memoryUsageMB: 0,
      };
  }
}

// =============================================================================
// Cleanup
// =============================================================================

function cleanupFinishedJobs() {
  const now = Date.now();
  const toDelete: string[] = [];

  for (const [jobId, job] of jobs) {
    if (job.state === "exited" || job.state === "failed") {
      if (now - job.lastActivityAtMs > config.finishedJobRetentionMs) {
        toDelete.push(jobId);
      }
    }
  }

  for (const jobId of toDelete) {
    jobs.delete(jobId);
    pendingChunks.delete(jobId);
    processes.delete(jobId);
  }

  if (toDelete.length > 0) {
    log("info", `Cleaned up ${toDelete.length} finished jobs`);
  }
}

// =============================================================================
// Main Loop
// =============================================================================

async function runControlLoop() {
  if (!controlSocket) {
    return;
  }

  log("info", `Control plane listening on ${config.controlAddress}`);

  for await (const [msg] of controlSocket) {
    try {
      const reqStr = msg.toString();
      const req = JSON.parse(reqStr) as ControlRequest;
      const res = await handleRequest(req);
      await controlSocket.send(JSON.stringify(res));
    } catch (err) {
      log("error", `Error handling request: ${String(err)}`);
      try {
        await controlSocket.send(
          JSON.stringify({
            type: "health",
            success: false,
            error: String(err),
          }),
        );
      } catch {
        // Ignore send errors
      }
    }
  }
}

// =============================================================================
// Startup
// =============================================================================

export async function startSupervisor(userConfig?: ExecSupervisorConfig): Promise<{
  stop: () => Promise<void>;
}> {
  config = {
    ...config,
    ...userConfig,
  };

  startedAtMs = Date.now();

  // Create sockets
  controlSocket = new zmq.Reply();
  eventSocket = new zmq.Publisher();

  await controlSocket.bind(config.controlAddress);
  await eventSocket.bind(config.eventAddress);

  log("info", `Exec supervisor started (protocol v${PROTOCOL_VERSION})`);
  log("info", `Control: ${config.controlAddress}`);
  log("info", `Events: ${config.eventAddress}`);
  log("info", `Max concurrent jobs: ${config.maxConcurrentJobs}`);
  log("info", `Ring buffer max: ${config.ringBufferMaxBytes} bytes`);

  // Start cleanup interval
  const cleanupInterval = setInterval(cleanupFinishedJobs, config.cleanupIntervalMs);

  // Start chunk flush interval
  const flushInterval = setInterval(() => {
    for (const jobId of pendingChunks.keys()) {
      const job = jobs.get(jobId);
      if (job && (job.state === "running" || job.state === "pending")) {
        flushPendingChunks(jobId);
      }
    }
  }, config.chunkMergeIntervalMs);

  // Start control loop (non-blocking)
  void runControlLoop();

  return {
    stop: async () => {
      clearInterval(cleanupInterval);
      clearInterval(flushInterval);

      // Kill all running processes
      for (const proc of processes.values()) {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Ignore
        }
      }

      // Close sockets
      if (controlSocket) {
        controlSocket.close();
        controlSocket = null;
      }
      if (eventSocket) {
        eventSocket.close();
        eventSocket = null;
      }

      log("info", "Exec supervisor stopped");
    },
  };
}

// =============================================================================
// CLI Entry Point
// =============================================================================

function parseArgs(): ExecSupervisorConfig {
  const cfg: ExecSupervisorConfig = {};
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--control=")) {
      cfg.controlAddress = arg.slice("--control=".length);
    } else if (arg.startsWith("--event=")) {
      cfg.eventAddress = arg.slice("--event=".length);
    } else if (arg.startsWith("--max-jobs=")) {
      cfg.maxConcurrentJobs = parseInt(arg.slice("--max-jobs=".length), 10);
    } else if (arg.startsWith("--ring-buffer=")) {
      cfg.ringBufferMaxBytes = parseInt(arg.slice("--ring-buffer=".length), 10);
    }
  }
  return cfg;
}

// Only run if this is the main module
const isMainModule =
  process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js");
if (isMainModule) {
  const cfg = parseArgs();
  startSupervisor(cfg).catch((err) => {
    log("error", `Failed to start supervisor: ${err}`);
    process.exit(1);
  });

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    log("info", "Received SIGINT, shutting down...");
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    log("info", "Received SIGTERM, shutting down...");
    process.exit(0);
  });
}
