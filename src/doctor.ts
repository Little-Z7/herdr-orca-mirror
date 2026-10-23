import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { canonical } from "./git.ts";
import { asRecord, parseJson, str } from "./run.ts";
import { loadState } from "./state.ts";
import { PLUGIN_ID, ensureRepos, observe, resolveTargets, type Deps } from "./sync.ts";

export const LEGACY_PLUGIN_ID = "rudironsoni.herdr-orca-sync";

export type DoctorReport = {
  versions: { herdrClient: string | null; herdrServer: string | null; protocol: number | null; orca: string | null; orcaState: string | null; node: string };
  plugin: { linked: boolean; enabled: boolean; root: string | null };
  config: { dir: string; includePaths: string[]; errors: string[] };
  legacy: { linked: boolean; enabled: boolean; adopt: boolean | null; daemonPid: number | null; daemonAlive: boolean };
  pairs: { paneId: string; terminalId: string; handle: string | null; worktreePath: string | null; title: string | null; orphaned: boolean; source: string; hidden: string | null }[];
  notShown: { paneId: string; terminalId: string; cwd: string | null; reason: string }[];
  leftovers: { handle: string; paneKey: string; title: string | null; worktreePath: string | null; herdrPaneId: string }[];
  problems: string[];
  warnings: string[];
};

function pluginInfo(deps: Deps, id: string): { linked: boolean; enabled: boolean; root: string | null } {
  const r = deps.run([deps.herdrBin, "plugin", "list", "--plugin", id, "--json"], { timeoutMs: 10_000 });
  const plugins = asRecord(asRecord(parseJson(r.stdout))?.result)?.plugins;
  const p = Array.isArray(plugins) ? asRecord(plugins[0]) : null;
  return { linked: Boolean(p), enabled: p?.enabled === true, root: str(p, "plugin_root") };
}

function legacyInfo(deps: Deps, home: string): DoctorReport["legacy"] {
  const info = pluginInfo(deps, LEGACY_PLUGIN_ID);
  let adopt: boolean | null = null;
  try {
    const text = readFileSync(join(home, ".config/herdr/plugins/config", LEGACY_PLUGIN_ID, "config.toml"), "utf8");
    const m = text.match(/^\s*adopt\s*=\s*(true|false)\s*$/m);
    adopt = m ? m[1] === "true" : true;
  } catch {
    adopt = info.linked ? true : null;
  }
  let daemonPid: number | null = null;
  let daemonAlive = false;
  try {
    daemonPid = Number(readFileSync(join(home, ".local/state/herdr/plugins", LEGACY_PLUGIN_ID, "syncd.pid"), "utf8").trim()) || null;
    if (daemonPid) {
      process.kill(daemonPid, 0);
      daemonAlive = true;
    }
  } catch {
    daemonAlive = false;
  }
  return { linked: info.linked, enabled: info.enabled, adopt, daemonPid, daemonAlive };
}

function hiddenReason(path: string): string {
  const norm = path.replace(/\\/g, "/");
  if (norm.includes("/.claude/worktrees/")) return 'hidden by Orca\'s "Claude Code" worktree source (show it in Orca\'s non-Orca worktrees dialog)';
  if (norm.includes("/.gsd-workspaces/")) return 'hidden by Orca\'s "GSD" worktree source';
  return "external worktrees are hidden for this repo (orca repo set --repo path:<repo> --external-worktree-visibility show)";
}

