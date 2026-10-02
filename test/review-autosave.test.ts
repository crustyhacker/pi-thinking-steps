import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { parseThinkingAutosaveSettings, pruneThinkingAutoExports, readThinkingAutosaveSettings, runThinkingAutosave, THINKING_AUTOSAVE_ENTRY } from "../autosave.js";
import { buildThinkingExport, renderThinkingExportMarkdown, saveThinkingExport } from "../export.js";
import thinkingStepsExtension from "../index.js";
import { buildThinkingReviewGroups, ThinkingReviewViewer, thinkingReviewText } from "../review.js";
import { renderThinkingExportFiles } from "../render.js";
import type { ThinkingExportAttachment, ThinkingExportSnapshot, ThinkingThemeLike } from "../types.js";

const theme: ThinkingThemeLike = { fg: (_color, text) => text, bold: (text) => text };
function response(text = "Answer.", thinking = "Verify the result.", stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return { role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "test", timestamp: 1, stopReason,
		content: [{ type: "thinking", thinking, thinkingSignature: "SIGNATURE_SECRET" }, { type: "thinking", thinking: "REDACTED_SECRET", redacted: true }, { type: "text", text }],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
async function withSession(run: (manager: SessionManager, root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "thinking-review-test-"));
	try {
		const manager = SessionManager.create(root, root);
		manager.appendMessage({ role: "user", content: "PROMPT_PRIVATE", timestamp: 0 });
		manager.appendMessage(response("RESPONSE_PRIVATE"));
		await run(manager, root);
	} finally { await rm(root, { recursive: true, force: true }); }
}
function harness(manager: SessionManager) {
	const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
	const notifications: string[] = [];
	const choices: string[][] = [];
	const selections: Array<number | undefined> = [];
	const viewed: string[] = [];
	const pi = {
		registerCommand(name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) { commands.set(name, command); },
		registerEntryRenderer() {}, registerShortcut() {},
		on(name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) { handlers.set(name, handler); return () => handlers.delete(name); },
		appendEntry(name: string, data: unknown) { manager.appendCustomEntry(name, data); },
	};
	const context = {
		cwd: manager.getCwd(), mode: "tui", hasUI: true, sessionManager: manager, isIdle: () => true,
		ui: {
			theme, notify(message: string) { notifications.push(message); }, setStatus() {}, setHiddenThinkingLabel() {},
			confirm: async () => true,
			select: async (_title: string, options: string[]) => { choices.push(options); const index = selections.shift(); return index === undefined ? undefined : options[index]; },
			custom: async (factory: (tui: { terminal: { rows: number }; requestRender(): void }, theme: ThinkingThemeLike, keys: unknown, done: () => void) => Component | Promise<Component>) => {
				const component = await factory({ terminal: { rows: 50 }, requestRender() {} }, theme, {}, () => {});
				viewed.push(component.render(120).join("\n"));
				component.handleInput?.("\x1b");
			},
		},
	};
	thinkingStepsExtension(pi as unknown as ExtensionAPI);
	return { pi, context, notifications, choices, selections, viewed, command: commands.get("thinking-steps")!,
		run: (args: string) => commands.get("thinking-steps")!.handler(args, context as unknown as ExtensionCommandContext),
		end: () => handlers.get("agent_end")!({}, context as unknown as ExtensionContext) };
}
function attachment(manager: SessionManager): ThinkingExportAttachment {
	const entry = manager.getLeafEntry();
	assert.ok(entry?.type === "custom" && entry.customType === "thinking-steps.export");
	return entry.data as ThinkingExportAttachment;
}

describe("branch exports and review browser", () => {
	it("selects exact ancestry, retains structural entries, and keeps all-branch defaults", async () => {
		await withSession(async (manager) => {
			const original = manager.getLeafId()!;
			const prompt = manager.getEntries()[0]!.id;
			manager.branch(prompt);
			const alternate = manager.appendMessage(response("ALTERNATE"));
			manager.appendCustomEntry("structural", { private: "CUSTOM_SECRET" });
			const source = manager.getEntries();
			const branch = buildThinkingExport(source, "s", manager.getLeafId(), undefined, { scope: "current-branch" });
			assert.deepEqual(branch.nodes.map((node) => node.id), manager.getBranch().map((entry) => entry.id));
			assert.ok(!branch.nodes.some((node) => node.id === original));
			assert.ok(branch.nodes.some((node) => node.id === alternate));
			assert.ok(buildThinkingExport(source, "s", manager.getLeafId()).nodes.some((node) => node.id === original));
			assert.deepEqual(buildThinkingExport(source, "s", null, undefined, { scope: "current-branch" }).nodes, []);
			assert.match(renderThinkingExportMarkdown(branch), /current branch only/);
			assert.doesNotMatch(JSON.stringify(branch), /CUSTOM_SECRET|REDACTED_SECRET|SIGNATURE_SECRET/);
			const test = harness(manager);
			await test.run("export both branch");
			assert.equal(attachment(manager).scope, "current-branch");
			assert.match(renderThinkingExportFiles(attachment(manager), theme).render(200).join("\n"), /current branch/);
		});
	});
	it("offers scope and autosave completions and rejects malformed controls", async () => {
		const test = harness(SessionManager.inMemory());
		assert.deepEqual(test.command.getArgumentCompletions?.("export json "), ["branch", "all"].map((value) => ({ value: `export json ${value}`, label: value })));
		assert.deepEqual(test.command.getArgumentCompletions?.("review b"), [{ value: "review branch", label: "branch" }]);
		assert.deepEqual(test.command.getArgumentCompletions?.("autosave on json branch 7 c"), [{ value: "autosave on json branch 7 conversation", label: "conversation" }]);
		for (const args of ["review invalid", "review all extra", "export json branch extra", "autosave off extra", "autosave on xml", "autosave on json branch 0", "autosave on json branch 51", "autosave on json branch 2 private"]) {
			await test.run(args); assert.match(test.notifications.at(-1)!, /Usage:/);
		}
	});
	it("groups alternate responses with their actual prompt and browses without writes or model context changes", async () => {
		await withSession(async (manager) => {
			manager.branch(manager.getEntries()[0]!.id);
			manager.appendMessage(response("Alternate response."));
			const before = manager.getEntries();
			const context = manager.buildSessionContext();
			const groups = buildThinkingReviewGroups(buildThinkingExport(before, manager.getSessionId(), manager.getLeafId()));
			assert.equal(groups.length, 1); assert.equal(groups[0]!.responses.length, 2);
			const test = harness(manager);
			test.selections.push(0, 0, undefined, undefined);
			await test.run("review all");
			assert.equal(test.viewed.length, 1);
			assert.match(test.viewed[0]!, /PROMPT_PRIVATE/);
			assert.match(test.viewed[0]!, /RESPONSE_PRIVATE/);
			assert.match(test.viewed[0]!, /Verify the result/);
			assert.match(test.viewed[0]!, /Reasoning is hidden by the provider/);
			assert.doesNotMatch(test.viewed[0]!, /REDACTED_SECRET|SIGNATURE_SECRET/);
			assert.deepEqual(manager.getEntries(), before);
			assert.deepEqual(manager.buildSessionContext(), context);
		});
	});
	it("keeps the browser TUI-only and handles an empty session", async () => {
		const test = harness(SessionManager.inMemory());
		await test.run("review"); assert.match(test.notifications.at(-1)!, /No recorded prompts/);
		test.context.mode = "rpc";
		await test.run("review"); assert.match(test.notifications.at(-1)!, /interactive terminal/);
	});
	it("scrolls, resizes, closes, and escapes terminal controls without exceeding terminal width", () => {
		let closed = false; let renders = 0;
		const viewer = new ThinkingReviewViewer("\x1b]52;c;secret\x07\n" + Array.from({ length: 40 }, (_, i) => `line ${i} 界`).join("\n"), theme, () => 8, () => { renders += 1; }, () => { closed = true; });
		assert.ok(!viewer.render(80).join("\n").includes("\x1b"));
		viewer.handleInput("\x1b[F");
		assert.match(viewer.render(80).join("\n"), /line 39/);
		viewer.handleInput("\x1b[H");
		assert.match(viewer.render(80).join("\n"), /u001b/);
		viewer.handleInput("\x1b[6~"); viewer.handleInput("\x1b[5~");
		for (const width of [1, 8, 40]) { viewer.invalidate(); assert.ok(viewer.render(width).every((line) => visibleWidth(line) <= width)); }
		assert.ok(renders >= 4);
		viewer.handleInput("\x1b"); assert.ok(closed);
		assert.match(thinkingReviewText(undefined, { id: "a", parentId: null, timestamp: "", entryType: "message", role: "assistant" }), /No thinking content supplied/);
	});
});

describe("opt-in automatic exports", () => {
	it("defaults off, validates bounded settings, requires consent, and persists no model content", async () => {
		assert.deepEqual(parseThinkingAutosaveSettings([]), { format: "json", scope: "current-branch", keep: 10, content: "thinking-only" });
		for (const keep of ["0", "51", "NaN", "1.5", "-1", "Infinity"]) assert.equal(parseThinkingAutosaveSettings(["json", "branch", keep]), undefined);
		await withSession(async (manager, root) => {
			const test = harness(manager); const before = manager.buildSessionContext().messages;
			await test.end(); assert.ok(!(await readdir(root)).some((name) => name.includes("thinking-steps-auto-")));
			await test.run("autosave status"); assert.match(test.notifications.at(-1)!, /off \(default\)/);
			test.context.ui.confirm = async () => false;
			await test.run("autosave on"); assert.equal(readThinkingAutosaveSettings(manager.getEntries(), manager.getSessionId()), undefined);
			test.context.ui.confirm = async () => true;
			await test.run("autosave on");
			assert.deepEqual(manager.buildSessionContext().messages, before);
			assert.equal(readThinkingAutosaveSettings(manager.getEntries(), manager.getSessionId())?.keep, 10);
			assert.equal(readThinkingAutosaveSettings(manager.getEntries(), "forked-session"), undefined);
			const reopened = SessionManager.open(manager.getSessionFile()!);
			assert.equal(readThinkingAutosaveSettings(reopened.getEntries(), reopened.getSessionId())?.content, "thinking-only");
		});
	});
	it("saves thinking-only snapshots once per response and retains only owned automatic snapshots", async () => {
		await withSession(async (manager, root) => {
			const test = harness(manager);
			await test.run("export json"); const manual = attachment(manager).files[0]!.path;
			await test.run("autosave on json branch 2 thinking");
			for (let i = 0; i < 4; i += 1) {
				manager.appendMessage(response(`RESPONSE_PRIVATE_${i}`));
				const before = manager.buildSessionContext().messages;
				await test.end();
				const saved = attachment(manager); assert.equal(saved.automatic, true);
				const snapshot = JSON.parse(await readFile(saved.files[0]!.path, "utf8")) as ThinkingExportSnapshot;
				assert.equal(snapshot.scope, "current-branch"); assert.equal(snapshot.content, "thinking-only");
				assert.doesNotMatch(JSON.stringify(snapshot), /PROMPT_PRIVATE|RESPONSE_PRIVATE|SIGNATURE_SECRET|REDACTED_SECRET/);
				assert.match(JSON.stringify(snapshot), /Verify the result/);
				assert.deepEqual(manager.buildSessionContext().messages, before);
				const leaf = manager.getLeafId(); await test.end(); assert.equal(manager.getLeafId(), leaf);
			}
			assert.equal((await readdir(root)).filter((name) => name.includes("thinking-steps-auto-")).length, 2);
			assert.match(await readFile(manual, "utf8"), /PROMPT_PRIVATE/);
			await test.run("autosave off");
			manager.appendMessage(response("After disabling.")); const leaf = manager.getLeafId();
			await test.end(); assert.equal(manager.getLeafId(), leaf);
			assert.equal((await readdir(root)).filter((name) => name.includes("thinking-steps-auto-")).length, 2);
		});
	});
	it("can explicitly include the conversation and all branches but skips aborted/error responses and non-TUI runs", async () => {
		await withSession(async (manager) => {
			const test = harness(manager); await test.run("autosave on both all 1 conversation");
			for (const reason of ["aborted", "error"] as const) { manager.appendMessage(response("Failed", "", reason)); const leaf = manager.getLeafId(); await test.end(); assert.equal(manager.getLeafId(), leaf); }
			manager.appendMessage(response());
			test.context.mode = "rpc"; const leaf = manager.getLeafId(); await test.end(); assert.equal(manager.getLeafId(), leaf);
			test.context.mode = "tui"; await test.end();
			const saved = attachment(manager); assert.equal(saved.files.length, 2);
			assert.match(await readFile(saved.files[0]!.path, "utf8"), /PROMPT_PRIVATE/);
			assert.equal(saved.scope, "all-recorded-branches");
		});
	});
	it("refuses to enable in RPC, busy, or in-memory sessions and does not silently accept corrupt settings", async () => {
		const memory = harness(SessionManager.inMemory()); await memory.run("autosave on"); assert.match(memory.notifications.at(-1)!, /persistent session/);
		await withSession(async (manager) => {
			const test = harness(manager); test.context.mode = "rpc";
			await test.run("autosave on"); assert.match(test.notifications.at(-1)!, /interactive terminal/);
			test.context.mode = "tui"; test.context.isIdle = () => false;
			await test.run("autosave on"); assert.match(test.notifications.at(-1)!, /finish before changing/);
			manager.appendCustomEntry(THINKING_AUTOSAVE_ENTRY, { schemaVersion: 1, sessionId: manager.getSessionId(), settings: { keep: -1 } });
			assert.throws(() => readThinkingAutosaveSettings(manager.getEntries(), manager.getSessionId()), /Invalid thinking autosave/);
			test.context.isIdle = () => true; await test.run("autosave off");
			assert.equal(readThinkingAutosaveSettings(manager.getEntries(), manager.getSessionId()), undefined);
		});
	});
	it("keeps saved paths visible when attachment or session checks fail", async () => {
		await withSession(async (manager) => {
			const test = harness(manager); await test.run("autosave on");
			const leaf = manager.getLeafId();
			await assert.rejects(runThinkingAutosave(test.pi as unknown as ExtensionAPI, test.context as unknown as ExtensionContext, () => false), /session or settings changed.*\n/s);
			assert.equal(manager.getLeafId(), leaf);
			test.pi.appendEntry = () => { throw new Error("storage failure"); };
			await test.end(); assert.match(test.notifications.at(-1)!, /attachment failed: storage failure/); assert.match(test.notifications.at(-1)!, /thinking-steps.json/);
		});
	});
	it("refuses retention cleanup of unknown files and symbolic links", async () => {
		await withSession(async (manager, root) => {
			const snapshot = buildThinkingExport(manager.getEntries(), manager.getSessionId(), manager.getLeafId());
			const first = await saveThinkingExport(snapshot, manager.getSessionFile()!, "json", true);
			const firstDir = dirname(first.files[0]!.path);
			const newest = await saveThinkingExport(snapshot, manager.getSessionFile()!, "json", true);
			const newestDir = dirname(newest.files[0]!.path);
			await writeFile(join(firstDir, "keep-me.txt"), "user data");
			await assert.rejects(pruneThinkingAutoExports(manager.getSessionFile()!, manager.getSessionId(), 1, newestDir), /unexpected content/);
			assert.equal(await readFile(join(firstDir, "keep-me.txt"), "utf8"), "user data");
			await rm(join(firstDir, "keep-me.txt"));
			if (process.platform !== "win32") {
				await rm(first.files[0]!.path); await writeFile(join(root, "outside.json"), "keep outside");
				await symlink(join(root, "outside.json"), first.files[0]!.path);
				await assert.rejects(pruneThinkingAutoExports(manager.getSessionFile()!, manager.getSessionId(), 1, newestDir), /unexpected content/);
				assert.equal(await readFile(join(root, "outside.json"), "utf8"), "keep outside");
			}
		});
	});
});
