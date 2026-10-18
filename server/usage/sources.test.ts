import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { discoverUsage, fetchCodexUsage, fetchZaiUsage, registerUsageSources } from "./sources.js";
import type { UsageSourceRegistration } from "@getpaseo/plugin/server/usage";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function fixture(store: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "omo-usage-")); dirs.push(dir);
  await mkdir(join(dir, "agent"));
  const path = join(dir, "agent", "auth.json");
  await writeFile(path, JSON.stringify(store));
  return { path, env: { OMO_CODING_AGENT_DIR: join(dir, "agent") } };
}
const oauth = { type: "oauth", access: "fictional-access", refresh: "fictional-refresh", accountId: "fictional-account", expires: 2000000000000 };
const key = { type: "api_key", key: "fictional-zai-key" };
const globalScope = { kind: "global" } as const;

it("discovers only configured OmO stores and serializes locators, never credentials", async () => {
  const f = await fixture({ "chatgpt-subscription": oauth, zai: key });
  const before = await readFile(f.path, "utf8");
  const accounts = [...await discoverUsage("codex", globalScope, f), ...await discoverUsage("zai", globalScope, f)];
  expect(accounts).toHaveLength(2);
  expect(accounts.every((a) => a.harness === "OmO" && /^[a-zA-Z0-9._-]{1,128}$/.test(a.key))).toBe(true);
  const serialized = JSON.stringify(accounts);
  for (const value of [oauth.access, oauth.refresh, oauth.accountId, key.key]) expect(serialized).not.toContain(value);
  expect(accounts.map((a) => a.input)).toEqual([{ path: f.path }, { path: f.path }]);
  expect(await readFile(f.path, "utf8")).toBe(before);
});

it("keeps discovery identity stable across credential rotation", async () => {
  const f = await fixture({ "chatgpt-subscription": oauth, zai: key });
  const before = await Promise.all(["codex", "zai"].map((p) => discoverUsage(p as "codex" | "zai", globalScope, f)));
  await writeFile(f.path, JSON.stringify({ "chatgpt-subscription": { ...oauth, access: "rotated" }, zai: { ...key, key: "rotated" } }));
  expect(await Promise.all(["codex", "zai"].map((p) => discoverUsage(p as "codex" | "zai", globalScope, f)))).toEqual(before);
});

it("never scans global stores for session scope or attributes other providers to a Claude chat", async () => {
  const f = await fixture({ "chatgpt-subscription": oauth, zai: key });
  for (const provider of ["codex", "zai"] as const)
    expect(await discoverUsage(provider, { kind: "session", provider: "omo", model: "anthropic-subscription/claude-sonnet-5-5", env: {} }, f)).toEqual([]);
});

it("does not discover missing, malformed or unrelated credentials", async () => {
  const f = await fixture({ anthropic: oauth, zai: { type: "oauth", access: "unrelated" } });
  expect(await discoverUsage("codex", globalScope, f)).toEqual([]);
  expect(await discoverUsage("zai", globalScope, f)).toEqual([]);
  await writeFile(f.path, "not-json");
  expect(await discoverUsage("codex", globalScope, f)).toEqual([]);
});

it("reads fresh Codex credentials without refreshing or writing and uses reported window durations", async () => {
  const f = await fixture({ "chatgpt-subscription": oauth });
  const before = await readFile(f.path, "utf8");
  const fetchJson = vi.fn().mockResolvedValue({ status: 200, body: {
    plan_type: "plus", email: "not-for-report@example.invalid", rate_limit: {
      primary_window: { used_percent: 25, limit_window_seconds: 604800, reset_at: 1800000000 }, secondary_window: null,
    }, additional_rate_limits: [{ limit_name: "Special model", metered_feature: "special", rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 18000 } } }],
  } });
  const r = await fetchCodexUsage({ path: f.path }, { fetchJson, now: () => 1000 });
  expect(fetchJson).toHaveBeenCalledWith("https://chatgpt.com/backend-api/wham/usage", { Authorization: "Bearer fictional-access", "ChatGPT-Account-Id": "fictional-account" });
  expect(r).toMatchObject({ status: "available", planLabel: "plus", windows: [
    { id: "weekly", label: "Weekly", usedPct: 25 }, { id: "limit:special:five_hour", usedPct: 0 },
  ] });
  expect(JSON.stringify(r)).not.toContain("not-for-report");
  expect(JSON.stringify(r)).not.toContain(oauth.access);
  expect(await readFile(f.path, "utf8")).toBe(before);
});

