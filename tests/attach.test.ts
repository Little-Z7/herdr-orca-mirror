import assert from "node:assert/strict";
import { test } from "node:test";
import { RECONNECT_WINDOW_MS, paneTerminalVia, runAttachLoop, tuiSizeVia, type AttachLoopDeps, type PaneLookup } from "../src/attach.ts";

function deps(
  lookups: PaneLookup[],
  results: ("ended" | "input_closed")[] = [],
  attachMs = 5_000,
): AttachLoopDeps & { attached: string[] } {
  let clock = 0;
  const attached: string[] = [];
  return {
    attached,
    async attach(id) {
      attached.push(id);
      clock += attachMs;
      return results.shift() ?? "ended";
    },
    paneTerminal: () => lookups.shift() ?? { kind: "gone" },
    async sleep(ms) {
      clock += ms;
    },
    now: () => clock,
    log: () => {},
  };
}

test("after a herdr live update the loop reattaches the pane's new terminal in place", async () => {
  const d = deps([{ kind: "unavailable" }, { kind: "terminal", terminalId: "term_new" }, { kind: "gone" }]);
  assert.equal(await runAttachLoop("w1:p1", "term_old", d), 0);
  assert.deepEqual(d.attached, ["term_old", "term_new"]);
});

test("a dropped stream on the same terminal reconnects; a closed pane ends the tab", async () => {
  const d = deps([{ kind: "terminal", terminalId: "term_a" }, { kind: "gone" }]);
  assert.equal(await runAttachLoop("w1:p1", "term_a", d), 0);
  assert.deepEqual(d.attached, ["term_a", "term_a"]);
});

test("the Orca pane closing ends the loop without looking the pane up", async () => {
  const d = deps([{ kind: "terminal", terminalId: "term_a" }], ["input_closed"]);
  assert.equal(await runAttachLoop("w1:p1", "term_a", d), 0);
  assert.deepEqual(d.attached, ["term_a"]);
});

test("herdr staying unreachable past the reconnect window gives up", async () => {
  const d = deps(Array.from({ length: RECONNECT_WINDOW_MS / 500 + 10 }, () => ({ kind: "unavailable" as const })));
  assert.equal(await runAttachLoop("w1:p1", "term_a", d), 1);
});

test("a stream that keeps closing immediately stops after a few tries", async () => {
  const d = deps(Array.from({ length: 20 }, () => ({ kind: "terminal" as const, terminalId: "term_a" })), [], 10);
  assert.equal(await runAttachLoop("w1:p1", "term_a", d), 1);
  assert.equal(d.attached.length, 5);
});

test("paneTerminalVia distinguishes pane_not_found from herdr being unavailable", () => {
  const lookup = paneTerminalVia((argv) => {
    if (argv[3] === "w1:p1") return { status: 0, stdout: JSON.stringify({ result: { pane: { terminal_id: "term_x" } } }), stderr: "" };
    if (argv[3] === "w1:gone") return { status: 1, stdout: JSON.stringify({ error: { code: "pane_not_found" } }), stderr: "" };
    return { status: 1, stdout: "", stderr: "connection refused" };
  }, "herdr");
  assert.deepEqual(lookup("w1:p1"), { kind: "terminal", terminalId: "term_x" });
  assert.deepEqual(lookup("w1:gone"), { kind: "gone" });
  assert.deepEqual(lookup("w1:other"), { kind: "unavailable" });
});

test("tuiSizeVia reads herdr's layout rect for the pane", () => {
  const size = tuiSizeVia(
    () => ({ status: 0, stdout: JSON.stringify({ result: { layout: { panes: [{ pane_id: "w1:p2", rect: { x: 0, y: 0, width: 173, height: 55 } }] } } }), stderr: "" }),
    "herdr",
    "w1:p2",
  );
  assert.deepEqual(size(), { cols: 173, rows: 55 });
});
