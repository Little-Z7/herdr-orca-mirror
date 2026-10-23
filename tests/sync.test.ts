import assert from "node:assert/strict";
import { test } from "node:test";
import { OrcaCommandError, type OrcaCli } from "../src/orca.ts";
import { PENDING_GRACE_MS, RETRY_AFTER_MS } from "../src/reconcile.ts";
import { loadState, saveState, emptyState } from "../src/state.ts";
import { attachCommand, runSync, stableHerdrBin, type SyncOptions } from "../src/sync.ts";
import { fakeOrca, fakeRunner, makeWorld, tempDirs, type World } from "./helpers.ts";

const REPO = "/src/proj";

function baseWorld(): World {
  return makeWorld({
    panes: [{ paneId: "w1:p1", terminalId: "term_new1", workspaceId: "w1", tabId: "w1:t1", cwd: REPO }],
    workspaces: [{ workspaceId: "w1", label: "proj" }],
    git: { [REPO]: { top: REPO, repoRoot: REPO } },
    repos: [{ id: "r1", path: REPO, externalWorktreeVisibility: "show" }],
  });
}

const BINS = { herdrBin: "/opt/homebrew/bin/herdr", nodeBin: "/usr/bin/node", mainPath: "/x/src/main.ts", socketPath: null };

function sync(w: World, orca: OrcaCli, dirs: { stateDir: string; configDir: string }, opts: Partial<SyncOptions> & { now?: number } = {}) {
  return runSync(
    { run: fakeRunner(w), orca, ...BINS, ...dirs, now: () => opts.now ?? 1_000_000 },
    { dryRun: false, reason: "test", startedAt: 0, coalesce: false, ...opts },
  );
}

test("attachCommand execs our attach loop and rejects unexpected ids", () => {
  assert.equal(
    attachCommand(BINS, "w1:p1", "term_abc"),
    "exec '/usr/bin/node' --disable-warning=ExperimentalWarning '/x/src/main.ts' attach --pane w1:p1 --terminal term_abc --herdr '/opt/homebrew/bin/herdr'",
  );
  assert.match(attachCommand({ ...BINS, socketPath: "/tmp/s.sock" }, "w1:p1", "term_abc"), /^exec env HERDR_SOCKET_PATH='\/tmp\/s.sock' /);
  assert.equal(
    attachCommand(
      { nodeBin: "C:\\nvm4w\\nodejs\\node.exe", mainPath: "C:\\p\\src\\main.ts", herdrBin: "C:\\Herdr\\herdr.exe", socketPath: null },
      "w1:p1",
      "term_abc",
    ),
    "& 'C:\\nvm4w\\nodejs\\node.exe' --disable-warning=ExperimentalWarning 'C:\\p\\src\\main.ts' attach --pane w1:p1 --terminal term_abc --herdr 'C:\\Herdr\\herdr.exe'; exit $LASTEXITCODE",
  );
  assert.throws(() => attachCommand(BINS, "w1:p1", "term_x; rm -rf /"));
  assert.throws(() => attachCommand(BINS, "w1:p1;x", "term_abc"));
});

test("a versioned Homebrew Cellar herdr path is replaced by the stable one on PATH", () => {
  const which = () => "/opt/homebrew/bin/herdr";
  assert.equal(stableHerdrBin({ HERDR_BIN_PATH: "/opt/homebrew/Cellar/herdr/0.9.5/bin/herdr" }, which), "/opt/homebrew/bin/herdr");
  assert.equal(stableHerdrBin({ HERDR_BIN_PATH: "/usr/local/bin/herdr" }, which), "/usr/local/bin/herdr");
  assert.equal(stableHerdrBin({}, () => null), "herdr");
});

