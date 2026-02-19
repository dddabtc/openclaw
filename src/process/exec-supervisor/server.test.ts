import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as zmq from "zeromq";
import { startSupervisor } from "./server.js";
import type {
  HealthResponse,
  SpawnResponse,
  PollResponse,
  KillResponse,
  StatusResponse,
} from "./types.js";

describe("exec-supervisor server", () => {
  let stopServer: (() => Promise<void>) | null = null;
  let controlSocket: zmq.Request | null = null;

  const testControlAddr = "tcp://127.0.0.1:19790";
  const testEventAddr = "tcp://127.0.0.1:19791";

  beforeEach(async () => {
    const server = await startSupervisor({
      controlAddress: testControlAddr,
      eventAddress: testEventAddr,
      maxConcurrentJobs: 10,
      ringBufferMaxBytes: 1024 * 1024,
      chunkMergeIntervalMs: 50,
      defaultTimeoutMs: 5000,
      cleanupIntervalMs: 1000,
      finishedJobRetentionMs: 2000,
    });
    stopServer = server.stop;

    controlSocket = new zmq.Request();
    controlSocket.connect(testControlAddr);
  });

  afterEach(async () => {
    if (controlSocket) {
      controlSocket.close();
      controlSocket = null;
    }
    if (stopServer) {
      await stopServer();
      stopServer = null;
    }
    // Give sockets time to close
    await new Promise((r) => setTimeout(r, 100));
  });

  async function sendRequest<T>(req: unknown): Promise<T> {
    await controlSocket!.send(JSON.stringify(req));
    const [msg] = await controlSocket!.receive();
    return JSON.parse(msg.toString()) as T;
  }

  it("should respond to health check", async () => {
    const res = await sendRequest<HealthResponse>({ type: "health" });
    expect(res.type).toBe("health");
    expect(res.success).toBe(true);
    expect(res.activeJobs).toBe(0);
    expect(typeof res.uptime).toBe("number");
    expect(typeof res.memoryUsageMB).toBe("number");
  });

  it("should spawn a job and poll output", async () => {
    const jobId = `test-job-${Date.now()}`;

    // Spawn
    const spawnRes = await sendRequest<SpawnResponse>({
      type: "spawn",
      jobId,
      command: "echo hello",
    });
    expect(spawnRes.success).toBe(true);
    expect(spawnRes.jobId).toBe(jobId);
    expect(typeof spawnRes.pid).toBe("number");

    // Wait for output
    await new Promise((r) => setTimeout(r, 300));

    // Poll
    const pollRes = await sendRequest<PollResponse>({
      type: "poll",
      jobId,
      cursor: 0,
    });
    expect(pollRes.success).toBe(true);
    expect(pollRes.state).toBe("exited");

    // Check output contains "hello"
    const output = pollRes.chunks.map((c) => c.data).join("");
    expect(output).toContain("hello");
  });

  it("should reject duplicate job ids", async () => {
    const jobId = `test-dup-${Date.now()}`;

    // First spawn
    const res1 = await sendRequest<SpawnResponse>({
      type: "spawn",
      jobId,
      command: "sleep 1",
    });
    expect(res1.success).toBe(true);

    // Second spawn with same id
    const res2 = await sendRequest<SpawnResponse>({
      type: "spawn",
      jobId,
      command: "echo test",
    });
    expect(res2.success).toBe(false);
    expect(res2.error).toContain("already exists");
  });

  it("should kill a running job", async () => {
    const jobId = `test-kill-${Date.now()}`;

    // Spawn long-running command
    const spawnRes = await sendRequest<SpawnResponse>({
      type: "spawn",
      jobId,
      command: "sleep 10",
    });
    expect(spawnRes.success).toBe(true);

    // Wait a bit for process to start
    await new Promise((r) => setTimeout(r, 100));

    // Kill
    const killRes = await sendRequest<KillResponse>({
      type: "kill",
      jobId,
    });
    expect(killRes.success).toBe(true);

    // Wait for process to exit
    await new Promise((r) => setTimeout(r, 200));

    // Check status
    const pollRes = await sendRequest<PollResponse>({
      type: "poll",
      jobId,
      cursor: 0,
    });
    expect(["exited", "failed"]).toContain(pollRes.state);
  });

  it("should return job status", async () => {
    const jobId = `test-status-${Date.now()}`;

    // Spawn
    await sendRequest<SpawnResponse>({
      type: "spawn",
      jobId,
      command: "echo test",
    });

    // Wait for completion
    await new Promise((r) => setTimeout(r, 200));

    // Get status
    const statusRes = await sendRequest<StatusResponse>({
      type: "status",
      jobId,
    });
    expect(statusRes.success).toBe(true);
    expect(statusRes.job?.jobId).toBe(jobId);
    expect(statusRes.job?.state).toBe("exited");
  });

  it("should return all jobs status", async () => {
    const jobId1 = `test-all-1-${Date.now()}`;
    const jobId2 = `test-all-2-${Date.now()}`;

    // Spawn two jobs
    await sendRequest<SpawnResponse>({
      type: "spawn",
      jobId: jobId1,
      command: "echo 1",
    });
    await sendRequest<SpawnResponse>({
      type: "spawn",
      jobId: jobId2,
      command: "echo 2",
    });

    // Wait for completion
    await new Promise((r) => setTimeout(r, 200));

    // Get all status
    const statusRes = await sendRequest<StatusResponse>({
      type: "status",
    });
    expect(statusRes.success).toBe(true);
    expect(Array.isArray(statusRes.jobs)).toBe(true);
    expect(statusRes.jobs!.length).toBeGreaterThanOrEqual(2);
  });

  it("should handle timeout", async () => {
    const jobId = `test-timeout-${Date.now()}`;

    // Spawn with short timeout
    const spawnRes = await sendRequest<SpawnResponse>({
      type: "spawn",
      jobId,
      command: "sleep 10",
      timeoutMs: 500,
    });
    expect(spawnRes.success).toBe(true);

    // Wait for timeout
    await new Promise((r) => setTimeout(r, 800));

    // Check status - should be failed with timeout reason
    const pollRes = await sendRequest<PollResponse>({
      type: "poll",
      jobId,
      cursor: 0,
    });
    expect(pollRes.state).toBe("failed");
    expect(pollRes.terminationReason).toBe("timeout");
  });

  it("should capture stderr output", async () => {
    const jobId = `test-stderr-${Date.now()}`;

    // Spawn command that writes to stderr
    const spawnRes = await sendRequest<SpawnResponse>({
      type: "spawn",
      jobId,
      command: "echo error >&2",
    });
    expect(spawnRes.success).toBe(true);

    // Wait for output
    await new Promise((r) => setTimeout(r, 200));

    // Poll
    const pollRes = await sendRequest<PollResponse>({
      type: "poll",
      jobId,
      cursor: 0,
    });
    expect(pollRes.success).toBe(true);

    // Check stderr output
    const stderrChunks = pollRes.chunks.filter((c) => c.kind === "stderr");
    expect(stderrChunks.length).toBeGreaterThan(0);
    expect(stderrChunks.map((c) => c.data).join("")).toContain("error");
  });

  it("should handle poll with cursor for incremental output", async () => {
    const jobId = `test-cursor-${Date.now()}`;

    // Spawn
    await sendRequest<SpawnResponse>({
      type: "spawn",
      jobId,
      command: "echo line1; sleep 0.1; echo line2",
    });

    // Wait for completion
    await new Promise((r) => setTimeout(r, 400));

    // First poll
    const poll1 = await sendRequest<PollResponse>({
      type: "poll",
      jobId,
      cursor: 0,
    });
    expect(poll1.success).toBe(true);
    const cursor1 = poll1.cursor;

    // Second poll with cursor - should return no new chunks
    const poll2 = await sendRequest<PollResponse>({
      type: "poll",
      jobId,
      cursor: cursor1,
    });
    expect(poll2.success).toBe(true);
    expect(poll2.chunks.length).toBe(0);
  });
});
