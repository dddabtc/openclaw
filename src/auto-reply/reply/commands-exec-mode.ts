/**
 * /exec-mode command handler
 *
 * Allows runtime switching between exec modes:
 * - origin: In-process exec (current implementation)
 * - zmq: Out-of-process exec via ZMQ supervisor
 */

import {
  formatModeStatus,
  getExecModeStatus,
  setExecMode,
  type ExecMode,
} from "../../process/exec-supervisor/index.js";
import type { CommandHandler, CommandHandlerResult } from "./commands-types.js";

/**
 * Handle /exec-mode command
 */
export const handleExecModeCommand: CommandHandler = async (
  params,
  allowTextCommands,
): Promise<CommandHandlerResult | null> => {
  if (!allowTextCommands) {
    return null;
  }

  const { command } = params;
  const normalized = command.commandBodyNormalized;

  // Check if this is an exec-mode command
  const match = normalized.match(/^\/(exec-mode|execmode)(?:\s+(.+))?$/i);
  if (!match) {
    return null;
  }

  // Only authorized senders can change exec mode
  if (!command.isAuthorizedSender) {
    return { shouldContinue: false };
  }

  const arg = match[2]?.trim().toLowerCase();

  // If no argument, show current status
  if (!arg) {
    const status = await getExecModeStatus();
    const text = formatModeStatus(status);

    return {
      shouldContinue: false,
      reply: { text },
    };
  }

  // Validate mode
  if (arg !== "origin" && arg !== "zmq") {
    return {
      shouldContinue: false,
      reply: {
        text: `Invalid exec mode "${arg}". Valid modes: origin, zmq`,
      },
    };
  }

  // Attempt to set mode
  const result = await setExecMode(arg as ExecMode);

  if (result.success) {
    const status = await getExecModeStatus();
    const statusText = formatModeStatus(status);

    return {
      shouldContinue: false,
      reply: {
        text: `Exec mode changed: ${result.previousMode} → ${result.currentMode}\n\n${statusText}`,
      },
    };
  }

  return {
    shouldContinue: false,
    reply: {
      text: `Failed to switch exec mode: ${result.error}`,
    },
  };
};
