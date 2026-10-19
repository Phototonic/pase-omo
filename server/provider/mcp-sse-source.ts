/** Self-contained worker source: Paseo evaluates bundles without module-relative asset URLs. */
export const SSE_PROXY_SOURCE = String.raw`
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

async function main() {
  const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const url = new URL(config.url);
  const headers = new Headers(config.headers);
  const controller = new AbortController();
  let stopped = false, endpointResolve, endpointReject, input, initializeId, protocolVersion;
  const endpoint = new Promise((resolve, reject) => { endpointResolve = resolve; endpointReject = reject; });
  // Startup failures may precede the first client message.
  void endpoint.catch(() => {});
  const stop = () => {
    stopped = true;
    controller.abort();
    endpointReject(new Error("closed"));
    input?.close();
    process.stdin.pause();
  };
  process.stdin.once("end", stop);
  process.stdin.once("close", stop);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, stop);

  async function receive() {
    const receiveHeaders = new Headers(headers);
    receiveHeaders.set("Accept", "text/event-stream");
    const response = await fetch(url, { headers: receiveHeaders, signal: controller.signal, redirect: "error" });
    if (!response.ok || !response.body) throw new Error("SSE connection failed");
    const lines = createInterface({ input: Readable.fromWeb(response.body), crlfDelay: Infinity });
    let event = "message", data = [];
    for await (const line of lines) {
      if (line === "") {
        if (data.length) {
          const value = data.join("\n");
          if (event === "endpoint") {
            const target = new URL(value, url);
            if (target.origin !== url.origin) throw new Error("Cross-origin SSE endpoint");
            endpointResolve(target);
          } else if (event === "message") {
            const message = JSON.parse(value);
            if (message.id === initializeId && typeof message.result?.protocolVersion === "string") protocolVersion = message.result.protocolVersion;
            const output = JSON.stringify(message) + "\n";
            await new Promise((resolve, reject) => process.stdout.write(output, error => error ? reject(error) : resolve()));
          }
        }
        event = "message"; data = [];
      } else if (!line.startsWith(":")) {
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = value;
        if (field === "data") data.push(value);
      }
    }
    if (!stopped) throw new Error("SSE stream closed");
  }
  async function send() {
    input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of input) {
      if (!line.trim()) continue;
      const target = await endpoint;
      const requestHeaders = new Headers(headers);
      requestHeaders.set("Content-Type", "application/json");
      if (protocolVersion) requestHeaders.set("MCP-Protocol-Version", protocolVersion);
      const message = JSON.parse(line);
      if (message.method === "initialize") initializeId = message.id;
      const response = await fetch(target, { method: "POST", headers: requestHeaders, body: JSON.stringify(message), signal: controller.signal, redirect: "error" });
      if (!response.ok) throw new Error("SSE request failed");
      await response.arrayBuffer();
    }
  }
  const work = [receive(), send()];
  try {
    await Promise.race(work);
  } catch {
    if (!stopped) {
      process.stderr.write("pase-omo: SSE MCP transport failed\n");
      process.exitCode = 1;
    }
  } finally {
    stop();
    await Promise.allSettled(work);
  }
}
await main().catch(() => {
  process.stderr.write("pase-omo: SSE MCP transport failed\n");
  process.exitCode = 1;
});
`;
