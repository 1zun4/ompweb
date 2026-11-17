#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as path from "node:path";

const runnerDir = path.resolve(import.meta.dir, "..");
const pinPath = path.join(runnerDir, "omp-build.json");
const pin = await Bun.file(pinPath).json();
const commit = process.argv[2] ?? pin.commit;
if (pin.repo !== "can1357/oh-my-pi" || !/^[0-9a-f]{40}$/.test(commit ?? "")) {
	throw new Error("omp-build.json must pin can1357/oh-my-pi to a full commit SHA");
}
const sourceDir = path.join(runnerDir, "vendor", "omp");
function run(cmd: string[], cwd: string): string {
	const result = Bun.spawnSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"] });
	if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${result.stderr.toString()}`);
	return result.stdout.toString().trim();
}

function patchSource(cwd: string): void {
	for (const name of ["session-host", "chunk-paths"]) {
		const patch = path.join(runnerDir, "patches", `${name}.patch`);
		const applied = Bun.spawnSync(["git", "apply", "--recount", "--reverse", "--check", patch], {
			cwd, stdio: ["ignore", "pipe", "pipe"],
		});
		if (applied.exitCode === 0) continue;
		run(["git", "apply", "--recount", "--check", patch], cwd);
		run(["git", "apply", "--recount", patch], cwd);
	}
}

await fs.mkdir(path.dirname(sourceDir), { recursive: true });
const installed = await fs.access(path.join(sourceDir, ".git")).then(() => true, () => false);
if (!installed || run(["git", "rev-parse", "HEAD"], sourceDir) !== commit) {
	const staging = `${sourceDir}.new`;
	await fs.rm(staging, { recursive: true, force: true });
	await fs.mkdir(staging);
	try {
		run(["git", "init", "--quiet"], staging);
		run(["git", "fetch", "--depth=1", `https://github.com/${pin.repo}.git`, commit], staging);
		run(["git", "checkout", "--detach", "FETCH_HEAD"], staging);
		if (run(["git", "rev-parse", "HEAD"], staging) !== commit) throw new Error("OMP checkout does not match its pin");
		patchSource(staging);
		run([process.execPath, "install", "--frozen-lockfile"], staging);
		await fs.rm(sourceDir, { recursive: true, force: true });
		await fs.rename(staging, sourceDir);
	} finally {
		await fs.rm(staging, { recursive: true, force: true });
	}
} else {
	patchSource(sourceDir);
	run([process.execPath, "install", "--frozen-lockfile"], sourceDir);
}
// One workspace dependency graph keeps every @oh-my-pi import on the pinned source.
const modules = path.join(runnerDir, "node_modules");
await fs.rm(modules, { recursive: true, force: true });
await fs.symlink(path.join(sourceDir, "node_modules"), modules, process.platform === "win32" ? "junction" : "dir");
if (process.argv[2]) await Bun.write(pinPath, `${JSON.stringify({ repo: pin.repo, commit }, null, 2)}\n`);
console.log(`OMP_COMMIT=${commit}`);
