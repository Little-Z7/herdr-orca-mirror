import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "./config.ts";
import { canonical, isInside, resolveGit, type GitInfo } from "./git.ts";
import { readHerdrSnapshot, type HerdrPane, type HerdrSnapshot } from "./herdr.ts";
import { OrcaCommandError, type OrcaCli, type OrcaRepo, type OrcaTerminal } from "./orca.ts";
import { scanAttachProcesses, type AttachProcess } from "./procscan.ts";
import {
  classify,
  hiddenBySource,
  nextState,
  planCreates,
  retiredToClose,
  visibilityActions,
  type CreateOp,
  type Status,
  type Target,
  type WorktreeRef,
} from "./reconcile.ts";
import { psQuote, shQuote, type Runner } from "./run.ts";
import { loadState, saveState, withLock, type Entry, type State } from "./state.ts";

export const PLUGIN_ID = "csqc.orca-mirror";
const REPO_RETRY_MS = 5 * 60_000;

export type Deps = {
  run: Runner;
  orca: OrcaCli;
  herdrBin: string;
  nodeBin: string;
  mainPath: string;
  stateDir: string;
  configDir: string;
  socketPath: string | null;
  now: () => number;
};

export type SyncOptions = { dryRun: boolean; reason: string; startedAt: number; coalesce: boolean };

export type SkipReason = "no_cwd" | "not_git" | "out_of_scope" | "repo_not_in_orca" | "repo_add_failed";

export type SyncReport = {
  reason: string;
  dryRun: boolean;
  skipped: string | null;
  counts: Record<string, number>;
  created: { terminalId: string; paneId: string; method: "tab" | "split"; handle: string | null; worktreePath: string }[];
  planned: CreateOp[];
  failed: { terminalId: string; error: string; ambiguous: boolean }[];
  notes: string[];
  errors: string[];
};

export type Observation = {
  herdr: HerdrSnapshot;
  orcaTerminals: OrcaTerminal[];
  attach: AttachProcess[];
  statuses: Map<string, Status>;
  state: State;
  now: number;
};

export function defaultDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): { stateDir: string; configDir: string } {
  const home = homedir();
  if (platform === "win32") {
    return {
      stateDir: env.HERDR_PLUGIN_STATE_DIR || join(env.LOCALAPPDATA || join(home, "AppData/Local"), "herdr/plugins", PLUGIN_ID),
      configDir: env.HERDR_PLUGIN_CONFIG_DIR || join(env.APPDATA || join(home, "AppData/Roaming"), "herdr/plugins/config", PLUGIN_ID),
    };
  }
  return {
    stateDir: env.HERDR_PLUGIN_STATE_DIR || join(env.XDG_STATE_HOME || join(home, ".local/state"), "herdr/plugins", PLUGIN_ID),
    configDir: env.HERDR_PLUGIN_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, ".config"), "herdr/plugins/config", PLUGIN_ID),
  };
}

/**
 * Long-lived attach loops must survive package upgrades: herdr's HERDR_BIN_PATH can point into a versioned
 * Homebrew Cellar dir that disappears on upgrade, so prefer the `herdr` found on PATH (a stable symlink).
 */
export function stableHerdrBin(env: NodeJS.ProcessEnv, which: (name: string) => string | null): string {
  const fromEnv = env.HERDR_BIN_PATH;
  if (fromEnv && !fromEnv.includes("/Cellar/")) return fromEnv;
  return which("herdr") ?? fromEnv ?? "herdr";
}

/**
 * The command an Orca tab runs: our attach loop, exec'd so the tab lives exactly as long as the loop.
 * Closing the tab detaches; the herdr pane closing (or the user detaching) ends the tab.
 */
export function attachCommand(
  deps: Pick<Deps, "nodeBin" | "mainPath" | "herdrBin" | "socketPath">,
  paneId: string,
  terminalId: string,
  platform?: NodeJS.Platform,
): string {
  if (!/^term_[A-Za-z0-9]+$/.test(terminalId)) throw new Error(`refusing unexpected terminal id ${terminalId}`);
  if (!/^[A-Za-z0-9]+:[A-Za-z0-9]+$/.test(paneId)) throw new Error(`refusing unexpected pane id ${paneId}`);
  const isWin = (platform ?? (/^[A-Za-z]:|\.exe$/i.test(deps.nodeBin) ? "win32" : "darwin")) === "win32";
  if (isWin) {
    const env = deps.socketPath ? `$env:HERDR_SOCKET_PATH = ${psQuote(deps.socketPath)}; ` : "";
    return `${env}& ${psQuote(deps.nodeBin)} --disable-warning=ExperimentalWarning ${psQuote(deps.mainPath)} attach --pane ${paneId} --terminal ${terminalId} --herdr ${psQuote(deps.herdrBin)}; exit $LASTEXITCODE`;
  }
  const env = deps.socketPath ? `env HERDR_SOCKET_PATH=${shQuote(deps.socketPath)} ` : "";
  return `exec ${env}${shQuote(deps.nodeBin)} --disable-warning=ExperimentalWarning ${shQuote(deps.mainPath)} attach --pane ${paneId} --terminal ${terminalId} --herdr ${shQuote(deps.herdrBin)}`;
}