export function runDoctor(deps: Deps, home = homedir()): DoctorReport {
  const { config, errors } = loadConfig(deps.configDir);
  const client = deps.run([deps.herdrBin, "--version"], { timeoutMs: 5_000 }).stdout.trim().replace(/^herdr\s+/, "") || null;
  const orcaStatus = deps.orca.status();
  const report: DoctorReport = {
    versions: { herdrClient: client, herdrServer: null, protocol: null, orca: orcaStatus.appVersion, orcaState: orcaStatus.state, node: process.version },
    plugin: pluginInfo(deps, PLUGIN_ID),
    config: { dir: deps.configDir, includePaths: config.includePaths, errors },
    legacy: legacyInfo(deps, home),
    pairs: [],
    notShown: [],
    leftovers: [],
    problems: [],
    warnings: [],
  };
  if (errors.length > 0) report.problems.push(`config.toml is invalid, syncing is disabled: ${errors.join("; ")}`);
  if (!report.plugin.linked) report.problems.push(`plugin ${PLUGIN_ID} is not linked in herdr (herdr plugin link <dir>)`);
  else if (!report.plugin.enabled) report.problems.push(`plugin ${PLUGIN_ID} is disabled (herdr plugin enable ${PLUGIN_ID})`);
  if (report.legacy.enabled && report.legacy.adopt) {
    report.problems.push(`legacy ${LEGACY_PLUGIN_ID} has adopt=true; it cannot see existing tabs on Orca 1.4.229 and will open duplicates`);
  }
  if (report.legacy.daemonAlive) report.warnings.push(`legacy daemon pid ${report.legacy.daemonPid} is running (it polls Orca continuously; not needed by orca-mirror)`);
  if (!orcaStatus.reachable) {
    report.problems.push("Orca is not running or not reachable");
    return report;
  }

  const obs = observe(deps, loadState(deps.stateDir));
  if (!obs) {
    report.problems.push("Orca is not running or not reachable");
    return report;
  }
  report.versions.herdrServer = obs.herdr.version;
  report.versions.protocol = obs.herdr.protocol;
  const visible = new Set(deps.orca.listWorktreePaths().map(canonical));
  const hiddenSeen = new Set<string>();
  for (const pane of obs.herdr.panes) {
    const s = obs.statuses.get(pane.terminalId);
    const entry = obs.state.terminals[pane.terminalId];
    if (s?.kind === "paired") {
      const wt = s.orca?.worktreePath ?? null;
      const hidden = wt && !visible.has(canonical(wt)) ? hiddenReason(wt) : null;
      if (hidden && wt && !hiddenSeen.has(wt)) {
        hiddenSeen.add(wt);
        report.warnings.push(`${wt}: ${hidden}`);
      }
      report.pairs.push({
        paneId: pane.paneId,
        terminalId: pane.terminalId,
        handle: s.orca?.handle ?? null,
        worktreePath: wt,
        title: s.orca?.title ?? null,
        orphaned: s.orca?.orphaned ?? false,
        source: entry?.method && entry.method !== "existing" ? `orca-mirror (${entry.method})` : "existing",
        hidden,
      });
      continue;
    }
    const reason =
      s?.kind === "closed" ? "its Orca tab was closed; not reopened automatically (run `orca-mirror open` in that pane)"
      : s?.kind === "unconfirmed" ? `Orca tab ${entry?.handle ?? "?"} was created but never seen attached; not retried automatically`
      : s?.kind === "failed" ? `Orca refused ${entry?.failures ?? 0} times: ${entry?.lastError ?? "?"}`
      : s?.kind === "retry_wait" ? `Orca refused the last attempt, retrying later: ${entry?.lastError ?? "?"}`
      : s?.kind === "pending" ? "Orca tab is being created"
      : null;
    report.notShown.push({ paneId: pane.paneId, terminalId: pane.terminalId, cwd: pane.cwd, reason: reason ?? "" });
  }

  const candidates = obs.herdr.panes.filter((p) => obs.statuses.get(p.terminalId)?.kind === "candidate");
  const repos = candidates.length ? deps.orca.listRepos() : [];
  const resolved = resolveTargets(deps, obs.herdr, candidates, config.includePaths, repos);
  const sink = { notes: [] as string[], errors: [] as string[] };
  const ensured = ensureRepos(deps, resolved.targets, repos, config, obs.state, sink, true);
  const reasonText: Record<string, string> = {
    no_cwd: "herdr reports no cwd",
    not_git: "not inside a git checkout (no Orca worktree)",
    out_of_scope: "outside include_paths in config.toml",
    repo_not_in_orca: "repo not registered in Orca and auto_add_repo = false",
    repo_add_failed: "orca repo add failed recently",
  };
  for (const row of report.notShown) {
    if (row.reason) continue;
    const why = resolved.skipped.get(row.terminalId) ?? ensured.skipped.get(row.terminalId);
    row.reason = why ? reasonText[why] ?? why : "will be created by the next sync";
  }
  for (const n of sink.notes) report.warnings.push(n);

  const attachedKeys = new Set(obs.attach.map((a) => a.paneKey).filter(Boolean));
  for (const [paneKey, own] of Object.entries(obs.state.ownPanes)) {
    if (attachedKeys.has(paneKey)) continue;
    const t = obs.orcaTerminals.find((o) => o.paneKey === paneKey);
    if (t) report.leftovers.push({ handle: t.handle, paneKey, title: t.title, worktreePath: t.worktreePath, herdrPaneId: own.paneId });
  }
  const plain = obs.attach.filter((a) => a.paneId === null && a.inOrca === true).length;
  if (plain > 0) {
    report.warnings.push(`${plain} Orca tab(s) run a plain \`herdr terminal attach --takeover\`, which pins the herdr pane size to Orca; replace them with \`orca-mirror upgrade-tabs\``);
  }
  if (report.leftovers.length > 0) report.warnings.push(`${report.leftovers.length} Orca pane(s) created by orca-mirror no longer show herdr (idle shells); close them with \`orca terminal close --terminal <handle> --tab\``);
  for (const row of report.notShown) if (/refused/.test(row.reason)) report.problems.push(`${row.paneId}: ${row.reason}`);
  return report;
}

