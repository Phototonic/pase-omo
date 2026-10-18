import { readFile } from "node:fs/promises";
import { get } from "node:https";
import { join } from "node:path";
import { z } from "zod";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  hashAccountKey, toneFromUsedPct, unavailable, usedPctOf,
  windowFromReportedDuration, windowFromUsedPct,
  type UsageAccount, type UsageReport, type UsageScope, type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import { agentDir } from "../provider/omo-store.js";

const inputSchema = z.object({ path: z.string().min(1) }).strict();
const oauthSchema = z.object({ type: z.literal("oauth"), access: z.string().min(1), accountId: z.string().optional(), expires: z.number().finite().optional() });
const keySchema = z.object({ type: z.literal("api_key"), key: z.string().min(1) });
type Provider = "codex" | "zai";
type JsonResponse = { status: number; body: unknown };
type FetchJson = (url: string, headers: Record<string, string>) => Promise<JsonResponse>;
interface Dependencies { env?: NodeJS.ProcessEnv; fetchJson?: FetchJson; now?: () => number }

/** Bounded reads, normal TLS verification, no redirects or credential-bearing error bodies. */
export function fetchQuotaJson(url: string, headers: Record<string, string>): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const request = get(url, {
      headers: { ...headers, Accept: "application/json" },
      // Dual-stack Node GETs timed out here while IPv4 GETs succeeded.
      // Keep the preference local to this GET; do not alter daemon DNS/TLS settings.
      ...(new URL(url).hostname === "api.z.ai" ? { family: 4 } : {}),
      signal: AbortSignal.timeout(12_000),
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (status !== 200) { response.resume(); resolve({ status, body: null }); return; }
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > 1_048_576) { response.destroy(); reject(new Error("Quota response exceeded size limit")); }
        else chunks.push(chunk);
      });
      response.on("error", () => reject(new Error("Quota response interrupted")));
      response.on("end", () => {
        try { resolve({ status, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
        catch { reject(new Error("Quota endpoint returned invalid JSON")); }
      });
    });
    request.on("error", () => reject(new Error("Quota endpoint connection failed or timed out")));
  });
}

async function readStore(path: string): Promise<Record<string, unknown> | null> {
  try { return z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(path, "utf8"))); }
  catch { return null; }
}

function codexAuth(store: Record<string, unknown> | null) {
  const result = oauthSchema.safeParse(store?.["chatgpt-subscription"] ?? store?.["openai-codex"]);
  return result.success ? result.data : null;
}
function zaiAuth(store: Record<string, unknown> | null) {
  const result = keySchema.safeParse(store?.zai);
  return result.success ? result.data : null;
}

export async function discoverUsage(provider: Provider, scope: UsageScope, deps: Dependencies = {}): Promise<UsageAccount[]> {
  // Global account panel only. Do not attribute every stored login to a Claude chat.
  if (scope.kind !== "global") return [];
  const path = join(agentDir(deps.env ?? process.env), "auth.json");
  const store = await readStore(path);
  const auth = provider === "codex" ? codexAuth(store) : zaiAuth(store);
  if (!auth) return [];
  const identity = provider === "codex" && "accountId" in auth && auth.accountId
    ? auth.accountId : path;
  return [{ key: hashAccountKey(`${provider}:${identity}`), harness: "OmO", input: { path } }];
}

