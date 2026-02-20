import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { dispatchReplyFromConfig } from "../src/auto-reply/reply/dispatch-from-config.js";
import type { ReplyDispatcher } from "../src/auto-reply/reply/reply-dispatcher.js";
import { buildTestCtx } from "../src/auto-reply/reply/test-ctx.js";
import type { OpenClawConfig } from "../src/config/config.js";
import { resolveStateDir } from "../src/config/paths.js";

type Sample = { ms: number; timedOut: boolean };

type RoundStats = {
  round: number;
  stopAck: { meanMs: number; p95Ms: number; maxMs: number; timeouts: number; samples: number };
  stopTotal: { meanMs: number; p95Ms: number; maxMs: number; timeouts: number; samples: number };
  status: { meanMs: number; p95Ms: number; maxMs: number; timeouts: number; samples: number };
  collectiveTimeoutBurst: boolean;
};

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].toSorted((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

function summarize(samples: Sample[]) {
  const values = samples.map((s) => s.ms);
  const timeouts = samples.filter((s) => s.timedOut).length;
  return {
    meanMs: mean(values),
    p95Ms: percentile(values, 95),
    maxMs: values.length > 0 ? Math.max(...values) : 0,
    timeouts,
    samples: samples.length,
  };
}

function tailJsonl(filePath: string, fromLine: number): unknown[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const lines = fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  return lines.slice(fromLine).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { __raw: line };
    }
  });
}

function lineCount(filePath: string): number {
  if (!fs.existsSync(filePath)) {
    return 0;
  }
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0).length;
}

