#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

function run(cmd: string[], cwd: string): string {
	const result = Bun.spawnSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"] });
	if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${result.stderr.toString()}`);
	return result.stdout.toString().trim();
}

export async function copyNativeAddon(sourceDir: string, packageDir: string, target: { platform: string; arch: string }): Promise<void> {
	const nativeDir = path.join(sourceDir, "packages", "natives", "native");
	const { version } = await Bun.file(path.join(nativeDir, "..", "package.json")).json();
	const leaf = `@oh-my-pi/pi-natives-${target.platform}-${target.arch}`;
	const manifest = await Bun.file(path.join(packageDir, "package.json")).json();
	if (manifest.name !== leaf || manifest.version !== version) throw new Error(`Native package does not match ${leaf}@${version}`);
	// Setup fetches the pinned source; its validation module does not exist at script startup.
	const { containsVersionStamp, containsLegacyVersionSentinel } = await import(pathToFileURL(path.join(nativeDir, "version-sentinel.js")).href);
	const tag = `${target.platform}-${target.arch}`;
	const names = target.arch === "x64"
		? [`pi_natives.${tag}-modern.node`, `pi_natives.${tag}-baseline.node`]
		: [`pi_natives.${tag}.node`];
	const files = (await fs.readdir(packageDir)).filter(file => names.includes(file));
	if (files.length === 0) throw new Error(`No native addons found for ${tag}`);
	for (const file of files) {
		const bytes = await fs.readFile(path.join(packageDir, file));
		if (!containsVersionStamp(bytes, version) && !containsLegacyVersionSentinel(bytes, version)) {
			throw new Error(`Native addon ${file} does not carry the @oh-my-pi/pi-natives@${version} version stamp`);
		}
	}
	for (const file of files) await fs.copyFile(path.join(packageDir, file), path.join(nativeDir, file));
}

export async function installNativeAddon(sourceDir: string, target: { platform: string; arch: string }): Promise<void> {
	const { version } = await Bun.file(path.join(sourceDir, "packages", "natives", "package.json")).json();
	const staging = await fs.mkdtemp(path.join(path.dirname(sourceDir), "native-"));
	try {
		const leaf = `@oh-my-pi/pi-natives-${target.platform}-${target.arch}`;
		const packed = JSON.parse(run([
			"npm", "pack", `${leaf}@${version}`, "--registry=https://registry.npmjs.org",
			"--ignore-scripts", "--json", "--pack-destination", staging,
		], sourceDir));
		const filename = packed[0]?.filename;
		if (typeof filename !== "string" || !/^[\w.-]+\.tgz$/.test(filename)) throw new Error("Invalid native package archive");
		const tar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
		run([tar, "-xf", path.join(staging, filename), "-C", staging], sourceDir);
		await copyNativeAddon(sourceDir, path.join(staging, "package"), target);
	} finally {
		await fs.rm(staging, { recursive: true, force: true });
	}
}
async function useOmpBuild(): Promise<void> {
	const runnerDir = path.resolve(import.meta.dir, "..");
	const pinPath = path.join(runnerDir, "omp-build.json");
	const pin = await Bun.file(pinPath).json();
	const commit = process.argv[2] ?? pin.commit;
	if (pin.repo !== "can1357/oh-my-pi" || !/^[0-9a-f]{40}$/.test(commit ?? "")) {
		throw new Error("omp-build.json must pin can1357/oh-my-pi to a full commit SHA");
	}
	const sourceDir = path.join(runnerDir, "vendor", "omp");

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
			await fs.rm(sourceDir, { recursive: true, force: true });
			await fs.rename(staging, sourceDir);
		} finally {
			await fs.rm(staging, { recursive: true, force: true });
		}
	} else {
		patchSource(sourceDir);
	}
	// Windows workspace junctions must be created at their final path, not under omp.new.
	run([process.execPath, "install", "--frozen-lockfile"], sourceDir);
	await installNativeAddon(sourceDir, { platform: process.platform, arch: process.arch });
	const modules = path.join(runnerDir, "node_modules");
	await fs.rm(modules, { recursive: true, force: true });
	await fs.symlink(path.join(sourceDir, "node_modules"), modules, process.platform === "win32" ? "junction" : "dir");
	if (process.argv[2]) await Bun.write(pinPath, `${JSON.stringify({ repo: pin.repo, commit }, null, 2)}\n`);
	console.log(`OMP_COMMIT=${commit}`);
}

if (import.meta.main) await useOmpBuild();
