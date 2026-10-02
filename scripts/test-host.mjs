import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

const hostRoot = resolve(process.env.PI_TEST_HOST_PACKAGE ?? "node_modules/@earendil-works/pi-coding-agent");
const bundled = existsSync(join(hostRoot, "dist/bundle/index.js"));
process.env.PI_PACKAGE_DIR = hostRoot;
const host = await import(pathToFileURL(join(hostRoot, bundled ? "dist/bundle/index.js" : "dist/index.js")).href);
const deep = await import(pathToFileURL(join(hostRoot, "dist/modes/interactive/components/assistant-message.js")).href);
host.initTheme("dark", true);
const original = host.AssistantMessageComponent.prototype.updateContent;
const deepOriginal = deep.AssistantMessageComponent.prototype.updateContent;
if (bundled) assert.notEqual(host.AssistantMessageComponent, deep.AssistantMessageComponent);
const root = await mkdtemp(join(tmpdir(), "thinking-steps-host-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
let extension;
let ctx;
try {
	const agentDir = join(root, "agent");
	await mkdir(agentDir);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const loaded = await host.discoverAndLoadExtensions([resolve("index.ts")], root, agentDir);
	assert.deepEqual(loaded.errors, []);
	extension = loaded.extensions.find((entry) => entry.commands.has("thinking-steps"));
	assert.ok(extension, "Extension must load through the actual host loader");
	const notices = [];
	const choices = [];
	const viewed = [];
	const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };
	ctx = {
		cwd: root, mode: "tui", hasUI: true, isIdle: () => true,
		sessionManager: host.SessionManager.create(root, root),
		ui: {
			theme, notify: (message, level) => notices.push({ message, level }), setStatus() {}, setHiddenThinkingLabel() {},
			confirm: async () => true,
			select: async (_title, options) => { const index = choices.shift(); return index === undefined ? undefined : options[index]; },
			custom: async (factory) => {
				const viewer = await factory({ terminal: { rows: 30 }, requestRender() {} }, theme, {}, () => {});
				viewed.push(viewer.render(100).join("\n"));
				viewer.handleInput("\x1b");
			},
		},
	};
	const runtime = loaded.runtime;
	runtime.appendEntry = (name, data) => ctx.sessionManager.appendCustomEntry(name, data);
	for (const handler of extension.handlers.get("session_start") ?? []) await handler({}, ctx);
	assert.deepEqual(notices.filter((notice) => notice.level === "warning"), []);
	assert.notEqual(host.AssistantMessageComponent.prototype.updateContent, original);
	if (bundled) assert.equal(deep.AssistantMessageComponent.prototype.updateContent, deepOriginal);
	const message = {
		role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "test", timestamp: 1, stopReason: "stop",
		content: [{ type: "thinking", thinking: "Verify the host renderer." }],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
	const component = new host.AssistantMessageComponent();
	for (const mode of ["collapsed", "summary", "expanded"]) {
		await extension.commands.get("thinking-steps").handler(mode, ctx);
		component.updateContent(message, true);
		assert.match(component.render(100).join("\n"), /Verify the host renderer/);
		component.updateContent({ ...message, content: [] }, true);
		assert.match(component.render(100).join("\n"), /Waiting for thinking content/);
		component.updateContent({ ...message, content: [] }, false);
		assert.match(component.render(100).join("\n"), /No thinking content supplied/);
	}
	const shortcut = extension.shortcuts.get("alt+t");
	assert.ok(shortcut);
	await shortcut.handler(ctx);
	component.setOutputPad(3);
	component.updateContent({ ...message, content: [] }, true);
	assert.ok(component.render(100).map(stripVTControlCharacters).includes("   Thinking · Waiting for thinking content   "));
	const manager = ctx.sessionManager;
	manager.appendMessage({ role: "user", content: "HOST_PROMPT_PRIVATE", timestamp: 0 });
	manager.appendMessage(message);
	const modelContext = manager.buildSessionContext().messages;
	const command = extension.commands.get("thinking-steps");
	await command.handler("export both branch", ctx);
	const manual = manager.getLeafEntry().data;
	assert.equal(manual.scope, "current-branch");
	assert.equal(manual.files.length, 2);
	choices.push(0, 0, undefined, undefined);
	await command.handler("review branch", ctx);
	assert.equal(viewed.length, 1);
	assert.match(viewed[0], /Verify the host renderer/);
	await command.handler("autosave on json branch 1 thinking", ctx);
	for (let i = 0; i < 2; i += 1) {
		manager.appendMessage({ ...message, timestamp: i + 2 });
		for (const handler of extension.handlers.get("agent_end") ?? []) await handler({}, ctx);
		const saved = manager.getLeafEntry().data;
		assert.equal(saved.automatic, true);
		assert.doesNotMatch(await readFile(saved.files[0].path, "utf8"), /HOST_PROMPT_PRIVATE/);
	}
	assert.equal((await readdir(root)).filter((name) => name.includes("thinking-steps-auto-")).length, 1);
	assert.match(await readFile(manual.files[0].path, "utf8"), /HOST_PROMPT_PRIVATE/);
	assert.deepEqual(manager.buildSessionContext().messages.slice(0, modelContext.length), modelContext);
	assert.deepEqual(notices.filter((notice) => notice.level === "warning"), []);
	console.log(`Host loader smoke passed (${bundled ? "bundled" : "unbundled"}; renderer, export, review, autosave).`);
} finally {
	try {
		if (extension && ctx) for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler({}, ctx);
		assert.equal(host.AssistantMessageComponent.prototype.updateContent, original);
		assert.equal(deep.AssistantMessageComponent.prototype.updateContent, deepOriginal);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	}
}