async function run() {
  const rounds = Math.max(10, Number.parseInt(process.env.ROUNDS ?? "10", 10) || 10);
  const stopPerRound = 5;
  const statusPerRound = 5;

  const cfg = {} as OpenClawConfig;
  const stopAck: Sample[] = [];
  const stopTotal: Sample[] = [];
  const status: Sample[] = [];
  const perRound: RoundStats[] = [];

  const stateDir = resolveStateDir();
  const adapterLog = path.join(stateDir, "adapters", "whatsapp", "command-log.jsonl");
  const queueLog = path.join(stateDir, "agents", "main", "control-queue.jsonl");
  const eventsLog = path.join(stateDir, "agents", "main", "control-events.jsonl");
  const stateFile = path.join(stateDir, "agents", "main", "control-state.json");

  const adapterStart = lineCount(adapterLog);
  const queueStart = lineCount(queueLog);
  const eventsStart = lineCount(eventsLog);

  for (let round = 1; round <= rounds; round += 1) {
    const roundStopAck: Sample[] = [];
    const roundStopTotal: Sample[] = [];
    const roundStatus: Sample[] = [];
    const jobs: Promise<void>[] = [];

    for (let i = 0; i < stopPerRound; i += 1) {
      jobs.push(
        (async () => {
          const t0 = performance.now();
          const marks: number[] = [];
          const finalTexts: string[] = [];
          const dispatcher: ReplyDispatcher = {
            sendToolResult: () => true,
            sendBlockReply: () => true,
            sendFinalReply: (payload) => {
              marks.push(performance.now());
              if (typeof payload?.text === "string") {
                finalTexts.push(payload.text);
              }
              return true;
            },
            waitForIdle: async () => {},
            getQueuedCounts: () => ({ tool: 0, block: 0, final: marks.length }),
            markComplete: () => {},
          };
          await dispatchReplyFromConfig({
            ctx: buildTestCtx({ Body: "/stop", CommandBody: "/stop", CommandAuthorized: true }),
            cfg,
            dispatcher,
          });

          if (marks.length > 0) {
            roundStopAck.push({ ms: marks[0] - t0, timedOut: false });
          }
          const totalMs = performance.now() - t0;
          const timedOut = finalTexts.some((t) => /timeout/i.test(t));
          roundStopTotal.push({ ms: totalMs, timedOut });
        })(),
      );
    }

    for (let i = 0; i < statusPerRound; i += 1) {
      jobs.push(
        (async () => {
          const t0 = performance.now();
          let finalText = "";
          const dispatcher: ReplyDispatcher = {
            sendToolResult: () => true,
            sendBlockReply: () => true,
            sendFinalReply: (payload) => {
              finalText = String(payload?.text ?? "");
              return true;
            },
            waitForIdle: async () => {},
            getQueuedCounts: () => ({ tool: 0, block: 0, final: 1 }),
            markComplete: () => {},
          };
          await dispatchReplyFromConfig({
            ctx: buildTestCtx({ Body: "/status", CommandBody: "/status", CommandAuthorized: true }),
            cfg,
            dispatcher,
          });

          roundStatus.push({ ms: performance.now() - t0, timedOut: /timeout/i.test(finalText) });
        })(),
      );
    }

    await Promise.all(jobs);

    stopAck.push(...roundStopAck);
    stopTotal.push(...roundStopTotal);
    status.push(...roundStatus);

    const s1 = summarize(roundStopAck);
    const s2 = summarize(roundStopTotal);
    const s3 = summarize(roundStatus);
    const collectiveTimeoutBurst = s2.timeouts + s3.timeouts >= 5;

    perRound.push({
      round,
      stopAck: s1,
      stopTotal: s2,
      status: s3,
      collectiveTimeoutBurst,
    });
  }

  const adapterRecords = tailJsonl(adapterLog, adapterStart) as Array<Record<string, unknown>>;
  const queueRecords = tailJsonl(queueLog, queueStart) as Array<Record<string, unknown>>;
  const eventRecords = tailJsonl(eventsLog, eventsStart) as Array<Record<string, unknown>>;

  const eventTypeCount = eventRecords.reduce<Record<string, number>>((acc, r) => {
    const eventType = r.type;
    const k = typeof eventType === "string" && eventType.trim().length > 0 ? eventType : "unknown";
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});

  const adapterReceived = adapterRecords.filter((r) => r.type === "RECEIVED").length;
  const queueStop = queueRecords.filter((r) => r.normalized === "/stop").length;
  const doneEvents = (eventTypeCount.DONE ?? 0) > 0;
  const ackEvents = (eventTypeCount.ACK_SENT ?? 0) > 0;

  const overall = {
    stopAck: summarize(stopAck),
    stopTotal: summarize(stopTotal),
    status: summarize(status),
  };
  const collectiveTimeoutBurst = perRound.some((r) => r.collectiveTimeoutBurst);

  const slo = {
    ackP95Lt200: overall.stopAck.p95Ms < 200,
    statusP95Lt500: overall.status.p95Ms < 500,
    stopTotalP95Lt2000: overall.stopTotal.p95Ms < 2000,
  };

  const result = {
    rounds,
    scenario: {
      perRound: { stop: stopPerRound, status: statusPerRound, mode: "concurrent" },
      rateLimitContext: "same adapter+agent path, write/read mixed",
      stateDir,
    },
    perRound,
    overall,
    collectiveTimeoutBurst,
    controlPlaneEvidence: {
      files: { adapterLog, queueLog, eventsLog, stateFile },
      deltas: {
        adapterRecords: adapterRecords.length,
        queueRecords: queueRecords.length,
        eventRecords: eventRecords.length,
      },
      checks: {
        adapterReceived,
        queueStop,
        eventTypeCount,
        hasAckSent: ackEvents,
        hasDone: doneEvents,
        stateFileExists: fs.existsSync(stateFile),
      },
      verified:
        adapterReceived > 0 && queueStop > 0 && ackEvents && doneEvents && fs.existsSync(stateFile),
    },
    slo,
    pass: Object.values(slo).every(Boolean) && !collectiveTimeoutBurst,
    host: os.hostname(),
  };

  console.log(JSON.stringify(result, null, 2));
}

void run();
