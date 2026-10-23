import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { emptyState, loadState, saveState, withLock } from "../src/state.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "orca-mirror-state-"));

test("state round-trips and a missing file is empty", () => {
  const dir = tmp();
  assert.deepEqual(loadState(dir), emptyState());
  const s = { ...emptyState(), lastSyncStartedAt: 7, terminals: { term_a: { status: "paired" as const, handle: "h" } } };
  saveState(dir, s);
  assert.deepEqual(loadState(dir), s);
});

test("withLock serializes concurrent processes", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "counter"), "0");
  const stateModule = new URL("../src/state.ts", import.meta.url).href;
  const script = `
    import { readFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { withLock } from ${JSON.stringify(stateModule)};
    const dir = process.argv[1];
    for (let i = 0; i < 5; i += 1) {
      withLock(dir, () => {
        const n = Number(readFileSync(join(dir, "counter"), "utf8"));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        writeFileSync(join(dir, "counter"), String(n + 1));
      });
    }`;
  const runs = Array.from({ length: 5 }, () =>
    new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script, dir], {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
      let stderr = "";
      child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("close", (code) => resolve({ code, stderr }));
    }),
  );
  for (const r of await Promise.all(runs)) assert.equal(r.code, 0, r.stderr);
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