function emptyReport(opts: SyncOptions): SyncReport {
  return { reason: opts.reason, dryRun: opts.dryRun, skipped: null, counts: {}, created: [], planned: [], failed: [], notes: [], errors: [] };
}

/** Snapshot herdr, Orca and attach processes and classify every herdr terminal. Null when Orca is unreachable. */
export function observe(deps: Deps, state: State): Observation | null {
  const herdr = readHerdrSnapshot(deps.run, deps.herdrBin);
  if (!deps.orca.reachable()) return null;
  const orcaList = deps.orca.listTerminals();
  if (orcaList.truncated) throw new Error("orca terminal list was truncated; refusing to create tabs");
  const attach = scanAttachProcesses(deps.run, { stateDir: deps.stateDir });
  const now = deps.now();
  const statuses = classify({ panes: herdr.panes, orcaTerminals: orcaList.terminals, attach, state, now });
  return {
    herdr,
    orcaTerminals: orcaList.terminals,
    attach,
    statuses,
    state: nextState(state, herdr.panes, statuses, orcaList.terminals, now),
    now,
  };
}

export function runSync(deps: Deps, opts: SyncOptions): SyncReport {
  const report = emptyReport(opts);
  const { config, errors } = loadConfig(deps.configDir);
  report.errors.push(...errors.map((e) => `config: ${e}`));
  if (!config.enabled) {
    report.skipped = errors.length > 0 ? "config_invalid" : "disabled";
    return report;
  }
  const result = opts.dryRun
    ? syncLocked(deps, opts, config, report)
    : withLock(deps.stateDir, () => syncLocked(deps, opts, config, report));
  result.notes = [...new Set(result.notes)];
  return result;
}

function syncLocked(deps: Deps, opts: SyncOptions, config: Config, report: SyncReport): SyncReport {
  const loaded = loadState(deps.stateDir);
  if (!opts.dryRun && opts.coalesce && loaded.lastSyncStartedAt >= opts.startedAt) {
    report.skipped = "coalesced";
    return report;
  }
  const syncStartedAt = deps.now();
  const obs = observe(deps, loaded);
  if (!obs) {
    report.skipped = "orca_unreachable";
    return report;
  }
  const state = obs.state;
  if (!opts.dryRun) state.lastSyncStartedAt = syncStartedAt;

  for (const s of obs.statuses.values()) report.counts[s.kind] = (report.counts[s.kind] ?? 0) + 1;
  if (config.mirrorSidebar) mirrorSidebar(deps, obs.herdr, config, state, report, opts.dryRun);
  const candidates = obs.herdr.panes.filter((p) => obs.statuses.get(p.terminalId)?.kind === "candidate");
  const repos = candidates.length > 0 ? deps.orca.listRepos() : [];
  const resolved = resolveTargets(deps, obs.herdr, candidates, config.includePaths, repos);
  const ensured = ensureRepos(deps, resolved.targets, repos, config, state, report, opts.dryRun);
  for (const reason of [...resolved.skipped.values(), ...ensured.skipped.values()]) {
    report.counts[`skipped_${reason}`] = (report.counts[`skipped_${reason}`] ?? 0) + 1;
  }

  const { anchors, handles } = anchorsOf(obs);
  const ops = planCreates(ensured.ready, obs.herdr, anchors, { mirrorSplits: config.mirrorSplits });
  report.planned = ops;
  if (opts.dryRun) return report;

  saveState(deps.stateDir, state);
  for (const t of retiredToClose(obs.orcaTerminals, obs.attach, state.retiredTabs)) {
    try {
      deps.orca.closeTab(t.handle);
      report.notes.push(`closed retired Orca tab ${t.handle}${t.title ? ` "${t.title}"` : ""} (${t.worktreePath ?? "?"})`);
    } catch (e) {
      report.errors.push(`close retired tab ${t.handle}: ${(e as Error).message}`);
    }
  }
  for (const op of ops) {
    const r = executeCreate(deps, op, state, handles, "auto");
    if (r.ok) report.created.push({ terminalId: op.terminalId, paneId: op.paneId, method: r.method, handle: r.handle, worktreePath: op.worktreePath });
    else report.failed.push({ terminalId: op.terminalId, error: r.error, ambiguous: r.ambiguous });
    report.notes.push(...r.notes);
  }
  saveState(deps.stateDir, state);
  return report;
}

