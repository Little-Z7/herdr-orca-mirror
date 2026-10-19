import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrcaCommandError, type CreatedTerminal, type OrcaCli, type OrcaRepo, type OrcaTerminal } from "../src/orca.ts";
import type { RunResult, Runner } from "../src/run.ts";

export type FakePane = {
  paneId: string;
  terminalId: string;
  workspaceId: string;
  tabId: string;
  cwd: string;
  rect?: { x: number; y: number; width: number; height: number };
};
export type FakeWorkspace = {
  workspaceId: string;
  label: string;
  worktree?: { checkout_path: string; repo_root: string; is_linked_worktree: boolean };
};
export type FakeAttach = {
  pid: number;
  terminalId: string;
  paneKey: string | null;
  env: "orca" | "other" | "unreadable";
  /** Set for our attach loop (`main.ts attach --pane ...`); absent for a bare `herdr terminal attach`. */
  loopPaneId?: string;
};

export type World = {
  panes: FakePane[];
  workspaces: FakeWorkspace[];
  /** cwd -> git toplevel + common dir parent */
  git: Record<string, { top: string; repoRoot: string }>;
  attach: FakeAttach[];
  orcaTerminals: OrcaTerminal[];
  repos: OrcaRepo[];
  reachable: boolean;
};

export function makeWorld(partial: Partial<World> = {}): World {
  return {
    panes: [],
    workspaces: [],
    git: {},
    attach: [],
    orcaTerminals: [],
    repos: [],
    reachable: true,
    ...partial,
  };
}

export function snapshotJson(w: World): unknown {
  const tabIds = [...new Set(w.panes.map((p) => p.tabId))];
  return {
    result: {
      snapshot: {
        panes: w.panes.map((p) => ({ pane_id: p.paneId, terminal_id: p.terminalId, workspace_id: p.workspaceId, tab_id: p.tabId, cwd: p.cwd })),
        tabs: tabIds.map((tabId, i) => ({ tab_id: tabId, workspace_id: tabId.split(":")[0], label: String(i + 1), number: i + 1 })),
        workspaces: w.workspaces.map((ws) => ({ workspace_id: ws.workspaceId, label: ws.label, ...(ws.worktree ? { worktree: ws.worktree } : {}) })),
        layouts: tabIds.map((tabId) => ({
          tab_id: tabId,
          panes: w.panes
            .filter((p) => p.tabId === tabId)
            .map((p) => ({ pane_id: p.paneId, rect: p.rect ?? { x: 0, y: 0, width: 200, height: 60 } })),
        })),
      },
    },
  };
}

const ok = (stdout: string): RunResult => ({ status: 0, stdout, stderr: "" });

export function fakeRunner(w: World): Runner & { calls: string[][] } {
  const calls: string[][] = [];
  const cmdline = (a: FakeAttach) =>
    a.loopPaneId
      ? `/usr/bin/node --disable-warning=ExperimentalWarning /x/src/main.ts attach --pane ${a.loopPaneId} --terminal ${a.terminalId} --herdr /opt/homebrew/bin/herdr`
      : `/opt/homebrew/bin/herdr terminal attach ${a.terminalId} --takeover`;
  const run = ((argv: string[]) => {
    calls.push(argv);
    const [cmd, ...args] = argv;
    if (cmd?.endsWith("herdr") && args[0] === "api" && args[1] === "snapshot") return ok(JSON.stringify(snapshotJson(w)));
    if (cmd?.endsWith("herdr") && args[0] === "--version") return ok("herdr 0.9.5\n");
    if (cmd?.endsWith("herdr") && args[0] === "plugin") return ok(JSON.stringify({ result: { plugins: [] } }));
    if (cmd?.endsWith("herdr") && args[0] === "notification") return ok("{}");
    if (cmd === "ps" && args[0] === "-axww") return ok(w.attach.map((a) => `${a.pid} ${cmdline(a)}`).join("\n"));
    if (cmd === "ps" && args[0] === "-ww") {
      return ok(
        w.attach
          .map((a) => {
            const base = `${a.pid} ${cmdline(a)}`;
            if (a.env === "orca") return `${base} PATH=/usr/bin TERM_PROGRAM=Orca ORCA_PANE_KEY=${a.paneKey}`;
            if (a.env === "other") return `${base} PATH=/usr/bin TERM_PROGRAM=ghostty`;
            return base;
          })
          .join("\n"),
      );
    }
    if (cmd === "git" && args[0] === "-C") {
      const g = w.git[args[1] ?? ""];
      return g ? ok(`${g.top}\n${g.repoRoot}/.git\n`) : { status: 128, stdout: "", stderr: "not a git repository" };
    }
    return { status: 127, stdout: "", stderr: `unexpected command ${argv.join(" ")}` };
  }) as Runner & { calls: string[][] };
  run.calls = calls;
  return run;
}

