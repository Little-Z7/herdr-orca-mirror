import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHerdrSnapshot, type HerdrPane } from "../src/herdr.ts";
import type { OrcaTerminal } from "../src/orca.ts";
import {
  MAX_FAILURES,
  PENDING_GRACE_MS,
  RETRY_AFTER_MS,
  adjacency,
  classify,
  hiddenBySource,
  nextState,
  planCreates,
  retiredToClose,
  visibilityActions,
} from "../src/reconcile.ts";
import { orcaAppFromLauncher, orcaWinDirFromLauncher } from "../src/orca.ts";
import { emptyState, type State } from "../src/state.ts";
import { makeWorld, snapshotJson } from "./helpers.ts";

const pane = (terminalId: string, paneId = `w1:${terminalId}`, tabId = "w1:t1"): HerdrPane => ({
  paneId,
  terminalId,
  workspaceId: "w1",
  tabId,
  cwd: "/repo",
});
const orcaTerm = (handle: string, paneKey: string, extra: Partial<OrcaTerminal> = {}): OrcaTerminal => ({
  handle,
  paneKey,
  worktreeId: "r::/repo",
  worktreePath: "/repo",
  title: null,
  orphaned: false,
  ...extra,
});
const stateWith = (terminals: State["terminals"]): State => ({ ...emptyState(), terminals });

test("a live attach in an Orca pane pairs the terminal, including legacy orphaned rows via recordedPaneKey", () => {
  const statuses = classify({
    panes: [pane("term_a"), pane("term_b")],
    orcaTerminals: [orcaTerm("h_a", "t1:l1"), orcaTerm("h_b", "t9:l9", { orphaned: true })],
    attach: [
      { pid: 1, terminalId: "term_a", paneId: null, paneKey: "t1:l1", inOrca: true },
      { pid: 2, terminalId: "term_b", paneId: null, paneKey: "t9:l9", inOrca: true },
    ],
    state: emptyState(),
    now: 0,
  });
  assert.equal(statuses.get("term_a")?.kind, "paired");
  const b = statuses.get("term_b");
  assert.ok(b?.kind === "paired" && b.orca?.handle === "h_b" && b.orca.orphaned);
});

test("unknown env counts as displayed; an attach outside Orca does not", () => {
  const statuses = classify({
    panes: [pane("term_a"), pane("term_b")],
    orcaTerminals: [],
    attach: [
      { pid: 1, terminalId: "term_a", paneId: null, paneKey: null, inOrca: null },
      { pid: 2, terminalId: "term_b", paneId: null, paneKey: null, inOrca: false },
    ],
    state: emptyState(),
    now: 0,
  });
  assert.deepEqual(statuses.get("term_a"), { kind: "paired", orca: null });
  assert.deepEqual(statuses.get("term_b"), { kind: "candidate" });
});

test("state entries block a second automatic create", () => {
  const now = 1_000_000;
  const statuses = classify({
    panes: ["fresh", "creating", "stale", "closed", "failwait", "failretry", "failmax"].map((id) => pane(`term_${id}`)),
    orcaTerminals: [],
    attach: [],
    state: stateWith({
      term_creating: { status: "creating", createdAt: now - 1000 },
      term_stale: { status: "created", createdAt: now - PENDING_GRACE_MS - 1 },
      term_closed: { status: "paired" },
      term_failwait: { status: "failed", failures: 1, lastFailedAt: now - 10 },
      term_failretry: { status: "failed", failures: 1, lastFailedAt: now - RETRY_AFTER_MS - 1 },
      term_failmax: { status: "failed", failures: MAX_FAILURES, lastFailedAt: 0 },
    }),
    now,
  });
  assert.deepEqual(
    Object.fromEntries([...statuses].map(([k, v]) => [k, v.kind])),
    {
      term_fresh: "candidate",
      term_creating: "pending",
      term_stale: "unconfirmed",
      term_closed: "closed",
      term_failwait: "retry_wait",
      term_failretry: "candidate",
      term_failmax: "failed",
    },
  );
});

test("a created tab whose Orca pane disappeared before it was ever seen attached counts as closed", () => {
  const statuses = classify({
    panes: [pane("term_a"), pane("term_b")],
    orcaTerminals: [orcaTerm("h_b", "tb:lb")],
    attach: [],
    state: stateWith({
      term_a: { status: "created", paneKey: "ta:la", createdAt: 0 },
      term_b: { status: "created", paneKey: "tb:lb", createdAt: 0 },
    }),
    now: 1,
  });
  assert.equal(statuses.get("term_a")?.kind, "closed");
  assert.equal(statuses.get("term_b")?.kind, "pending");
});

