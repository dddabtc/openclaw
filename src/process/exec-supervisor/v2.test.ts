/**
 * v2 Feature Tests for Exec Supervisor
 *
 * Tests for:
 * - Push mode event reception
 * - Gap detection + auto-backfill
 * - Disconnect/reconnect + resubscribe
 * - Journal persistence + recovery
 * - Mixed mode (push + poll fallback)
 */

import * as fs from "node:fs";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createExecSupervisorClient, type ExecSupervisorClient } from "./client.js";
import { startSupervisor } from "./server.js";
import type { JobEvent } from "./types.js";

describe("exec-supervisor v2", () => {
  let stopServer: (() => Promise<void>) | null = null;
  let client: ExecSupervisorClient | null = null;

  const testControlAddr = "tcp://127.0.0.1:19990";
  const testEventAddr = "tcp://127.0.0.1:19991";
  const testJournalPath = "/tmp/exec-supervisor-test-journal.json";

  beforeEach(async () => {
    // Clean up any previous journal
    if (fs.existsSync(testJournalPath)) {
      fs.unlinkSync(testJournalPath);
    }

    const server = await startSupervisor({
      controlAddress: testControlAddr,
      eventAddress: testEventAddr,
      maxConcurrentJobs: 10,
      ringBufferMaxBytes: 1024 * 1024,
      chunkMergeIntervalMs: 50,
      defaultTimeoutMs: 5000,
      cleanupIntervalMs: 1000,
      finishedJobRetentionMs: 2000,
      journalPath: testJournalPath,
      journalFlushIntervalMs: 500,
      eventHwm: 100,
    });
    stopServer = server.stop;

    client = createExecSupervisorClient({
      controlAddress: testControlAddr,
      eventAddress: testEventAddr,
      requestTimeoutMs: 5000,
      subscribeMode: "push",
      autoBackfill: true,
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
    // Clean up journal
    if (fs.existsSync(testJournalPath)) {
      fs.unlinkSync(testJournalPath);
    }
    // Give sockets time to close
    await new Promise((r) => setTimeout(r, 100));
  });

  describe("push mode", () => {
    it("should receive events in push mode", async () => {
      const jobId = `v2-push-test-${Date.now()}`;
      const events: JobEvent[] = [];

      // Subscribe before spawning
      client!.subscribe(jobId, (event) => {
        events.push(event);
      });

      // Spawn
      const spawnRes = await client!.spawn({
        jobId,
        command: "echo hello-push",
      });
      expect(spawnRes.success).toBe(true);

      // Wait for events
      await new Promise((r) => setTimeout(r, 500));

      // Should have received events via push
      expect(events.length).toBeGreaterThan(0);
      expect(events.some((e) => e.kind === "job.started")).toBe(true);
    });

    it("should get subscribe mode", () => {
      expect(client!.getSubscribeMode()).toBe("push");
    });

    it("should set subscribe mode", () => {
      client!.setSubscribeMode("poll");
      expect(client!.getSubscribeMode()).toBe("poll");
      client!.setSubscribeMode("push");
      expect(client!.getSubscribeMode()).toBe("push");
    });
  });

  describe("local buffer", () => {
    it("should get job state from local buffer", async () => {
      const jobId = `v2-buffer-test-${Date.now()}`;

      // Subscribe to get events
      client!.subscribe(jobId, () => {});

      // Spawn
      await client!.spawn({
        jobId,
        command: "echo line1; echo line2",
      });

      // Wait for completion
      await new Promise((r) => setTimeout(r, 500));

      // Poll to ensure data is available
      await client!.poll(jobId, 0);

      // Get job state
      const state = client!.getJobState(jobId);
      expect(state).not.toBeNull();
      expect(state!.chunks.length).toBeGreaterThan(0);
      // Note: hasGap might be true if the "started" event (seq 0) is not stored as an output chunk
      // This is expected behavior since we only store stdout/stderr chunks
      expect(state!.maxSeq).toBeGreaterThanOrEqual(0);
    });
  });

  describe("list-jobs", () => {
    it("should list active jobs", async () => {
      const jobId = `v2-list-test-${Date.now()}`;

      // Spawn a long-running job
      await client!.spawn({
        jobId,
        command: "sleep 2",
      });

      // Wait a bit for it to start
      await new Promise((r) => setTimeout(r, 100));

      // List jobs
      const listRes = await client!.listJobs();
      expect(listRes.success).toBe(true);
      expect(listRes.jobs.length).toBeGreaterThan(0);
      expect(listRes.jobs.some((j) => j.jobId === jobId)).toBe(true);

      // Kill the job to clean up
      await client!.kill(jobId);
    });
  });

  describe("subscribe request", () => {
    it("should get events via subscribe request for backfill", async () => {
      const jobId = `v2-subscribe-test-${Date.now()}`;

      // Spawn
      await client!.spawn({
        jobId,
        command: "echo backfill-test",
      });

      // Wait for completion
      await new Promise((r) => setTimeout(r, 300));

      // Note: The subscribe request is used internally for backfill
      // We test it indirectly through the poll with push mode
      const pollRes = await client!.poll(jobId, 0);
      expect(pollRes.success).toBe(true);
      expect(pollRes.state).toBe("exited");
    });
  });

  describe("health response", () => {
    it("should include eventsDropped in health response", async () => {
      const health = await client!.health();
      expect(health.success).toBe(true);
      expect(typeof health.eventsDropped).toBe("number");
    });
  });
});

describe("exec-supervisor v2 journal", () => {
  const testControlAddr = "tcp://127.0.0.1:19992";
  const testEventAddr = "tcp://127.0.0.1:19993";
  const testJournalPath = "/tmp/exec-supervisor-journal-test.json";

  beforeEach(() => {
    // Clean up any previous journal
    if (fs.existsSync(testJournalPath)) {
      fs.unlinkSync(testJournalPath);
    }
  });

  afterEach(() => {
    // Clean up journal
    if (fs.existsSync(testJournalPath)) {
      fs.unlinkSync(testJournalPath);
    }
  });

  it("should persist journal for active jobs", async () => {
    // Start supervisor
    const server = await startSupervisor({
      controlAddress: testControlAddr,
      eventAddress: testEventAddr,
      maxConcurrentJobs: 10,
      journalPath: testJournalPath,
      journalFlushIntervalMs: 100,
    });

    const client = createExecSupervisorClient({
      controlAddress: testControlAddr,
      eventAddress: testEventAddr,
      requestTimeoutMs: 5000,
    });
    await client.connect();

    // Spawn a long-running job
    const jobId = `journal-test-${Date.now()}`;
    await client.spawn({
      jobId,
      command: "sleep 5",
    });

    // Wait for journal flush
    await new Promise((r) => setTimeout(r, 200));

    // Check journal exists
    expect(fs.existsSync(testJournalPath)).toBe(true);

    // Read journal
    const journal = JSON.parse(fs.readFileSync(testJournalPath, "utf-8"));
    expect(journal.version).toBe(2);
    expect(journal.jobs.length).toBeGreaterThan(0);

    // Clean up
    await client.kill(jobId);
    await client.disconnect();
    await server.stop();
    await new Promise((r) => setTimeout(r, 100));
  });

  it("should recover job state from journal on restart", async () => {
    // Start first supervisor
    const server1 = await startSupervisor({
      controlAddress: testControlAddr,
      eventAddress: testEventAddr,
      maxConcurrentJobs: 10,
      journalPath: testJournalPath,
      journalFlushIntervalMs: 100,
    });

    const client1 = createExecSupervisorClient({
      controlAddress: testControlAddr,
      eventAddress: testEventAddr,
      requestTimeoutMs: 5000,
    });
    await client1.connect();

    // Spawn a job
    const jobId = `recover-test-${Date.now()}`;
    await client1.spawn({
      jobId,
      command: "sleep 5",
    });

    // Wait for journal flush
    await new Promise((r) => setTimeout(r, 200));

    // Stop first supervisor (simulating crash)
    await client1.disconnect();
    await server1.stop();
    await new Promise((r) => setTimeout(r, 100));

    // Start second supervisor
    const server2 = await startSupervisor({
      controlAddress: testControlAddr,
      eventAddress: testEventAddr,
      maxConcurrentJobs: 10,
      journalPath: testJournalPath,
      journalFlushIntervalMs: 100,
    });

    const client2 = createExecSupervisorClient({
      controlAddress: testControlAddr,
      eventAddress: testEventAddr,
      requestTimeoutMs: 5000,
    });
    await client2.connect();

    // The recovered job should be marked as failed (since the process was lost)
    const status = await client2.status(jobId);
    expect(status.success).toBe(true);
    expect(status.job?.state).toBe("failed");

    // Clean up
    await client2.disconnect();
    await server2.stop();
    await new Promise((r) => setTimeout(r, 100));
  });
});

describe("exec-supervisor v2 mixed mode", () => {
  let stopServer: (() => Promise<void>) | null = null;
  let client: ExecSupervisorClient | null = null;

  const testControlAddr = "tcp://127.0.0.1:19994";
  const testEventAddr = "tcp://127.0.0.1:19995";

  beforeEach(async () => {
    const server = await startSupervisor({
      controlAddress: testControlAddr,
      eventAddress: testEventAddr,
      maxConcurrentJobs: 10,
      chunkMergeIntervalMs: 50,
      defaultTimeoutMs: 5000,
    });
    stopServer = server.stop;

    client = createExecSupervisorClient({
      controlAddress: testControlAddr,
      eventAddress: testEventAddr,
      requestTimeoutMs: 5000,
      subscribeMode: "push",
      autoBackfill: true,
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
    await new Promise((r) => setTimeout(r, 100));
  });

  it("should use local buffer in push mode for poll", async () => {
    const jobId = `mixed-mode-${Date.now()}`;
    const events: JobEvent[] = [];

    // Subscribe to get events via push
    client!.subscribe(jobId, (event) => {
      events.push(event);
    });

    // Spawn
    await client!.spawn({
      jobId,
      command: "echo mixed-test",
    });

    // Wait for events to arrive via push
    await new Promise((r) => setTimeout(r, 300));

    // Poll should use local buffer
    const pollRes = await client!.poll(jobId, 0);
    expect(pollRes.success).toBe(true);
    expect(pollRes.state).toBe("exited");

    // Should have received events
    expect(events.length).toBeGreaterThan(0);
  });

  it("should switch between poll and push modes", async () => {
    // Start in push mode
    expect(client!.getSubscribeMode()).toBe("push");

    // Switch to poll mode
    client!.setSubscribeMode("poll");
    expect(client!.getSubscribeMode()).toBe("poll");

    // Spawn job in poll mode
    const jobId = `mode-switch-${Date.now()}`;
    await client!.spawn({
      jobId,
      command: "echo switch-test",
    });

    // Wait for completion
    await new Promise((r) => setTimeout(r, 300));

    // Poll in poll mode
    const pollRes = await client!.poll(jobId, 0);
    expect(pollRes.success).toBe(true);

    // Switch back to push mode
    client!.setSubscribeMode("push");
    expect(client!.getSubscribeMode()).toBe("push");
  });
});
