# Isolated Paseo 0.11.4 trial fork

Historical notes from the initial isolated trial. The integration is now published at
https://github.com/Phototonic/pase-omo, retaining the MIT license and upstream history.
The observations below describe that initial validation stage, not the current
provider authentication, deployment or acceptance state. See FORK.md.

- Base: `7eedceb5cbc4ae636e0638d0ee31a78129698e92`.
- Background-work PR #28: `15c41da5642b0ecc9de291cdadf57eba57a991c6`, incorporated with its original history. Skipped-DAG and session-environment review fixes are already included.
- Contracts: Paseo client/plugin/protocol 0.11.4 and Senpi 2026.10.16. Supported trial range: Paseo >=0.11.4 <0.12.0. Tested runtime: OmO 5.1.35 with its pinned Senpi 2026.10.16, on Node 24.19.0.
- npm is the trial package manager. `package-lock.json` replaces the stale upstream `bun.lock`.

## Local changes

`PASEO_OMO_DISABLE_UPDATE=1` prevents global installation before any session is suspended, suppresses registry checks, and shows an explanatory status. Restart-only operations remain available. The isolated launcher sets this flag; the fork alone is not a filesystem sandbox.

The task watcher recognizes current engine terminal states `interrupted` and `lost`, and maps cancellation/interruption to canceled rather than successful completion. Unreadable/corrupt task files throw rather than silently becoming an empty task list. After three occupancy-probe failures, chat shows one updatable diagnostic and regular polling backs off to 15 seconds. Recovery replaces that diagnostic and resumes completion tracking.

## State contract

The current engine may store project tasks under its canonical agent root rather than `<cwd>/.omo/senpi-task`. This trial sets `task.state_dir` in its private global `omo.jsonc` and passes the same absolute directory as `PASEO_OMO_TASK_STATE_DIR` to every plugin reader. The adapter override alone does not redirect the engine. Future project overrides must keep both sides aligned.

`PASEO_OMO_COMMAND` points at the exact local Node runtime and pinned omo-ai launcher. No executable-resolution patch was needed.

## Validation and limits

Original main: 405 tests and typecheck passed. Final fork: 453 tests and typecheck passed. The real engine answered get_state, get_available_models, and get_commands without a generation request. Authenticated local UI/API and WebSocket admission were checked separately. OmO registered successfully; no provider credentials are present, so the model catalogue is currently empty.

Live provider tasks, background execution, task survival, billing, and remote access are NOT validated by these checks. Full child-transcript fidelity remains constrained by OmO issue #10201. Remove compatibility patches only after equivalent upstream behavior is verified.
