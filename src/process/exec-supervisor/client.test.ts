import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createExecSupervisorClient, type ExecSupervisorClient } from "./client.js";
import { startSupervisor } from "./server.js";

describe("exec-supervisor client", () => {
  let stopServer: (() => Promise<void>) | null = null;
  let client: ExecSupervisorClient | null = null;

  const testControlAddr = "tcp://127.0.0.1:19890";
  const testEventAddr = "tcp://127.0.0.1:19891";

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

    client = createExecSupervisorClient({
      controlAddress: testControlAddr,
      eventAddress: testEventAddr,
      requestTimeoutMs: 5000,
    });
    await client.connect();
  });

  afterEach(async () => {
    if (client) {
      await client.disconnect();
      client = null;
    }
    if (stopServer) {
      await stopServer();
      stopServer = null;
    }
    // Give sockets time to close
    await new Promise((r) => setTimeout(r, 100));
  });

  it("should check health", async () => {
    const healthy = await client!.isHealthy();
    expect(healthy).toBe(true);
  });

  it("should get health details", async () => {
    const health = await client!.health();
    expect(health.success).toBe(true);
    expect(health.activeJobs).toBe(0);
    expect(typeof health.uptime).toBe("number");
  });

  it("should spawn and poll a job", async () => {
    const jobId = `client-test-${Date.now()}`;

    const spawnRes = await client!.spawn({
      jobId,
      command: "echo hello world",
    });
    expect(spawnRes.success).toBe(true);
    expect(spawnRes.pid).toBeDefined();

    // Wait for completion
    await new Promise((r) => setTimeout(r, 300));

    const pollRes = await client!.poll(jobId);
    expect(pollRes.success).toBe(true);
    expect(pollRes.state).toBe("exited");

    // Check output
    const output = pollRes.chunks.map((c) => c.data).join("");
    expect(output).toContain("hello world");
  });

  it("should kill a running job", async () => {
    const jobId = `client-kill-${Date.now()}`;

    await client!.spawn({
      jobId,
      command: "sleep 30",
    });

    await new Promise((r) => setTimeout(r, 100));

    const killRes = await client!.kill(jobId);
    expect(killRes.success).toBe(true);

    await new Promise((r) => setTimeout(r, 200));

    const pollRes = await client!.poll(jobId);
    expect(["exited", "failed"]).toContain(pollRes.state);
  });

  it("should get job status", async () => {
    const jobId = `client-status-${Date.now()}`;

    await client!.spawn({
      jobId,
      command: "echo test",
    });

    await new Promise((r) => setTimeout(r, 200));

    const statusRes = await client!.status(jobId);
    expect(statusRes.success).toBe(true);
    expect(statusRes.job?.jobId).toBe(jobId);
  });

  it("should deduplicate chunks from poll", async () => {
    const jobId = `client-dedup-${Date.now()}`;

    await client!.spawn({
      jobId,
      command: "echo test",
    });

    await new Promise((r) => setTimeout(r, 200));

    // First poll
    const poll1 = await client!.poll(jobId, 0);
    const chunks1 = poll1.chunks;

    // Second poll from same cursor should return no new chunks (deduplicated)
    const poll2 = await client!.poll(jobId, 0);
    expect(poll2.chunks.length).toBe(0);

    // But getOutput should return all chunks
    const allOutput = client!.getOutput(jobId, 0);
    expect(allOutput.length).toBeGreaterThanOrEqual(chunks1.length);
  });

  it("should subscribe to events", async () => {
    const jobId = `client-events-${Date.now()}`;
    const events: string[] = [];

    // Subscribe before spawning
    const unsub = client!.subscribe(jobId, (event) => {
      events.push(event.kind);
    });

    // Spawn
    await client!.spawn({
      jobId,
      command: "echo event-test",
    });

    // Wait for events
    await new Promise((r) => setTimeout(r, 500));

    // Should have received events
    expect(events.length).toBeGreaterThan(0);
    expect(events).toContain("job.started");

    unsub();
  });

  it("should getOutput with startSeq filter", async () => {
    const jobId = `client-output-${Date.now()}`;

    await client!.spawn({
      jobId,
      command: "echo line1; echo line2; echo line3",
    });

    await new Promise((r) => setTimeout(r, 300));

    // Poll to populate local state
    await client!.poll(jobId, 0);

    // Get all output
    const allOutput = client!.getOutput(jobId, 0);
    expect(allOutput.length).toBeGreaterThan(0);

    // Get output from a higher seq
    if (allOutput.length > 1) {
      const partialOutput = client!.getOutput(jobId, allOutput[1].seq);
      expect(partialOutput.length).toBeLessThan(allOutput.length);
    }
  });
});
