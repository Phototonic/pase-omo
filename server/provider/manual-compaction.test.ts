import { afterEach, expect, test, vi } from "vitest";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { OmoSession } from "./omo-session.js";

const mocks = vi.hoisted(() => ({ instances: [] as Array<{ emit(event: Record<string, unknown>): void; call: ReturnType<typeof vi.fn<(name: string, ...args: unknown[]) => Promise<unknown>>> }>, state: {} as Record<string, unknown> }));
vi.mock("./omo-process.js", () => ({ OmoProcess: class {
  readonly whenExited = Promise.resolve();
  readonly stop = vi.fn();
  readonly notify = vi.fn();
  readonly call = vi.fn(async (name: string) => {
    if (name === "get_state") return mocks.state;
    if (name === "get_commands") return { commands: [] };
    if (name === "get_available_models") return { models: [] };
    if (name === "compact") return { tokensBefore: 900000, estimatedTokensAfter: 24000 };
    return {};
  });
  constructor(private options: { onEvent(event: Record<string, unknown>): void }) { mocks.instances.push(this); }
  start() {}
  emit(event: Record<string, unknown>) { this.options.onEvent(event); }
} }));
const sessions: OmoSession[] = [];
function setup() {
  const events: ProviderEvent[] = [];
  const session = new OmoSession({ paseoSessionId: "parent", launch: { command: "omo", base: [], origin: "fixture" }, config: { cwd: "/tmp/compaction-fixture", env: {}, settings: {}, mcpServers: {}, persist: false }, capabilities: [], emit: event => events.push(event), log: vi.fn(), onRuntimeFailure: vi.fn() });
  sessions.push(session);
  return { session, process: mocks.instances.at(-1)!, events };
}
afterEach(() => { for (const s of sessions.splice(0)) s.close(); mocks.instances.length = 0; mocks.state = {}; });

test("advertises compact even when the RPC catalogue contains no TUI commands", async () => {
  const f = setup(); await f.session.open("open", "skip");
  expect(f.events).toContainEqual(expect.objectContaining({ type: "session.commands", commands: expect.arrayContaining([expect.objectContaining({ name: "compact", argumentHint: "[instructions]" })]) }));
  f.process.emit({ type: "commands_changed", commands: [] });
  expect(f.events.filter(e => e.type === "session.commands").at(-1)).toMatchObject({ commands: expect.arrayContaining([expect.objectContaining({ name: "compact" })]) });
});

test("compact uses the native RPC, completes a visible turn and refreshes context", async () => {
  mocks.state = { contextUsage: { tokens: null, contextWindow: 1000000 } };
  const f = setup(); f.session.prompt("compact", "/compact Preserve decisions and remaining tasks", [], false);
  await vi.waitFor(() => expect(f.process.call).toHaveBeenCalledWith("compact", { customInstructions: "Preserve decisions and remaining tasks" }, expect.any(Number)));
  await vi.waitFor(() => expect(f.events).toContainEqual(expect.objectContaining({ type: "session.turn", state: "completed" })));
  expect(f.process.call).not.toHaveBeenCalledWith("prompt", expect.anything(), expect.anything());
  expect(f.events).toContainEqual(expect.objectContaining({ type: "session.usage" }));
  expect(f.events).toContainEqual(expect.objectContaining({ type: "timeline.item", item: expect.objectContaining({ type: "assistant_message", text: expect.stringContaining("Context compacted") }) }));
});

test("refuses compaction during a live turn without aborting it", async () => {
  const f = setup(); f.session.prompt("work", "Continue work", [], false);
  f.session.prompt("compact", "/compact", [], false);
  await Promise.resolve();
  expect(f.events).toContainEqual(expect.objectContaining({ type: "session.prompt_result", clientMessageId: "compact", result: expect.objectContaining({ type: "failed" }) }));
  expect(f.process.call.mock.calls.some(([name]) => name === "compact" || name === "abort")).toBe(false);
});

test.each([{ isStreaming: true }, { isCompacting: true }, { pendingMessageCount: 1 }])("refuses native occupancy before compaction: %j", async state => {
  mocks.state = state;
  const f = setup(); f.session.prompt("compact", "/compact", [], false);
  await vi.waitFor(() => expect(f.events).toContainEqual(expect.objectContaining({ type: "session.turn", state: "failed" })));
  expect(f.process.call.mock.calls.some(([name]) => name === "compact" || name === "abort")).toBe(false);
});

test("unreadable occupancy fails closed", async () => {
  const f = setup(); f.process.call.mockRejectedValueOnce(new Error("state unavailable"));
  f.session.prompt("compact", "/compact", [], false);
  await vi.waitFor(() => expect(f.events).toContainEqual(expect.objectContaining({ type: "session.turn", state: "failed" })));
  expect(f.process.call.mock.calls.some(([name]) => name === "compact")).toBe(false);
});

