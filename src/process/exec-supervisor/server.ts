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
import * as fs from "node:fs";
import * as path from "node:path";
import * as zmq from "zeromq";
import {
  DEFAULT_CHUNK_MERGE_INTERVAL_MS,
  DEFAULT_CLEANUP_INTERVAL_MS,
  DEFAULT_CONTROL_ADDRESS,
  DEFAULT_EVENT_ADDRESS,
  DEFAULT_EVENT_HWM,
  DEFAULT_FINISHED_JOB_RETENTION_MS,
  DEFAULT_JOURNAL_FLUSH_INTERVAL_MS,
  DEFAULT_JOURNAL_PATH,
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
  JournalEntry,
  JournalFile,
  KillResponse,
  ListJobsResponse,
  OutputChunk,
  PollResponse,
  RingBufferEntry,
  SpawnResponse,
  StatusResponse,
  SubscribeResponse,
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

// v2: Event tracking
let eventsDropped = 0;
let _eventQueueSize = 0; // Reserved for future HWM tracking

// v2: Journal state
let journalDirty = false;
let journalPath = DEFAULT_JOURNAL_PATH;

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
  eventHwm: DEFAULT_EVENT_HWM,
  journalPath: DEFAULT_JOURNAL_PATH,
  journalFlushIntervalMs: DEFAULT_JOURNAL_FLUSH_INTERVAL_MS,
};

// =============================================================================
// Logging
// =============================================================================