test("nextState records pairings, prunes gone terminals and forgets own panes Orca no longer has", () => {
  const state: State = {
    ...stateWith({ term_gone: { status: "paired" }, term_a: { status: "created", method: "split", createdAt: 5 } }),
    ownPanes: { "t:l": { terminalId: "term_a", paneId: "w1:term_a", createdAt: 5 }, "old:k": { terminalId: "x", paneId: "w1:x", createdAt: 1 } },
  };
  const orca = orcaTerm("h_a", "t:l");
  const next = nextState(state, [pane("term_a")], new Map([["term_a", { kind: "paired" as const, orca }]]), [orca], 42);
  assert.deepEqual(Object.keys(next.terminals), ["term_a"]);
  assert.equal(next.terminals.term_a?.status, "paired");
  assert.equal(next.terminals.term_a?.method, "split");
  assert.equal(next.terminals.term_a?.handle, "h_a");
  assert.equal(next.terminals.term_a?.herdrPaneId, "w1:term_a");
  assert.equal(next.terminals.term_a?.pairedAt, 42);
  assert.deepEqual(Object.keys(next.ownPanes), ["t:l"]);
});

test("our attach loop for a pane keeps it paired across a terminal id change", () => {
  const statuses = classify({
    panes: [pane("term_new", "w1:p1")],
    orcaTerminals: [orcaTerm("h", "t:l")],
    attach: [{ pid: 1, terminalId: "term_old", paneId: "w1:p1", paneKey: "t:l", inOrca: true }],
    state: emptyState(),
    now: 0,
  });
  const s = statuses.get("term_new");
  assert.ok(s?.kind === "paired" && s.orca?.handle === "h");
});

test("adjacency maps herdr right/down splits to Orca horizontal/vertical", () => {
  const left = { x: 0, y: 0, width: 100, height: 60 };
  assert.equal(adjacency(left, { x: 101, y: 0, width: 100, height: 60 })?.direction, "horizontal");
  assert.equal(adjacency(left, { x: 0, y: 61, width: 100, height: 30 })?.direction, "vertical");
  assert.equal(adjacency(left, { x: 150, y: 70, width: 10, height: 10 }), null);
});

function snapshotOf(panes: { paneId: string; terminalId: string; tabId: string; rect: { x: number; y: number; width: number; height: number } }[]) {
  return parseHerdrSnapshot(
    snapshotJson(
      makeWorld({
        panes: panes.map((p) => ({ ...p, workspaceId: "w1", cwd: "/repo" })),
        workspaces: [{ workspaceId: "w1", label: "proj" }],
      }),
    ),
  );
}

test("a new tab's first pane opens an Orca tab and its sibling splits next to it", () => {
  const snap = snapshotOf([
    { paneId: "w1:p2", terminalId: "term_b", tabId: "w1:t1", rect: { x: 101, y: 0, width: 100, height: 60 } },
    { paneId: "w1:p1", terminalId: "term_a", tabId: "w1:t1", rect: { x: 0, y: 0, width: 100, height: 60 } },
  ]);
  const targets = snap.panes.map((p) => ({ pane: p, worktreePath: "/repo", repoRoot: "/repo" }));
  const ops = planCreates(targets, snap, new Map(), { mirrorSplits: true });
  assert.deepEqual(
    ops.map((o) => [o.terminalId, o.split]),
    [
      ["term_a", null],
      ["term_b", { anchorTerminalId: "term_a", direction: "horizontal" }],
    ],
  );
  assert.equal(ops[0]?.title, "proj · 1");
});

test("splits only anchor on a non-orphaned pane of the same worktree; otherwise a new tab", () => {
  const snap = snapshotOf([
    { paneId: "w1:p1", terminalId: "term_a", tabId: "w1:t1", rect: { x: 0, y: 0, width: 100, height: 30 } },
    { paneId: "w1:p2", terminalId: "term_b", tabId: "w1:t1", rect: { x: 0, y: 31, width: 100, height: 30 } },
  ]);
  const target = [{ pane: snap.panes[1] as HerdrPane, worktreePath: "/repo", repoRoot: "/repo" }];
  const split = planCreates(target, snap, new Map([["term_a", { worktreePath: "/repo", orphaned: false }]]), { mirrorSplits: true });
  assert.deepEqual(split[0]?.split, { anchorTerminalId: "term_a", direction: "vertical" });
  assert.equal(planCreates(target, snap, new Map([["term_a", { worktreePath: "/repo", orphaned: true }]]), { mirrorSplits: true })[0]?.split, null);
  assert.equal(planCreates(target, snap, new Map([["term_a", { worktreePath: "/other", orphaned: false }]]), { mirrorSplits: true })[0]?.split, null);
  assert.equal(planCreates(target, snap, new Map([["term_a", { worktreePath: "/repo", orphaned: false }]]), { mirrorSplits: false })[0]?.split, null);
});