test("busy compaction rejects another prompt and ignores premature idle signals", async () => {
  let finish!: (value: unknown) => void;
  const f = setup();
  const original = f.process.call.getMockImplementation()!;
  f.process.call.mockImplementation((name: string, ...args: unknown[]) => name === "compact" ? new Promise(resolve => { finish = resolve; }) : original(name, ...args));
  f.session.prompt("compact", "/compact", [], false);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  f.process.emit({ type: "agent_idle" });
  f.session.prompt("other", "Continue", [], false);
  await Promise.resolve();
  expect(f.events).toContainEqual(expect.objectContaining({ type: "session.prompt_result", clientMessageId: "other", result: expect.objectContaining({ type: "failed" }) }));
  expect(f.events.some(e => e.type === "session.turn" && e.state === "completed")).toBe(false);
  finish({});
  await vi.waitFor(() => expect(f.events).toContainEqual(expect.objectContaining({ type: "session.turn", state: "completed" })));
});

test("compaction failure is visible and never falls through to a model prompt", async () => {
  const f = setup();
  const original = f.process.call.getMockImplementation()!;
  f.process.call.mockImplementation((name: string, ...args: unknown[]) => name === "compact" ? Promise.reject(new Error("Already compacted")) : original(name, ...args));
  f.session.prompt("compact", "/compact", [], false);
  await vi.waitFor(() => expect(f.events).toContainEqual(expect.objectContaining({ type: "session.turn", state: "failed", error: { message: expect.stringContaining("Already compacted") } })));
  expect(f.process.call.mock.calls.some(([name]) => name === "prompt")).toBe(false);
});

test("native compaction_end invalidates old context without an assistant generation", async () => {
  const f = setup(); mocks.state = { contextUsage: { tokens: 900000, contextWindow: 1000000 } };
  await f.session.open("open", "skip");
  mocks.state = { contextUsage: { tokens: null, contextWindow: 1000000 } };
  f.process.emit({ type: "compaction_end", reason: "manual", result: {}, aborted: false });
  await vi.waitFor(() => {
    const usage = f.events.filter(e => e.type === "session.usage").at(-1);
    expect(usage).toMatchObject({ usage: { contextWindowMaxTokens: 1000000 } });
    if (usage?.type === "session.usage") expect(usage.usage.contextWindowUsedTokens).toBeUndefined();
  });
});

test("open background wake sources prevent manual compaction", async () => {
  const f = setup();
  f.process.emit({ type: "extension_event", name: "wake_source_state", data: { source: "tasks", activeCount: 1 } });
  f.session.prompt("compact", "/compact", [], false);
  await vi.waitFor(() => expect(f.events).toContainEqual(expect.objectContaining({ type: "session.turn", state: "failed" })));
  expect(f.process.call.mock.calls.some(([name]) => name === "compact")).toBe(false);
});

test("closing during the idle probe prevents a late compaction request", async () => {
  let finish!: (value: unknown) => void;
  const f = setup(); f.process.call.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  f.session.prompt("compact", "/compact", [], false);
  f.session.close(); finish({});
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(f.process.call.mock.calls.some(([name]) => name === "compact")).toBe(false);
  expect(f.events.some(e => e.type === "session.turn" && e.state === "completed")).toBe(false);
});

test("stop cancels only the compaction RPC and late completion stays canceled", async () => {
  let finish!: (value: unknown) => void;
  const f = setup(); const original = f.process.call.getMockImplementation()!;
  f.process.call.mockImplementation((name: string, ...args: unknown[]) => name === "compact" ? new Promise(resolve => { finish = resolve; }) : original(name, ...args));
  f.session.prompt("compact", "/compact", [], false);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await f.session.interrupt(); finish({});
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(f.process.call).toHaveBeenCalledWith("abort_compaction", {}, 30000);
  expect(f.events.filter(e => e.type === "session.turn" && e.state === "canceled")).toHaveLength(1);
  expect(f.events.some(e => e.type === "session.turn" && e.state === "completed")).toBe(false);
  expect(f.process.call.mock.calls.some(([name]) => name === "abort")).toBe(false);
});

test("attachments cannot accidentally become a compaction prompt", () => {
  const f = setup(); f.session.prompt("compact", "/compact", [{ data: "fixture", mimeType: "image/png" }], false);
  expect(f.events).toContainEqual(expect.objectContaining({ type: "session.prompt_result", result: expect.objectContaining({ type: "failed" }) }));
  expect(f.process.call).not.toHaveBeenCalled();
});
