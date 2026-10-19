import { expect, test } from "vitest";
import { normalizeTask } from "./dag-store.js";

const task = (extra: Record<string, unknown>) => normalizeTask({ task_id: "st_model", ...extra });

test("provider-qualified OpenAI labels are readable and retain the exact model reference", () => {
  expect(task({ resolved_model: { provider: "chatgpt-subscription", model_id: "gpt-6-luna-fast", display: "chatgpt-subscription/gpt-6-luna-fast" } }))
    .toMatchObject({ model: "GPT-6 Luna Fast", modelRef: "chatgpt-subscription/gpt-6-luna-fast" });
});

test("effective model wins over the initial route and the requested provider remains inspectable", () => {
  expect(task({
    requested_model: { provider: "zai", model_id: "glm-5.3-flash" },
    resolved_model: { provider: "chatgpt-subscription", model_id: "gpt-6-luna-fast" },
    effective_model: { provider: "chatgpt-subscription", model_id: "gpt-6-luna", display: "chatgpt-subscription/gpt-6-luna" },
  })).toMatchObject({ model: "GPT-6 Luna", modelRef: "chatgpt-subscription/gpt-6-luna", requestedModel: "zai/glm-5.3-flash", resolvedModel: "chatgpt-subscription/gpt-6-luna-fast" });
});

test("existing friendly names survive when the effective model is the same route", () => {
  const result = task({
    requested_model: { provider: "zai", model_id: "glm-5.3-flash" },
    resolved_model: { provider: "zai", model_id: "glm-5.3-flash", display: "GLM-5.3-Flash" },
    effective_model: { provider: "zai", model_id: "glm-5.3-flash", display: "zai/glm-5.3-flash" },
  });
  expect(result).toMatchObject({ model: "GLM-5.3-Flash", modelRef: "zai/glm-5.3-flash" });
  expect(result?.requestedModel).toBeUndefined();
  expect(result?.resolvedModel).toBeUndefined();
});

test("older records and unfamiliar provider names remain usable", () => {
  expect(task({ model: "custom/my-model" })).toMatchObject({ model: "my-model", modelRef: "custom/my-model" });
  expect(task({ resolved_model: { display: "Claude Opus 5.5" } })).toMatchObject({ model: "Claude Opus 5.5" });
  expect(task({})?.model).toBeUndefined();
});