test("a new herdr terminal gets exactly one Orca tab across repeated syncs", () => {
  const w = baseWorld();
  const orca = fakeOrca(w);
  const dirs = tempDirs();
  const first = sync(w, orca, dirs);
  assert.equal(first.created.length, 1);
  assert.deepEqual(orca.calls.map((c) => c.op), ["create"]);
  assert.equal(orca.calls[0]?.args.worktreePath, REPO);
  assert.match(String(orca.calls[0]?.args.command), /attach --pane w1:p1 --terminal term_new1 /);
  for (let i = 0; i < 5; i += 1) sync(w, orca, dirs, { now: 1_000_000 + i * 60_000 });
  assert.equal(orca.calls.length, 1);
  const state = loadState(dirs.stateDir);
  assert.equal(state.terminals.term_new1?.status, "paired");
  assert.equal(state.terminals.term_new1?.herdrPaneId, "w1:p1");
  assert.deepEqual(Object.values(state.ownPanes).map((o) => o.terminalId), ["term_new1"]);
});

test("a herdr live update (same pane, new terminal id) is not a new tab while our loop reattaches", () => {
  const w = baseWorld();
  const orca = fakeOrca(w);
  const dirs = tempDirs();
  sync(w, orca, dirs);
  w.panes[0]!.terminalId = "term_after_handoff";
  const r = sync(w, orca, dirs);
  assert.equal(r.counts.paired, 1);
  assert.equal(orca.calls.length, 1);
});

test("legacy tabs (attach found by ORCA_PANE_KEY) are recognised and never duplicated", () => {
  const w = baseWorld();
  w.orcaTerminals.push({ handle: "h_legacy", paneKey: "tL:lL", worktreeId: "r1::/src/proj", worktreePath: REPO, title: null, orphaned: true });
  w.attach.push({ pid: 7, terminalId: "term_new1", paneKey: "tL:lL", env: "orca" });
  const orca = fakeOrca(w);
  const report = sync(w, orca, tempDirs());
  assert.equal(report.counts.paired, 1);
  assert.equal(orca.calls.length, 0);
});

test("a tab created but not yet attached is pending, then unconfirmed; never recreated automatically", () => {
  const w = baseWorld();
  const orca = fakeOrca(w, { attachStarts: false });
  const dirs = tempDirs();
  sync(w, orca, dirs, { now: 1_000_000 });
  assert.equal(sync(w, orca, dirs, { now: 1_000_000 + 1000 }).counts.pending, 1);
  assert.equal(sync(w, orca, dirs, { now: 1_000_000 + PENDING_GRACE_MS + 1 }).counts.unconfirmed, 1);
  assert.equal(orca.calls.filter((c) => c.op === "create").length, 1);
});

test("a user-closed Orca tab is not reopened", () => {
  const w = baseWorld();
  const orca = fakeOrca(w);
  const dirs = tempDirs();
  sync(w, orca, dirs);
  sync(w, orca, dirs);
  w.attach = [];
  w.orcaTerminals = [];
  assert.equal(sync(w, orca, dirs).counts.closed, 1);
  assert.equal(orca.calls.length, 1);
});

test("a definite refusal is retried after a back-off; an ambiguous failure is not retried", () => {
  const w = baseWorld();
  const dirs = tempDirs();
  const refusing = fakeOrca(w, { createError: new OrcaCommandError("orca terminal create: worktree_not_found", false) });
  sync(w, refusing, dirs, { now: 1_000_000 });
  assert.equal(loadState(dirs.stateDir).terminals.term_new1?.status, "failed");
  sync(w, refusing, dirs, { now: 1_000_000 + 1000 });
  assert.equal(refusing.calls.length, 1);
  sync(w, refusing, dirs, { now: 1_000_000 + RETRY_AFTER_MS + 1 });
  assert.equal(refusing.calls.length, 2);

  const w2 = baseWorld();
  const dirs2 = tempDirs();
  const lost = fakeOrca(w2, { createError: new OrcaCommandError("orca terminal create: no readable reply", true) });
  const r = sync(w2, lost, dirs2, { now: 1_000_000 });
  assert.equal(r.failed[0]?.ambiguous, true);
  assert.equal(loadState(dirs2.stateDir).terminals.term_new1?.status, "creating");
  sync(w2, lost, dirs2, { now: 1_000_000 + 10 * RETRY_AFTER_MS });
  assert.equal(lost.calls.length, 1);
});

