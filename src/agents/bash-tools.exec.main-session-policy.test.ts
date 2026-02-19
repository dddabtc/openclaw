import { describe, expect, it } from "vitest";
import { createExecTool } from "./bash-tools.exec.js";

describe("exec main-session long-run guard", () => {
  it("allows short foreground exec in main session", async () => {
    const tool = createExecTool({
      sessionKey: "agent:alpha:main",
      mainSessionPolicy: {
        forbidLongExec: true,
        maxExecTimeoutSec: 120,
      },
    });

    const result = await tool.execute("call-allow", {
      command: "echo ok",
      timeout: 30,
      yieldMs: 1000,
    });

    expect(result.details.status).toBe("completed");
  });

  it("rejects long foreground exec in main session", async () => {
    const tool = createExecTool({
      sessionKey: "agent:alpha:main",
      mainSessionPolicy: {
        forbidLongExec: true,
        maxExecTimeoutSec: 120,
      },
    });

    await expect(
      tool.execute("call-deny", {
        command: "sleep 1",
      }),
    ).rejects.toThrow("Main session policy blocked exec");
  });
});
