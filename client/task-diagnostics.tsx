import type { PluginTheme } from "@getpaseo/plugin";
import { Text, View } from "react-native";
import type { DagTask } from "../shared/dag.js";

/** Shared by board, cards and chat-popover inspectors. Counts are explicitly observed. */
export function TaskDiagnostics({ task, theme }: { task: DagTask | undefined; theme: PluginTheme }) {
  if (!task) return null;
  const activity = task.lastActivityAt && Number.isFinite(Date.parse(task.lastActivityAt))
    ? new Date(task.lastActivityAt).toLocaleString() : undefined;
  return (
    <View style={{ gap: 6 }}>
      {task.terminalReason ? <Text style={{ color: theme.colors.foreground }}>{`Reason: ${task.terminalReason}`}</Text> : null}
      {task.observedToolCalls !== undefined && task.toolCalls === undefined
        ? <Text style={{ color: theme.colors.foregroundMuted }}>{`Observed tool calls: ${task.observedToolCalls}`}</Text> : null}
      {activity ? <Text style={{ color: theme.colors.foregroundMuted }}>{`Last recorded activity: ${activity}`}</Text> : null}
      {task.activityError ? <Text style={{ color: theme.colors.statusWarning }}>{task.activityError}</Text> : null}
    </View>
  );
}
