import type { ProviderMcpServerConfig } from "@getpaseo/plugin/server/provider";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SSE_PROXY_SOURCE } from "./mcp-sse-source.js";

export interface McpLaunchBridge {
  args: string[];
  cleanup(): void;
}

// Structural native port: importing the engine's barrel types makes Paseo's
// plugin compiler traverse the entire engine/Anthropic dependency graph.
interface McpServerDeclaration {
  type: "stdio" | "http";
  lifecycle: "eager";
  exposure: "direct" | "auto";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

/** Per-process declarations: never write caller credentials into global/project MCP settings. */
export function prepareMcpBridge(
  servers: Readonly<Record<string, ProviderMcpServerConfig>>,
  cwd: string,
): McpLaunchBridge {
  if (Object.keys(servers).length === 0) return { args: [], cleanup() {} };
  const dir = mkdtempSync(join(tmpdir(), "pase-omo-mcp-"));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    const declarations: Record<string, McpServerDeclaration> = Object.create(null);
    for (const [name, server] of Object.entries(servers)) {
      const common = { lifecycle: "eager" as const, exposure: server.alwaysLoad ? "direct" as const : "auto" as const };
      if (server.type === "stdio") {
        declarations[name] = { ...common, type: "stdio", command: server.command, args: [...(server.args ?? [])], env: { ...server.env }, cwd };
      } else if (server.type === "http") {
        declarations[name] = { ...common, type: "http", url: server.url, headers: { ...server.headers } };
      } else if (server.type === "sse") {
        // Native Senpi only declares stdio and Streamable HTTP. Preserve legacy SSE
        // with a byte-level JSON-RPC transport relay, not an incorrect HTTP mapping.
        const config = join(dir, `sse-${Object.keys(declarations).length}.json`);
        writeFileSync(config, JSON.stringify({ url: server.url, headers: server.headers ?? {} }), { mode: 0o600 });
        const proxy = join(dir, "mcp-sse-proxy.mjs");
        writeFileSync(proxy, SSE_PROXY_SOURCE, { mode: 0o600 });
        declarations[name] = { ...common, type: "stdio", command: process.execPath,
          args: [proxy, config], cwd };
      } else {
        throw new Error(`Unsupported MCP transport for server ${JSON.stringify(name)}`);
      }
    }
    const extension = join(dir, "mcp-extension.mjs");
    // JSON.parse preserves arbitrary server names, including object-prototype keys.
    writeFileSync(extension, `const declarations = JSON.parse(${JSON.stringify(JSON.stringify(declarations))});\nexport default function (pi) {\n  for (const [name, config] of Object.entries(declarations)) pi.registerMcpServer(name, config);\n}\n`, { mode: 0o600 });
    return { args: ["--extension", extension], cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
