import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveSessionAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveCommandAuthorization } from "./command-auth.js";
import { formatAbortReplyText, tryFastAbortFromMessage } from "./reply/abort.js";
import type { ReplyDispatcher } from "./reply/reply-dispatcher.js";
import type { FinalizedMsgContext } from "./templating.js";

export const STRICT_CONTROL_COMMAND_RE = /^\/(stop|status)(?:@[\w_]+)?$/i;

type ControlCommand = "stop" | "status";

type ControlEnvelope = {
  commandId: string;
  seq: number;
  agentId: string;
  adapter: string;
  chatId?: string;
  senderId?: string;
  sessionId?: string;
  normalized: `/${ControlCommand}`;
  raw: string;
  ingressAt: string;
  deadlineMs: number;
};

type ControlState = {
  lastCommandId?: string;
  lastCommand?: string;
  status?: "queued" | "ack_sent" | "done" | "failed" | "timed_out";
  updatedAt?: string;
  lastResult?: string;
};

export function matchStrictControlCommand(
  raw?: string,
): { command: ControlCommand; rawTrimmed: string } | null {
  const rawTrimmed = String(raw ?? "").trim();
  if (!rawTrimmed) {
    return null;
  }
  const m = rawTrimmed.match(STRICT_CONTROL_COMMAND_RE);
  if (!m) {
    return null;
  }
  const command = m[1]?.toLowerCase();
  if (command !== "stop" && command !== "status") {
    return null;
  }
  return { command, rawTrimmed };
}

function appendJsonl(filePath: string, record: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

class AdapterCommandLogWriter {
  constructor(
    private readonly adapter: string,
    private readonly stateDir: string,
  ) {}
  write(record: unknown): void {
    appendJsonl(path.join(this.stateDir, "adapters", this.adapter, "command-log.jsonl"), record);
  }
}

class AgentControlIngressWriter {
  constructor(
    private readonly agentId: string,
    private readonly stateDir: string,
  ) {}
  appendQueue(record: unknown): void {
    appendJsonl(path.join(this.stateDir, "agents", this.agentId, "control-queue.jsonl"), record);
  }
}

class AgentControlExecutorWriter {
  constructor(
    private readonly agentId: string,
    private readonly stateDir: string,
  ) {}
  appendEvent(record: unknown): void {
    appendJsonl(path.join(this.stateDir, "agents", this.agentId, "control-events.jsonl"), record);
  }
  writeState(state: ControlState): void {
    const filePath = path.join(this.stateDir, "agents", this.agentId, "control-state.json");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
  }
  readState(): ControlState {
    const filePath = path.join(this.stateDir, "agents", this.agentId, "control-state.json");
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8")) as ControlState;
    } catch {
      return {};
    }
  }
}

function shortCommandId(commandId: string): string {
  return commandId.slice(-6);
}

let globalSeq = 0;

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ ok: true; value: T } | { ok: false; reason: "timeout" | "aborted" }> {
  if (signal?.aborted) {
    return { ok: false, reason: "aborted" };
  }
  return await new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ ok: false as const, reason: "timeout" as const }),
      timeoutMs,
    );
    const onAbort = () => {
      clearTimeout(timer);
      resolve({ ok: false as const, reason: "aborted" as const });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    void promise
      .then((value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve({ ok: true as const, value });
      })
      .catch(() => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve({ ok: false as const, reason: "timeout" as const });
      });
  });
}

function recoverNonTerminalCommands(agentId: string, stateDir: string): void {
  const queueFile = path.join(stateDir, "agents", agentId, "control-queue.jsonl");
  const eventsFile = path.join(stateDir, "agents", agentId, "control-events.jsonl");
  if (!fs.existsSync(queueFile)) {
    return;
  }
  const queueLines = fs
    .readFileSync(queueFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { commandId?: string });
  const terminal = new Set<string>();
  if (fs.existsSync(eventsFile)) {
    for (const line of fs.readFileSync(eventsFile, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) {
        continue;
      }
      const evt = JSON.parse(t) as { commandId?: string; type?: string };
      if (
        evt.commandId &&
        ["DONE", "FAILED", "TIMED_OUT", "TIMED_OUT_RECOVERED"].includes(String(evt.type))
      ) {
        terminal.add(evt.commandId);
      }
    }
  }
  const execWriter = new AgentControlExecutorWriter(agentId, stateDir);
  for (const item of queueLines) {
    if (!item.commandId || terminal.has(item.commandId)) {
      continue;
    }
    execWriter.appendEvent({
      eventId: `evt_${crypto.randomUUID()}`,
      commandId: item.commandId,
      agentId,
      type: "TIMED_OUT_RECOVERED",
      at: new Date().toISOString(),
      data: { reason: "startup_recovery" },
    });
  }
}

