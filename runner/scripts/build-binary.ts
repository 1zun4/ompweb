#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { compileCodingAgent } from "../vendor/omp/packages/coding-agent/scripts/compile-binary";

const runnerDir = path.resolve(import.meta.dir, "..");
const sourceDir = path.join(runnerDir, "vendor", "omp");
const targets: Record<string, { platform: string; arch: string; bun: Bun.Build.CompileTarget }> = {
	"linux-x64": { platform: "linux", arch: "x64", bun: "bun-linux-x64-baseline" },
	"linux-arm64": { platform: "linux", arch: "arm64", bun: "bun-linux-arm64" },
	"darwin-x64": { platform: "darwin", arch: "x64", bun: "bun-darwin-x64-baseline" },
	"darwin-arm64": { platform: "darwin", arch: "arm64", bun: "bun-darwin-arm64" },
	"windows-x64": { platform: "win32", arch: "x64", bun: "bun-windows-x64-baseline" },
};
const hostId = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const ids = process.argv.length > 2 ? process.argv.slice(2) : [hostId];
for (const id of ids) {
	if (!targets[id]) throw new Error(`Unknown target ${id}`);
}
function run(cmd: string[], cwd = sourceDir): string {
	const result = Bun.spawnSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"] });
	if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${result.stderr.toString()}`);
	return result.stdout.toString();
}
const pin = await Bun.file(path.join(runnerDir, "omp-build.json")).json();
if (run(["git", "rev-parse", "HEAD"]).trim() !== pin.commit) throw new Error("OMP source does not match omp-build.json");
const nativeDir = path.join(sourceDir, "packages", "natives", "native");
const { version } = await Bun.file(path.join(nativeDir, "..", "package.json")).json();
await fs.mkdir(path.join(runnerDir, "release"), { recursive: true });
run([process.execPath, "run", "gen:stats"]);
run([process.execPath, "run", "gen:export-viewer"]);
try {
	for (const id of ids) {
		const target = targets[id];
		const staging = await fs.mkdtemp(path.join(runnerDir, "vendor", "native-"));
		try {
			const leaf = `@oh-my-pi/pi-natives-${target.platform}-${target.arch}`;
			const packed = JSON.parse(run([
				"npm", "pack", `${leaf}@${version}`, "--registry=https://registry.npmjs.org",
				"--ignore-scripts", "--json", "--pack-destination", staging,
			]));
			const filename = packed[0]?.filename;
			if (typeof filename !== "string" || !/^[\w.-]+\.tgz$/.test(filename)) throw new Error("Invalid native package archive");
			const tar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
			run([tar, "-xf", path.join(staging, filename), "-C", staging]);
			const manifest = await Bun.file(path.join(staging, "package", "package.json")).json();
			if (manifest.name !== leaf || manifest.version !== version) throw new Error(`Native package does not match ${leaf}@${version}`);
			for (const file of await fs.readdir(path.join(staging, "package"))) {
				if (file.startsWith(`pi_natives.${target.platform}-${target.arch}`) && file.endsWith(".node")) {
					await fs.copyFile(path.join(staging, "package", file), path.join(nativeDir, file));
				}
			}
		} finally {
			await fs.rm(staging, { recursive: true, force: true });
		}
		const extension = target.platform === "win32" ? ".exe" : "";
		for (const name of ["ompweb-omp", "omp"]) {
			const outfile = path.join(runnerDir, "release", `${name}-${id}${extension}`);
			await compileCodingAgent({
				repoRoot: runnerDir,
				entrypoint: name === "omp" ? path.join(sourceDir, "packages", "coding-agent", "src", "cli.ts") : path.join(runnerDir, "src", "cli.ts"),
				outfile,
				native: target,
				target: target.bun,
				minifyIdentifiers: true,
				skipBuiltinCodesign: target.platform === "darwin" && process.platform === "darwin",
			});
			if (target.platform === "darwin" && process.platform === "darwin") {
				run(["codesign", "--force", "--sign", "-", "--entitlements", path.join(sourceDir, "scripts", "macos-entitlements.plist"), outfile]);
			}
		}
	}
} finally {
	run([process.execPath, "run", "gen:stats:reset"]);
}
