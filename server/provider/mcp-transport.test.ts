import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { prepareMcpBridge } from "./mcp.js";

let fixture: ChildProcess, port: number;
beforeAll(async () => {
  fixture = spawn(process.execPath, [fileURLToPath(new URL("../../test/fixtures/mcp-server.mjs", import.meta.url)), "http"], { stdio: ["ignore", "pipe", "pipe"] });
  const line = await Promise.race([once(fixture.stdout!, "data"), once(fixture, "exit").then(() => { throw new Error("MCP fixture exited before listening"); })]); port = JSON.parse(line[0].toString()).port;
}, 10000);
afterAll(async () => { if (fixture?.exitCode === null) { const exited = once(fixture, "exit"); fixture.kill(); await exited; } });

describe("real MCP transports", () => {
  for (const type of ["stdio", "http", "sse"] as const) {
    it(`discovers and calls ${type}, forwarding authentication, resources, prompts and tool errors`, async () => {
      const server = type === "stdio"
        ? { type, command: process.execPath,
            args: [fileURLToPath(new URL("../../test/fixtures/mcp-server.mjs", import.meta.url)), "stdio", "two words"],
            env: { MCP_FIXTURE_ENV: "fixture-only" } }
        : { type, url: `http://127.0.0.1:${port}/${type === "sse" ? "sse" : "mcp"}`, headers: { Authorization: "Bearer fixture-only" } };
      const bridge = prepareMcpBridge({ fixture: server }, process.cwd());
      const captured: Array<Record<string, unknown>> = [];
      const mod = await import(/* @vite-ignore */ pathToFileURL(bridge.args[1]!).href);
      mod.default({ registerMcpServer: (_name: string, config: Record<string, unknown>) => captured.push(config) });
      const config = captured[0]!;
      const transport = config.type === "stdio" ? new StdioClientTransport({ command: config.command as string, args: config.args as string[], env: config.env as Record<string, string>, cwd: config.cwd as string, stderr: "pipe" })
        : new StreamableHTTPClientTransport(new URL(config.url as string), { requestInit: { headers: config.headers as Record<string, string> } });
      const c = new Client({ name: "bridge-test", version: "1" });
      try {
        // SDK 1.32's HTTP getter permits undefined while its Transport optional
        // field omits it under exactOptionalPropertyTypes; runtime APIs agree.
        await c.connect(transport as Parameters<Client["connect"]>[0]);
        expect((await c.listTools()).tools.map(t => t.name)).toContain("bridge_echo");
        const result = await c.callTool({ name: "bridge_echo", arguments: { value: "ROUND_TRIP_OK" } });
        expect(JSON.stringify(result)).toContain("ROUND_TRIP_OK");
        if (type === "stdio") {
          const blocks = result.content as Array<{ type: string; text: string }>;
          expect(JSON.parse(blocks[0]!.text)).toMatchObject({ envMatched: true, argumentMatched: true, cwd: process.cwd() });
        }
        expect((await c.callTool({ name: "bridge_error", arguments: {} })).isError).toBe(true);
        expect((await c.listResources()).resources[0]?.uri).toBe("fixture://note");
        expect(JSON.stringify(await c.readResource({ uri: "fixture://note" }))).toContain("RESOURCE_OK");
        expect((await c.listPrompts()).prompts[0]?.name).toBe("fixture_prompt");
        expect(JSON.stringify(await c.getPrompt({ name: "fixture_prompt" }))).toContain("PROMPT_OK");
      } finally { await c.close(); bridge.cleanup(); }
    }, 15000);
  }
  it("fails an unauthenticated SSE connection without disclosing its credential", async () => {
    const secret = "invalid-fixture-credential";
    const bridge = prepareMcpBridge({ legacy: { type: "sse", url: `http://127.0.0.1:${port}/sse`, headers: { Authorization: `Bearer ${secret}` } } }, process.cwd());
    let config: { command: string; args: string[] } | undefined;
    const mod = await import(/* @vite-ignore */ pathToFileURL(bridge.args[1]!).href);
    mod.default({ registerMcpServer: (_name: string, value: typeof config) => { config = value; } });
    const transport = new StdioClientTransport({ ...config!, stderr: "pipe" });
    let stderr = "";
    transport.stderr?.on("data", chunk => { stderr += chunk.toString(); });
    const c = new Client({ name: "bridge-auth-failure", version: "1" });
    try {
      await expect(c.connect(transport, { timeout: 3000 })).rejects.toThrow();
      expect(stderr).toContain("SSE MCP transport failed");
      expect(stderr).not.toContain(secret);
      expect(stderr).not.toContain("Authorization");
    } finally { await c.close(); bridge.cleanup(); }
  }, 10000);
});