test("retired tabs are closed only when idle: no herdr attach, no agent, screen at a prompt or unknown", () => {
  const retired = { "d1db6aac-377a-468": { retiredAt: 1 }, "abcdef12-full-tab-id": { retiredAt: 1 } };
  const t = (handle: string, paneKey: string, extra: Partial<OrcaTerminal> = {}) => orcaTerm(handle, paneKey, extra);
  const terminals = [
    t("idle", "d1db6aac-377a-4688-a0e9-e7e098ea8b76:leaf", { preview: "csqc@mac repo %   " }),
    t("orphan", "abcdef12-full-tab-id:leaf", { preview: "", orphaned: true }),
    t("busy", "d1db6aac-377a-4688-a0e9-e7e098ea8b76:leaf2", { preview: "building... 42%done" }),
    t("agent", "d1db6aac-377a-4688-a0e9-e7e098ea8b76:leaf3", { agentIdentity: "claude", preview: "%" }),
    t("attached", "abcdef12-full-tab-id:leaf4", { preview: "%" }),
    t("other", "99999999-not-retired:leaf", { preview: "%" }),
  ];
  const attach = [{ pid: 1, terminalId: "term_x", paneId: "w1:p1", paneKey: "abcdef12-full-tab-id:leaf4", inOrca: true }];
  assert.deepEqual(retiredToClose(terminals, attach, retired).map((x) => x.handle), ["idle", "orphan"]);
  assert.deepEqual(retiredToClose(terminals, attach, {}), []);
});

test("visibilityActions: per-source hidden worktrees are imported, external ones flip the repo once", () => {
  const repos = [
    { id: "r1", path: "/r", externalWorktreeVisibility: "hide" },
    { id: "r2", path: "/s", externalWorktreeVisibility: "show" },
  ];
  const plan = visibilityActions(
    [
      { worktreePath: "/r", repoRoot: "/r" },
      { worktreePath: "/r/.claude/worktrees/a", repoRoot: "/r" },
      { worktreePath: "/home/.herdr/worktrees/r/b", repoRoot: "/r" },
      { worktreePath: "/home/.herdr/worktrees/r/c", repoRoot: "/r" },
      { worktreePath: "/s/.claude/worktrees/x", repoRoot: "/s" },
      { worktreePath: "/t", repoRoot: "/t" },
      { worktreePath: "/visible", repoRoot: "/r" },
    ],
    new Set(["/r", "/visible"]),
    repos,
  );
  assert.deepEqual(
    plan.actions.map((a) => [a.kind, a.worktreePath]),
    [
      ["import", "/r/.claude/worktrees/a"],
      ["show_external", "/home/.herdr/worktrees/r/b"],
      ["import", "/s/.claude/worktrees/x"],
    ],
  );
  assert.deepEqual(plan.missingRepos, ["/t"]);
});

test("orcaAppFromLauncher finds the app bundle and orcaWinDirFromLauncher finds the Windows install dir", () => {
  assert.equal(orcaAppFromLauncher("/Volumes/X/Applications/Orca.app/Contents/Resources/bin/orca"), "/Volumes/X/Applications/Orca.app");
  assert.equal(orcaAppFromLauncher("/usr/local/bin/orca"), null);
  assert.equal(
    orcaWinDirFromLauncher("C:\\Users\\Administrator\\AppData\\Local\\Programs\\orca\\resources\\bin\\orca.exe"),
    "C:\\Users\\Administrator\\AppData\\Local\\Programs\\orca",
  );
});

test("worktrees under .claude/worktrees are hidden by Orca's per-source policy", () => {
  assert.equal(hiddenBySource("/r/.claude/worktrees/x", "/r"), "claude");
  assert.equal(hiddenBySource("F:\\r\\.claude\\worktrees\\x", "F:\\r"), "claude");
  assert.equal(hiddenBySource("/home/u/.herdr/worktrees/r/x", "/r"), null);
});
