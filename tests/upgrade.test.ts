import assert from "node:assert/strict";
import { test } from "node:test";
import { loadState, saveState, emptyState } from "../src/state.ts";
import { runSync } from "../src/sync.ts";
import { runUpgradeTabs } from "../src/upgrade.ts";
import { fakeOrca, fakeRunner, makeWorld, tempDirs } from "./helpers.ts";

const REPO = "/src/proj";
const BINS = { herdrBin: "/opt/homebrew/bin/herdr", nodeBin: "/usr/bin/node", mainPath: "/x/src/main.ts", socketPath: null };

test("plain-attach tabs are closed (attach client only) and recreated with the bridge loop", () => {
  const w = makeWorld({
    panes: [
      { paneId: "w1:p1", terminalId: "term_legacy", workspaceId: "w1", tabId: "w1:t1", cwd: REPO },
      { paneId: "w1:p2", terminalId: "term_ours", workspaceId: "w1", tabId: "w1:t2", cwd: REPO },
    ],
    workspaces: [{ workspaceId: "w1", label: "proj" }],
    git: { [REPO]: { top: REPO, repoRoot: REPO } },
    repos: [{ id: "r1", path: REPO, externalWorktreeVisibility: "show" }],
    orcaTerminals: [
      { handle: "h_legacy", paneKey: "tL:lL", worktreeId: "r1::/src/proj", worktreePath: REPO, title: null, orphaned: true },
      { handle: "h_ours", paneKey: "tO:lO", worktreeId: "r1::/src/proj", worktreePath: REPO, title: null, orphaned: false },
    ],
    attach: [
      { pid: 50, terminalId: "term_legacy", paneKey: "tL:lL", env: "orca" },
      { pid: 60, terminalId: "term_ours", paneKey: "tO:lO", env: "orca", loopPaneId: "w1:p2" },
    ],
  });
  const orca = fakeOrca(w);
  const dirs = tempDirs();
  saveState(dirs.stateDir, { ...emptyState(), terminals: { term_legacy: { status: "paired", method: "existing" } } });
  const killed: number[] = [];
  const deps = {
    run: fakeRunner(w),
    orca,
    ...BINS,
    ...dirs,
    now: () => 1_000_000,
    sleep: () => {},
    kill: (pid: number) => {
      killed.push(pid);
      const a = w.attach.find((x) => x.pid === pid);
      w.attach = w.attach.filter((x) => x.pid !== pid);
      w.orcaTerminals = w.orcaTerminals.filter((t) => t.paneKey !== a?.paneKey);
    },
    alive: (pid: number) => w.attach.some((a) => a.pid === pid),
  };

  const dry = runUpgradeTabs(deps, { dryRun: true });
  assert.deepEqual(dry.targets.map((t) => t.terminalId), ["term_legacy"]);
  assert.deepEqual(killed, []);

  const r = runUpgradeTabs(deps, { dryRun: false });
  assert.deepEqual(killed, [50]);
  assert.equal(r.sync?.created.length, 1);
  assert.match(String(orca.calls.find((c) => c.op === "create")?.args.command), /attach --pane w1:p1 --terminal term_legacy /);
  assert.equal(loadState(dirs.stateDir).terminals.term_legacy?.status, "created");
  assert.deepEqual(Object.keys(loadState(dirs.stateDir).retiredTabs), ["tL"]);

  // Orca later restores the retired tab with a fresh shell: the next sync closes it.
  w.orcaTerminals.push({ handle: "h_respawned", paneKey: "tL:lL", worktreeId: "r1::/src/proj", worktreePath: REPO, title: null, orphaned: false, preview: "user@mac proj % " });
  const again = runUpgradeTabs(deps, { dryRun: true });
  assert.equal(again.targets.length, 0);
  const sync = runSync(deps, { dryRun: false, reason: "t", startedAt: 0, coalesce: false });
  assert.ok(orca.calls.some((c) => c.op === "closeTab" && c.args.handle === "h_respawned"));
  assert.match(sync.notes.join("\n"), /closed retired Orca tab h_respawned/);
});