export function formatDoctor(r: DoctorReport): string {
  const v = r.versions;
  const lines = [
    "orca-mirror doctor",
    `  herdr: client ${v.herdrClient ?? "?"}, server ${v.herdrServer ?? "?"} (protocol ${v.protocol ?? "?"})`,
    `  orca:  ${v.orca ?? "?"} (${v.orcaState ?? "unreachable"})`,
    `  node:  ${v.node}`,
    `  plugin ${PLUGIN_ID}: ${r.plugin.linked ? (r.plugin.enabled ? "enabled" : "disabled") : "not linked"}${r.plugin.root ? ` at ${r.plugin.root}` : ""}`,
    `  config: ${r.config.dir}/config.toml; scope: ${r.config.includePaths.length ? r.config.includePaths.join(", ") : "all repos"}`,
    `  legacy ${LEGACY_PLUGIN_ID}: ${r.legacy.linked ? `${r.legacy.enabled ? "enabled" : "disabled"}, adopt=${r.legacy.adopt}, daemon ${r.legacy.daemonAlive ? `running (pid ${r.legacy.daemonPid})` : "not running"}` : "not installed"}`,
    "",
    `shown in Orca (${r.pairs.length}):`,
    ...r.pairs.map((p) => `  ${p.paneId.padEnd(8)} ${p.terminalId} -> ${p.handle?.slice(0, 13) ?? "?"} ${p.worktreePath ?? "?"}${p.title ? ` "${p.title}"` : ""} [${p.source}${p.orphaned ? ", orphaned" : ""}${p.hidden ? ", worktree hidden" : ""}]`),
    "",
    `not shown (${r.notShown.length}):`,
    ...r.notShown.map((n) => `  ${n.paneId.padEnd(8)} ${n.terminalId} ${n.cwd ?? ""}: ${n.reason}`),
  ];
  if (r.leftovers.length) {
    lines.push("", `leftover Orca panes (${r.leftovers.length}):`);
    for (const l of r.leftovers) lines.push(`  ${l.handle} ${l.worktreePath ?? ""}${l.title ? ` "${l.title}"` : ""} (was ${l.herdrPaneId})`);
  }
  if (r.warnings.length) lines.push("", "warnings:", ...r.warnings.map((w) => `  - ${w}`));
  lines.push("", r.problems.length ? "problems:" : "no problems found", ...r.problems.map((p) => `  - ${p}`));
  return `${lines.join("\n")}\n`;
}
