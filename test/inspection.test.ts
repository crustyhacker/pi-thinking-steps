import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager, VERSION, initTheme, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { deleteThinkingExport, listThinkingExports, prepareThinkingExportDeletion } from "../archives.js";
import { thinkingDiagnostics, THINKING_LOADED_VERSION } from "../diagnostics.js";
import { buildThinkingExport, saveThinkingExport } from "../export.js";
import thinkingStepsExtension from "../index.js";
import { areThinkingAlternatives, renderThinkingComparison, searchThinkingReview } from "../inspection.js";
import { safeReviewText, ThinkingReviewViewer, thinkingReviewText, wrapReviewText } from "../review.js";
import { getPatchRefCount } from "../state.js";
import type { ThinkingExportAttachment, ThinkingExportSnapshot, ThinkingThemeLike } from "../types.js";

const theme: ThinkingThemeLike = { fg: (_color, text) => text, bold: (text) => text };
const raw = "# Heading\n  keep  spaces  \n\tpath\\file\n\nliteral [A]. SOURCE_PRIVATE \x1b[31m";
function response(text = "ANSWER_PRIVATE"): AssistantMessage {
	return { role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "test", timestamp: 1, stopReason: "stop",
		content: [{ type: "thinking", thinking: raw, thinkingSignature: "SIGNATURE_PRIVATE" }, { type: "thinking", thinking: "REDACTED_PRIVATE", redacted: true }, { type: "text", text }],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
async function withSession(run: (manager: SessionManager, root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "thinking-inspection-"));
	try {
		const manager = SessionManager.create(root, root);
		manager.appendMessage({ role: "user", content: "PROMPT_PRIVATE", timestamp: 0 });
		manager.appendMessage(response());
		await run(manager, root);
	} finally { await rm(root, { recursive: true, force: true }); }
}
function snapshot(manager: SessionManager): ThinkingExportSnapshot { return buildThinkingExport(manager.getEntries(), manager.getSessionId(), manager.getLeafId()); }
function harness(manager: SessionManager) {
	const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
	const notifications: string[] = []; const selections: Array<number | undefined> = []; const viewed: string[] = []; const choices: string[][] = []; const confirmations: string[] = [];
	const pi = { registerCommand(name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) { commands.set(name, command); }, registerEntryRenderer() {}, registerShortcut() {},
		on(name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) { handlers.set(name, handler); return () => handlers.delete(name); },
		appendEntry(name: string, data: unknown) { manager.appendCustomEntry(name, data); } };
	const context = { cwd: manager.getCwd(), mode: "tui", hasUI: true, sessionManager: manager, isIdle: () => true,
		ui: { theme, notify(message: string) { notifications.push(message); }, setStatus() {}, setHiddenThinkingLabel() {},
			input: async () => "",
			confirm: async (_title: string, detail: string) => { confirmations.push(detail); return true; },
			select: async (_title: string, options: string[]) => { choices.push(options); const index = selections.shift(); return index === undefined ? undefined : options[index]; },
			custom: async (factory: (tui: { terminal: { rows: number }; requestRender(): void }, theme: ThinkingThemeLike, keys: unknown, done: () => void) => Component | Promise<Component>) => {
				const component = await factory({ terminal: { rows: 50 }, requestRender() {} }, theme, {}, () => {});
				viewed.push(component.render(120).join("\n")); component.handleInput?.("\x1b");
			} } };
	thinkingStepsExtension(pi as unknown as ExtensionAPI);
	return { context, notifications, selections, viewed, choices, confirmations, command: commands.get("thinking-steps")!,
		run: (args: string) => commands.get("thinking-steps")!.handler(args, context as unknown as ExtensionCommandContext),
		event: (name: string) => handlers.get(name)!({}, context as unknown as ExtensionContext) };
}
async function save(manager: SessionManager, automatic = false, format: "json" | "both" = "both"): Promise<ThinkingExportAttachment> {
	const data = await saveThinkingExport(snapshot(manager), manager.getSessionFile()!, format, automatic);
	manager.appendCustomEntry("thinking-steps.export", data); return data;
}

describe("verbatim, search, and branch comparison", () => {
	it("preserves source whitespace and punctuation, separates derived steps, and never reveals redacted payloads", async () => {
		await withSession(async (manager) => {
			const data = snapshot(manager); const node = data.nodes.find((entry) => entry.role === "assistant")!;
			const text = thinkingReviewText(data.nodes[0], node, "verbatim");
			assert.ok(text.includes(safeReviewText(raw)));
			assert.doesNotMatch(text, /Derived steps|ANSWER_PRIVATE|PROMPT_PRIVATE|REDACTED_PRIVATE|SIGNATURE_PRIVATE/);
			assert.match(text, /hidden by the provider/);
			assert.match(thinkingReviewText(data.nodes[0], node, "steps"), /Derived steps/);
			assert.deepEqual(wrapReviewText("  a  \n\nb  ", 40), ["  a  ", "", "b  "]);
			assert.deepEqual(wrapReviewText("ab  cd", 3), ["ab ", " cd"]);
			for (const width of [1, 2, 8, 80]) assert.ok(wrapReviewText(raw + " 界 👩‍💻", width).every((line) => visibleWidth(line) <= width && !line.includes("\x1b")));
			const test = harness(manager); const before = manager.getEntries();
			test.selections.push(0, 0, undefined, undefined); await test.run("verbatim");
			assert.match(test.viewed[0]!, /verbatim source/); assert.doesNotMatch(test.viewed[0]!, /Derived steps/);
			assert.deepEqual(manager.getEntries(), before);
		});
	});
	it("toggles source/steps/all, navigates matches, and reflows safely after resizing", () => {
		const variants = { all: "full review", verbatim: "  source  ", steps: "derived steps" };
		const viewer = new ThinkingReviewViewer("", theme, () => 10, () => {}, () => {}, { variants, initialView: "verbatim" });
		assert.ok(viewer.render(80).includes("  source  "));
		viewer.handleInput("s"); assert.match(viewer.render(80).join("\n"), /derived steps/);
		viewer.handleInput("a"); assert.match(viewer.render(80).join("\n"), /full review/);
		viewer.handleInput("v"); for (const width of [1, 8, 80]) { viewer.invalidate(); assert.ok(viewer.render(width).every((line) => visibleWidth(line) <= width)); }
		const jump = new ThinkingReviewViewer(Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"), theme, () => 8, () => {}, () => {}, { jumpToLine: 50 });
		assert.match(jump.render(80).join("\n"), /line 50/); assert.doesNotMatch(jump.render(80).join("\n"), /line 0\n/);
	});
	it("searches literal case-insensitive source fields with bounded results and redaction exclusions", async () => {
		await withSession(async (manager) => {
			const data = snapshot(manager);
			assert.equal(searchThinkingReview(data, "prompt_private").matches[0]?.field, "prompt");
			assert.equal(searchThinkingReview(data, "answer_private").matches[0]?.field, "response");
			assert.equal(searchThinkingReview(data, "[a].").matches[0]?.field, "thinking");
			assert.equal(searchThinkingReview(data, "[a].").matches[0]?.line, 4);
			assert.equal(searchThinkingReview(data, "REDACTED_PRIVATE").matches.length, 0);
			assert.equal(searchThinkingReview(data, "SIGNATURE_PRIVATE").matches.length, 0);
			assert.equal(searchThinkingReview(data, " ").matches.length, 0);
			assert.equal(searchThinkingReview(data, "a", 1).truncated, true);
			assert.throws(() => searchThinkingReview(data, "a", 0), /limit/);
			const test = harness(manager); const before = manager.buildSessionContext();
			test.selections.push(0, undefined); await test.run("search all [A].");
			assert.match(test.viewed[0]!, /literal \[A\]\./); assert.doesNotMatch(test.viewed[0]!, /Derived steps/);
			assert.deepEqual(manager.buildSessionContext(), before);
			await test.run("search"); assert.equal(test.viewed.length, 1);
		});
	});
	it("compares actual alternate responses but excludes same-branch continuations", async () => {
		await withSession(async (manager) => {
			const original = manager.getLeafId()!;
			const continuation = manager.appendMessage(response("CONTINUATION"));
			manager.branch(manager.getEntries()[0]!.id); const alternate = manager.appendMessage(response("ALTERNATE"));
			const data = snapshot(manager); const a = data.nodes.find((node) => node.id === original)!; const b = data.nodes.find((node) => node.id === alternate)!;
			assert.equal(areThinkingAlternatives(data, a, b), true);
			assert.equal(areThinkingAlternatives(data, a, data.nodes.find((node) => node.id === continuation)!), false);
			assert.equal(areThinkingAlternatives(data, a, a), false);
			assert.match(renderThinkingComparison(a, b, 100).join("\n"), / │ /);
			assert.match(renderThinkingComparison(a, b, 40).join("\n"), /RIGHT/);
			for (const width of [1, 8, 59, 60, 101]) assert.ok(renderThinkingComparison(a, b, width).every((line) => visibleWidth(line) <= width));
			const test = harness(manager); const before = manager.getEntries(); test.selections.push(0, 0, 0); await test.run("compare");
			assert.match(test.viewed[0]!, /ALTERNATE/); assert.match(test.viewed[0]!, /ANSWER_PRIVATE/);
			assert.doesNotMatch(test.viewed[0]!, /CONTINUATION|REDACTED_PRIVATE|SIGNATURE_PRIVATE/);
			assert.deepEqual(manager.getEntries(), before);
		});
	});
	it("handles empty/non-TUI review tools and validates commands/completions", async () => {
		const test = harness(SessionManager.inMemory()); await test.run("compare"); assert.match(test.notifications.at(-1)!, /No alternate/);
		assert.deepEqual(await test.command.getArgumentCompletions?.("verbatim b"), [{ value: "verbatim branch", label: "branch" }]);
		assert.deepEqual(await test.command.getArgumentCompletions?.("dia"), [{ value: "diagnostics", label: "diagnostics" }]);
		for (const args of ["verbatim invalid", "compare all", "exports extra", "diagnostics extra"]) { await test.run(args); assert.match(test.notifications.at(-1)!, /Usage:/); }
		test.context.mode = "rpc";
		for (const args of ["verbatim", "search abc", "compare", "exports"]) { await test.run(args); assert.match(test.notifications.at(-1)!, /interactive terminal/); }
	});
});

describe("managed export inspection and deletion", () => {
	it("reports available, partial, missing and invalid attachments without writing session history", async () => {
		await withSession(async (manager) => {
			const data = await save(manager); const before = manager.getEntries();
			const list = () => listThinkingExports(manager.getEntries(), manager.getSessionFile()!, manager.getSessionId());
			assert.equal((await list())[0]?.status, "available");
			await rm(data.files[0]!.path); assert.equal((await list())[0]?.status, "partial");
			await rm(dirname(data.files[0]!.path), { recursive: true }); assert.equal((await list())[0]?.status, "missing");
			assert.deepEqual(manager.getEntries(), before);
			manager.appendCustomEntry("thinking-steps.export", { bad: true }); assert.equal((await list())[0]?.status, "unsafe");
		});
	});
	it("deletes only selected manual or automatic snapshots and preserves neighboring files and model context", async () => {
		await withSession(async (manager) => {
			const neighbor = await save(manager);
			for (const automatic of [false, true]) {
				const data = await save(manager, automatic); const before = manager.buildSessionContext();
				const plan = await prepareThinkingExportDeletion(data, manager.getSessionFile()!, manager.getSessionId()); assert.ok(plan);
				await deleteThinkingExport(data, manager.getSessionFile()!, manager.getSessionId(), plan);
				await assert.rejects(readFile(data.files[0]!.path), /ENOENT/);
				assert.match(await readFile(neighbor.files[0]!.path, "utf8"), /PROMPT_PRIVATE/);
				assert.deepEqual(manager.buildSessionContext(), before);
			}
		});
	});
	it("requires confirmation and marks links missing after user-approved deletion", async () => {
		await withSession(async (manager) => {
			const data = await save(manager); const test = harness(manager); const before = manager.getEntries();
			test.context.ui.confirm = async () => false; test.selections.push(0, 1, undefined); await test.run("exports");
			assert.ok(await readFile(data.files[0]!.path));
			test.context.ui.confirm = async (_title, detail) => { test.confirmations.push(detail); return true; };
			test.selections.push(0, 1, undefined); await test.run("exports");
			assert.match(test.confirmations[0]!, /cannot be undone/);
			assert.equal((await listThinkingExports(manager.getEntries(), manager.getSessionFile()!, manager.getSessionId()))[0]?.status, "missing");
			assert.deepEqual(manager.getEntries(), before);
		});
	});
	it("rejects forged paths, foreign sessions, unexpected content, symlinks, and changed snapshots", async () => {
		await withSession(async (manager, root) => {
			const data = await save(manager); const file = manager.getSessionFile()!; const id = manager.getSessionId();
			await assert.rejects(prepareThinkingExportDeletion({ ...data, files: [{ format: "json", path: file }] }, file, id), /outside|Unsafe/);
			await assert.rejects(prepareThinkingExportDeletion(data, file, "other"), /foreign/);
			await writeFile(join(dirname(data.files[0]!.path), "notes.txt"), "keep");
			await assert.rejects(prepareThinkingExportDeletion(data, file, id), /Unexpected/); await rm(join(dirname(data.files[0]!.path), "notes.txt"));
			const plan = await prepareThinkingExportDeletion(data, file, id); assert.ok(plan);
			await writeFile(data.files[0]!.path, "changed after selection");
			await assert.rejects(deleteThinkingExport(data, file, id, plan), /changed/);
			assert.equal(await readFile(data.files[0]!.path, "utf8"), "changed after selection");
			if (process.platform !== "win32") {
				await rm(data.files[0]!.path); const outside = join(root, "outside.json"); await writeFile(outside, "outside"); await symlink(outside, data.files[0]!.path);
				await assert.rejects(prepareThinkingExportDeletion(data, file, id), /symbolic-link/); assert.equal(await readFile(outside, "utf8"), "outside");
			}
		});
	});
	it("rechecks session identity and file contents after the confirmation dialog", async () => {
		await withSession(async (manager) => {
			const data = await save(manager); const test = harness(manager);
			test.context.ui.confirm = async () => { await writeFile(data.files[0]!.path, "new contents"); return true; };
			test.selections.push(0, 1); await test.run("exports"); assert.match(test.notifications.at(-1)!, /changed/); assert.ok(await readFile(data.files[1]!.path));
			test.context.ui.confirm = async () => { manager.getSessionId = () => "different"; return true; };
			test.selections.push(0, 1); await test.run("exports"); assert.match(test.notifications.at(-1)!, /Session changed/); assert.equal(await readFile(data.files[0]!.path, "utf8"), "new contents");
		});
	});
	it("refuses malformed auto ownership markers and keeps unknown files untouched", async () => {
		await withSession(async (manager) => {
			const data = await save(manager, true, "json");
			await writeFile(join(dirname(data.files[0]!.path), "autosave.json"), "null");
			await assert.rejects(prepareThinkingExportDeletion(data, manager.getSessionFile()!, manager.getSessionId()), /ownership marker/);
			assert.equal((await readdir(dirname(data.files[0]!.path))).length, 2);
		});
	});
});

describe("compatibility diagnostics", () => {
	it("reports loaded versions, lifecycle state and availability without conversation text", async () => {
		await withSession(async (manager) => {
			const test = harness(manager); const before = manager.buildSessionContext();
			await test.run("diagnostics"); const output = test.notifications.at(-1)!;
			assert.match(output, new RegExp(`Pi runtime version: ${VERSION.replaceAll(".", "\\.")}`));
			assert.equal(THINKING_LOADED_VERSION, JSON.parse(await readFile("package.json", "utf8")).version);
			assert.match(output, /not-started/); assert.match(output, /1 available, 1 provider-hidden/);
			assert.doesNotMatch(output, /PROMPT_PRIVATE|ANSWER_PRIVATE|SOURCE_PRIVATE|REDACTED_PRIVATE|SIGNATURE_PRIVATE/);
			assert.deepEqual(manager.buildSessionContext(), before);
			const failed = thinkingDiagnostics(test.context as unknown as ExtensionContext, { status: "failed", detail: "incompatible renderer" });
			assert.match(failed, /failed · incompatible renderer/);
			test.context.mode = "rpc"; await test.run("diagnostics"); assert.match(test.notifications.at(-1)!, /Session patch status: native/);
		});
	});
	it("reports active and stopped patch states through the real session lifecycle", async () => {
		await withSession(async (manager) => {
			initTheme("dark", true); const baseline = getPatchRefCount(); const test = harness(manager);
			try { await test.event("session_start"); await test.run("diagnostics"); assert.match(test.notifications.at(-1)!, /Session patch status: active/); }
			finally { await test.event("session_shutdown"); }
			await test.run("diagnostics"); assert.match(test.notifications.at(-1)!, /Session patch status: stopped/);
			assert.equal(getPatchRefCount(), baseline);
		});
	});
});