export async function maybeHandleControlPlaneCommand(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  signal?: AbortSignal;
}): Promise<{ handled: boolean }> {
  const { ctx, cfg, dispatcher, signal } = params;
  const matched = matchStrictControlCommand(ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "");
  if (!matched) {
    return { handled: false };
  }

  const auth = resolveCommandAuthorization({ ctx, cfg, commandAuthorized: ctx.CommandAuthorized });

  const adapter = String(ctx.Surface ?? ctx.Provider ?? "unknown").toLowerCase();
  const agentId = resolveSessionAgentId({ sessionKey: ctx.SessionKey ?? "", config: cfg });
  const stateDir = resolveStateDir();
  recoverNonTerminalCommands(agentId, stateDir);

  const commandId = `cmd_${crypto.randomUUID()}`;
  const seq = ++globalSeq;
  const now = new Date().toISOString();
  const envelope: ControlEnvelope = {
    commandId,
    seq,
    agentId,
    adapter,
    chatId: ctx.To ?? ctx.From,
    senderId: auth.senderId,
    sessionId: ctx.SessionKey,
    normalized: `/${matched.command}`,
    raw: matched.rawTrimmed,
    ingressAt: now,
    deadlineMs: matched.command === "status" ? 1000 : 3000,
  };

  const adapterWriter = new AdapterCommandLogWriter(adapter, stateDir);
  const ingressWriter = new AgentControlIngressWriter(agentId, stateDir);
  const execWriter = new AgentControlExecutorWriter(agentId, stateDir);

  adapterWriter.write({ type: "RECEIVED", at: now, commandId, raw: matched.rawTrimmed });

  if (matched.command === "status") {
    const statusResult = await withTimeout(Promise.resolve(execWriter.readState()), 1000, signal);
    const text = statusResult.ok
      ? `Status#${shortCommandId(commandId)}: ${statusResult.value.status ?? "idle"}`
      : `Status#${shortCommandId(commandId)}: timeout`;
    dispatcher.sendFinalReply({ text });
    execWriter.appendEvent({
      eventId: `evt_${crypto.randomUUID()}`,
      commandId,
      seq,
      agentId,
      type: "DONE",
      at: new Date().toISOString(),
      data: { fastPath: true, status: statusResult.ok ? "ok" : statusResult.reason },
    });
    return { handled: true };
  }

  ingressWriter.appendQueue(envelope);
  execWriter.appendEvent({
    eventId: `evt_${crypto.randomUUID()}`,
    commandId,
    seq,
    agentId,
    type: "ENQUEUED",
    at: new Date().toISOString(),
  });
  execWriter.writeState({
    lastCommandId: commandId,
    lastCommand: matched.command,
    status: "queued",
    updatedAt: new Date().toISOString(),
  });

  const ack = await withTimeout(
    Promise.resolve(
      dispatcher.sendFinalReply({ text: `Stopping... [#${shortCommandId(commandId)}]` }),
    ),
    1000,
    signal,
  );
  execWriter.appendEvent({
    eventId: `evt_${crypto.randomUUID()}`,
    commandId,
    seq,
    agentId,
    type: "ACK_SENT",
    at: new Date().toISOString(),
    data: { ok: ack.ok },
  });

  const dispatch = await withTimeout(tryFastAbortFromMessage({ ctx, cfg }), 3000, signal);
  if (!dispatch.ok) {
    dispatcher.sendFinalReply({
      text: `Stop failed [#${shortCommandId(commandId)}]: ${dispatch.reason}`,
    });
    execWriter.appendEvent({
      eventId: `evt_${crypto.randomUUID()}`,
      commandId,
      seq,
      agentId,
      type: "TIMED_OUT",
      at: new Date().toISOString(),
      data: { phase: "dispatch", reason: dispatch.reason },
    });
    execWriter.writeState({
      lastCommandId: commandId,
      lastCommand: matched.command,
      status: "timed_out",
      updatedAt: new Date().toISOString(),
      lastResult: dispatch.reason,
    });
    return { handled: true };
  }

  const finalText = formatAbortReplyText(dispatch.value.stoppedSubagents);
  dispatcher.sendFinalReply({ text: `${finalText} [#${shortCommandId(commandId)}]` });
  execWriter.appendEvent({
    eventId: `evt_${crypto.randomUUID()}`,
    commandId,
    seq,
    agentId,
    type: "DONE",
    at: new Date().toISOString(),
  });
  execWriter.writeState({
    lastCommandId: commandId,
    lastCommand: matched.command,
    status: "done",
    updatedAt: new Date().toISOString(),
    lastResult: finalText,
  });
  return { handled: true };
}