const number = z.union([z.number(), z.string().trim().min(1)]).transform(Number).refine(Number.isFinite);
const percent = number.refine((value) => value >= 0 && value <= 100);
const quotaWindow = z.object({ used_percent: percent.nullish(), reset_at: number.nullish(), limit_window_seconds: number.nullish() });
const rateLimit = z.object({ primary_window: quotaWindow.nullish(), secondary_window: quotaWindow.nullish() });
const codexResponse = z.object({
  plan_type: z.string().optional(), rate_limit: rateLimit.nullish(),
  additional_rate_limits: z.array(z.object({ limit_name: z.string().optional(), metered_feature: z.string().optional(), rate_limit: rateLimit.nullish() })).nullish(),
  code_review_rate_limit: rateLimit.nullish(),
});
function isoEpoch(value: number | null | undefined, milliseconds = false): string | null {
  if (value == null || value <= 0) return null;
  const date = new Date(milliseconds ? value : value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function codexWindows(limit: z.infer<typeof rateLimit> | null | undefined, scope?: { id: string; label: string }): UsageWindow[] {
  return (["primary_window", "secondary_window"] as const).flatMap((slot) => {
    const value = limit?.[slot];
    if (!value) return [];
    return [windowFromReportedDuration({ durationSeconds: value.limit_window_seconds ?? null,
      unknown: { id: slot, label: slot === "primary_window" ? "Primary limit" : "Secondary limit", shortLabel: "" },
      ...(scope ? { scope } : {}), utilizationPct: value.used_percent, resetsAt: isoEpoch(value.reset_at),
      summary: !scope, tone: toneFromUsedPct(value.used_percent) })];
  });
}

export async function fetchCodexUsage(input: unknown, deps: Dependencies = {}): Promise<UsageReport> {
  const { path } = inputSchema.parse(input);
  const auth = codexAuth(await readStore(path));
  if (!auth) return unavailable({ kind: "no_quota", detail: "OmO Codex login missing or unreadable" });
  if (auth.expires !== undefined && auth.expires <= (deps.now ?? Date.now)())
    return unavailable({ kind: "expired", expiresAt: new Date(auth.expires).toISOString(), refreshedBy: "OmO" });
  const response = await (deps.fetchJson ?? fetchQuotaJson)("https://chatgpt.com/backend-api/wham/usage", {
    Authorization: `Bearer ${auth.access}`, ...(auth.accountId ? { "ChatGPT-Account-Id": auth.accountId } : {}),
  });
  if ([401, 403].includes(response.status)) return unavailable({ kind: "rejected", status: response.status, refreshedBy: "OmO" });
  if (response.status !== 200) throw new Error(`Codex quota endpoint returned HTTP ${response.status}`);
  const parsed = codexResponse.safeParse(response.body);
  if (!parsed.success) throw new Error("Codex quota response has an unsupported shape");
  const body = parsed.data;
  const windows = [...codexWindows(body.rate_limit), ...(body.additional_rate_limits ?? []).flatMap((entry) => {
    const id = entry.metered_feature || entry.limit_name;
    return id ? codexWindows(entry.rate_limit, { id: `limit:${encodeURIComponent(id)}`, label: entry.limit_name || id }) : [];
  }), ...codexWindows(body.code_review_rate_limit, { id: "code_review", label: "Code review" })];
  if (!windows.length) return unavailable({ kind: "no_quota", detail: "Codex returned no allowance windows" });
  return { status: "available", ...(body.plan_type ? { planLabel: body.plan_type } : {}), windows };
}

const zaiResponse = z.object({
  code: number.optional(), success: z.boolean().optional(),
  data: z.object({ level: z.string().optional(), limits: z.array(z.object({
    type: z.string(), unit: number.optional(), number: number.optional(), percentage: number.nullish(),
    usage: number.nullish(), currentValue: number.nullish(), nextResetTime: number.nullish(),
  })) }).optional(),
});
export async function fetchZaiUsage(input: unknown, deps: Dependencies = {}): Promise<UsageReport> {
  const { path } = inputSchema.parse(input);
  const auth = zaiAuth(await readStore(path));
  if (!auth) return unavailable({ kind: "no_quota", detail: "OmO Z.ai login missing or unreadable" });
  // Z.ai's own usage-query plugin sends the raw coding-plan key on this endpoint.
  const response = await (deps.fetchJson ?? fetchQuotaJson)("https://api.z.ai/api/monitor/usage/quota/limit", { Authorization: auth.key });
  if ([401, 403].includes(response.status)) return unavailable({ kind: "rejected", status: response.status });
  if (response.status !== 200) throw new Error(`Z.ai quota endpoint returned HTTP ${response.status}`);
  const parsed = zaiResponse.safeParse(response.body);
  if (!parsed.success) throw new Error("Z.ai quota response has an unsupported shape");
  const body = parsed.data;
  if (body.code === 401 || body.code === 403) return unavailable({ kind: "rejected", status: body.code });
  if (body.success === false || (body.code !== undefined && body.code !== 200)) throw new Error("Z.ai quota endpoint rejected the query");
  const windows = (body.data?.limits ?? []).flatMap((limit, index): UsageWindow[] => {
    if (!["TOKENS_LIMIT", "CREDIT_LIMIT", "TIME_LIMIT"].includes(limit.type)) return [];
    const pct = limit.percentage ?? usedPctOf(limit.currentValue, limit.usage);
    if (pct === null || pct < 0 || pct > 100) throw new Error("Z.ai quota window is missing valid utilization");
    const scope = limit.type === "TIME_LIMIT" ? { id: "mcp", label: "MCP requests" } : undefined;
    const resetsAt = isoEpoch(limit.nextResetTime, true);
    if (limit.unit === 5 && limit.number === 1)
      return [windowFromUsedPct({ id: scope ? "mcp:monthly" : "monthly", label: scope ? "MCP requests · Monthly" : "Monthly", utilizationPct: pct, resetsAt, summary: !scope, tone: toneFromUsedPct(pct) })];
    const duration = limit.number && limit.number > 0 ? (limit.unit === 3 ? limit.number * 3600 : limit.unit === 6 ? limit.number * 604800 : null) : null;
    return [windowFromReportedDuration({ durationSeconds: duration, ...(scope ? { scope } : {}), unknown: { id: `unknown_${limit.type}_${index}`, label: "Reported quota", shortLabel: "" }, utilizationPct: pct, resetsAt, summary: !scope, tone: toneFromUsedPct(pct) })];
  });
  if (!windows.length) return unavailable({ kind: "no_quota", detail: "Z.ai returned no recognized quota windows" });
  return { status: "available", ...(body.data?.level ? { planLabel: body.data.level } : {}), windows };
}

export function registerUsageSources(server: Pick<PluginServerContext, "registerUsageSource">): void {
  for (const provider of ["codex", "zai"] as const) server.registerUsageSource({
    id: `omo-${provider}`, label: provider === "codex" ? "Codex" : "Z.ai", input: inputSchema,
    discover: (scope) => discoverUsage(provider, scope),
    fetch: provider === "codex" ? fetchCodexUsage : fetchZaiUsage,
  });
}
