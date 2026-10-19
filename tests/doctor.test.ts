import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formatDoctor, runDoctor } from "../src/doctor.ts";
import { installShim } from "../src/shim.ts";
import { saveState, emptyState } from "../src/state.ts";
import { runSync } from "../src/sync.ts";
import { fakeOrca, fakeRunner, makeWorld, tempDirs } from "./helpers.ts";

const REPO = "/src/proj";
const BINS = { herdrBin: "/opt/homebrew/bin/herdr", nodeBin: "/usr/bin/node", mainPath: "/x/src/main.ts", socketPath: null };

test("doctor lists pairs, explains what is not shown, and flags leftover own panes", () => {
  const w = makeWorld({
    panes: [
      { paneId: "w1:p1", terminalId: "term_a", workspaceId: "w1", tabId: "w1:t1", cwd: REPO },
      { paneId: "w1:p2", terminalId: "term_b", workspaceId: "w1", tabId: "w1:t2", cwd: REPO },
      { paneId: "w9:p1", terminalId: "term_root", workspaceId: "w9", tabId: "w9:t1", cwd: "/" },
    ],
    workspaces: [{ workspaceId: "w1", label: "proj" }, { workspaceId: "w9", label: "root" }],
    git: { [REPO]: { top: REPO, repoRoot: REPO } },
    repos: [{ id: "r1", path: REPO, externalWorktreeVisibility: "show" }],
  });
  const orca = fakeOrca(w);
  const dirs = tempDirs();
  const home = mkdtempSync(join(tmpdir(), "orca-mirror-home-"));
  const deps = { run: fakeRunner(w), orca, ...BINS, ...dirs, now: () => 1_000_000 };
  runSync(deps, { dryRun: false, reason: "t", startedAt: 0, coalesce: false });
  // The user closes term_b's tab; Orca keeps an idle shell in term_a's pane (attach gone).
  const own = w.attach.find((a) => a.terminalId === "term_a");
  w.attach = [];
  w.orcaTerminals = w.orcaTerminals.filter((t) => t.paneKey === own?.paneKey);
  const r = runDoctor(deps, home);
  assert.equal(r.versions.herdrClient, "0.9.5");
  assert.equal(r.versions.orca, "1.4.229");
  assert.equal(r.pairs.length, 0);
  const reasons = Object.fromEntries(r.notShown.map((n) => [n.paneId, n.reason]));
  assert.match(reasons["w1:p2"] ?? "", /closed/);
  assert.match(reasons["w9:p1"] ?? "", /not inside a git checkout/);
  assert.equal(r.leftovers.length, 1);
  assert.match(formatDoctor(r), /leftover Orca panes \(1\)/);
});

test("doctor reports an unreachable Orca and a broken config as problems", () => {
  const w = makeWorld({ reachable: false });
  const dirs = tempDirs(`include_paths = /bad\n`);
  const r = runDoctor({ run: fakeRunner(w), orca: fakeOrca(w), ...BINS, ...dirs, now: () => 0 }, mkdtempSync(join(tmpdir(), "h-")));
  assert.ok(r.problems.some((p) => /config\.toml is invalid/.test(p)));
  assert.ok(r.problems.some((p) => /Orca is not running/.test(p)));
});

test("doctor warns when the legacy plugin would adopt", () => {
  const w = makeWorld();
  const home = mkdtempSync(join(tmpdir(), "h-"));
  const cfgDir = join(home, ".config/herdr/plugins/config/rudironsoni.herdr-orca-sync");
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, "config.toml"), "[sync]\nadopt = true\n");
  const run = fakeRunner(w);
  const withLegacy: typeof run = Object.assign(
    (argv: string[]) =>
      argv.includes("rudironsoni.herdr-orca-sync")
        ? { status: 0, stdout: JSON.stringify({ result: { plugins: [{ plugin_id: "x", enabled: true }] } }), stderr: "" }
        : run(argv),
    { calls: run.calls },
  );
  saveState(tempDirs().stateDir, emptyState());
  const r = runDoctor({ run: withLegacy, orca: fakeOrca(w), ...BINS, ...tempDirs(), now: () => 0 }, home);
  assert.ok(r.problems.some((p) => /adopt=true/.test(p)));
});

test("install-shim writes an executable shim and never overwrites a foreign file", () => {
  const home = mkdtempSync(join(tmpdir(), "h-"));
  const r = installShim({ home, nodeBin: "/usr/bin/node", mainPath: "/p q/src/main.ts", pathEnv: `${home}/.local/bin` });
  assert.equal(r.ok, true);
  assert.match(readFileSync(r.path, "utf8"), /exec '\/usr\/bin\/node' --disable-warning=ExperimentalWarning '\/p q\/src\/main.ts' "\$@"/);
  writeFileSync(r.path, "#!/bin/sh\necho mine\n");
  assert.equal(installShim({ home, nodeBin: "n", mainPath: "m", pathEnv: "" }).ok, false);
});
