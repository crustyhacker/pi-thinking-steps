import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent, initTheme, SessionManager, type EntryRenderer, type ExtensionAPI, type ExtensionCommandContext, type RegisteredCommand, type SessionEntry, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildThinkingExport, renderThinkingExportMarkdown, saveThinkingExport } from "../export.js";
import thinkingStepsExtension from "../index.js";
import { retainThinkingStepsPatch } from "../internal-patch.js";
import { renderThinkingExportFiles, renderThinkingStepsLines } from "../render.js";
import { getPatchRefCount, setThinkingStepsMode } from "../state.js";
import type { ThinkingExportAttachment, ThinkingExportSnapshot, ThinkingThemeLike } from "../types.js";

const theme: ThinkingThemeLike = { fg: (_color, text) => text, bold: (text) => text };
const timestamp = "2026-10-01T00:00:00.000Z";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model: "test", timestamp: 1, stopReason: "stop",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

function entries(): SessionEntry[] {
	return [
		{ id: "p", parentId: null, timestamp, type: "message", message: { role: "user", content: [{ type: "text", text: "Inspect this prompt.\n```\n<script>unsafe()</script>" }, { type: "image", data: "IMAGE_SECRET", mimeType: "image/png" }], timestamp: 0 } },
		{ id: "a", parentId: "p", timestamp, type: "message", message: assistant([{ type: "thinking", thinking: "Inspect render.ts.\n\nVerify the output.", thinkingSignature: "SIGNATURE_SECRET" }, { type: "text", text: "Answer." }, { type: "toolCall", id: "tool", name: "read", arguments: { private: "TOOL_SECRET" } }]) },
		{ id: "tool", parentId: "a", timestamp, type: "message", message: { role: "toolResult", toolCallId: "tool", toolName: "read", content: [{ type: "text", text: "RESULT_SECRET" }], isError: false, timestamp: 2 } },
		{ id: "next", parentId: "tool", timestamp, type: "message", message: assistant([{ type: "thinking", thinking: "REDACTED_SECRET", redacted: true }]) },
		{ id: "custom", parentId: "next", timestamp, type: "custom", customType: "secret", data: "CUSTOM_SECRET" },
		{ id: "alternate", parentId: "p", timestamp, type: "message", message: assistant([{ type: "text", text: "Alternate answer." }]) },
	];
}

async function withDirectory(run: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "thinking-export-test-"));
	try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

function harness(manager: SessionManager) {
	const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
	const renderers = new Map<string, EntryRenderer>();
	const handlers = new Map<string, unknown>();
	const shortcuts = new Map<string, unknown>();
	const notifications: Array<{ message: string; level: string }> = [];
	const pi = {
		registerCommand(name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) { commands.set(name, command); },
		registerEntryRenderer(name: string, renderer: EntryRenderer) { renderers.set(name, renderer); },
		registerShortcut(key: string, shortcut: unknown) { shortcuts.set(key, shortcut); },
		on(event: string, handler: unknown) { handlers.set(event, handler); return () => handlers.delete(event); },
		appendEntry(name: string, data: unknown) { manager.appendCustomEntry(name, data); },
	};
	const context = {
		cwd: manager.getCwd(), mode: "tui", hasUI: true, sessionManager: manager, isIdle: () => true,
		ui: { theme, notify(message: string, level: string) { notifications.push({ message, level }); } },
	};
	thinkingStepsExtension(pi as unknown as ExtensionAPI);
	return { pi, context, notifications, renderers, command: commands.get("thinking-steps")!, run: (args: string) => commands.get("thinking-steps")!.handler(args, context as unknown as ExtensionCommandContext) };
}

function persistentManager(root: string): SessionManager {
	const manager = SessionManager.create(root, root);
	manager.appendMessage({ role: "user", content: "A persistent prompt", timestamp: 0 });
	manager.appendMessage(assistant([{ type: "thinking", thinking: "Verify the saved tree." }, { type: "text", text: "Done." }]));
	return manager;
}

