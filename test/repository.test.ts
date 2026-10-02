import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { it } from "node:test";

it("keeps repository lockfile metadata aligned with the package", async () => {
	const manifest = JSON.parse(await readFile("package.json", "utf8"));
	const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
	assert.equal(lock.version, manifest.version);
	assert.equal(lock.packages[""].version, manifest.version);
	assert.deepEqual(lock.packages[""].peerDependencies, manifest.peerDependencies);
	assert.deepEqual(lock.packages[""].devDependencies, manifest.devDependencies);
	for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
		assert.equal(lock.packages[`node_modules/${name}`].version, manifest.devDependencies[name]);
	}
});
