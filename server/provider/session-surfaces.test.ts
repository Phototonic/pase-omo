import { afterEach, expect, test, vi } from "vitest";
import { contextUsageOf, OmoSession } from "./omo-session.js";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";

const mocks = vi.hoisted(() => ({ instances: [] as Array<{ emit(event: Record<string, unknown>): void; call: ReturnType<typeof vi.fn> }>, state: {} as Record<string, unknown>, commands: [] as Array<Record<string, unknown>> }));
vi.mock("./omo-process.js", () => ({ OmoProcess: class {
  readonly whenExited = Promise.resolve();
  readonly stop = vi.fn();
  readonly notify = vi.fn();
  readonly call = vi.fn(async (name: string) => {
    if (name === "get_state") return mocks.state;
    if (name === "get_commands") return { commands: mocks.commands };
    if (name === "get_available_models") return { models: [] };
    return {};
  });
  constructor(private options: { onEvent(event: Record<string, unknown>): void }) { mocks.instances.push(this); }
  start() {}
  emit(event: Record<string, unknown>) { this.options.onEvent(event); }
} }));
const sessions: OmoSession[] = [];
function setup() {
  const events: ProviderEvent[] = [];
  const session = new OmoSession({ paseoSessionId: "parent", launch: { command: "omo", base: [], origin: "fixture" }, config: { cwd: "/tmp/skill-context-fixture", env: {}, settings: {}, mcpServers: {}, persist: false }, capabilities: [], emit: event => events.push(event), log: vi.fn(), onRuntimeFailure: vi.fn() });
  sessions.push(session);
  return { session, process: mocks.instances.at(-1)!, events };
}
afterEach(() => { for (const session of sessions.splice(0)) session.close(); vi.useRealTimers(); mocks.instances.length = 0; mocks.state = {}; mocks.commands = []; });

test("native global and project skills appear as supported slash commands", async () => {
  mocks.commands = [{ name: "goal", description: "Goal", syntax: "slash" }, { name: "skill:code-review", description: "Review code", syntax: "dollar" }, { name: "skill:voxetra-qa-recovery", description: "Recover QA", syntax: "dollar" }];
  const f = setup(); await f.session.open("open", "skip");
  const event = f.events.find(e => e.type === "session.commands");
  expect(event).toMatchObject({ commands: [expect.objectContaining({ name: "goal" }), expect.objectContaining({ name: "skill:code-review" }), expect.objectContaining({ name: "skill:voxetra-qa-recovery" })] });
});

test("native resource reload updates the skill menu without a restart", () => {
  const f = setup();
  f.process.emit({ type: "commands_changed", commands: [{ name: "skill:voxetra-release", syntax: "dollar", description: "Release" }] });
  expect(f.events).toContainEqual(expect.objectContaining({ type: "session.commands", commands: [expect.objectContaining({ name: "skill:voxetra-release" })] }));
});

test("opening a restored session publishes native context usage", async () => {
  mocks.state = { contextUsage: { tokens: 12000, contextWindow: 200000, percent: 6 } };
  const f = setup(); await f.session.open("open", "skip");
  expect(f.events).toContainEqual(expect.objectContaining({ type: "session.usage", usage: { contextWindowUsedTokens: 12000, contextWindowMaxTokens: 200000 } }));
  expect(f.events.findIndex(e => e.type === "session.opened")).toBeLessThan(f.events.findIndex(e => e.type === "session.usage"));
});

test("the first normal poll replays opening usage for Paseo's late subscriber", async () => {
  mocks.state = { contextUsage: { tokens: 12000, contextWindow: 200000 } };
  const f = setup(); await f.session.open("open", "skip");
  f.events.length = 0;
  await vi.waitFor(() => expect(f.events.filter(e => e.type === "session.usage")).toHaveLength(1), { timeout: 3000 });
  expect(f.events).toContainEqual(expect.objectContaining({ type: "session.usage", usage: { contextWindowUsedTokens: 12000, contextWindowMaxTokens: 200000 } }));
});

test("context updates during work and clears unknown counts after compaction", async () => {
  const f = setup();
  mocks.state = { contextUsage: { tokens: 24000, contextWindow: 200000 } };
  f.process.emit({ type: "message_end", message: { role: "assistant", content: [], usage: { input: 100, output: 20 } } });
  await vi.waitFor(() => expect(f.events).toContainEqual(expect.objectContaining({ type: "session.usage", usage: expect.objectContaining({ contextWindowUsedTokens: 24000 }) })));
  mocks.state = { contextUsage: { tokens: null, contextWindow: 200000 } };
  f.process.emit({ type: "auto_compaction_end" });
  await vi.waitFor(() => {
    const last = f.events.filter(e => e.type === "session.usage").at(-1);
    expect(last).toMatchObject({ usage: { inputTokens: 100, outputTokens: 20, contextWindowMaxTokens: 200000 } });
    if (last?.type === "session.usage") expect(last.usage.contextWindowUsedTokens).toBeUndefined();
  });
});

test("selecting a skill forwards the accepted legacy invocation unchanged", () => {
  const f = setup(); f.session.prompt("message", "/skill:voxetra-qa-recovery investigate the failure", [], false);
  expect(f.process.call).toHaveBeenCalledWith("prompt", expect.objectContaining({ message: "/skill:voxetra-qa-recovery investigate the failure" }), expect.any(Number));
});

test("context parsing preserves unknown estimates and rejects invalid counts", () => {
  expect(contextUsageOf({ contextUsage: { tokens: 0, contextWindow: 100 } })).toEqual({ contextWindowUsedTokens: 0, contextWindowMaxTokens: 100 });
  expect(contextUsageOf({ contextUsage: { tokens: null, contextWindow: 100, percent: 42 } })).toEqual({ contextWindowMaxTokens: 100 });
  expect(contextUsageOf({ model: { contextWindow: 100 }, contextUsage: { tokens: -1, contextWindow: 0 } })).toEqual({ contextWindowMaxTokens: 100 });
  expect(contextUsageOf({ contextUsage: { tokens: NaN, contextWindow: Infinity } })).toEqual({});
  expect(contextUsageOf({ contextUsage: { tokens: 120, contextWindow: 100 } })).toEqual({ contextWindowUsedTokens: 120, contextWindowMaxTokens: 100 });
});

test("a stale in-flight read cannot restore pre-compaction context", async () => {
  const f = setup();
  let resolve!: (state: unknown) => void;
  f.process.call.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  f.process.emit({ type: "message_end", message: { role: "assistant", content: [] } });
  mocks.state = { contextUsage: { tokens: null, contextWindow: 200000 } };
  f.process.emit({ type: "auto_compaction_end" });
  resolve({ contextUsage: { tokens: 190000, contextWindow: 200000 } });
  await vi.waitFor(() => expect(f.process.call).toHaveBeenCalledTimes(2));
  expect(f.events.filter(e => e.type === "session.usage").every(e => e.usage.contextWindowUsedTokens !== 190000)).toBe(true);
});

test("closing during a context query cannot publish late usage", async () => {
  const f = setup();
  let resolve!: (state: unknown) => void;
  f.process.call.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  f.process.emit({ type: "message_end", message: { role: "assistant", content: [] } });
  f.session.close();
  resolve({ contextUsage: { tokens: 100, contextWindow: 200000 } });
  await new Promise(r => setTimeout(r, 0));
  expect(f.events.filter(e => e.type === "session.usage")).toEqual([]);
});
