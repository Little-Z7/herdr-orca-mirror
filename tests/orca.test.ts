import assert from "node:assert/strict";
import { test } from "node:test";
import { OrcaCommandError, orcaCli, paneKeyOf, parseRepoList, parseTerminalList } from "../src/orca.ts";
import type { Runner } from "../src/run.ts";

test("paneKeyOf uses tabId:leafId for live rows and recordedPaneKey for orphaned rows", () => {
  assert.equal(paneKeyOf({ tabId: "t1", leafId: "l1" }), "t1:l1");
  assert.equal(paneKeyOf({ tabId: "pty:3369", leafId: "pty:3369", recordedPaneKey: "t9:l9", orphaned: true }), "t9:l9");
  assert.equal(paneKeyOf({ tabId: "pty:3369", leafId: "pty:3369", orphaned: true }), null);
});

test("parseTerminalList keeps the fields Orca 1.4.229 returns and the truncated flag", () => {
  const parsed = parseTerminalList({
    result: {
      terminals: [
        { handle: "term_a", tabId: "t1", leafId: "l1", worktreeId: "r::/w", worktreePath: "/w", title: "x", orphaned: false },
        { handle: "term_b", tabId: "pty:1", leafId: "pty:1", recordedPaneKey: "t2:l2", worktreePath: "/w", title: null, orphaned: true },
        { tabId: "no-handle" },
      ],
      truncated: true,
    },
  });
  assert.equal(parsed.truncated, true);
  assert.deepEqual(
    parsed.terminals.map((t) => [t.handle, t.paneKey, t.orphaned]),
    [
      ["term_a", "t1:l1", false],
      ["term_b", "t2:l2", true],
    ],
  );
  assert.throws(() => parseTerminalList({ result: {} }));
});

test("parseRepoList reads id, path and external worktree visibility", () => {
  assert.deepEqual(parseRepoList({ result: { repos: [{ id: "r1", path: "/p", externalWorktreeVisibility: "show" }, { id: "x" }] } }), [
    { id: "r1", path: "/p", externalWorktreeVisibility: "show" },
  ]);
});

function runnerReturning(stdout: string, status: number | null = 0): Runner & { argv: string[][] } {
  const argv: string[][] = [];
  const run = ((a: string[]) => {
    argv.push(a);
    return { status, stdout, stderr: "" };
  }) as Runner & { argv: string[][] };
  run.argv = argv;
  return run;
}

test("createTerminal passes worktree/title/command and returns handle + paneKey", () => {
  const run = runnerReturning(JSON.stringify({ ok: true, result: { terminal: { handle: "term_x", paneKey: "t:l", tabId: "t" } } }));
  const created = orcaCli(run).createTerminal({ worktreePath: "/repo", title: "ws · 1", command: "exec herdr" });
  assert.deepEqual(created, { handle: "term_x", paneKey: "t:l" });
  assert.deepEqual(run.argv[0], [
    "orca", "terminal", "create", "--worktree", "path:/repo", "--title", "ws · 1", "--command", "exec herdr", "--json",
  ]);
});

test("splitTerminal derives the pane key from tabId and leafId", () => {
  const run = runnerReturning(JSON.stringify({ ok: true, result: { split: { handle: "term_s", tabId: "t", leafId: "l2", paneRuntimeId: -1 } } }));
  assert.deepEqual(orcaCli(run).splitTerminal({ handle: "term_a", direction: "horizontal", command: "c" }), { handle: "term_s", paneKey: "t:l2" });
});

test("an ok:false envelope is a definite failure; no readable reply is ambiguous", () => {
  const refused = runnerReturning(JSON.stringify({ ok: false, error: { code: "worktree_not_found", message: "worktree_not_found" } }), 1);
  assert.throws(
    () => orcaCli(refused).createTerminal({ worktreePath: "/x", title: "t", command: "c" }),
    (e: unknown) => e instanceof OrcaCommandError && !e.ambiguous && /worktree_not_found/.test(e.message),
  );
  const timedOut = runnerReturning("", null);
  assert.throws(
    () => orcaCli(timedOut).createTerminal({ worktreePath: "/x", title: "t", command: "c" }),
    (e: unknown) => e instanceof OrcaCommandError && e.ambiguous,
  );
});

test("reachable reads runtime.reachable and treats errors as unreachable", () => {
  assert.equal(orcaCli(runnerReturning(JSON.stringify({ ok: true, result: { runtime: { reachable: true } } }))).reachable(), true);
  assert.equal(orcaCli(runnerReturning("garbage", 1)).reachable(), false);
});
