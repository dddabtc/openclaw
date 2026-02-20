import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { maybeHandleControlPlaneCommand, matchStrictControlCommand } from "./control-plane.js";
import type { ReplyDispatcher } from "./reply/reply-dispatcher.js";
import { buildTestCtx } from "./reply/test-ctx.js";

const abortMock = vi.hoisted(() =>
  vi.fn(async () => ({ handled: true, aborted: true, stoppedSubagents: 0 })),
);

vi.mock("./reply/abort.js", async () => {
  const actual = await vi.importActual<typeof import("./reply/abort.js")>("./reply/abort.js");
  return {
    ...actual,
    tryFastAbortFromMessage: abortMock,
  };
});

function createDispatcher(): ReplyDispatcher {
  return {
    sendToolResult: vi.fn(() => true),
    sendBlockReply: vi.fn(() => true),
    sendFinalReply: vi.fn(() => true),
    waitForIdle: vi.fn(async () => {}),
    getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    markComplete: vi.fn(),
  };
}

describe("control plane strict matching", () => {
  it("matches only full /stop or /status forms", () => {
    expect(matchStrictControlCommand(" /stop ")?.command).toBe("stop");
    expect(matchStrictControlCommand("/status@openclaw")?.command).toBe("status");
    expect(matchStrictControlCommand("hello /stop")).toBeNull();
    expect(matchStrictControlCommand("/status now")).toBeNull();
    expect(matchStrictControlCommand("/stop\nnext")).toBeNull();
  });
});

describe("maybeHandleControlPlaneCommand", () => {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  beforeEach(() => {
    abortMock.mockClear();
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  });

  it("handles /stop in control plane and sends ack before final", async () => {
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Body: "/stop",
      CommandBody: "/stop",
      CommandAuthorized: true,
    });

    const result = await maybeHandleControlPlaneCommand({
      ctx,
      cfg: {} as OpenClawConfig,
      dispatcher,
    });

    expect(result.handled).toBe(true);
    expect(abortMock).toHaveBeenCalledTimes(1);
    const calls = (dispatcher.sendFinalReply as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(String(calls[0]?.[0]?.text ?? "")).toContain("Stopping...");
  });

  it("does not handle non-full matches", async () => {
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Body: "please /stop",
      CommandBody: "please /stop",
      CommandAuthorized: true,
    });

    const result = await maybeHandleControlPlaneCommand({
      ctx,
      cfg: {} as OpenClawConfig,
      dispatcher,
    });
    expect(result.handled).toBe(false);
    expect(abortMock).not.toHaveBeenCalled();
  });

  it("supports abortable control waits", async () => {
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Body: "/stop", CommandBody: "/stop", CommandAuthorized: true });
    const ac = new AbortController();
    ac.abort();

    const result = await maybeHandleControlPlaneCommand({
      ctx,
      cfg: {} as OpenClawConfig,
      dispatcher,
      signal: ac.signal,
    });

    expect(result.handled).toBe(true);
    const calls = (dispatcher.sendFinalReply as ReturnType<typeof vi.fn>).mock.calls;
    expect(String(calls[calls.length - 1]?.[0]?.text ?? "")).toContain("aborted");
  });

  it("replays non-terminal commands into recovered terminal event", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-control-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const agentDir = path.join(stateDir, "agents", "main");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "control-queue.jsonl"),
      `${JSON.stringify({ commandId: "cmd_pending" })}\n`,
      "utf8",
    );

    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Body: "/status", CommandBody: "/status", CommandAuthorized: true });
    await maybeHandleControlPlaneCommand({ ctx, cfg: {} as OpenClawConfig, dispatcher });

    const events = fs.readFileSync(path.join(agentDir, "control-events.jsonl"), "utf8");
    expect(events).toContain("TIMED_OUT_RECOVERED");
  });
});
