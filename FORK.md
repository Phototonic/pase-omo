# Phototonic pase-omo integration fork

Upstream: https://github.com/Hakubisual/pase-omo. MIT license retained.

## Branches and provenance

- `main` follows the upstream default branch.
- `live/native-install` contains the integration used by the installed plugin,
  plus this fork documentation. The baseline before manual compaction is
  `0a19e45`; native worker output, skills/context and DAG observability are
  already deployed there.
- `fix/worker-transcripts`, `fix/skills-and-context` and `fix/dag-observability`
  preserve the development history of those integrated fixes.
- `fix/manual-compaction` adds an explicit native compaction command with an
  idle guard, cancellation and context refresh. Deploy only during an all-idle
  window; it does not update the engine or desktop application.
- `fix/dag-attempt-display`, `fix/mobile-dag-scrolling` and
  `fix/dag-model-labels` are independent contributions based on upstream `main`.

Audrey Tang's background-work changes (`e4f5799`, `30b20b7`, `15c41da`) are
included with original authorship from upstream PR #28. They are not new
Phototonic contributions and must not be submitted as a duplicate PR.

## Integration changes

- Background occupancy, terminal/interrupted/lost states and visible read errors.
- An opt-out for global updates in isolated environments; ordinary native update
  behavior remains available when isolation is not requested.
- MCP forwarding into OmO, including stdio, Streamable HTTP, legacy SSE through
  a private transport relay, and session environment propagation.
- Native task-state configuration discovery, using the same store for DAG and
  worker readers; ESM JSONC import compatible with Paseo's production evaluator.
- Codex and Z.ai subscription usage reporting through the host usage panel.
- Correct DAG attempt numbering and mobile popover scrolling.
- Worker-output/history and effective-model display changes.
- Native global/project skill entries in Paseo's slash menu, including resource
  reloads; `/skill:name` invokes Senpi's supported skill parser.
- Native context-used and capacity estimates, refreshed during work, compaction
  and model changes. Unknown estimates remain unknown instead of becoming zero.
- Native terminal reasons and a bounded, incremental activity reader for running
  DAG workers. Observed tool counts and last recorded activity are presented
  separately from native totals; unreadable or partial logs remain visible.
- `/compact [instructions]` delegates to native compaction only after the
  session's occupancy is readable and idle; it supports cancellation and the
  current `compaction_end` event as well as the legacy event spelling.

The integration pins Paseo development packages to 0.11.4 and Senpi to
2026.10.16; the integration was exercised with OmO 5.1.35 and read-only live
acceptance repeated after the normal update to OmO 5.1.38 / Senpi 2026.10.19.
These pins and the npm lockfile are
integration choices, not requirements imposed on the small upstream UI PRs.

## Validation

On 2026-10-20, the compaction integration passed 542 tests across 73 files,
TypeScript and Paseo 0.12.0 production compilation. The private 19-check
acceptance covers native compaction RPC routing, command/context restoration,
worker output, DAG metadata, plugin reload and reconnects using a fake OmO
process; it does not claim a real long session was summarized. Read-only live
acceptance after the native 5.1.38 update verified three saved parents, global
and project skills, context, three-provider worker history, DAGs, model and
usage catalogues, reconnect stability and seven MCPs, including a browser
read call. No paid generation was requested.

Known upstream limits remain: Paseo's provider adapter classifies plugin skills
as ordinary commands, hiding them from inline completion (#7443), and native
5.1.38 predates the plan-gate reload handoff fix (OmO #9849 / #10143). Neither
issue is repaired by changing model routes or restarting a working session.

On 2026-10-19, the combined pending feature branch passed 528 tests in 72 files,
TypeScript checks, and Paseo production bundle compilation/evaluation.
Independent review approved the three small upstream contribution diffs; its
two model-display findings were corrected and regression-tested.
Deterministic fixture tests against an isolated Paseo 0.11.4 daemon covered
worker text/tool output, WebSocket reconnects, output after reconnect, and
history rebuilding after plugin reload without duplicate final messages.
The skills/context extension additionally covered the host command menu, native
skill invocation parsing, live context updates, unknown post-compaction estimates,
and context/skill restoration across reconnects and plugin reloads. The fixture
used the 11 global and four Voxetra skill names found by native discovery. This
proves routing and presentation data, not model compliance with skill bodies.
Read-only replay also recovered worker transcripts from all three providers.
These checks did not request paid model generations and did not modify or reload
the active installation.

The updated deterministic harness passed all 16 checks against private 0.11.4
and 0.12.0 daemons, including DAG activity and cancellation reasons. The runtime
manifest admits both minor releases; development dependencies remain pinned.
This is fixture-level compatibility evidence, not a live 0.12.0 desktop test.
The full integration suite uses a private home: running tests against the real
home allowed native task-store configuration to override legacy test fixtures,
causing 13 failures in unrelated fixture readers. That diagnostic run is retained;
the private-home suite and the upstream-dependency suite passed.

Independent review of the focused activity/reason contribution found no blockers.
Its two minor suggestions (read-budget catch-up coverage and precise buffer
privacy documentation) were implemented before submission. The separate host
status-overwrite regression remains reproducible in published Paseo 0.12.0 and
is tracked at https://github.com/getpaseo/paseo/issues/7390.

The Android DAG popover scrolling correction was confirmed on a physical device.
A passing test suite does not assert that every feature works on every Paseo or
OmO version. PR-specific validation and independent review belong in each PR.

## Upstream contribution plan

Opened as independent contributions, without merging or enabling auto-merge:

- [#30 — native DAG attempt numbers](https://github.com/Hakubisual/pase-omo/pull/30):
  405 tests and TypeScript passed with upstream dependencies.
- [#31 — mobile DAG popover scrolling](https://github.com/Hakubisual/pase-omo/pull/31):
  405 tests and TypeScript passed on the isolated rerun; physical Android
  acceptance passed on Paseo 0.11.4. The initial parallel run's unrelated
  catalog-cache failure is disclosed in the PR.
- [#32 — effective model labels and routing detail](https://github.com/Hakubisual/pase-omo/pull/32):
  410 tests and TypeScript passed with upstream dependencies.
- [#33 — native terminal reasons and recorded worker activity](https://github.com/Hakubisual/pase-omo/pull/33):
  focused contribution from the independently validated integration.

All three received an independent agent source review before submission.
Upstream-dependency validation used Paseo 0.8.0 / Senpi 2026.9.26. The newer
integration was validated separately; no SDK version bump is included in these
contributions.

MCP forwarding, usage integration and native state discovery need separately
scoped comparisons and review before upstream submission.
Worker transcript integration currently builds on PR #28 and the native task
store changes; preserve its branch rather than submitting the entire integration
as one overlapping PR.

`TRIAL.md` is retained as historical provenance and contains initial-stage
results and limitations that have since changed. No credentials, machine
configuration, pairing links or task transcripts are part of this fork.