export type OrcaCall = { op: string; args: Record<string, unknown> };

/**
 * Fake Orca that mutates the world like the real thing: a created tab spawns an attach process whose
 * ORCA_PANE_KEY names the new pane (unless `attachStarts` is false).
 */
export function fakeOrca(
  w: World,
  behavior: {
    attachStarts?: boolean;
    createError?: OrcaCommandError;
    splitError?: OrcaCommandError;
  } = {},
): OrcaCli & { calls: OrcaCall[] } {
  const calls: OrcaCall[] = [];
  const imported: string[] = [];
  let seq = 0;
  const spawn = (command: string, tabId: string, worktreePath: string): CreatedTerminal => {
    seq += 1;
    const leafId = `leaf${seq}`;
    const handle = `term_orca${seq}`;
    const paneKey = `${tabId}:${leafId}`;
    w.orcaTerminals.push({ handle, paneKey, worktreeId: `repo::${worktreePath}`, worktreePath, title: null, orphaned: false });
    const loop = command.match(/attach --pane (\S+) --terminal (term_\S+)/);
    if (behavior.attachStarts !== false && loop?.[2]) {
      w.attach.push({ pid: 1000 + seq, terminalId: loop[2], paneKey, env: "orca", loopPaneId: loop[1] });
    }
    return { handle, paneKey };
  };
  return {
    calls,
    status: () => ({ reachable: w.reachable, appVersion: w.reachable ? "1.4.229" : null, state: w.reachable ? "ready" : null }),
    reachable: () => w.reachable,
    listTerminals: () => ({ terminals: [...w.orcaTerminals], truncated: false }),
    listRepos: () => w.repos.map((r) => ({ ...r })),
    listWorktreePaths: () => [...w.repos.map((r) => r.path), ...imported],
    addRepo(path) {
      calls.push({ op: "addRepo", args: { path } });
      const repo = { id: `repo-${w.repos.length + 1}`, path, externalWorktreeVisibility: "hide" };
      w.repos.push(repo);
      return { ...repo };
    },
    showExternalWorktrees(repoId) {
      calls.push({ op: "showExternal", args: { repoId } });
      const repo = w.repos.find((r) => r.id === repoId);
      if (repo) repo.externalWorktreeVisibility = "show";
    },
    createTerminal(opts) {
      calls.push({ op: "create", args: opts });
      if (behavior.createError) throw behavior.createError;
      return spawn(opts.command, `tab${seq + 1}`, opts.worktreePath);
    },
    importWorktree(repoId, path) {
      calls.push({ op: "importWorktree", args: { repoId, path } });
      imported.push(path);
    },
    closeTab(handle) {
      calls.push({ op: "closeTab", args: { handle } });
      w.orcaTerminals = w.orcaTerminals.filter((t) => t.handle !== handle);
    },
    splitTerminal(opts) {
      calls.push({ op: "split", args: opts });
      if (behavior.splitError) throw behavior.splitError;
      const anchor = w.orcaTerminals.find((t) => t.handle === opts.handle);
      const tabId = anchor?.paneKey?.split(":")[0] ?? "tabX";
      return spawn(opts.command, tabId, anchor?.worktreePath ?? "");
    },
  };
}

export function tempDirs(configToml?: string): { stateDir: string; configDir: string } {
  const root = mkdtempSync(join(tmpdir(), "orca-mirror-test-"));
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  if (configToml !== undefined) {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.toml"), configToml);
  }
  return { stateDir, configDir };
}
