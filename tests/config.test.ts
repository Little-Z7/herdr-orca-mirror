import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, loadConfig, parseConfig } from "../src/config.ts";

test("missing config means defaults: enabled, mirror everything", () => {
  assert.deepEqual(parseConfig(null), { config: DEFAULT_CONFIG, errors: [] });
});

test("parses booleans and include_paths, expanding ~ and allowing commas in paths", () => {
  const { config, errors } = parseConfig(`
# comment
[sync]
enabled = true
mirror_splits = false   # trailing comment
include_paths = ["~/src/test,repo", "/abs/path"]
auto_add_repo = false
`);
  assert.deepEqual(errors, []);
  assert.equal(config.mirrorSplits, false);
  assert.equal(config.autoAddRepo, false);
  assert.deepEqual(config.includePaths, [join(homedir(), "src/test,repo"), "/abs/path"]);
});

test("unknown keys and malformed values are errors", () => {
  const { errors } = parseConfig(`enabled = yes\ninclude_paths = [/x]\nadopt = true\n`);
  assert.equal(errors.length, 3);
});

test("a broken config file disables syncing rather than mirroring everything", () => {
  const dir = mkdtempSync(join(tmpdir(), "orca-mirror-cfg-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.toml"), `include_paths = "/oops"\n`);
  const { config, errors } = loadConfig(dir);
  assert.equal(config.enabled, false);
  assert.equal(errors.length, 1);
});