/** The worktree each herdr workspace stands for: its worktree provenance, else its first pane's git checkout. */
export function herdrWorkspaceWorktrees(deps: Deps, herdr: HerdrSnapshot, includePaths: string[]): WorktreeRef[] {
  const out: WorktreeRef[] = [];
  const gitCache = new Map<string, GitInfo | null>();
  for (const ws of herdr.workspaces) {
    let ref: WorktreeRef | null = ws.worktree ? { worktreePath: canonical(ws.worktree.checkoutPath), repoRoot: canonical(ws.worktree.repoRoot) } : null;
    if (!ref) {
      const cwd = herdr.panes.find((p) => p.workspaceId === ws.workspaceId && p.cwd)?.cwd;
      if (cwd && !gitCache.has(cwd)) gitCache.set(cwd, resolveGit(deps.run, cwd));
      ref = cwd ? gitCache.get(cwd) ?? null : null;
    }
    if (!ref) continue;
    const r = ref;
    if (includePaths.length > 0 && !includePaths.some((p) => isInside(r.repoRoot, p) || isInside(r.worktreePath, p))) continue;
    out.push(r);
  }
  return out;
}

/** Make Orca's sidebar show every worktree that herdr's sidebar shows. */
function mirrorSidebar(deps: Deps, herdr: HerdrSnapshot, config: Config, state: State, report: SyncReport, dryRun: boolean): void {
  const worktrees = herdrWorkspaceWorktrees(deps, herdr, config.includePaths);
  if (worktrees.length === 0) return;
  const visible = new Set(deps.orca.listWorktreePaths().map(canonical));
  const repos = deps.orca.listRepos().map((r) => ({ ...r, path: canonical(r.path) }));
  let plan = visibilityActions(worktrees, visible, repos);
  if (plan.missingRepos.length > 0 && config.autoAddRepo) {
    for (const root of plan.missingRepos) {
      const failure = state.repoFailures[root];
      if (failure && deps.now() - failure.at < REPO_RETRY_MS) continue;
      if (dryRun) {
        report.notes.push(`would orca repo add ${root}`);
        continue;
      }
      try {
        const repo = deps.orca.addRepo(root);
        repos.push({ ...repo, path: canonical(repo.path) });
        report.notes.push(`orca repo add ${root}`);
      } catch (e) {
        state.repoFailures[root] = { at: deps.now(), error: (e as Error).message };
        report.errors.push(`repo add ${root}: ${(e as Error).message}`);
      }
    }
    plan = visibilityActions(worktrees, new Set([...visible, ...plan.missingRepos]), repos);
  }
  for (const a of plan.actions) {
    if (a.kind === "show_external" && !config.ensureExternalVisibility) continue;
    const what = a.kind === "show_external" ? `show external worktrees of ${a.repoPath}` : `show ${a.worktreePath} in Orca's sidebar`;
    if (dryRun) {
      report.notes.push(`would ${what}`);
      continue;
    }
    try {
      if (a.kind === "show_external") deps.orca.showExternalWorktrees(a.repoId);
      else deps.orca.importWorktree(a.repoId, a.worktreePath);
      report.notes.push(what);
    } catch (e) {
      report.errors.push(`${what}: ${(e as Error).message}`);
    }
  }
}

/** Already-shown terminals that a new pane in the same herdr tab can split next to. */
export function anchorsOf(obs: Observation): {
  anchors: Map<string, { worktreePath: string | null; orphaned: boolean }>;
  handles: Map<string, string>;
} {
  const anchors = new Map<string, { worktreePath: string | null; orphaned: boolean }>();
  const handles = new Map<string, string>();
  for (const [id, s] of obs.statuses) {
    if (s.kind === "paired" && s.orca) {
      anchors.set(id, { worktreePath: s.orca.worktreePath ? canonical(s.orca.worktreePath) : null, orphaned: s.orca.orphaned });
      handles.set(id, s.orca.handle);
    }
    const entry = obs.state.terminals[id];
    if (s.kind === "pending" && entry?.handle) {
      anchors.set(id, { worktreePath: entry.worktreePath ?? null, orphaned: false });
      handles.set(id, entry.handle);
    }
  }
  return { anchors, handles };
}

