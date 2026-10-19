import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { dagRunsDir, taskStateDir } from "./task-state.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * The DAG runs tree has two readers: the snapshot RPCs (server/dag) and the
 * timeline publisher (server/chat). Before the merge only the first honoured
 * PASEO_OMO_TASK_STATE_DIR, so with the override set one reader saw runs the
 * other could not.
 */
test("an override redirects the runs directory for every reader", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-task-state-"));
  roots.push(root);
  const cwd = join(root, "project");
  const override = join(root, "elsewhere");

  expect(taskStateDir(cwd, {})).toBe(resolve(join(cwd, ".omo", "senpi-task")));
  expect(taskStateDir(cwd, { PASEO_OMO_TASK_STATE_DIR: override })).toBe(resolve(override));
  expect(dagRunsDir(cwd, { PASEO_OMO_TASK_STATE_DIR: override })).toBe(resolve(join(override, "dag", "runs")));
});

test("the legacy OMO_HERDR_DAG_TASK_STATE_DIR name still works, but loses to the current one", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-task-state-"));
  roots.push(root);
  const cwd = join(root, "project");

  expect(taskStateDir(cwd, { OMO_HERDR_DAG_TASK_STATE_DIR: join(root, "legacy") })).toBe(resolve(join(root, "legacy")));
  expect(
    taskStateDir(cwd, { PASEO_OMO_TASK_STATE_DIR: join(root, "current"), OMO_HERDR_DAG_TASK_STATE_DIR: join(root, "legacy") }),
  ).toBe(resolve(join(root, "current")));
});

test("an empty override is ignored rather than resolving to the process cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-task-state-"));
  roots.push(root);
  const cwd = join(root, "project");
  expect(taskStateDir(cwd, { PASEO_OMO_TASK_STATE_DIR: "  " })).toBe(resolve(join(cwd, ".omo", "senpi-task")));
});

test("normal native config supplies the task store without a launcher override", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "omo-native-config-")); roots.push(root);
  await mkdir(join(root, ".omo"), { recursive: true });
  await writeFile(join(root, ".omo", "omo.jsonc"), JSON.stringify({ task: { state_dir: join(root, "tasks") } }));
  const cwd = join(root, "project");
  expect(taskStateDir(cwd, { HOME: root })).toBe(join(root, "tasks"));
  expect(dagRunsDir(cwd, { HOME: root })).toBe(join(root, "tasks", "dag", "runs"));
});

test("project native JSONC overrides the global store and environment remains explicit", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "omo-native-config-")); roots.push(root);
  const cwd = join(root, "project");
  await mkdir(join(root, ".omo"), { recursive: true }); await mkdir(join(cwd, ".omo"), { recursive: true });
  await writeFile(join(root, ".omo", "omo.jsonc"), JSON.stringify({ task: { state_dir: join(root, "global") } }));
  await writeFile(join(cwd, ".omo", "omo.jsonc"), '{ // native overlay, including a trailing comma\n "task":{"state_dir":"unused"}, "[native]":{"task":{"state_dir":"./local-state",}},\n}');
  expect(taskStateDir(cwd, { HOME: root })).toBe(join(cwd, "local-state"));
  expect(taskStateDir(cwd, { HOME: root, PASEO_OMO_TASK_STATE_DIR: join(root, "explicit") })).toBe(join(root, "explicit"));
});
