import assert from "node:assert/strict";
import { test } from "node:test";
import { runOpen } from "../src/open.ts";
import { OrcaCommandError, type OrcaCli } from "../src/orca.ts";
import { loadState, saveState, emptyState } from "../src/state.ts";
import { fakeOrca, fakeRunner, makeWorld, tempDirs, type World } from "./helpers.ts";

const REPO = "/src/proj";
const BINS = { herdrBin: "/opt/homebrew/bin/herdr", nodeBin: "/usr/bin/node", mainPath: "/x/src/main.ts", socketPath: null };

function world(): World {
  return makeWorld({
    panes: [
      { paneId: "w1:p1", terminalId: "term_a", workspaceId: "w1", tabId: "w1:t1", cwd: REPO },
      { paneId: "w9:p1", terminalId: "term_root", workspaceId: "w9", tabId: "w9:t1", cwd: "/" },
    ],
    workspaces: [{ workspaceId: "w1", label: "proj" }, { workspaceId: "w9", label: "root" }],
    git: { [REPO]: { top: REPO, repoRoot: REPO } },
    repos: [{ id: "r1", path: REPO, externalWorktreeVisibility: "show" }],
  });
}

function open(w: World, orca: OrcaCli, dirs: { stateDir: string; configDir: string }, paneId: string | null) {
  let clock = 1_000_000;
  return runOpen(
    { run: fakeRunner(w), orca, ...BINS, ...dirs, now: () => clock, sleep: (ms) => (clock += ms) },
    { paneId, terminalId: null, timeoutMs: 3000, pollMs: 300 },
  );
}

test("open creates a tab, ignores include_paths, and reports success only once the attach is seen", () => {
  const w = world();
  const orca = fakeOrca(w);
  const dirs = tempDirs(`include_paths = ["/elsewhere"]\n`);
  const r = open(w, orca, dirs, "w1:p1");
  assert.equal(r.ok, true, r.message);
  assert.equal(r.created, true);
  assert.match(r.message, /opened in Orca under \/src\/proj/);
  assert.equal(loadState(dirs.stateDir).terminals.term_a?.status, "paired");
  assert.equal(loadState(dirs.stateDir).terminals.term_a?.method, "manual");
});

test("open on an already-shown terminal says where it is and creates nothing", () => {
  const w = world();
  const orca = fakeOrca(w);
  const dirs = tempDirs();
  open(w, orca, dirs, "w1:p1");
  const r = open(w, orca, dirs, "w1:p1");
  assert.equal(r.ok, true);
  assert.equal(r.created, false);
  assert.match(r.message, /already shown/);
  assert.equal(orca.calls.filter((c) => c.op === "create").length, 1);
});

test("open reopens a terminal whose tab the user closed", () => {
  const w = world();
  const orca = fakeOrca(w);
  const dirs = tempDirs();
  saveState(dirs.stateDir, { ...emptyState(), terminals: { term_a: { status: "paired", herdrPaneId: "w1:p1" } } });
  assert.equal(open(w, orca, dirs, "w1:p1").ok, true);
  assert.equal(orca.calls.filter((c) => c.op === "create").length, 1);
});

test("open fails clearly when the tab never attaches, when Orca refuses, and outside git", () => {
  const w = world();
  const silent = fakeOrca(w, { attachStarts: false });
  const r = open(w, silent, tempDirs(), "w1:p1");
  assert.equal(r.ok, false);
  assert.match(r.message, /no herdr attach showed up/);

  const w2 = world();
  const refused = open(w2, fakeOrca(w2, { createError: new OrcaCommandError("orca terminal create: worktree_not_found", false) }), tempDirs(), "w1:p1");
  assert.equal(refused.ok, false);
  assert.match(refused.message, /worktree_not_found/);

  const w3 = world();
  const notGit = open(w3, fakeOrca(w3), tempDirs(), "w9:p1");
  assert.equal(notGit.ok, false);
  assert.match(notGit.message, /not inside a git checkout/);
});

test("open needs a pane and a reachable Orca", () => {
  const w = world();
  assert.match(open(w, fakeOrca(w), tempDirs(), null).message, /run this inside a herdr pane/);
  w.reachable = false;
  assert.match(open(w, fakeOrca(w), tempDirs(), "w1:p1").message, /Orca is not running/);
});
