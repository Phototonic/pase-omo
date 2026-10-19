import { expect, it, vi } from "vitest";
import { OmoProcess } from "./omo-process.js";

it("releases process-scoped resources when stopped before spawn, exactly once", async () => {
  const onExit = vi.fn();
  const proc = new OmoProcess({ launch: { command: "omo", base: [], origin: "test" }, args: [], cwd: process.cwd(), env: {}, onEvent() {}, onExit });
  proc.stop(); proc.stop();
  await expect(proc.whenExited).resolves.toBeUndefined();
  expect(onExit).toHaveBeenCalledExactlyOnceWith({ code: null, signal: null, stderr: "" });
});
