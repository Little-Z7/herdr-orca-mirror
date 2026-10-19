import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { emptyState, loadState, saveState, withLock } from "../src/state.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "orca-mirror-state-"));

test("state round-trips and a missing file is empty", () => {
  const dir = tmp();
  assert.deepEqual(loadState(dir), emptyState());
  const s = { ...emptyState(), lastSyncStartedAt: 7, terminals: { term_a: { status: "paired" as const, handle: "h" } } };
  saveState(dir, s);
  assert.deepEqual(loadState(dir), s);
});

test("withLock serializes concurrent processes", () => {
  const dir = tmp();
  writeFileSync(join(dir, "counter"), "0");
  const stateModule = fileURLToPath(new URL("../src/state.ts", import.meta.url));
  const script = `
    import { readFileSync, writeFileSync } from "node:fs";
    import { withLock } from ${JSON.stringify(stateModule)};
    const dir = process.argv[1];
    withLock(dir, () => {
      const n = Number(readFileSync(dir + "/counter", "utf8"));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
      writeFileSync(dir + "/counter", String(n + 1));
    });`;
  const children = Array.from({ length: 5 }, () =>
    spawnSync(
      "sh",
      ["-c", `for i in 1 2 3 4 5; do node --disable-warning=ExperimentalWarning --input-type=module -e '${script.replace(/'/g, `'\\''`)}' ${dir} & done; wait`],
      { encoding: "utf8" },
    ),
  );
  for (const c of children) assert.equal(c.status, 0, c.stderr);
  assert.equal(readFileSync(join(dir, "counter"), "utf8"), "25");
});

test("a lock left by a dead process is broken", () => {
  const dir = tmp();
  writeFileSync(join(dir, "sync.lock"), "999999\n");
  assert.equal(withLock(dir, () => "ran", { timeoutMs: 1000 }), "ran");
});

test("a fresh lock file whose pid is not written yet is respected", () => {
  const dir = tmp();
  writeFileSync(join(dir, "sync.lock"), "");
  assert.throws(() => withLock(dir, () => "ran", { timeoutMs: 300 }), /timed out/);
});
