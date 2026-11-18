import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { copyNativeAddon } from "../runner/scripts/use-omp-build.ts";

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

function nativeFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "omp-native-package-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const native = join(source, "packages", "natives", "native");
  const packed = join(root, "package");
  mkdirSync(native, { recursive: true });
  mkdirSync(packed);
  writeFileSync(join(native, "..", "package.json"), JSON.stringify({ version: "1.2.3" }));
  copyFileSync(new URL("../runner/vendor/omp/packages/natives/native/version-sentinel.js", import.meta.url), join(native, "version-sentinel.js"));
  return { source, native, packed };
}

test("native packages keep exact release identities and target variants for source and cross builds", async (t) => {
  const { source, native, packed } = nativeFixture(t);
  for (const target of [
    { platform: "linux", arch: "x64" },
    { platform: "linux", arch: "arm64" },
    { platform: "darwin", arch: "x64" },
    { platform: "darwin", arch: "arm64" },
    { platform: "win32", arch: "x64" },
  ]) {
    const tag = `${target.platform}-${target.arch}`;
    writeFileSync(join(packed, "package.json"), JSON.stringify({ name: `@oh-my-pi/pi-natives-${tag}`, version: "1.2.3" }));
    const names = target.arch === "x64" ? [`pi_natives.${tag}-baseline.node`, `pi_natives.${tag}-modern.node`] : [`pi_natives.${tag}.node`];
    for (const [index, name] of names.entries()) {
      writeFileSync(join(packed, name), index ? "__piNativesV1_2_3\0" : "PI_NATIVES_VERSION_STAMP:1.2.3\0");
    }
    await copyNativeAddon(source, packed, target);
    for (const name of names) assert.deepEqual(readFileSync(join(native, name)), readFileSync(join(packed, name)));
  }
});

test("native setup rejects foreign versions, missing addons and invalid stamps before copying", async (t) => {
  const { source, native, packed } = nativeFixture(t);
  const target = { platform: "linux", arch: "x64" };
  const manifest = { name: "@oh-my-pi/pi-natives-linux-x64", version: "1.2.3" };
  for (const patch of [{ name: "@oh-my-pi/pi-natives-win32-x64" }, { version: "1.2.30" }]) {
    writeFileSync(join(packed, "package.json"), JSON.stringify({ ...manifest, ...patch }));
    await assert.rejects(copyNativeAddon(source, packed, target), /Native package does not match/);
  }
  writeFileSync(join(packed, "package.json"), JSON.stringify(manifest));
  await assert.rejects(copyNativeAddon(source, packed, target), /No native addons found/);
  const baseline = "pi_natives.linux-x64-baseline.node";
  const modern = "pi_natives.linux-x64-modern.node";
  writeFileSync(join(packed, baseline), "PI_NATIVES_VERSION_STAMP:1.2.3\0");
  for (const bytes of ["unstamped", "PI_NATIVES_VERSION_STAMP:1.2.30\0", "__piNativesV1_2_30\0"]) {
    writeFileSync(join(packed, modern), bytes);
    await assert.rejects(copyNativeAddon(source, packed, target), /does not carry.*version stamp/);
    assert.equal(existsSync(join(native, baseline)), false);
    assert.equal(existsSync(join(native, modern)), false);
  }
});

test("prepared source runner starts before a binary build", { timeout: 30_000 }, async () => {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../runner/src/cli.ts", import.meta.url)), "--version"], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  assert.equal(code, 0, stderr);
  assert.match(stdout, /\d+\.\d+\.\d+/);
});