/** A herdr worktree workspace pins its panes to that checkout; other panes follow their cwd's git checkout (or an Orca folder project). */
export function resolveTargets(
  deps: Deps,
  herdr: HerdrSnapshot,
  panes: HerdrPane[],
  includePaths: string[],
  repos: OrcaRepo[] = [],
): { targets: Target[]; skipped: Map<string, SkipReason> } {
  const gitCache = new Map<string, GitInfo | null>();
  const folderRepos = repos
    .filter((r) => r.kind === "folder")
    .map((r) => canonical(r.path))
    .sort((a, b) => b.length - a.length);
  const targets: Target[] = [];
  const skipped = new Map<string, SkipReason>();
  for (const pane of panes) {
    const wt = herdr.workspaces.find((w) => w.workspaceId === pane.workspaceId)?.worktree;
    let git: GitInfo | null | undefined = wt
      ? { worktreePath: canonical(wt.checkoutPath), repoRoot: canonical(wt.repoRoot) }
      : undefined;
    if (!git && !pane.cwd) {
      skipped.set(pane.terminalId, "no_cwd");
      continue;
    }
    if (!git && pane.cwd) {
      if (!gitCache.has(pane.cwd)) gitCache.set(pane.cwd, resolveGit(deps.run, pane.cwd));
      git = gitCache.get(pane.cwd);
      if (!git) {
        const folder = folderRepos.find((r) => isInside(pane.cwd!, r));
        if (folder) git = { worktreePath: folder, repoRoot: folder };
      }
    }
    if (!git) {
      skipped.set(pane.terminalId, "not_git");
      continue;
    }
    const info = git;
    if (includePaths.length > 0 && !includePaths.some((p) => isInside(info.repoRoot, p) || isInside(info.worktreePath, p))) {
      skipped.set(pane.terminalId, "out_of_scope");
      continue;
    }
    targets.push({ pane, ...info });
  }
  return { targets, skipped };
}

/** Register unknown repos and make herdr-created (external) worktrees visible. Targets of failed repos are dropped. */
export function ensureRepos(
  deps: Deps,
  targets: Target[],
  repos: OrcaRepo[],
  config: Pick<Config, "autoAddRepo" | "ensureExternalVisibility" | "mirrorSidebar">,
  state: State,
  report: Pick<SyncReport, "notes" | "errors">,
  dryRun: boolean,
): { ready: Target[]; skipped: Map<string, SkipReason> } {
  const byPath = new Map(repos.map((r) => [canonical(r.path), r]));
  const now = deps.now();
  const ready: Target[] = [];
  const skipped = new Map<string, SkipReason>();
  const done = new Set<string>();
  for (const t of targets) {
    let repo = byPath.get(t.repoRoot);
    if (!repo) {
      const failure = state.repoFailures[t.repoRoot];
      if (!config.autoAddRepo || (failure && now - failure.at < REPO_RETRY_MS)) {
        skipped.set(t.pane.terminalId, failure ? "repo_add_failed" : "repo_not_in_orca");
        continue;
      }
      if (dryRun) {
        report.notes.push(`would orca repo add ${t.repoRoot}`);
        ready.push(t);
        continue;
      }
      try {
        repo = deps.orca.addRepo(t.repoRoot);
        byPath.set(t.repoRoot, repo);
        delete state.repoFailures[t.repoRoot];
        report.notes.push(`orca repo add ${t.repoRoot}`);
      } catch (e) {
        state.repoFailures[t.repoRoot] = { at: now, error: (e as Error).message };
        report.errors.push(`repo add ${t.repoRoot}: ${(e as Error).message}`);
        skipped.set(t.pane.terminalId, "repo_add_failed");
        continue;
      }
    }
    if (t.worktreePath !== t.repoRoot) {
      const source = hiddenBySource(t.worktreePath, t.repoRoot);
      if (source) {
        if (!config.mirrorSidebar) {
          report.notes.push(`${t.worktreePath} is hidden by Orca's "${source}" worktree source; enable it in Orca's non-Orca worktrees dialog`);
        }
      } else if (config.ensureExternalVisibility && repo.externalWorktreeVisibility !== "show" && !done.has(repo.id)) {
        done.add(repo.id);
        if (dryRun) {
          report.notes.push(`would orca repo set ${repo.path} --external-worktree-visibility show`);
        } else {
          try {
            deps.orca.showExternalWorktrees(repo.id);
            repo.externalWorktreeVisibility = "show";
            report.notes.push(`orca repo set ${repo.path} --external-worktree-visibility show`);
          } catch (e) {
            report.errors.push(`repo set visibility ${repo.path}: ${(e as Error).message}`);
          }
        }
      }
    }
    ready.push(t);
  }
  return { ready, skipped };
}

