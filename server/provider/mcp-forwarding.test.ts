import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dirname } from "node:path";
import type { ProviderMcpServerConfig } from "@getpaseo/plugin/server/provider";
import { OmoSession } from "./omo-session.js";

const state = vi.hoisted(() => ({ processes: [] as Array<{
  options: { args: string[]; env: Record<string, string>; onExit(info: { code: number; signal: null; stderr: string }): void };
  exit(): void;
}> }));
vi.mock("./omo-process.js", () => ({ OmoProcess: class {
  readonly whenExited = Promise.resolve();
  constructor(readonly options: (typeof state.processes)[number]["options"]) { state.processes.push(this); }
  start() {}
  stop() {}
  exit() { this.options.onExit({ code: 0, signal: null, stderr: "" }); }
  async call(command: string) { return command === "get_available_models" ? { models: [{ provider: "fixture", id: "fixture", name: "Fixture" }] } : {}; }
} }));
const sessions: OmoSession[] = [];
function create(servers: Record<string, ProviderMcpServerConfig>) {
  const session = new OmoSession({ paseoSessionId: "mcp-test", launch: { command: "omo", base: [], origin: "test" },
    config: { cwd: process.cwd(), env: {}, mcpServers: servers, settings: {}, persist: true },
    capabilities: [], emit() {}, log() {}, onRuntimeFailure() {},
  });
  sessions.push(session);
  return { session, proc: state.processes.at(-1)! };
}
function extension(proc: (typeof state.processes)[number]) {
  const index = proc.options.args.indexOf("--extension");
  expect(index, "MCP configuration must reach a native extension").toBeGreaterThanOrEqual(0);
  return proc.options.args[index + 1]!;
}
async function declarations(file: string) {
  const registerMcpServer = vi.fn();
  const mod = await import(/* @vite-ignore */ pathToFileURL(file).href);
  mod.default({ registerMcpServer });
  return registerMcpServer.mock.calls;
}
afterEach(() => { for (const s of sessions.splice(0)) s.close(); for (const p of state.processes.splice(0)) p.exit(); });

describe("MCP configuration at the OmO process boundary", () => {
  it("forwards stdio arguments/environment and HTTP headers without putting secrets in argv", async () => {
    const { proc } = create({ local: { type: "stdio", command: "node", args: ["fixture.js", "two words"], env: { FIXTURE_TOKEN: "stdio-secret" } },
      remote: { type: "http", url: "https://fixture.invalid/mcp", headers: { Authorization: "Bearer http-secret" }, alwaysLoad: true } });
    const file = extension(proc);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
    const calls = await declarations(file);
    expect(calls).toEqual(expect.arrayContaining([
      ["local", expect.objectContaining({ type: "stdio", command: "node", args: ["fixture.js", "two words"], env: { FIXTURE_TOKEN: "stdio-secret" }, cwd: process.cwd() })],
      ["remote", expect.objectContaining({ type: "http", url: "https://fixture.invalid/mcp", headers: { Authorization: "Bearer http-secret" }, exposure: "direct" })],
    ]));
    expect(JSON.stringify(proc.options.args)).not.toMatch(/http-secret|stdio-secret/);
  });
  it("gives each launch private declarations and keeps them until that process exits", async () => {
    const a = create({ one: { type: "http", url: "https://one.invalid/mcp" } });
    const b = create({ two: { type: "http", url: "https://two.invalid/mcp" } });
    const first = extension(a.proc), second = extension(b.proc);
    expect(first).not.toBe(second);
    a.session.close(); expect(existsSync(first)).toBe(true);
    a.proc.exit(); expect(existsSync(first)).toBe(false); expect(existsSync(second)).toBe(true);
    expect((await declarations(second)).map(c => c[0])).toEqual(["two"]);
  });
  it("preserves legacy SSE as SSE through a separate stdio transport, keeping its headers private", async () => {
    const { proc } = create({ legacy: { type: "sse", url: "https://legacy.invalid/sse", headers: { Authorization: "Bearer sse-secret" } } });
    const calls = await declarations(extension(proc)); const config = calls[0]![1];
    expect(config.type).toBe("stdio"); expect(config.command).toBe(process.execPath);
    expect(config.args[0]).toMatch(/mcp-sse-proxy\.mjs$/);
    expect(statSync(config.args[1]).mode & 0o777).toBe(0o600);
    expect(readFileSync(config.args[1], "utf8")).toContain("sse-secret");
    expect(JSON.stringify(proc.options.args)).not.toContain("sse-secret");
    expect(JSON.stringify(config.args)).not.toContain("sse-secret");
  });
  it("adds no bridge when Paseo supplied no MCP servers", () => {
    expect(create({}).proc.options.args).not.toContain("--extension");
  });
  it("regenerates declarations on resume and an old exit cannot remove the new lease", async () => {
    const a = create({ local: { type: "stdio", command: "node", env: { TOKEN: "resume-only" } } });
    const original = extension(a.proc);
    await a.session.suspend();
    a.proc.exit(); expect(existsSync(original)).toBe(false);
    await a.session.resume();
    const next = state.processes.at(-1)!; const resumed = extension(next);
    expect(resumed).not.toBe(original);
    a.proc.exit(); expect(existsSync(resumed)).toBe(true);
    expect((await declarations(resumed))[0]![1].env).toEqual({ TOKEN: "resume-only" });
  });
});
