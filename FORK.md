# Phototonic pase-omo integration fork

Upstream: https://github.com/Hakubisual/pase-omo. MIT license retained.

## Branches and provenance

- `main` follows the upstream default branch.
- `live/native-install` contains the integration used by the installed plugin,
  plus this fork documentation. Runtime baseline: `dffd5fb`.
- `fix/worker-transcripts` preserves the tested worker transcript and model-label
  changes pending safe deployment. It is not evidence that live sessions have
  been reloaded with those changes.
- `fix/skills-and-context` builds on that branch with native skill commands and
  context-window reporting. It also remains pending while live work is active.
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
- Separate pending worker-output/history and effective-model display changes.
- Native global/project skill entries in Paseo's slash menu, including resource
  reloads; `/skill:name` invokes Senpi's supported skill parser.
- Native context-used and capacity estimates, refreshed during work, compaction
  and model changes. Unknown estimates remain unknown instead of becoming zero.

The integration pins Paseo development packages to 0.11.4 and Senpi to
2026.10.16; it was exercised with OmO 5.1.35. These pins and the npm lockfile are
integration choices, not requirements imposed on the small upstream UI PRs.

## Validation

On 2026-10-19, the combined pending feature branch passed 518 tests in 70 files,
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