test("Orca unreachable: nothing is created and state is untouched", () => {
  const w = baseWorld();
  w.reachable = false;
  const orca = fakeOrca(w);
  const dirs = tempDirs();
  assert.equal(sync(w, orca, dirs).skipped, "orca_unreachable");
  assert.deepEqual(loadState(dirs.stateDir), emptyState());
  assert.equal(orca.calls.length, 0);
});

test("dry-run plans without touching Orca or state", () => {
  const w = baseWorld();
  w.repos = [];
  const orca = fakeOrca(w);
  const dirs = tempDirs();
  const r = sync(w, orca, dirs, { dryRun: true });
  assert.equal(r.planned.length, 1);
  assert.deepEqual(r.notes, [`would orca repo add ${REPO}`]);
  assert.equal(orca.calls.length, 0);
  assert.deepEqual(loadState(dirs.stateDir), emptyState());
});

test("unknown repos are added; herdr worktrees make the repo show external worktrees once", () => {
  const wt1 = "/home/u/.herdr/worktrees/proj/a";
  const wt2 = "/home/u/.herdr/worktrees/proj/b";
  const w = makeWorld({
    panes: [
      { paneId: "w2:p1", terminalId: "term_wt1", workspaceId: "w2", tabId: "w2:t1", cwd: wt1 },
      { paneId: "w3:p1", terminalId: "term_wt2", workspaceId: "w3", tabId: "w3:t1", cwd: wt2 },
    ],
    workspaces: [
      { workspaceId: "w2", label: "a", worktree: { checkout_path: wt1, repo_root: REPO, is_linked_worktree: true } },
      { workspaceId: "w3", label: "b", worktree: { checkout_path: wt2, repo_root: REPO, is_linked_worktree: true } },
    ],
  });
  const orca = fakeOrca(w);
  sync(w, orca, tempDirs());
  assert.deepEqual(orca.calls.map((c) => c.op), ["addRepo", "showExternal", "create", "create"]);
  assert.equal(orca.calls[2]?.args.worktreePath, wt1);
});

test("every herdr workspace's worktree is made visible in Orca, including .claude/worktrees ones", () => {
  const claudeWt = `${REPO}/.claude/worktrees/feature`;
  const w = baseWorld();
  w.panes.push({ paneId: "w2:p1", terminalId: "term_wt", workspaceId: "w2", tabId: "w2:t1", cwd: claudeWt });
  w.workspaces.push({ workspaceId: "w2", label: "feature", worktree: { checkout_path: claudeWt, repo_root: REPO, is_linked_worktree: true } });
  const orca = fakeOrca(w);
  const dirs = tempDirs();
  const dry = sync(w, orca, dirs, { dryRun: true });
  assert.ok(dry.notes.includes(`would show ${claudeWt} in Orca's sidebar`));
  assert.equal(orca.calls.length, 0);
  sync(w, orca, dirs);
  assert.deepEqual(orca.calls.filter((c) => c.op === "importWorktree").map((c) => c.args), [{ repoId: "r1", path: claudeWt }]);
  sync(w, orca, dirs);
  assert.equal(orca.calls.filter((c) => c.op === "importWorktree").length, 1, "already visible: not imported again");
});

test("mirror_sidebar = false leaves Orca's sidebar alone", () => {
  const claudeWt = `${REPO}/.claude/worktrees/feature`;
  const w = baseWorld();
  w.workspaces.push({ workspaceId: "w2", label: "feature", worktree: { checkout_path: claudeWt, repo_root: REPO, is_linked_worktree: true } });
  const orca = fakeOrca(w);
  sync(w, orca, tempDirs("mirror_sidebar = false\n"));
  assert.equal(orca.calls.filter((c) => c.op === "importWorktree").length, 0);
});

