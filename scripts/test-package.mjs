import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "thinking-steps-package-"));
try {
	const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", root], { encoding: "utf8" }));
	assert.equal(packed.length, 1);
	execFileSync("tar", ["-xzf", join(root, packed[0].filename), "-C", root], { stdio: "inherit" });
	const cwd = join(root, "package");
	const files = await readdir(cwd);
	for (const excluded of ["AGENTS.md", "package-lock.json", ".git", ".pi", "node_modules", "prompts", "plan.md", "progress.md"]) assert.ok(!files.includes(excluded), `Unexpected package artifact: ${excluded}`);
	const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
	assert.ok(manifest.scripts.test);
	execFileSync("npm", ["install", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"], { cwd, stdio: "inherit" });
	execFileSync("npm", ["test"], { cwd, stdio: "inherit" });
	console.log("Extracted package validation passed without repository-only files.");
} finally {
	await rm(root, { recursive: true, force: true });
}