export type CreateResult =
  | { ok: true; method: "tab" | "split"; handle: string; paneKey: string | null; notes: string[] }
  | { ok: false; error: string; ambiguous: boolean; notes: string[] };

/** Write-ahead the state entry, then ask Orca for a split (if planned) or a new tab. */
export function executeCreate(
  deps: Deps,
  op: CreateOp,
  state: State,
  handles: Map<string, string>,
  origin: "auto" | "manual",
): CreateResult {
  const notes: string[] = [];
  const prev = state.terminals[op.terminalId];
  const command = attachCommand(deps, op.paneId, op.terminalId);
  state.terminals[op.terminalId] = { ...prev, status: "creating", herdrPaneId: op.paneId, worktreePath: op.worktreePath, createdAt: deps.now() };
  saveState(deps.stateDir, state);

  const anchorHandle = op.split ? handles.get(op.split.anchorTerminalId) : undefined;
  let method: "tab" | "split" = "tab";
  let created: { handle: string; paneKey: string | null } | null = null;
  try {
    if (op.split && anchorHandle) {
      try {
        created = deps.orca.splitTerminal({ handle: anchorHandle, direction: op.split.direction, command });
        method = "split";
      } catch (e) {
        if (!(e instanceof OrcaCommandError) || e.ambiguous) throw e;
        notes.push(`split next to ${op.split.anchorTerminalId} failed (${e.message}); opened a new tab instead`);
      }
    }
    created ??= deps.orca.createTerminal({ worktreePath: op.worktreePath, title: op.title, command });
  } catch (e) {
    const ambiguous = !(e instanceof OrcaCommandError) || e.ambiguous;
    if (!ambiguous) {
      const failed: Entry = {
        ...state.terminals[op.terminalId],
        status: "failed",
        failures: (prev?.failures ?? 0) + 1,
        lastFailedAt: deps.now(),
        lastError: (e as Error).message,
      };
      state.terminals[op.terminalId] = failed;
    }
    saveState(deps.stateDir, state);
    return { ok: false, error: (e as Error).message, ambiguous, notes };
  }
  state.terminals[op.terminalId] = {
    ...state.terminals[op.terminalId],
    status: "created",
    method: origin === "manual" ? "manual" : method,
    handle: created.handle,
    paneKey: created.paneKey,
  };
  if (created.paneKey) state.ownPanes[created.paneKey] = { terminalId: op.terminalId, paneId: op.paneId, createdAt: deps.now() };
  handles.set(op.terminalId, created.handle);
  saveState(deps.stateDir, state);
  return { ok: true, method, handle: created.handle, paneKey: created.paneKey, notes };
}

export function formatReport(r: SyncReport): string {
  const head = `orca-mirror sync (${r.reason}${r.dryRun ? ", dry-run" : ""})`;
  if (r.skipped) return `${head}: skipped (${r.skipped})\n${r.errors.map((e) => `  error: ${e}\n`).join("")}`;
  const counts = Object.entries(r.counts).map(([k, v]) => `${k}=${v}`).join(" ");
  const lines = [`${head}: ${counts}`];
  for (const op of r.dryRun ? r.planned : []) {
    lines.push(`  plan ${op.split ? `split ${op.split.direction} next to ${op.split.anchorTerminalId}` : "new tab"}: ${op.terminalId} (${op.paneId}) -> ${op.worktreePath} "${op.title}"`);
  }
  for (const c of r.created) lines.push(`  created ${c.method}: ${c.terminalId} (${c.paneId}) -> ${c.worktreePath} [${c.handle}]`);
  for (const f of r.failed) lines.push(`  failed${f.ambiguous ? " (ambiguous)" : ""}: ${f.terminalId}: ${f.error}`);
  for (const n of r.notes) lines.push(`  note: ${n}`);
  for (const e of r.errors) lines.push(`  error: ${e}`);
  return `${lines.join("\n")}\n`;
}