describe("thinking review exports", () => {
	it("preserves all branches, original IDs, raw available blocks, and every derived step without secret payloads", () => {
		const source = entries();
		const snapshot = buildThinkingExport(source, "session", "alternate", timestamp);
		assert.equal(snapshot.schemaVersion, 1);
		assert.equal(snapshot.scope, "all-recorded-branches");
		assert.deepEqual(snapshot.nodes.map(({ id, parentId }) => ({ id, parentId })), source.map(({ id, parentId }) => ({ id, parentId })));
		assert.equal(snapshot.nodes[0]?.imageCount, 1);
		assert.equal(snapshot.nodes[1]?.thinkingBlocks?.[0]?.text, "Inspect render.ts.\n\nVerify the output.");
		assert.equal(snapshot.nodes[1]?.steps?.length, 2);
		assert.equal(snapshot.nodes[3]?.steps?.[0]?.summary, "Reasoning is hidden by the provider.");
		assert.equal(snapshot.nodes[3]?.thinkingBlocks?.[0]?.text, "");
		assert.doesNotMatch(JSON.stringify(snapshot), /IMAGE_SECRET|SIGNATURE_SECRET|TOOL_SECRET|RESULT_SECRET|REDACTED_SECRET|CUSTOM_SECRET/);
		assert.match(JSON.stringify(source), /REDACTED_SECRET/);
	});

	it("renders a linked tree, fenced prompts and detailed steps, and honest missing/redacted states", () => {
		const snapshot = buildThinkingExport(entries(), "session", "alternate", timestamp);
		const markdown = renderThinkingExportMarkdown(snapshot);
		assert.match(markdown, /## Tree/);
		assert.match(markdown, /parent: Entry 1 · current leaf/);
		assert.match(markdown, /````text\nInspect this prompt\.\n```\n<script>unsafe\(\)<\/script>\n````/);
		assert.match(markdown, /#### Step 2 · block 0/);
		assert.match(markdown, /No thinking content supplied/);
		assert.match(markdown, /Reasoning is hidden by the provider/);
		assert.match(markdown, /Images omitted: 1/);
		assert.doesNotMatch(markdown, /REDACTED_SECRET|SIGNATURE_SECRET|TOOL_SECRET|RESULT_SECRET/);
	});

	it("escapes terminal controls in Markdown but leaves JSON source text faithful", () => {
		const snapshot = buildThinkingExport(entries(), "session", "alternate", timestamp);
		snapshot.nodes[0]!.text = "\x1b]52;c;secret\x07\n````\n# injected";
		const markdown = renderThinkingExportMarkdown(snapshot);
		assert.ok(!markdown.includes("\x1b"));
		assert.ok(markdown.includes("\\u001b]52;c;secret\\u0007"));
		assert.ok(markdown.includes("`````text"));
		assert.equal(JSON.parse(JSON.stringify(snapshot)).nodes[0].text, snapshot.nodes[0]!.text);
	});

	it("handles empty trees and rejects duplicate IDs, dangling parents, cycles, and missing leaves", () => {
		assert.deepEqual(buildThinkingExport([], "empty", null).nodes, []);
		const source = entries();
		assert.throws(() => buildThinkingExport([...source, source[0]!], "s", null), /duplicate/);
		assert.throws(() => buildThinkingExport(source.slice(1), "s", null), /missing parent/);
		assert.throws(() => buildThinkingExport(source, "s", "missing"), /leaf is missing/);
		source[0]!.parentId = "alternate";
		assert.throws(() => buildThinkingExport(source, "s", null), /cycle/);
	});

	it("renders long trees iteratively with bounded indentation and exact parent links", () => {
		const source: SessionEntry[] = Array.from({ length: 1500 }, (_, i) => ({ id: String(i), parentId: i ? String(i - 1) : null, timestamp, type: "custom", customType: "test" }));
		const output = renderThinkingExportMarkdown(buildThinkingExport(source, "s", "1499"));
		assert.match(output, /Entry 1500/);
		assert.ok(output.split("\n").filter((line) => line.trimStart().startsWith("- [Entry")).every((line) => line.length - line.trimStart().length <= 16));
	});

	it("writes only the requested formats with private permissions and unique snapshots", async () => {
		await withDirectory(async (root) => {
			const snapshot = buildThinkingExport(entries(), "s", "alternate", timestamp);
			const directories = new Set<string>();
			for (const format of ["json", "markdown", "both"] as const) {
				const saved = await saveThinkingExport(snapshot, join(root, "session.jsonl"), format);
				const directory = dirname(saved.files[0]!.path);
				directories.add(directory);
				assert.equal(saved.files.length, format === "both" ? 2 : 1);
				assert.equal((await readdir(directory)).length, saved.files.length);
				if (process.platform !== "win32") assert.equal((await stat(directory)).mode & 0o777, 0o700);
				for (const file of saved.files) {
					if (process.platform !== "win32") assert.equal((await stat(file.path)).mode & 0o777, 0o600);
					const content = await readFile(file.path, "utf8");
					if (file.format === "json") assert.deepEqual(JSON.parse(content), snapshot);
					else assert.equal(content, renderThinkingExportMarkdown(snapshot));
				}
			}
			assert.equal(directories.size, 3);
		});
	});

	it("reports path/write failures instead of returning attachments", async () => {
		await withDirectory(async (root) => {
			const snapshot = buildThinkingExport([], "s", null);
			await assert.rejects(saveThinkingExport(snapshot, "relative.jsonl", "json"), /absolute/);
			await assert.rejects(saveThinkingExport(snapshot, join(root, "missing", "session.jsonl"), "both"), /ENOENT/);
			assert.deepEqual(await readdir(root), []);
		});
	});

	it("attaches manual exports to a real persisted session without adding model context", async () => {
		await withDirectory(async (root) => {
			const manager = persistentManager(root);
			const before = manager.buildSessionContext().messages;
			const test = harness(manager);
			assert.equal((await readdir(root)).filter((path) => path.includes("thinking-steps-")).length, 0);
			await test.run("export both");
			const entry = manager.getLeafEntry();
			assert.equal(entry?.type, "custom");
			assert.ok(entry?.type === "custom");
			assert.equal(entry.customType, "thinking-steps.export");
			assert.deepEqual(manager.buildSessionContext().messages, before);
			const data = entry.data as ThinkingExportAttachment;
			assert.equal(data.files.length, 2);
			const snapshot = JSON.parse(await readFile(data.files[0]!.path, "utf8")) as ThinkingExportSnapshot;
			assert.equal(snapshot.leafId, entry.parentId);
			const reopened = SessionManager.open(manager.getSessionFile()!);
			assert.deepEqual(reopened.getLeafEntry(), entry);
			const renderer = harness(reopened).renderers.get("thinking-steps.export")!;
			const rendered = renderer(entry, { expanded: false }, theme as Theme)!.render(100).join("\n");
			assert.match(rendered, /Thinking review/);
			assert.match(rendered, /file:\/\//);
			assert.equal(test.notifications.at(-1)?.level, "info");
		});
	});

	it("validates export arguments and offers completions without disturbing modes", async () => {
		const test = harness(SessionManager.inMemory());
		assert.deepEqual(await test.command.getArgumentCompletions?.("export "), ["json", "markdown", "both"].map((format) => ({ value: `export ${format}`, label: format })));
		assert.deepEqual(await test.command.getArgumentCompletions?.("export m"), [{ value: "export markdown", label: "markdown" }]);
		assert.equal(await test.command.getArgumentCompletions?.("export json extra"), null);
		for (const args of ["export", "export xml", "export both extra"]) {
			await test.run(args);
			assert.match(test.notifications.at(-1)?.message ?? "", /Usage:/);
		}
		assert.deepEqual(test.context.sessionManager.getEntries(), []);
	});

	it("rejects busy and nonpersistent sessions and reports command I/O failures", async () => {
		await withDirectory(async (root) => {
			const test = harness(SessionManager.inMemory());
			await test.run("export json");
			assert.match(test.notifications.at(-1)?.message ?? "", /persistent session/);
			test.context.isIdle = () => false;
			await test.run("export json");
			assert.match(test.notifications.at(-1)?.message ?? "", /finish before exporting/);
			const manager = persistentManager(root);
			const failed = harness(manager);
			manager.getSessionFile = () => join(root, "missing", "session.jsonl");
			const leaf = manager.getLeafId();
			await failed.run("export json");
			assert.match(failed.notifications.at(-1)?.message ?? "", /Thinking export failed:.*ENOENT/);
			assert.equal(manager.getLeafId(), leaf);
		});
	});

	it("keeps saved files but refuses attachment when session identity changes during writing", async () => {
		await withDirectory(async (root) => {
			const manager = persistentManager(root);
			const test = harness(manager);
			const leaf = manager.getLeafId();
			let calls = 0;
			manager.getSessionId = () => ++calls === 1 ? "original" : "different";
			await test.run("export both");
			assert.equal(manager.getLeafId(), leaf);
			assert.match(test.notifications.at(-1)?.message ?? "", /session changed; files were not attached/);
			assert.equal((await readdir(root)).filter((path) => path.includes("thinking-steps-")).length, 1);
		});
	});

	it("reports attachment failures with the successfully saved paths", async () => {
		await withDirectory(async (root) => {
			const manager = persistentManager(root);
			const test = harness(manager);
			const leaf = manager.getLeafId();
			test.pi.appendEntry = () => { throw new Error("session storage unavailable"); };
			await test.run("export markdown");
			assert.equal(manager.getLeafId(), leaf);
			assert.match(test.notifications.at(-1)?.message ?? "", /attaching it failed: session storage unavailable/);
			assert.match(test.notifications.at(-1)?.message ?? "", /thinking-steps\.md/);
		});
	});

	it("renders validated attachment links safely and rejects malformed session metadata", () => {
		for (const invalid of [null, {}, { schemaVersion: 1, files: [null] }, { schemaVersion: 1, files: [{ format: "json", path: "relative" }] }]) {
			assert.match(renderThinkingExportFiles(invalid, theme).render(100).join("\n"), /invalid attachment/);
		}
		const component = renderThinkingExportFiles({ schemaVersion: 1, files: [{ format: "json", path: join(tmpdir(), "file\x1b space.json") }] }, theme);
		assert.match(component.render(200).join("\n"), /file%1B%20space\.json/);
		for (const width of [1, 8, 40, 100]) assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
	});
});

describe("always-visible thinking panel", () => {
	it("shows truthful waiting/missing states in all modes and at narrow widths", () => {
		for (const mode of ["collapsed", "summary", "expanded"] as const) {
			for (const isStreaming of [true, false]) {
				const render = (width: number) => renderThinkingStepsLines(theme, width, { mode, steps: [], isActive: false, isStreaming });
				assert.match(render(100).join("\n"), isStreaming ? /Waiting for thinking content/ : /No thinking content supplied/);
				for (const width of [1, 8, 40]) assert.ok(render(width).every((line) => visibleWidth(line) <= width));
			}
		}
	});

	it("keeps the real renderer visible through empty, text, tool, thinking, and final transitions", async () => {
		initTheme("dark", true);
		const baseline = getPatchRefCount();
		const release = await retainThinkingStepsPatch(theme);
		try {
			const component = new AssistantMessageComponent();
			const output = () => component.render(120).join("\n");
			for (const mode of ["collapsed", "summary", "expanded"] as const) {
				setThinkingStepsMode(mode);
				component.updateContent(assistant([]), true);
				assert.match(output(), /Waiting for thinking content/);
				component.updateContent(assistant([{ type: "thinking", thinking: " \n" }, { type: "text", text: "Hello" }]), true);
				assert.match(output(), /Waiting for thinking content/);
				assert.match(output(), /Hello/);
				component.updateContent(assistant([{ type: "text", text: "Hello" }]), false);
				assert.match(output(), /No thinking content supplied/);
				component.updateContent(assistant([{ type: "toolCall", id: "t", name: "read", arguments: {} }]), false);
				assert.match(output(), /No thinking content supplied/);
				component.updateContent(assistant([{ type: "thinking", thinking: "Verify the renderer." }]), false);
				assert.match(output(), /Verify the renderer/);
				assert.doesNotMatch(output(), /No thinking content supplied|Waiting for thinking content/);
				component.updateContent(assistant([{ type: "thinking", thinking: "", redacted: true }]), false);
				assert.match(output(), /hidden by the provider/);
			}
			setThinkingStepsMode("summary");
			component.setOutputPad(3);
			component.updateContent(assistant([]), true);
			assert.ok(component.render(100).map(stripVTControlCharacters).includes("   Thinking · Waiting for thinking content   "));
			for (const width of [1, 8, 40]) assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
			component.updateContent({ ...assistant([]), stopReason: "error", errorMessage: "Example failure" }, false);
			assert.match(output(), /Example failure/);
			assert.match(output(), /No thinking content supplied/);
		} finally {
			setThinkingStepsMode("summary");
			await release();
		}
		assert.equal(getPatchRefCount(), baseline);
	});
});
