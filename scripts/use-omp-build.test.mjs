import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("source setup rejects unpinned or foreign source before touching the installed build", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "omp-source-pin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "vendor", "omp"), { recursive: true });
  const previous = join(root, "vendor", "omp", "previous");
  writeFileSync(previous, "installed source");
  const script = join(root, "scripts", "use-omp-build.ts");
  copyFileSync(new URL("../runner/scripts/use-omp-build.ts", import.meta.url), script);
  for (const pin of [
    { repo: "can1357/oh-my-pi", commit: "main" },
    { repo: "can1357/oh-my-pi", tag: "v18.20.0-int.202611131515.g11d9dc7" },
    { repo: "foreign/source", commit: "a".repeat(40) },
  ]) {
    writeFileSync(join(root, "omp-build.json"), JSON.stringify(pin));
    const child = Bun.spawn([process.execPath, script], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    assert.notEqual(code, 0);
    assert.match(stderr, /must pin can1357\/oh-my-pi to a full commit SHA/);
    assert.equal(readFileSync(previous, "utf8"), "installed source");
  }
});

test("source setup refuses an incompatible host patch before changing dependencies", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "omp-source-patch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "vendor", "omp");
  mkdirSync(source, { recursive: true });
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "patches"));
  copyFileSync(new URL("../runner/scripts/use-omp-build.ts", import.meta.url), join(root, "scripts", "use-omp-build.ts"));
  const git = (...args) => execFileSync("git", args, { cwd: source, encoding: "utf8" }).trim();
  git("init", "--quiet");
  writeFileSync(join(source, "main.ts"), "changed upstream API\n");
  git("add", "main.ts");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "core.hooksPath=/dev/null", "commit", "--no-gpg-sign", "-m", "fixture");
  writeFileSync(join(root, "omp-build.json"), JSON.stringify({ repo: "can1357/oh-my-pi", commit: git("rev-parse", "HEAD") }));
  writeFileSync(join(root, "patches", "session-host.patch"), "--- a/main.ts\n+++ b/main.ts\n@@ -1 +1 @@\n-expected upstream API\n+host hook\n");
  const child = Bun.spawn([process.execPath, join(root, "scripts", "use-omp-build.ts")], {
    cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  assert.notEqual(code, 0);
  assert.match(stderr, /patch.*(failed|does not apply)/);
  assert.equal(readFileSync(join(source, "main.ts"), "utf8"), "changed upstream API\n");
  assert.equal(git("status", "--porcelain"), "");
});