it("labels a Codex slot with no reported duration as unknown rather than inventing five hours", async () => {
  const f = await fixture({ "openai-codex": oauth });
  const r = await fetchCodexUsage({ path: f.path }, { fetchJson: async () => ({ status: 200, body: { rate_limit: { primary_window: { used_percent: 0 } } } }) });
  expect(r).toMatchObject({ status: "available", windows: [{ id: "primary_window", label: "Primary limit", usedPct: 0 }] });
});

it("returns expired Codex status without a network call or OAuth refresh", async () => {
  const f = await fixture({ "chatgpt-subscription": { ...oauth, expires: 1000 } });
  const fetchJson = vi.fn();
  expect(await fetchCodexUsage({ path: f.path }, { fetchJson, now: () => 1001 })).toMatchObject({ status: "unavailable", problem: { kind: "expired", refreshedBy: "OmO" } });
  expect(fetchJson).not.toHaveBeenCalled();
});

it.each([401, 403])("handles rejected Codex credentials without exposing response bodies (%s)", async (status) => {
  const f = await fixture({ "chatgpt-subscription": oauth });
  expect(await fetchCodexUsage({ path: f.path }, { fetchJson: async () => ({ status, body: { secret: oauth.access } }) })).toMatchObject({ status: "unavailable", problem: { kind: "rejected", status } });
});

it("maps current Z.ai CREDIT_LIMIT 5h/weekly and legacy token/MCP windows separately", async () => {
  const f = await fixture({ zai: key });
  const before = await readFile(f.path, "utf8");
  const fetchJson = vi.fn().mockResolvedValue({ status: 200, body: { code: 200, success: true, data: { level: "pro", limits: [
    { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 1, nextResetTime: 1800000000000 },
    { type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 56 },
    { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 20 },
    { type: "OTHER", percentage: 90 },
  ] } } });
  const r = await fetchZaiUsage({ path: f.path }, { fetchJson });
  expect(fetchJson).toHaveBeenCalledWith("https://api.z.ai/api/monitor/usage/quota/limit", { Authorization: key.key });
  expect(r).toMatchObject({ status: "available", planLabel: "pro", windows: [
    { id: "five_hour", usedPct: 1, summary: true, resetsAt: new Date(1800000000000).toISOString() },
    { id: "weekly", usedPct: 56, summary: true }, { id: "mcp:monthly", usedPct: 20 },
  ] });
  expect(JSON.stringify(r)).not.toContain(key.key);
  expect(await readFile(f.path, "utf8")).toBe(before);
});

it("derives legacy utilization only when valid absolutes exist, preserving genuine zero", async () => {
  const f = await fixture({ zai: key });
  const r = await fetchZaiUsage({ path: f.path }, { fetchJson: async () => ({ status: 200, body: { data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, usage: 100, currentValue: 0 }] } } }) });
  expect(r).toMatchObject({ status: "available", windows: [{ usedPct: 0, resetsAt: null }] });
});

it.each([{}, { percentage: "" }, { percentage: false }, { percentage: -1 }])("rejects unusable Z.ai utilization instead of displaying zero: %j", async (value) => {
  const f = await fixture({ zai: key });
  await expect(fetchZaiUsage({ path: f.path }, { fetchJson: async () => ({ status: 200, body: { data: { limits: [{ type: "CREDIT_LIMIT", ...value }] } } }) })).rejects.toThrow(/unsupported shape|valid utilization/);
});

it("recognizes Z.ai application-level authentication rejection even on HTTP 200", async () => {
  const f = await fixture({ zai: key });
  expect(await fetchZaiUsage({ path: f.path }, { fetchJson: async () => ({ status: 200, body: { code: 401, success: false } }) })).toMatchObject({ status: "unavailable", problem: { kind: "rejected", status: 401 } });
});

it("keeps missing quotas unavailable instead of creating empty success cards", async () => {
  const f = await fixture({ "chatgpt-subscription": oauth, zai: key });
  const fetchJson = async () => ({ status: 200, body: {} });
  expect(await fetchCodexUsage({ path: f.path }, { fetchJson })).toMatchObject({ status: "unavailable", problem: { kind: "no_quota" } });
  expect(await fetchZaiUsage({ path: f.path }, { fetchJson })).toMatchObject({ status: "unavailable", problem: { kind: "no_quota" } });
});

it("registers two native usage sources without creating agent providers", () => {
  const sources: UsageSourceRegistration[] = [];
  registerUsageSources({ registerUsageSource: (source) => sources.push(source) });
  expect(sources.map((s) => s.id)).toEqual(["omo-codex", "omo-zai"]);
});
