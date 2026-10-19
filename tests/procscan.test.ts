import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAttachCandidates, parseEnvLines, scanAttachProcesses } from "../src/procscan.ts";
import type { Runner } from "../src/run.ts";

test("only the herdr attach leaf counts, whether launched by name or absolute path", () => {
  const ps = [
    "  101 herdr terminal attach term_65e2eade3f9bc27 --takeover",
    "  102 /opt/homebrew/bin/herdr terminal attach term_65e1b76a4a36fe --takeover",
    "  103 /usr/bin/node /x/herdr-orca/dist/herdr-orca.mjs attach --terminal term_zzz",
    "  104 rg herdr terminal attach term_qqq",
    "  105 /bin/zsh -l",
  ].join("\n");
  assert.deepEqual(parseAttachCandidates(ps), [
    { pid: 101, terminalId: "term_65e2eade3f9bc27", paneId: null },
    { pid: 102, terminalId: "term_65e1b76a4a36fe", paneId: null },
  ]);
});

test("our attach loop is recognised with its pane id, even with spaces in the plugin path", () => {
  const ps = "  201 /usr/bin/node --disable-warning=ExperimentalWarning /Volumes/SAMSUNG SSD01/p/src/main.ts attach --pane w1W:p1 --terminal term_65e2fae0083b81 --herdr /opt/homebrew/bin/herdr";
  assert.deepEqual(parseAttachCandidates(ps), [{ pid: 201, terminalId: "term_65e2fae0083b81", paneId: "w1W:p1" }]);
});

test("ORCA_PANE_KEY marks an Orca pane; readable env without it means attached elsewhere; unreadable is unknown", () => {
  const out = parseEnvLines(
    [
      "101 herdr terminal attach term_a --takeover TERM_PROGRAM=Orca PATH=/usr/bin ORCA_PANE_KEY=d0c88533-ed32:00d5bfea-cf3b ORCA_TAB_ID=d0c88533-ed32",
      "102 herdr terminal attach term_b --takeover PATH=/usr/bin TERM_PROGRAM=ghostty",
      "103 herdr terminal attach term_c --takeover",
    ].join("\n"),
  );
  assert.deepEqual(out.get(101), { paneKey: "d0c88533-ed32:00d5bfea-cf3b", inOrca: true });
  assert.deepEqual(out.get(102), { paneKey: null, inOrca: false });
  assert.deepEqual(out.get(103), { paneKey: null, inOrca: null });
});

test("scanAttachProcesses reads env only for attach pids and reports missing env as unknown", () => {
  const calls: string[][] = [];
  const run: Runner = (argv) => {
    calls.push(argv);
    if (argv[1] === "-axww") return { status: 0, stdout: "11 herdr terminal attach term_a --takeover\n12 herdr terminal attach term_b --takeover\n", stderr: "" };
    return { status: 0, stdout: "11 herdr terminal attach term_a --takeover PATH=/x ORCA_PANE_KEY=t:l\n", stderr: "" };
  };
  assert.deepEqual(scanAttachProcesses(run), [
    { pid: 11, terminalId: "term_a", paneId: null, paneKey: "t:l", inOrca: true },
    { pid: 12, terminalId: "term_b", paneId: null, paneKey: null, inOrca: null },
  ]);
  assert.deepEqual(calls[1], ["ps", "-ww", "-E", "-o", "pid=,command=", "-p", "11,12"]);
});

test("a failing ps aborts the scan instead of reporting nothing attached", () => {
  assert.throws(() => scanAttachProcesses(() => ({ status: 1, stdout: "", stderr: "boom" })), /ps failed/);
});
