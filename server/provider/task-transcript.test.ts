import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { TaskTranscriptReader } from "./task-transcript.js";
import { taskChildEvents, type TaskRecord } from "./task-watch.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const record: TaskRecord = { task_id: "st_abc", parent_session_id: "parent", status: "running", task_summary: "worker" };
const context = { parentSessionId: "paseo-parent", cwd: "/project" };
const line = (id: string, message: unknown) => JSON.stringify({ type: "message", id, message }) + "\n";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omo-worker-transcript-")); roots.push(root);
  const dir = join(root, "children", record.task_id, "sessions", record.task_id);
  await mkdir(dir, { recursive: true });
  return { root, file: join(dir, "session.jsonl"), env: { PASEO_OMO_TASK_STATE_DIR: root } };
}

it("shows saved worker text, reasoning and tool results instead of just the title", async () => {
  const f = await fixture();
  await writeFile(f.file, line("a", { role: "assistant", content: [
    { type: "thinking", thinking: "Check the contract" }, { type: "text", text: "I found the handler" },
    { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/app.ts" } },
  ] }) + line("b", { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [
    { type: "text", text: "export const ready = true" }, { type: "text", text: "PRIVATE MODEL CONTEXT", audience: "model" },
  ], isError: false }));
  const transcript = await new TaskTranscriptReader().read(context.cwd, record, f.env);
  const result = taskChildEvents({ ...context, record, transcript, previous: undefined });
  expect(result.events).toContainEqual(expect.objectContaining({ type: "timeline.item", item: expect.objectContaining({ text: "I found the handler" }) }));
  expect(transcript).toContainEqual(expect.objectContaining({ type: "reasoning", text: "Check the contract" }));
  expect(transcript).toContainEqual(expect.objectContaining({ type: "tool_call", status: "completed", detail: expect.objectContaining({ content: "export const ready = true" }) }));
  expect(JSON.stringify(transcript)).not.toContain("PRIVATE MODEL CONTEXT");
});

it("publishes new output even when the task status stays running, without duplicating old output", async () => {
  const f = await fixture(); const reader = new TaskTranscriptReader();
  await writeFile(f.file, line("a", { role: "assistant", content: [{ type: "text", text: "First update" }] }));
  const first = taskChildEvents({ ...context, record, transcript: await reader.read(context.cwd, record, f.env), previous: undefined });
  await appendFile(f.file, line("b", { role: "assistant", content: [{ type: "text", text: "Second update" }] }));
  const next = taskChildEvents({ ...context, record, transcript: await reader.read(context.cwd, record, f.env), previous: first.state });
  expect(next.events.filter(e => e.type === "timeline.item").map(e => e.item)).toEqual([expect.objectContaining({ text: "Second update" })]);
  const again = taskChildEvents({ ...context, record, transcript: await reader.read(context.cwd, record, f.env), previous: next.state });
  expect(again.events).toEqual([]);
});

it("keeps tool identity while a running call completes and records failures", async () => {
  const f = await fixture(); const reader = new TaskTranscriptReader();
  await writeFile(f.file, line("a", { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "check" } }] }));
  const first = await reader.read(context.cwd, record, f.env);
  await appendFile(f.file, line("b", { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "check failed" }], isError: true }));
  const second = await reader.read(context.cwd, record, f.env);
  expect(first[0]).toMatchObject({ type: "tool_call", status: "running" });
  expect(second[0]).toMatchObject({ id: first[0]?.id, type: "tool_call", status: "failed", error: "check failed" });
});

it("reconstructs completed worker history with stable IDs after reconnect", async () => {
  const f = await fixture();
  await writeFile(f.file, line("a", { role: "assistant", content: [{ type: "text", text: "Verified worker result" }] }));
  const completed = { ...record, status: "completed", final_response: "Verified worker result" };
  const first = taskChildEvents({ ...context, record: completed, transcript: await new TaskTranscriptReader().read(context.cwd, completed, f.env), previous: undefined });
  const replay = taskChildEvents({ ...context, record: completed, transcript: await new TaskTranscriptReader().read(context.cwd, completed, f.env), previous: undefined });
  expect(replay.events).toEqual(first.events);
  const textEvents = replay.events.filter(e => e.type === "timeline.item" && e.item.type === "assistant_message" && e.item.text === "Verified worker result");
  expect(textEvents).toHaveLength(1);
  expect(replay.events.findIndex(e => e.type === "timeline.item" && e.item.type === "assistant_message" && e.item.text === "Verified worker result"))
    .toBeLessThan(replay.events.findIndex(e => e.type === "session.closed"));
});

it("does not lose a partially written JSONL record or a split UTF-8 character", async () => {
  const f = await fixture(); const reader = new TaskTranscriptReader();
  const bytes = Buffer.from(line("a", { role: "assistant", content: [{ type: "text", text: "Ready ✓" }] }));
  const cut = bytes.indexOf(Buffer.from("✓")) + 1;
  await writeFile(f.file, bytes.subarray(0, cut));
  expect(await reader.read(context.cwd, record, f.env)).toEqual([]);
  await appendFile(f.file, bytes.subarray(cut));
  expect(await reader.read(context.cwd, record, f.env)).toContainEqual(expect.objectContaining({ text: "Ready ✓" }));
});

it("recovers a truncated/replaced transcript and ignores non-message metadata", async () => {
  const f = await fixture(); const reader = new TaskTranscriptReader();
  await writeFile(f.file, line("a", { role: "assistant", content: [{ type: "text", text: "Old longer output" }] }));
  await reader.read(context.cwd, record, f.env);
  await writeFile(f.file, JSON.stringify({ type: "custom", data: "hidden" }) + "\n" + line("b", { role: "assistant", content: [{ type: "text", text: "New" }] }));
  const result = await reader.read(context.cwd, record, f.env);
  expect(result).toContainEqual(expect.objectContaining({ text: "New" }));
  expect(JSON.stringify(result)).not.toContain("hidden");
});

it("uses a saved final response when a legacy worker has no transcript", async () => {
  const f = await fixture();
  const done = { ...record, status: "completed", final_response: "Legacy final response" };
  const result = await new TaskTranscriptReader().read(context.cwd, done, f.env);
  expect(result).toContainEqual(expect.objectContaining({ type: "assistant_message", text: "Legacy final response" }));
});

it("rejects task paths outside the task store", async () => {
  const f = await fixture();
  await expect(new TaskTranscriptReader().read(context.cwd, { ...record, task_id: "../../outside" }, f.env)).rejects.toThrow("Invalid task id");
});