function log(level: "info" | "warn" | "error", msg: string) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [exec-supervisor] [${level}] ${msg}`);
}

// =============================================================================
// v2: Journal Management
// =============================================================================

function getJournalEntry(job: JobRecord): JournalEntry {
  return {
    jobId: job.jobId,
    command: job.command,
    cwd: job.cwd,
    startedAtMs: job.startedAtMs,
    state: job.state,
    lastSeq: job.nextSeq - 1,
    pid: job.pid,
    exitCode: job.exitCode,
    exitSignal: job.exitSignal,
    terminationReason: job.terminationReason,
  };
}

function saveJournal(): void {
  if (!journalDirty) {
    return;
  }

  try {
    // Only save active jobs (pending/running)
    const activeJobs: JournalEntry[] = [];
    for (const job of jobs.values()) {
      if (job.state === "pending" || job.state === "running" || job.state === "exiting") {
        activeJobs.push(getJournalEntry(job));
      }
    }

    const journalData: JournalFile = {
      version: PROTOCOL_VERSION,
      updatedAtMs: Date.now(),
      jobs: activeJobs,
    };

    const journalDir = path.dirname(journalPath);
    if (!fs.existsSync(journalDir)) {
      fs.mkdirSync(journalDir, { recursive: true });
    }

    // Write atomically using temp file
    const tempPath = journalPath + ".tmp";
    fs.writeFileSync(tempPath, JSON.stringify(journalData, null, 2));
    fs.renameSync(tempPath, journalPath);

    journalDirty = false;
    log("info", `Journal saved: ${activeJobs.length} active jobs`);
  } catch (err) {
    log("error", `Failed to save journal: ${String(err)}`);
  }
}

function loadJournal(): JournalEntry[] {
  try {
    if (!fs.existsSync(journalPath)) {
      return [];
    }

    const data = fs.readFileSync(journalPath, "utf-8");
    const journal = JSON.parse(data) as JournalFile;

    // Validate version
    if (journal.version > PROTOCOL_VERSION) {
      log("warn", `Journal version ${journal.version} is newer than protocol ${PROTOCOL_VERSION}`);
    }

    // Filter to only return jobs that might still be running
    // (can't know for sure since we don't have the processes)
    const activeJobs = journal.jobs.filter(
      (j) => j.state === "pending" || j.state === "running" || j.state === "exiting",
    );

    log("info", `Journal loaded: ${activeJobs.length} active job entries`);
    return activeJobs;
  } catch (err) {
    log("warn", `Failed to load journal: ${String(err)}`);
    return [];
  }
}

function markJournalDirty(): void {
  journalDirty = true;
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

// Queue for serializing event publishing (ZMQ sockets are not thread-safe)
let eventPublishQueue: Promise<void> = Promise.resolve();

async function publishEvent(event: JobEvent) {
  if (!eventSocket) {
    return;
  }

  // Serialize event publishing to avoid "Socket is busy writing" error
  eventPublishQueue = eventPublishQueue.then(async () => {
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
  });

  return eventPublishQueue;
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

  // v2: Mark journal dirty (job completed, will be removed from journal)
  markJournalDirty();

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

    // v2: Mark journal dirty
    markJournalDirty();

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
    eventsDropped,
  };
}

// v2: Subscribe handler - returns events from a given sequence for backfill
function handleSubscribe(req: ControlRequest & { type: "subscribe" }): SubscribeResponse {
  const { jobId, fromSeq } = req;
  const job = jobs.get(jobId);

  if (!job) {
    return {
      type: "subscribe",
      success: false,
      jobId,
      error: "Job not found",
    };
  }

  const startSeq = fromSeq ?? 0;
  const events: JobEvent[] = [];

  // Build events from ring buffer entries
  for (const entry of job.ringBuffer) {
    if (entry.seq >= startSeq) {
      switch (entry.kind) {
        case "stdout":
          events.push({
            kind: "job.stdout",
            jobId,
            seq: entry.seq,
            ts: entry.ts,
            data: entry.data,
          });
          break;
        case "stderr":
          events.push({
            kind: "job.stderr",
            jobId,
            seq: entry.seq,
            ts: entry.ts,
            data: entry.data,
          });
          break;
        case "started":
          events.push({
            kind: "job.started",
            jobId,
            seq: entry.seq,
            ts: entry.ts,
            pid: job.pid,
            command: job.command,
          });
          break;
        case "exited":
          events.push({
            kind: "job.exited",
            jobId,
            seq: entry.seq,
            ts: entry.ts,
            exitCode: job.exitCode ?? null,
            exitSignal: job.exitSignal ?? null,
            reason: job.terminationReason ?? "exit",
          });
          break;
        case "failed":
          events.push({
            kind: "job.failed",
            jobId,
            seq: entry.seq,
            ts: entry.ts,
            error: job.terminationReason ?? "unknown",
            reason: job.terminationReason ?? "spawn-error",
          });
          break;
      }
    }
  }

  return {
    type: "subscribe",
    success: true,
    jobId,
    currentSeq: job.nextSeq - 1,
    events,
  };
}

// v2: List jobs handler - returns all active jobs for recovery
function handleListJobs(): ListJobsResponse {
  const jobList: ListJobsResponse["jobs"] = [];

  for (const job of jobs.values()) {
    if (job.state === "pending" || job.state === "running" || job.state === "exiting") {
      jobList.push({
        jobId: job.jobId,
        state: job.state,
        lastSeq: job.nextSeq - 1,
        startedAtMs: job.startedAtMs,
      });
    }
  }

  return {
    type: "list-jobs",
    success: true,
    jobs: jobList,
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
    case "subscribe":
      return handleSubscribe(req);
    case "list-jobs":
      return handleListJobs();
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

  // v2: Initialize journal path
  journalPath = config.journalPath;

  // v2: Load journal for recovery
  const journalEntries = loadJournal();
  for (const entry of journalEntries) {
    // Create placeholder job records for recovered jobs
    // These are "orphaned" since we don't have the processes
    // They'll be marked as failed on first poll
    const job: JobRecord = {
      jobId: entry.jobId,
      command: entry.command,
      cwd: entry.cwd,
      pid: entry.pid,
      state: "failed", // Mark as failed since we can't recover the process
      startedAtMs: entry.startedAtMs,
      lastActivityAtMs: Date.now(),
      exitCode: null,
      exitSignal: null,
      terminationReason: "spawn-error", // Supervisor restart
      ringBuffer: [],
      ringBufferBytes: 0,
      nextSeq: entry.lastSeq + 1,
    };
    jobs.set(entry.jobId, job);
    log("info", `Recovered job ${entry.jobId} from journal (marked as failed)`);
  }

  // v2: Reset counters
  eventsDropped = 0;
  _eventQueueSize = 0;

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
  log("info", `Event HWM: ${config.eventHwm}`);
  log("info", `Journal path: ${journalPath}`);

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

  // v2: Start journal flush interval
  const journalInterval = setInterval(saveJournal, config.journalFlushIntervalMs);

  // Start control loop (non-blocking)
  void runControlLoop();

  return {
    stop: async () => {
      clearInterval(cleanupInterval);
      clearInterval(flushInterval);
      clearInterval(journalInterval);

      // v2: Final journal save
      saveJournal();

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
