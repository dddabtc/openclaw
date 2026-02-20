import { performance } from "node:perf_hooks";
import { dispatchReplyFromConfig } from "../src/auto-reply/reply/dispatch-from-config.js";
import type { ReplyDispatcher } from "../src/auto-reply/reply/reply-dispatcher.js";
import { buildTestCtx } from "../src/auto-reply/reply/test-ctx.js";
import type { OpenClawConfig } from "../src/config/config.js";

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].toSorted((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

async function run() {
  const cfg = {} as OpenClawConfig;
  const ack: number[] = [];
  const status: number[] = [];
  const dispatch: number[] = [];

  for (let round = 0; round < 5; round += 1) {
    const jobs: Promise<void>[] = [];
    for (let i = 0; i < 5; i += 1) {
      jobs.push(
        (async () => {
          const t0 = performance.now();
          const marks: number[] = [];
          const dispatcher: ReplyDispatcher = {
            sendToolResult: () => true,
            sendBlockReply: () => true,
            sendFinalReply: () => {
              marks.push(performance.now());
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
          if (marks.length >= 1) {
            ack.push(marks[0] - t0);
          }
          if (marks.length >= 2) {
            dispatch.push(marks[1] - marks[0]);
          }
        })(),
      );
      jobs.push(
        (async () => {
          const t0 = performance.now();
          const dispatcher: ReplyDispatcher = {
            sendToolResult: () => true,
            sendBlockReply: () => true,
            sendFinalReply: () => true,
            waitForIdle: async () => {},
            getQueuedCounts: () => ({ tool: 0, block: 0, final: 1 }),
            markComplete: () => {},
          };
          await dispatchReplyFromConfig({
            ctx: buildTestCtx({ Body: "/status", CommandBody: "/status", CommandAuthorized: true }),
            cfg,
            dispatcher,
          });
          status.push(performance.now() - t0);
        })(),
      );
    }
    await Promise.all(jobs);
  }

  const ackP95 = percentile(ack, 95);
  const statusP95 = percentile(status, 95);
  const dispatchP95 = percentile(dispatch, 95);

  console.log(
    JSON.stringify(
      {
        rounds: 5,
        samples: { ack: ack.length, status: status.length, dispatch: dispatch.length },
        p95: { ackMs: ackP95, statusMs: statusP95, stopDispatchMs: dispatchP95 },
        pass: {
          ack: ackP95 < 200,
          status: statusP95 < 500,
          dispatch: dispatchP95 < 2000,
        },
      },
      null,
      2,
    ),
  );
}

void run();
