# orca-mirror (herdr plugin `csqc.orca-mirror`)

herdr owns terminal processes; Orca only displays them. Each herdr pane gets one Orca tab (or a split of
the tab that shows its herdr-tab sibling) running our attach loop:
`exec node src/main.ts attach --pane <pane_id> --terminal <terminal_id> --herdr <herdr>`.

The loop runs a bridge (`src/bridge.ts`), not `herdr terminal attach`: a direct-attach/controller client
owns the herdr PTY size, so the bridge stays a read-only `terminal session observe` (renders at Orca's
size, never resizes) and only switches to `terminal session control --takeover` when the Orca pane gets
focus (xterm focus report, enabled with `ESC[?1004h`) or input. On blur it resizes the PTY back to
herdr's layout rect (`herdr pane layout`) and sends `terminal.release`. Control protocol (verified):
`{"type":"terminal.input","bytes":<b64>}`, `{"type":"terminal.resize","cols","rows"}`,
`{"type":"terminal.release"}`; closed reasons include `terminal attach taken over` and `detached`.
`orca-mirror upgrade-tabs` replaces tabs still running a plain `herdr terminal attach --takeover`.

## Commands

- Tests: `pnpm test` (node:test, TypeScript via Node 22 type stripping, no build step)
- Typecheck: `pnpm typecheck`
- CLI (shim at `~/.local/bin/orca-mirror`, reinstall with `orca-mirror install-shim` if the repo moves):
  - `orca-mirror sync --dry-run` — print the plan, change nothing
  - `orca-mirror open [--pane ID]` — show one pane in Orca; succeeds only after the attach is seen in Orca
  - `orca-mirror doctor` — versions, pairs, what is not shown and why, leftovers
- herdr: `herdr plugin link "$PWD"`; hooks: startup + `pane.created` → `sync`; actions `open`, `sync`, `doctor`

## Facts verified on herdr 0.9.1/0.9.5 + Orca 1.4.229

- `orca terminal list/show` never return the tab command. Pairing = live attach processes whose env
  `ORCA_PANE_KEY` (= Orca `tabId:leafId`) matches the list (`recordedPaneKey` for orphaned rows).
- herdr live update (`herdr update --handoff`) keeps processes and pane ids but gives every terminal a
  new terminal_id and drops all attach clients. The attach loop reattaches the same pane in place;
  scanning counts a loop by pane id so the startup hook does not duplicate tabs meanwhile.
- `HERDR_BIN_PATH` can point into a versioned Homebrew Cellar dir; long-lived loops use the PATH `herdr`.
- Orca hides `.claude/worktrees/*` (built-in "Claude Code" source) and, for repos added after 2026-05-23,
  external worktrees (`orca repo set --external-worktree-visibility show` fixes the latter only).
- `orca terminal create --json` returns `handle`, `tabId`, `paneKey`; `terminal split` returns `tabId`+`leafId`.

## Safety

- State file `~/.local/state/herdr/plugins/csqc.orca-mirror/state.json` only blocks a second automatic
  create per terminal_id; ambiguous Orca failures are never retried automatically.
- Config `~/.config/herdr/plugins/config/csqc.orca-mirror/config.toml` (`include_paths` empty = all repos).
  A broken config disables syncing.
- Do not modify `/Users/csqc/src/herdr-orca` (legacy plugin) or its config/daemon.
- Orca CLI has no `repo rm`; `orca worktree rm` deletes the git worktree too — never call it.
- Test in dedicated herdr workspaces on `/Users/csqc/src/orca-mirror-testrepo`; close only what you created.
- Orca can bring back a closed/replaced tab (restored layout, fresh shell, sometimes an auto-resumed agent).
  Tab ids replaced by `upgrade-tabs` are kept in `state.retiredTabs`; every sync closes those tabs when they
  show up idle (no attach, no agent, screen at a prompt). Retired tabs running an agent are left alone.
- Sidebar mirroring (`mirror_sidebar`, default on): every herdr workspace's worktree is made visible in
  Orca. External worktrees: `orca repo set --external-worktree-visibility show`. Worktrees hidden by a
  per-source policy (`.claude/worktrees`, `.gsd-workspaces`): only via Orca's internal runtime RPC
  `repo.update` → `importedExternalWorktreePaths` (`src/orca-rpc.cjs`, run with Orca's Electron in node mode).