test("a second pane in an already-shown herdr tab splits that Orca tab", () => {
  const w = baseWorld();
  w.panes[0]!.rect = { x: 0, y: 0, width: 100, height: 60 };
  const orca = fakeOrca(w);
  const dirs = tempDirs();
  sync(w, orca, dirs);
  w.panes.push({ paneId: "w1:p2", terminalId: "term_new2", workspaceId: "w1", tabId: "w1:t1", cwd: REPO, rect: { x: 101, y: 0, width: 100, height: 60 } });
  const r = sync(w, orca, dirs);
  assert.deepEqual(r.created.map((c) => c.method), ["split"]);
  const split = orca.calls.find((c) => c.op === "split");
  assert.equal(split?.args.handle, "term_orca1");
  assert.equal(split?.args.direction, "horizontal");
});

test("a refused split falls back to a new tab", () => {
  const w = baseWorld();
  w.panes[0]!.rect = { x: 0, y: 0, width: 100, height: 60 };
  const orca = fakeOrca(w, { splitError: new OrcaCommandError("orca terminal split: terminal_handle_stale", false) });
  const dirs = tempDirs();
  sync(w, orca, dirs);
  w.panes.push({ paneId: "w1:p2", terminalId: "term_new2", workspaceId: "w1", tabId: "w1:t1", cwd: REPO, rect: { x: 0, y: 61, width: 100, height: 30 } });
  const r = sync(w, orca, dirs);
  assert.deepEqual(orca.calls.map((c) => c.op), ["create", "split", "create"]);
  assert.deepEqual(r.created.map((c) => c.method), ["tab"]);
});

test("include_paths limits mirroring; non-git panes are skipped", () => {
  const w = baseWorld();
  w.panes.push({ paneId: "w9:p1", terminalId: "term_root", workspaceId: "w9", tabId: "w9:t1", cwd: "/" });
  const orca = fakeOrca(w);
  const r = sync(w, orca, tempDirs(`include_paths = ["/somewhere/else"]\n`));
  assert.equal(r.counts.skipped_out_of_scope, 1);
  assert.equal(r.counts.skipped_not_git, 1);
  assert.equal(orca.calls.length, 0);
});

test("an invalid config disables syncing", () => {
  const w = baseWorld();
  const orca = fakeOrca(w);
  const r = sync(w, orca, tempDirs(`include_paths = /oops\n`));
  assert.equal(r.skipped, "config_invalid");
  assert.equal(orca.calls.length, 0);
});

test("a waiter whose event was already covered by a later-started sync skips", () => {
  const w = baseWorld();
  const orca = fakeOrca(w);
  const dirs = tempDirs();
  saveState(dirs.stateDir, { ...emptyState(), lastSyncStartedAt: 500 });
  assert.equal(sync(w, orca, dirs, { coalesce: true, startedAt: 400 }).skipped, "coalesced");
  assert.equal(sync(w, orca, dirs, { coalesce: true, startedAt: 600 }).skipped, null);
});

test("non-git panes inside a registered Orca folder project mirror into that folder project", () => {
  const w = makeWorld({
    panes: [{ paneId: "w1:p1", terminalId: "term_folder1", workspaceId: "w1", tabId: "w1:t1", cwd: "F:\\codexworkspace" }],
    workspaces: [{ workspaceId: "w1", label: "codexworkspace" }],
    repos: [{ id: "r_f", path: "F:\\", externalWorktreeVisibility: null, kind: "folder" }],
  });
  const orca = fakeOrca(w);
  const r = sync(w, orca, tempDirs());
  assert.equal(r.created.length, 1);
  assert.equal(r.created[0]?.worktreePath, "F:\\");
});
