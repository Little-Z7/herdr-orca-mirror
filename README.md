# herdr-orca-mirror

A [herdr](https://herdr.dev) plugin that shows herdr terminals as tabs in the matching
Orca worktree. herdr owns the processes; Orca only displays them. One-way: herdr → Orca.

- Every new herdr tab / split / workspace / worktree workspace gets an Orca tab (splits stay splits).
- No duplicates across plugin, Orca or herdr restarts: pairing is read from live attach processes
  (`ORCA_PANE_KEY`), not from tab titles or commands.
- Orca tabs never fight herdr over the terminal size: they observe read-only and only take control while
  you focus or type in Orca, then hand the size back.
- Survives `herdr update --handoff` (terminal ids change; tabs reattach in place).
- Makes every herdr workspace's worktree visible in Orca's sidebar.
- Closing an Orca tab only detaches; the herdr process keeps running and the tab is not reopened.

## Requirements

macOS, herdr ≥ 0.9.1, Orca ≥ 1.4.229 (with the `orca` CLI on PATH), Node ≥ 22.18 (runs TypeScript directly).

## Install

```bash
git clone https://github.com/Little-Z7/herdr-orca-mirror.git
herdr plugin link "$PWD/herdr-orca-mirror"
node --disable-warning=ExperimentalWarning herdr-orca-mirror/src/main.ts install-shim   # ~/.local/bin/orca-mirror
orca-mirror doctor
```

## Commands

| Command | What it does |
| --- | --- |
| `orca-mirror sync [--dry-run]` | Create missing Orca tabs (runs automatically on herdr `pane.created` and startup) |
| `orca-mirror open` | In a herdr pane: show it in Orca and confirm it attached |
| `orca-mirror doctor` | Versions, what is shown, what is not and why |
| `orca-mirror upgrade-tabs` | Replace tabs running a plain `herdr terminal attach --takeover` |

## Config

`~/.config/herdr/plugins/config/csqc.orca-mirror/config.toml`

```toml
[sync]
include_paths = []        # only mirror repos under these paths; empty = all
auto_add_repo = true      # orca repo add unknown git repos
mirror_splits = true      # herdr splits become Orca splits
mirror_sidebar = true     # make herdr worktrees visible in Orca's sidebar
```

Showing worktrees under `.claude/worktrees` uses Orca's internal runtime RPC (not part of the public CLI)
and may break with future Orca versions.

## Development

`pnpm test` · `pnpm typecheck` · see `AGENTS.md`.

## License

MIT
