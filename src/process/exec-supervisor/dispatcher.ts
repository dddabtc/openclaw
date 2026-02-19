/**
 * Exec Mode Dispatcher
 *
 * Handles runtime switching between origin (in-process) and zmq (supervisor) exec modes.
 * - origin: Uses existing ProcessSupervisor (in-process)
 * - zmq: Uses ExecSupervisorClient (out-of-process via ZMQ)
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getExecSupervisorClient, type ExecSupervisorClient } from "./client.js";

const log = createSubsystemLogger("exec-supervisor/dispatcher");

// =============================================================================
// Types
// =============================================================================

export type ExecMode = "origin" | "zmq";

export type ModeChangeResult = {
  success: boolean;
  previousMode: ExecMode;
  currentMode: ExecMode;
  error?: string;
};

export type ModeStatus = {
  mode: ExecMode;
  zmqHealthy: boolean;
  zmqUptime?: number;
  zmqActiveJobs?: number;
};

// =============================================================================
// State
// =============================================================================

let currentMode: ExecMode = "origin";
let zmqClient: ExecSupervisorClient | null = null;

// =============================================================================
// Internal Helpers
// =============================================================================

/** Health check timeout in ms */
const HEALTH_CHECK_TIMEOUT_MS = 3000;

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutError: string,
): Promise<T> {
  let timeoutId: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(timeoutError)), timeoutMs);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    return result;
  } catch (err) {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    throw err;
  }
}

async function checkZmqHealth(): Promise<{
  healthy: boolean;
  uptime?: number;
  activeJobs?: number;
  error?: string;
}> {
  try {
    const client = getExecSupervisorClient();

    // Try to connect with timeout
    try {
      await withTimeout(client.connect(), HEALTH_CHECK_TIMEOUT_MS, "Connection timeout");
    } catch (err) {
      return { healthy: false, error: `Connection failed: ${String(err)}` };
    }

    // Check health with timeout
    const health = await withTimeout(
      client.health(),
      HEALTH_CHECK_TIMEOUT_MS,
      "Health check timeout",
    );
    if (!health.success) {
      return { healthy: false, error: "Health check failed" };
    }

    return {
      healthy: true,
      uptime: health.uptime,
      activeJobs: health.activeJobs,
    };
  } catch (err) {
    return { healthy: false, error: String(err) };
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Get current exec mode
 */
export function getExecMode(): ExecMode {
  return currentMode;
}

/**
 * Get detailed mode status including ZMQ health
 */
export async function getExecModeStatus(): Promise<ModeStatus> {
  const status: ModeStatus = {
    mode: currentMode,
    zmqHealthy: false,
  };

  // Always check ZMQ health for status
  const health = await checkZmqHealth();
  status.zmqHealthy = health.healthy;
  if (health.uptime !== undefined) {
    status.zmqUptime = health.uptime;
  }
  if (health.activeJobs !== undefined) {
    status.zmqActiveJobs = health.activeJobs;
  }

  return status;
}

/**
 * Set exec mode with health check for zmq mode
 */
export async function setExecMode(mode: ExecMode): Promise<ModeChangeResult> {
  const previousMode = currentMode;

  if (mode === currentMode) {
    return {
      success: true,
      previousMode,
      currentMode,
    };
  }

  if (mode === "zmq") {
    // Health check before switching to ZMQ
    const health = await checkZmqHealth();
    if (!health.healthy) {
      log.warn(`Cannot switch to zmq mode: ${health.error}`);
      return {
        success: false,
        previousMode,
        currentMode,
        error: `Supervisor not healthy: ${health.error}`,
      };
    }

    // Cache the client
    zmqClient = getExecSupervisorClient();
    currentMode = "zmq";
    log.info(`Switched exec mode: origin → zmq`);

    return {
      success: true,
      previousMode,
      currentMode,
    };
  }

  // Switching to origin
  currentMode = "origin";
  log.info(`Switched exec mode: zmq → origin`);

  return {
    success: true,
    previousMode,
    currentMode,
  };
}

/**
 * Get the ZMQ client (only valid when mode is zmq)
 */
export function getZmqClient(): ExecSupervisorClient | null {
  if (currentMode !== "zmq") {
    return null;
  }
  if (!zmqClient) {
    zmqClient = getExecSupervisorClient();
  }
  return zmqClient;
}

/**
 * Check if ZMQ mode is available (supervisor is healthy)
 */
export async function isZmqModeAvailable(): Promise<boolean> {
  const health = await checkZmqHealth();
  return health.healthy;
}

/**
 * Initialize exec mode from config
 */
export function initExecModeFromConfig(configMode?: ExecMode): void {
  if (configMode === "zmq" || configMode === "origin") {
    // Don't await health check during init - just set mode
    // Health check will happen on first use
    currentMode = configMode;
    log.info(`Initialized exec mode: ${configMode}`);
  }
}

/**
 * Format mode status for display
 */
export function formatModeStatus(status: ModeStatus): string {
  const lines: string[] = [];
  lines.push(`Exec mode: ${status.mode}`);

  if (status.zmqHealthy) {
    const uptimeStr = status.zmqUptime ? `${Math.round(status.zmqUptime / 1000)}s` : "unknown";
    const jobsStr = status.zmqActiveJobs ?? 0;
    lines.push(`ZMQ supervisor: ✓ healthy (uptime: ${uptimeStr}, active jobs: ${jobsStr})`);
  } else {
    lines.push(`ZMQ supervisor: ✗ not available`);
  }

  return lines.join("\n");
}
