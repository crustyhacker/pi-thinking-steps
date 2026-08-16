import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { deriveThinkingSteps, iconForThinkingRole, inferThinkingRole, parseThinkingMode, summarizeThinkingText } from "../parse.js";
import {
	assertPatchableAssistantMessageComponent,
	assertThinkingStepsTheme,
	importPiCodingAgentInternal,
	PI_CODING_AGENT_INTERNAL_MODULES,
	resolvePiCodingAgentInternalModuleUrl,
	retainThinkingStepsPatch,
} from "../internal-patch.js";
import { ThinkingStepsComponent, renderThinkingStepsLines } from "../render.js";
import {
	clearActiveThinkingState,
	getActiveThinkingState,
	getPatchCleanup,
	getPatchInstallPromise,
	getPatchRefCount,
	getThinkingStepsMode,
	resetThinkingStepsViewState,
	setActiveThinkingState,
	setCurrentThinkingScopeKey,
	setPatchCleanup,
	setPatchInstallPromise,
	setThinkingStepsMode,
} from "../state.js";
import type { ThinkingThemeLike } from "../types.js";
import thinkingStepsExtension from "../index.js";
import { Key } from "@mariozechner/pi-tui";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function createPlainTheme(): ThinkingThemeLike {
	return {
		fg: (_color, text) => text,
		bold: (text) => text,
	};
}

function createAnsiTheme(): ThinkingThemeLike {
	return {
		fg: (color, text) => `[${color === "accent" ? "36" : "37"}m${text}[39m`,
		bold: (text) => `[1m${text}[22m`,
	};
}

type FakeSessionEntry = { type?: string; customType?: string; data?: { mode?: string } };

type RegisteredCommand = {
	description: string;
	getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
	handler: (args: string, ctx: FakeExtensionContext) => Promise<void>;
};

type RegisteredShortcut = {
	key: unknown;
	description: string;
	handler: (ctx: FakeExtensionContext) => Promise<void>;
};

type FakeEventHandler = (...args: any[]) => Promise<void>;

interface FakeUI {
	theme: ThinkingThemeLike;
	hiddenThinkingLabels: string[];
	hiddenThinkingLabelEffects: Array<(label: string) => void>;
	statuses: Array<{ key: string; value: string | undefined }>;
	notifications: Array<{ message: string; level: string }>;
	selectCalls: Array<{ title: string; options: string[] }>;
	selectionQueue: Array<string | undefined>;
	setHiddenThinkingLabel(label: string): void;
	setStatus(key: string, value: string | undefined): void;
	notify(message: string, level: string): void;
	select(title: string, options: string[]): Promise<string | undefined>;
}

interface FakeExtensionContext {
	hasUI: boolean;
	cwd: string;
	ui: FakeUI;
	sessionManager: { getEntries(): FakeSessionEntry[] };
}

interface FakeExtensionAPI {
	commands: Map<string, RegisteredCommand>;
	shortcuts: RegisteredShortcut[];
	handlers: Map<string, FakeEventHandler[]>;
	appendedEntries: Array<{ type: "custom"; customType: string; data: { mode: string } }>;
	registerCommand(name: string, command: RegisteredCommand): void;
	registerShortcut(key: unknown, shortcut: Omit<RegisteredShortcut, "key">): void;
	on(event: string, handler: FakeEventHandler): void;
	appendEntry(customType: string, data: { mode: string }): void;
}

function createFakeUI(): FakeUI {
	const hiddenThinkingLabels: string[] = [];
	const hiddenThinkingLabelEffects: Array<(label: string) => void> = [];
	const statuses: Array<{ key: string; value: string | undefined }> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const selectCalls: Array<{ title: string; options: string[] }> = [];
	const selectionQueue: Array<string | undefined> = [];

	return {
		theme: createPlainTheme(),
		hiddenThinkingLabels,
		hiddenThinkingLabelEffects,
		statuses,
		notifications,
		selectCalls,
		selectionQueue,
		setHiddenThinkingLabel(label: string) {
			hiddenThinkingLabels.push(label);
			for (const effect of hiddenThinkingLabelEffects) {
				effect(label);
			}
		},
		setStatus(key: string, value: string | undefined) {
			statuses.push({ key, value });
		},
		notify(message: string, level: string) {
			notifications.push({ message, level });
		},
		async select(title: string, options: string[]) {
			selectCalls.push({ title, options: [...options] });
			return selectionQueue.shift();
		},
	};
}

function createFakeContext(entries: FakeSessionEntry[] = [], hasUI = true, cwd = process.cwd()): FakeExtensionContext {
	const sessionEntries = [...entries];
	return {
		hasUI,
		cwd,
		ui: createFakeUI(),
		sessionManager: {
			getEntries() {
				return sessionEntries;
			},
		},
	};
}

function createFakeExtensionAPI(): FakeExtensionAPI {
	const commands = new Map<string, RegisteredCommand>();
	const shortcuts: RegisteredShortcut[] = [];
	const handlers = new Map<string, FakeEventHandler[]>();
	const appendedEntries: Array<{ type: "custom"; customType: string; data: { mode: string } }> = [];

	return {
		commands,
		shortcuts,
		handlers,
		appendedEntries,
		registerCommand(name: string, command: RegisteredCommand) {
			commands.set(name, command);
		},
		registerShortcut(key: unknown, shortcut: Omit<RegisteredShortcut, "key">) {
			shortcuts.push({ key, ...shortcut });
		},
		on(event: string, handler: FakeEventHandler) {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
		appendEntry(customType: string, data: { mode: string }) {
			appendedEntries.push({ type: "custom", customType, data });
		},
	};
}

function createExtensionHarness(entries: FakeSessionEntry[] = [], hasUI = true, cwd = process.cwd()): {
	pi: FakeExtensionAPI;
	ctx: FakeExtensionContext;
} {
	const pi = createFakeExtensionAPI();
	const ctx = createFakeContext(entries, hasUI, cwd);
	thinkingStepsExtension(pi as any);
	return { pi, ctx };
}

function getSingleHandler(pi: FakeExtensionAPI, event: string): FakeEventHandler {
	const handlers = pi.handlers.get(event) ?? [];
	assert.equal(handlers.length, 1, `expected exactly one ${event} handler`);
	return handlers[0]!;
}

function resetExtensionState(scopeKey = process.cwd()): void {
	resetThinkingStepsViewState();
	setCurrentThinkingScopeKey(scopeKey);
	setThinkingStepsMode("summary", scopeKey);
	clearActiveThinkingState();
}

async function withPersistenceEnvironment<T>(
	run: (environment: { cwd: string; otherCwd: string; home: string }) => Promise<T>,
): Promise<T> {
	const root = await mkdtemp(join(tmpdir(), "thinking-steps-"));
	const home = join(root, "home");
	const cwd = join(root, "project");
	const otherCwd = join(root, "other-project");
	await Promise.all([mkdir(home, { recursive: true }), mkdir(cwd, { recursive: true }), mkdir(otherCwd, { recursive: true })]);

	const previousHome = process.env.HOME;
	process.env.HOME = home;

	try {
		return await run({ cwd, otherCwd, home });
	} finally {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}

		await rm(root, { recursive: true, force: true });
	}
}

describe("deriveThinkingSteps", () => {
	it("splits paragraphs and list items into meaningful steps", () => {
		const steps = deriveThinkingSteps([
			{
				contentIndex: 0,
				text: `I need to inspect the current assistant renderer.\n\n1. Compare the extension API to the TUI internals.\n2. Verify how thinking visibility is toggled.`,
			},
		]);

		assert.equal(steps.length, 3);
		assert.equal(steps[0]?.summary, "Inspect the current assistant renderer.");
		assert.equal(steps[1]?.summary, "Compare the extension API to the TUI internals.");
		assert.equal(steps[2]?.summary, "Verify how thinking visibility is toggled.");
		assert.equal(steps[0]?.icon, "◫");
		assert.equal(steps[2]?.icon, "✓");
	});

	it("keeps markdown heading paragraphs attached to their following body", () => {
		const steps = deriveThinkingSteps([
			{
				contentIndex: 0,
				text: "## Inspecting render pipeline\n\nVerify that refreshes can be triggered safely.",
			},
		]);

		assert.equal(steps.length, 1);
		assert.equal(steps[0]?.body, "## Inspecting render pipeline\n\nVerify that refreshes can be triggered safely.");
		assert.match(steps[0]?.summary ?? "", /Inspect render pipeline|Verify that refreshes can be triggered safely/);
	});

	it("keeps emphasized heading paragraphs attached to their following body", () => {
		const steps = deriveThinkingSteps([
			{
				contentIndex: 0,
				text: "**Inspecting event listeners**\n\nVerify that refreshes can be triggered safely.",
			},
		]);

		assert.equal(steps.length, 1);
		assert.equal(steps[0]?.body, "**Inspecting event listeners**\n\nVerify that refreshes can be triggered safely.");
		assert.match(steps[0]?.summary ?? "", /Inspect event listeners|Verify that refreshes can be triggered safely/);
	});

	it("keeps consecutive headings as separate section boundaries", () => {
		const steps = deriveThinkingSteps([
			{
				contentIndex: 0,
				text: "## Phase A\n\n## Phase B\n\nInspect parse.ts.",
			},
		]);

		assert.equal(steps.length, 2);
		assert.equal(steps[0]?.body, "## Phase A");
		assert.equal(steps[1]?.body, "## Phase B\n\nInspect parse.ts.");
	});

	it("creates a faithful fallback summary for redacted reasoning", () => {
		const steps = deriveThinkingSteps([{ contentIndex: 2, text: "", redacted: true }]);
		assert.equal(steps.length, 1);
		assert.equal(steps[0]?.summary, "Reasoning is hidden by the provider.");
	});
});

describe("patch guards", () => {
	it("rejects incompatible AssistantMessageComponent exports with a clear error", () => {
		assert.throws(
			() => assertPatchableAssistantMessageComponent({ prototype: {} }),
			/missing updateContent, setHideThinkingBlock, setHiddenThinkingLabel/,
		);
	});

	it("rejects incompatible theme exports with a clear error", () => {
		assert.throws(
			() => assertThinkingStepsTheme({ fg: () => "ok" }),
			/interactive theme export is incompatible/,
		);
	});

	it("exports the pinned Pi internal module paths used by the patch", () => {
		assert.equal(
			PI_CODING_AGENT_INTERNAL_MODULES.assistantMessageComponent,
			"dist/modes/interactive/components/assistant-message.js",
		);
		assert.equal(
			PI_CODING_AGENT_INTERNAL_MODULES.theme,
			"dist/modes/interactive/theme/theme.js",
		);
		assert.match(
			resolvePiCodingAgentInternalModuleUrl(PI_CODING_AGENT_INTERNAL_MODULES.assistantMessageComponent),
			/assistant-message\.js$/,
		);
	});

	it("reports a specific compatibility error when an internal module cannot be imported", async () => {
		await assert.rejects(
			() => importPiCodingAgentInternal("dist/modes/interactive/missing.js"),
			/could not import internal module "@mariozechner\/pi-coding-agent\/dist\/modes\/interactive\/missing\.js"/,
		);
	});
});


describe("iconForThinkingRole", () => {
	it("uses a restrained icon set with distinct inspect and search glyphs", () => {
		assert.equal(iconForThinkingRole("inspect"), "◫");
		assert.equal(iconForThinkingRole("search"), "⌕");
		assert.equal(iconForThinkingRole("plan"), "◇");
		assert.equal(iconForThinkingRole("compare"), "↔");
		assert.equal(iconForThinkingRole("verify"), "✓");
		assert.equal(iconForThinkingRole("write"), "✎");
		assert.equal(iconForThinkingRole("error"), "!");
		assert.equal(iconForThinkingRole("default"), "·");
	});
});
describe("summarizeThinkingText", () => {
	it("strips leading first-person filler without inventing new meaning", () => {
		assert.equal(
			summarizeThinkingText("I need to compare the current renderer with Pi's extension hooks."),
			"Compare the current renderer with Pi's extension hooks.",
		);
	});

	it("prefers concrete action clauses over truncated meta-thinking", () => {
		const summary = summarizeThinkingText(
			"I’m considering how we can connect and orient ourselves. It seems like using Larra edit workflows could be helpful here. I need to know the arguments for it, so I might look into using MCP to describe the tools available to me. It could be useful to inspect the connection first, just to make sure everything is set up right before diving into the workflows. Let's see what we can find!",
		);
		assert.match(summary, /Larra edit workflows|inspect the connection first/i);
		assert.doesNotMatch(summary, /considering how we can connect and orient ourselves|Let\'s see what we can find/i);
	});

	it("prefers concrete actions over meta setup in a real transcript delta", () => {
		const summary = summarizeThinkingText(
			"I think I need to gather project instructions and workspace details, possibly through Larra. I should really look into using the get_project_instructions function, but my project memory might have a conflicting inference about being \"Likely Python-based\" when it's actually TypeScript. I need to flag that! This could mean there's stale or inaccurate memory that needs updating later. Before moving forward, I should have a mandatory 5-line checkpoint for the developer after loading the current context. Let me retrieve the relevant instructions as well.",
		);
		assert.match(summary, /gather project instructions and workspace details|look into using the get_project_instructions function/i);
		assert.doesNotMatch(summary, /possibly through Larra|flag that|Clarifying project details/i);
	});

	it("prefers the concrete next step over contemplative framing in a real transcript delta", () => {
		const summary = summarizeThinkingText(
			"I’m contemplating whether I need to get workspaces or if that's necessary. Maybe I should look into using linked workspaces instead? I think the next step might be to inspect the list of workspaces I currently have available. I’m curious about what options I have and which would be the most efficient for my needs. Let's take a closer look and see what makes the most sense!",
		);
		assert.match(summary, /inspect the list of workspaces/i);
		assert.doesNotMatch(summary, /contemplating whether I need to get workspaces/i);
	});

	it("avoids negative tool-availability chatter in a real transcript delta", () => {
		const summary = summarizeThinkingText(
			"I need to find actual examples of transcripts, perhaps starting with the Larra transcript. While there's a tool for it, I might not retrieve the transcripts directly. I could search for session history or even look for previous sessions with relevant prompt files. Real examples would be better than synthetic ones. Gathering some actual thinking deltas from conversations or prompts would provide insights, so I should explore logs for phrases that show reasoning styles.",
		);
		assert.match(summary, /find actual examples of transcripts|search for session history|explore logs/i);
		assert.doesNotMatch(summary, /might not retrieve the transcripts directly|while there's a tool for it|worth checking out/i);
	});

	it("keeps the concrete retry step instead of the heading label or repair aside in a real transcript delta", () => {
		const summary = summarizeThinkingText(
			"I plan to retry once and check the index state. This involves direct actions like \"retry once\" and \"check,\" indicating some uncertainty that I should include. I don't necessarily need to stick to a classical formula since the user is asking for a deterministic classical pipeline. I'll keep some centrality based on tf-like methods. Since the file is currently broken, I’ll write the entire parse.ts with all contents while being careful and replacing only the summarize function. It should be manageable at about 400 lines.",
		);
		assert.match(summary, /retry once and check the index state/i);
		assert.doesNotMatch(summary, /Retrying and checking state|write the entire parse|since the file is currently broken/i);
	});

	it("deduplicates redundant candidates", () => {
		const summary = summarizeThinkingText(
			"Found TS2322 in render.ts. Found TS2322 in render.ts. Retry npm test after updating the type.",
		);
		assert.equal((summary.match(/TS2322/g) ?? []).length, 1);
	});

	it("preserves failure semantics", () => {
		const summary = summarizeThinkingText(
			"Ran npm test and it failed with TS2322 in render.ts. Need to update the type mismatch before retrying.",
		);
		assert.ok(summary.toLowerCase().includes("failed"));
		assert.ok(summary.includes("TS2322"));
	});

	it("preserves small-input failure summaries while optimizing similarity", () => {
		const summary = summarizeThinkingText(
			"Inspect file1.ts for context.\n\nInspect file2.ts for context.\n\nnpm test failed with exit code 1.",
		);
		assert.match(summary, /npm test failed with exit code 1/i);
	});

	it("keeps late salient failures when limiting large candidate sets", () => {
		const genericCandidates = Array.from({ length: 140 }, (_, index) => `Inspect file${index}.ts for context.`);
		const summary = summarizeThinkingText([
			...genericCandidates,
			"npm test failed with exit code 1.",
		].join("\n\n"));

		assert.match(summary, /npm test failed with exit code 1/i);
		assert.ok(summary.length <= 84);
	});

	it("preserves unverified suspicion instead of restating it as fact", () => {
		const summary = summarizeThinkingText(
			"This looks like a stale lock, but I haven't verified it yet. I will retry once and check the index state.",
		);
		assert.ok(/looks like|haven't verified/i.test(summary));
		assert.ok(!summary.includes("This is a stale lock."));
	});

	it("does not imply a commit completed when it did not", () => {
		const summary = summarizeThinkingText(
			"Prepared the commit message, but the commit did not complete because .git/index.lock exists.",
		);
		assert.ok(summary.toLowerCase().includes("did not complete"));
		assert.ok(!summary.toLowerCase().includes("commit completed"));
	});

	it("filters noisy tool-log lines", () => {
		const summary = summarizeThinkingText(
			"12:41:22\n-----\nThinking...\n> npm test\nloading...\nFound TS2322 in render.ts and need to retry after patching.",
		);
		assert.ok(summary.includes("TS2322"));
		assert.ok(!/Thinking|loading|12:41:22/.test(summary));
	});

	it("handles very short deltas cleanly", () => {
		assert.equal(
			summarizeThinkingText("Compare the extension API to the TUI internals."),
			"Compare the extension API to the TUI internals.",
		);
	});

	it("enforces the summary budget on long input", () => {
		const summary = summarizeThinkingText(
			"Found a lock in .git/index.lock. The commit did not complete. Need to inspect the running git process, verify the lock owner, and retry only after the repository is idle. Also compare whether Larra or git created the lock and preserve the exact failure semantics.",
		);
		assert.ok(summary.length <= 84);
	});

	it("keeps long visible summaries complete and period-terminated without ellipsis", () => {
		const summary = summarizeThinkingText(
			"Inspect parse.ts, render.ts, and test/thinking-steps.test.ts before applying the patch and rerunning npm test to preserve failure wording in summary mode.",
		);
		assert.ok(summary.length <= 84);
		assert.ok(summary.endsWith("."));
		assert.ok(!summary.includes("…"));
	});

	it("handles mixed bullets and prose", () => {
		const summary = summarizeThinkingText(
			"We need to decide the safest next step.\n\n- Found TS2322 in render.ts.\n- Retry npm test after patching the type.\n\nThat should confirm the fix.",
		);
		assert.ok(summary.includes("TS2322"));
		assert.ok(/Retry|retry/.test(summary));
	});

	it("handles provider-shaped reasoning deltas with semantic assertions", () => {
		const summary = summarizeThinkingText(
			"The failure happens before any renderer logic runs, so the first thing to verify is whether AssistantMessageComponent still exists at the expected internal path. If that import still resolves, I should compare the theme export shape next and rerun npm test. I should not assume the path moved until I verify it.",
		);
		assert.match(summary, /failure happens before any renderer logic runs|AssistantMessageComponent|theme export shape|rerun npm test/i);
		assert.doesNotMatch(summary, /path moved/i);
		assert.ok(summary.length <= 84);
	});

	it("does not overstate breakage in provider-shaped reasoning", () => {
		const summary = summarizeThinkingText(
			"It looks like the compatibility failure may be coming from the internal module import rather than the renderer code itself. I need to check the pinned Pi package layout first, then confirm whether the theme module moved before I call it a breaking drift.",
		);
		assert.match(summary, /check the pinned Pi package layout|confirm whether the theme module moved/i);
		assert.doesNotMatch(summary, /breaking drift|theme module moved\./i);
	});

	it("returns deterministic output for identical input", () => {
		const input = "Found TS2322 in render.ts. Retry npm test after patching the type mismatch.";
		assert.equal(summarizeThinkingText(input), summarizeThinkingText(input));
	});
});
describe("inferThinkingRole", () => {
	it("prefers inspect over weak write or verify cues in exploratory reasoning", () => {
		assert.equal(
			inferThinkingRole(
				"Use Larra edit workflows, then inspect the connection first. I need to describe the tools available and orient myself.",
			),
			"inspect",
		);
	});

	it("still detects concrete verification steps", () => {
		assert.equal(
			inferThinkingRole("Verify that refreshes can be triggered safely."),
			"verify",
		);
	});

	it("does not treat failure or error reference prose as explicit failure", () => {
		const steps = deriveThinkingSteps([{
			contentIndex: 0,
			text: "Inspect failure handling in parse.ts.\n\nCompare error rendering in render.ts.",
		}]);

		assert.equal(steps.length, 2);
		assert.equal(steps[0]?.hasExplicitFailure, false);
		assert.equal(steps[1]?.hasExplicitFailure, false);
		assert.equal(steps[0]?.role, "inspect");
		assert.equal(steps[1]?.role, "compare");
	});

	it("does not treat issue, problem, or warning reference prose as error-role failures", () => {
		const steps = deriveThinkingSteps([{
			contentIndex: 0,
			text: "Inspect issue handling in parse.ts.\n\nCompare warning rendering in render.ts.\n\nReview problem matching logic.",
		}]);

		assert.equal(steps.length, 3);
		assert.equal(steps[0]?.hasExplicitFailure, false);
		assert.equal(steps[1]?.hasExplicitFailure, false);
		assert.equal(steps[2]?.hasExplicitFailure, false);
		assert.equal(steps[0]?.role, "inspect");
		assert.equal(steps[1]?.role, "compare");
		assert.equal(steps[2]?.role, "inspect");
	});
});
describe("renderThinkingStepsLines", () => {
	const theme = createPlainTheme();
	const steps = deriveThinkingSteps([
		{
			contentIndex: 0,
			text: `Inspect the current renderer implementation.\n\nCompare how visibility toggling works.\n\nVerify the refresh path after mode changes.`,
		},
	]);

	it("collapsed mode renders exactly one summary line", () => {
		const lines = renderThinkingStepsLines(theme, 120, {
			mode: "collapsed",
			steps,
			activeStepId: steps[2]?.id,
			isActive: false,
			nowMs: 0,
		});
		assert.equal(lines.length, 1);
		assert.match(lines[0] ?? "", /Thinking/);
		assert.match(lines[0] ?? "", /Verify the refresh path after mode changes/);
	});

	it("collapsed mode wraps long summaries instead of truncating them with an ellipsis", () => {
		const [baseStep] = deriveThinkingSteps([
			{
				contentIndex: 0,
				text: "Inspect the current renderer implementation.",
			},
		]);
		assert.ok(baseStep);
		const longSummarySteps = [{
			...baseStep,
			summary: "Inspect the current renderer implementation and verify the refresh path after mode changes carefully.",
		}];
		const lines = renderThinkingStepsLines(theme, 48, {
			mode: "collapsed",
			steps: longSummarySteps,
			activeStepId: longSummarySteps[0]?.id,
			isActive: false,
			nowMs: 0,
		});
		assert.ok(lines.length > 1);
		const normalized = stripAnsi(lines.join(" "))
			.replace(/[│·]/g, " ")
			.replace(/\bThinking\b/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		assert.match(normalized, /renderer implementation|refresh path after mode changes/i);
		assert.ok(!normalized.includes("…"));
	});

	it("collapsed mode renders inline formatting instead of raw markdown markers", () => {
		const ansiTheme = createAnsiTheme();
		const markdownSummarySteps = deriveThinkingSteps([
			{
				contentIndex: 0,
				text: "Inspect `render.ts` carefully.",
			},
		]);
		const lines = renderThinkingStepsLines(ansiTheme, 120, {
			mode: "collapsed",
			steps: markdownSummarySteps,
			activeStepId: markdownSummarySteps[0]?.id,
			isActive: false,
			nowMs: 0,
		});
		assert.equal(lines.length, 1);
		assert.ok((lines[0] ?? "").includes("[1m"));
		const joined = stripAnsi(lines.join("\n"));
		assert.ok(joined.includes("Inspect render.ts carefully."));
		assert.ok(!joined.includes("`render.ts`"));
	});

	it("summary mode renders one summarized line per step with pipe connectors", () => {
		const lines = renderThinkingStepsLines(theme, 120, {
			mode: "summary",
			steps,
			activeStepId: steps[1]?.id,
			isActive: false,
		});
		assert.equal(stripAnsi(lines[0] ?? ""), "┆ Thinking Steps · Summary");
		const stepLines = lines.filter((line) => /^(├─|└─)/.test(stripAnsi(line)));
		assert.equal(stepLines.length, 3);
		assert.ok(stepLines.some((line) => stripAnsi(line).includes("◫ Inspect the current renderer implementation.")));
		assert.ok(stepLines.some((line) => stripAnsi(line).includes("↔ Compare how visibility toggling works.")));
		assert.ok(stepLines.some((line) => stripAnsi(line).includes("✓ Verify the refresh path after mode changes.")));
	});

	it("summary mode strips raw markdown markers from visible summaries", () => {
		const markdownSummarySteps = deriveThinkingSteps([
			{
				contentIndex: 0,
				text: "Inspect `render.ts` carefully.\n\nVerify that **refreshes** can be triggered safely.",
			},
		]);
		const lines = renderThinkingStepsLines(theme, 120, {
			mode: "summary",
			steps: markdownSummarySteps,
			activeStepId: undefined,
			isActive: false,
		});
		const joined = stripAnsi(lines.join("\n"));
		assert.ok(joined.includes("Inspect render.ts carefully."));
		assert.ok(joined.includes("Verify that refreshes can be triggered safely."));
		assert.ok(!joined.includes("`render.ts`"));
		assert.ok(!joined.includes("**refreshes**"));
	});

	it("expanded mode renders full step details with cleaner continuation pipes", () => {
		const lines = renderThinkingStepsLines(theme, 64, {
			mode: "expanded",
			steps,
			activeStepId: undefined,
			isActive: false,
		});
		const joined = stripAnsi(lines.join("\n"));
		assert.ok(joined.includes("Thinking Steps · Expanded"));
		assert.ok(joined.includes("├─ ◫ Inspect the current renderer implementation."));
		assert.ok(joined.includes("│  Inspect the current renderer implementation."));
		assert.ok(joined.includes("└─ ✓ Verify the refresh path after mode changes."));
		assert.ok(joined.includes("   Verify the refresh path after mode changes."));
		assert.ok(!joined.includes("│  Verify the refresh path after mode changes."));
	});

	it("expanded mode renders markdown as terminal formatting instead of raw markers", () => {
		const markdownSteps = deriveThinkingSteps([
			{
				contentIndex: 0,
				text: "## Inspecting `render.ts`\n\n- Verify that **refreshes** can be triggered safely.",
			},
		]);
		const lines = renderThinkingStepsLines(theme, 80, {
			mode: "expanded",
			steps: markdownSteps,
			activeStepId: undefined,
			isActive: false,
		});
		const joined = stripAnsi(lines.join("\n"));
		assert.ok(joined.includes("Inspecting render.ts"));
		assert.ok(joined.includes("• Verify that refreshes can be triggered safely."));
		assert.ok(!joined.includes("## Inspecting `render.ts`"));
		assert.ok(!joined.includes("- Verify that **refreshes** can be triggered safely."));
		assert.ok(!joined.includes("**"));
		assert.ok(!joined.includes("`"));
	});

	it("renders provider-hidden reasoning across collapsed, summary, and expanded modes", () => {
		const redactedSteps = deriveThinkingSteps([{ contentIndex: 0, text: "", redacted: true }]);
		const collapsed = stripAnsi(renderThinkingStepsLines(theme, 100, {
			mode: "collapsed",
			steps: redactedSteps,
			activeStepId: redactedSteps[0]?.id,
			isActive: false,
			nowMs: 0,
		}).join("\n"));
		const summary = stripAnsi(renderThinkingStepsLines(theme, 100, {
			mode: "summary",
			steps: redactedSteps,
			isActive: false,
		}).join("\n"));
		const expanded = stripAnsi(renderThinkingStepsLines(theme, 100, {
			mode: "expanded",
			steps: redactedSteps,
			isActive: false,
		}).join("\n"));

		assert.match(collapsed, /Reasoning is hidden by the provider\./);
		assert.match(summary, /Reasoning is hidden by the provider\./);
		assert.match(expanded, /Reasoning is hidden by the provider\./);
		assert.doesNotMatch(`${collapsed}\n${summary}\n${expanded}`, /undefined/);
	});

	it("wraps long summary and expanded headers instead of truncating them", () => {
		const [baseStep] = deriveThinkingSteps([
			{
				contentIndex: 0,
				text: "Inspect the current renderer implementation.",
			},
		]);
		assert.ok(baseStep);
		const longHeaderSteps = [{
			...baseStep,
			summary: "Inspect the current renderer implementation and verify the refresh path after mode changes carefully.",
			body: "Body.",
		}];
		const summaryLines = renderThinkingStepsLines(theme, 44, {
			mode: "summary",
			steps: longHeaderSteps,
			isActive: false,
		});
		const expandedLines = renderThinkingStepsLines(theme, 44, {
			mode: "expanded",
			steps: longHeaderSteps,
			isActive: false,
		});
		const summaryJoined = stripAnsi(summaryLines.join("\n"));
		const expandedJoined = stripAnsi(expandedLines.join("\n"));
		assert.ok(summaryLines.length > 2);
		assert.ok(expandedLines.length > 3);
		assert.match(summaryJoined, /refresh\s+path after mode changes carefully/i);
		assert.match(expandedJoined, /refresh\s+path after mode changes carefully/i);
		assert.ok(!summaryJoined.includes("…"));
		assert.ok(!expandedJoined.includes("…"));
	});

	it("collapsed active rendering animates without using italics", () => {
		const first = renderThinkingStepsLines(theme, 120, {
			mode: "collapsed",
			steps,
			activeStepId: steps[2]?.id,
			isActive: true,
			nowMs: 0,
		});
		const second = renderThinkingStepsLines(theme, 120, {
			mode: "collapsed",
			steps,
			activeStepId: steps[2]?.id,
			isActive: true,
			nowMs: 360,
		});
		assert.equal(first.length, 1);
		assert.equal(second.length, 1);
		assert.notEqual(first[0], second[0]);
		assert.ok(!/\x1b\[3m|\x1b\[23m/.test(first[0] ?? ""));
		assert.ok(!/\x1b\[3m|\x1b\[23m/.test(second[0] ?? ""));
	});
});

describe("integration patch", () => {
	it("patches AssistantMessageComponent so mode switching changes live thinking rendering", async () => {
		const release = await retainThinkingStepsPatch();
		try {
			const [{ AssistantMessageComponent }, { initTheme }] = await Promise.all([
				importPiCodingAgentInternal<{ AssistantMessageComponent: new (message?: unknown, hideThinkingBlock?: boolean) => { render(width: number): string[]; setHiddenThinkingLabel(label: string): void } }>(
					PI_CODING_AGENT_INTERNAL_MODULES.assistantMessageComponent,
				),
				importPiCodingAgentInternal<{ initTheme: (name?: string, quiet?: boolean) => void }>(
					PI_CODING_AGENT_INTERNAL_MODULES.theme,
				),
			]);
			initTheme("dark", true);

			const message = {
				role: "assistant",
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				timestamp: 123,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				content: [
					{
						type: "thinking",
						thinking:
							"Inspect the current rendering pipeline.\n\nCompare the public extension hooks against AssistantMessageComponent.\n\nVerify that refreshes can be triggered safely.",
					},
					{ type: "text", text: "Final answer." },
				],
			} as const;

			setThinkingStepsMode("summary");
			clearActiveThinkingState();
			const component = new AssistantMessageComponent(message, false);
			let lines = component.render(100).map(stripAnsi);
			assert.ok(lines.some((line) => line.includes("Thinking Steps · Summary")));
			assert.equal(lines.filter((line) => line.startsWith("├─") || line.startsWith("└─")).length, 3);
			assert.ok(lines.some((line) => line.includes("Final answer.")));

			setThinkingStepsMode("collapsed");
			setActiveThinkingState({ active: true, messageTimestamp: 123, contentIndex: 0 });
			component.setHiddenThinkingLabel("refresh");
			lines = component.render(100).map(stripAnsi);
			assert.ok(lines.some((line) => line.includes("Thinking")));
			assert.equal(lines.filter((line) => line.includes("Thinking")).length, 1);
			assert.ok(lines.some((line) => line.includes("Verify that refreshes can be triggered safely")));
			assert.ok(lines.every((line) => !/\x1b\[3m|\x1b\[23m/.test(line)));
		} finally {
			clearActiveThinkingState();
			setThinkingStepsMode("summary");
			await release();
		}
	});

	it("preserves host markdown transformers when Pi exposes them and falls back cleanly on older Pi", async () => {
		const release = await retainThinkingStepsPatch();
		try {
			const [{ AssistantMessageComponent }, { initTheme }] = await Promise.all([
				importPiCodingAgentInternal<{ AssistantMessageComponent: new (message?: unknown, hideThinkingBlock?: boolean) => { render(width: number): string[] } }>(
					PI_CODING_AGENT_INTERNAL_MODULES.assistantMessageComponent,
				),
				importPiCodingAgentInternal<{ initTheme: (name?: string, quiet?: boolean) => void }>(
					PI_CODING_AGENT_INTERNAL_MODULES.theme,
				),
			]);
			initTheme("dark", true);

			// Pi >= 0.84 ships markdown transformers (mermaid/LaTeX). On the pinned
			// Pi version the module does not exist and the patch must keep rendering
			// through its legacy Markdown construction without failing.
			let markdownTransformAvailable = false;
			try {
				await importPiCodingAgentInternal<{ createMarkdownTransform: unknown }>(
					PI_CODING_AGENT_INTERNAL_MODULES.markdownTransform,
				);
				markdownTransformAvailable = true;
			} catch {
				markdownTransformAvailable = false;
			}

			const message = {
				role: "assistant",
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				timestamp: 123,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				content: [
					{
						type: "text",
						text: "Final answer.\n\n```mermaid\nflowchart TD\n    A --> B\n```",
					},
				] as const,
			};

			setThinkingStepsMode("summary");
			clearActiveThinkingState();
			const component = new AssistantMessageComponent(message, false);
			const lines = component.render(120).map(stripAnsi);
			assert.ok(lines.some((line) => line.includes("Final answer.")));
			if (markdownTransformAvailable) {
				assert.ok(!lines.some((line) => line.includes("flowchart TD")));
			} else {
				assert.ok(lines.some((line) => line.includes("flowchart TD")));
			}
		} finally {
			clearActiveThinkingState();
			setThinkingStepsMode("summary");
			await release();
		}
	});
});

describe("parseThinkingMode", () => {
	it("accepts exact and shorthand mode names", () => {
		assert.equal(parseThinkingMode("collapsed"), "collapsed");
		assert.equal(parseThinkingMode("summary"), "summary");
		assert.equal(parseThinkingMode("expanded"), "expanded");
		assert.equal(parseThinkingMode("e"), "expanded");
		assert.equal(parseThinkingMode("unknown"), undefined);
	});
});

describe("thinkingStepsExtension", () => {
	it("registers the thinking-steps command, completions, and Alt+T shortcut", () => {
		resetExtensionState();
		const { pi } = createExtensionHarness();

		const command = pi.commands.get("thinking-steps");
		assert.ok(command);
		assert.equal(command.description, "Switch thinking view or set/clear project/global defaults");
		assert.deepEqual(command.getArgumentCompletions?.("s"), [{ value: "summary", label: "summary" }]);
		assert.equal(command.getArgumentCompletions?.("z") ?? null, null);

		assert.equal(pi.shortcuts.length, 1);
		assert.deepEqual(pi.shortcuts[0]?.key, Key.alt("t"));
		assert.equal(pi.shortcuts[0]?.description, "Cycle thinking view (collapsed, summary, expanded)");
		assert.equal(pi.handlers.get("session_start")?.length, 1);
		assert.equal(pi.handlers.get("message_start")?.length, 1);
		assert.equal(pi.handlers.get("message_update")?.length, 1);
		assert.equal(pi.handlers.get("message_end")?.length, 1);
		assert.equal(pi.handlers.get("agent_end")?.length, 1);
		assert.equal(pi.handlers.get("session_shutdown")?.length, 1);
	});

	it("restores the saved mode and persists explicit mode changes", async () => {
		resetExtensionState();
		const { pi, ctx } = createExtensionHarness([{ type: "custom", customType: "thinking-steps.mode", data: { mode: "collapsed" } }]);
		const sessionStart = getSingleHandler(pi, "session_start");
		const sessionShutdown = getSingleHandler(pi, "session_shutdown");
		const command = pi.commands.get("thinking-steps");
		const shortcut = pi.shortcuts[0];
		assert.ok(command);
		assert.ok(shortcut);

		try {
			assert.equal(getPatchRefCount(), 0);
			await sessionStart({}, ctx);
			assert.equal(getPatchRefCount(), 1);
			assert.deepEqual(getActiveThinkingState(), { active: false });
			assert.deepEqual(pi.appendedEntries, []);
			assert.equal(ctx.ui.hiddenThinkingLabels.at(-1), "Thinking...");
			assert.deepEqual(ctx.ui.statuses.at(-1), { key: "thinking-steps", value: "thinking: collapsed" });

			await command.handler("expanded", ctx);
			assert.equal(ctx.ui.selectCalls.length, 0);
			assert.deepEqual(pi.appendedEntries.at(-1), {
				type: "custom",
				customType: "thinking-steps.mode",
				data: { mode: "expanded" },
			});
			assert.deepEqual(ctx.ui.statuses.at(-1), { key: "thinking-steps", value: "thinking: expanded" });
			assert.deepEqual(ctx.ui.notifications.at(-1), { message: "Thinking view: expanded", level: "info" });

			await shortcut.handler(ctx);
			assert.deepEqual(pi.appendedEntries.at(-1), {
				type: "custom",
				customType: "thinking-steps.mode",
				data: { mode: "collapsed" },
			});
			assert.deepEqual(ctx.ui.statuses.at(-1), { key: "thinking-steps", value: "thinking: collapsed" });
			assert.deepEqual(ctx.ui.notifications.at(-1), { message: "Thinking view: collapsed", level: "info" });
		} finally {
			await sessionShutdown({}, ctx);
			assert.equal(getPatchRefCount(), 0);
			resetExtensionState();
		}
	});

	it("restores the most recent valid session mode when newer session entries are malformed", async () => {
		resetExtensionState();
		const { pi, ctx } = createExtensionHarness([
			{ type: "custom", customType: "thinking-steps.mode", data: { mode: "collapsed" } },
			{ type: "custom", customType: "thinking-steps.mode", data: { mode: "bogus" } },
			{ type: "custom", customType: "thinking-steps.mode" },
		]);
		const sessionStart = getSingleHandler(pi, "session_start");
		const sessionShutdown = getSingleHandler(pi, "session_shutdown");

		try {
			await sessionStart({}, ctx);
			assert.equal(getThinkingStepsMode(), "collapsed");
			assert.deepEqual(ctx.ui.statuses.at(-1), { key: "thinking-steps", value: "thinking: collapsed" });
		} finally {
			await sessionShutdown({}, ctx);
			resetExtensionState();
		}
	});

	it("rerenders a live patched component through public controls without relying on same-value labels", async () => {
		resetExtensionState("/scope-a");
		const { pi, ctx } = createExtensionHarness([], true, "/scope-a");
		const sessionStart = getSingleHandler(pi, "session_start");
		const sessionShutdown = getSingleHandler(pi, "session_shutdown");
		const command = pi.commands.get("thinking-steps");
		const shortcut = pi.shortcuts[0];
		assert.ok(command);
		assert.ok(shortcut);

		const [{ AssistantMessageComponent }, { initTheme }] = await Promise.all([
			importPiCodingAgentInternal<{ AssistantMessageComponent: new (message?: unknown, hideThinkingBlock?: boolean) => { render(width: number): string[]; setHiddenThinkingLabel(label: string): void } }>(
				PI_CODING_AGENT_INTERNAL_MODULES.assistantMessageComponent,
			),
			importPiCodingAgentInternal<{ initTheme: (name?: string, quiet?: boolean) => void }>(
				PI_CODING_AGENT_INTERNAL_MODULES.theme,
			),
		]);
		initTheme("dark", true);

		try {
			await sessionStart({}, ctx);
			const message = {
				role: "assistant",
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				timestamp: 333,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				content: [
					{ type: "thinking", thinking: "Inspect the current rendering pipeline.\n\nCompare the public extension hooks against AssistantMessageComponent.\n\nVerify that refreshes can be triggered safely." },
					{ type: "text", text: "Final answer." },
				],
			} as const;

			const component = new AssistantMessageComponent(message, false);
			ctx.ui.hiddenThinkingLabelEffects.push((label) => component.setHiddenThinkingLabel(label));

			let lines = component.render(100).map(stripAnsi);
			assert.ok(lines.some((line) => line.includes("Thinking Steps · Summary")));
			const firstRefreshLabel = ctx.ui.hiddenThinkingLabels.at(-1);

			await command.handler("collapsed", ctx);
			lines = component.render(100).map(stripAnsi);
			assert.ok(lines.some((line) => line.includes("Thinking")));
			assert.ok(lines.every((line) => !line.includes("Thinking Steps · Summary")));
			const secondRefreshLabel = ctx.ui.hiddenThinkingLabels.at(-1);
			assert.notEqual(secondRefreshLabel, firstRefreshLabel);

			await shortcut.handler(ctx);
			lines = component.render(100).map(stripAnsi);
			assert.ok(lines.some((line) => line.includes("Thinking Steps · Summary")));
			const thirdRefreshLabel = ctx.ui.hiddenThinkingLabels.at(-1);
			assert.notEqual(thirdRefreshLabel, secondRefreshLabel);
		} finally {
			await sessionShutdown({}, ctx);
			resetExtensionState();
		}
	});

	it("uses interactive selection when no mode argument is provided", async () => {
		resetExtensionState();
		const { pi, ctx } = createExtensionHarness();
		const command = pi.commands.get("thinking-steps");
		assert.ok(command);

		ctx.ui.selectionQueue.push("expanded");
		await command.handler("", ctx);

		assert.deepEqual(ctx.ui.selectCalls, [{ title: "Thinking view", options: ["collapsed", "summary", "expanded"] }]);
		assert.deepEqual(pi.appendedEntries, [{
			type: "custom",
			customType: "thinking-steps.mode",
			data: { mode: "expanded" },
		}]);
		assert.deepEqual(ctx.ui.statuses.at(-1), { key: "thinking-steps", value: "thinking: expanded" });
		assert.deepEqual(ctx.ui.notifications.at(-1), { message: "Thinking view: expanded", level: "info" });
	});

	it("tracks and clears active thinking state across assistant lifecycle events", async () => {
		resetExtensionState();
		const { pi, ctx } = createExtensionHarness();
		const sessionStart = getSingleHandler(pi, "session_start");
		const messageStart = getSingleHandler(pi, "message_start");
		const messageUpdate = getSingleHandler(pi, "message_update");
		const messageEnd = getSingleHandler(pi, "message_end");
		const agentEnd = getSingleHandler(pi, "agent_end");
		const sessionShutdown = getSingleHandler(pi, "session_shutdown");

		try {
			setActiveThinkingState({ active: true, messageTimestamp: 7, contentIndex: 3 });
			await sessionStart({}, ctx);
			assert.deepEqual(getActiveThinkingState(), { active: false });
			assert.equal(getPatchRefCount(), 1);

			await messageUpdate({
				message: { role: "assistant", timestamp: 321 },
				assistantMessageEvent: { type: "thinking_start", contentIndex: 4 },
			});
			assert.deepEqual(getActiveThinkingState(), { active: true, messageTimestamp: 321, contentIndex: 4 });

			await messageUpdate({
				message: { role: "assistant", timestamp: 321 },
				assistantMessageEvent: { type: "thinking_delta", contentIndex: 5 },
			});
			assert.deepEqual(getActiveThinkingState(), { active: true, messageTimestamp: 321, contentIndex: 5 });

			await messageStart({ message: { role: "assistant" } });
			assert.deepEqual(getActiveThinkingState(), { active: false });

			await messageUpdate({
				message: { role: "assistant", timestamp: 654 },
				assistantMessageEvent: { type: "thinking_start", contentIndex: 1 },
			});
			assert.deepEqual(getActiveThinkingState(), { active: true, messageTimestamp: 654, contentIndex: 1 });

			await messageUpdate({
				message: { role: "assistant", timestamp: 654 },
				assistantMessageEvent: { type: "text_start" },
			});
			assert.deepEqual(getActiveThinkingState(), { active: false });

			setActiveThinkingState({ active: true, messageTimestamp: 700, contentIndex: 2 });
			await messageEnd({ message: { role: "assistant" } });
			assert.deepEqual(getActiveThinkingState(), { active: false });

			setActiveThinkingState({ active: true, messageTimestamp: 701, contentIndex: 3 });
			await agentEnd();
			assert.deepEqual(getActiveThinkingState(), { active: false });

			setActiveThinkingState({ active: true, messageTimestamp: 702, contentIndex: 4 });
			await sessionShutdown({}, ctx);
			assert.deepEqual(getActiveThinkingState(), { active: false });
			assert.deepEqual(ctx.ui.statuses.at(-1), { key: "thinking-steps", value: undefined });
			assert.equal(getPatchRefCount(), 0);
		} finally {
			if (getPatchRefCount() > 0) {
				await sessionShutdown({}, ctx);
			}
			resetExtensionState();
		}
	});
});

describe("patch lifecycle", () => {

describe("thinkingStepsExtension persistence", () => {
	it("offers scoped completions for project and global defaults", () => {
		resetExtensionState();
		const { pi } = createExtensionHarness();
		const command = pi.commands.get("thinking-steps");
		assert.ok(command);

		assert.deepEqual(command.getArgumentCompletions?.("g"), [{ value: "global", label: "global" }]);
		assert.deepEqual(command.getArgumentCompletions?.("project e"), [{ value: "project expanded", label: "expanded" }]);
		assert.deepEqual(command.getArgumentCompletions?.("project "), [
			{ value: "project collapsed", label: "collapsed" },
			{ value: "project summary", label: "summary" },
			{ value: "project expanded", label: "expanded" },
			{ value: "project clear", label: "clear" },
		]);
	});

	it("restores session, project, and global defaults in precedence order", async () => {
		await withPersistenceEnvironment(async ({ cwd, otherCwd }) => {
			resetExtensionState();
			const { pi, ctx } = createExtensionHarness([], true, cwd);
			const command = pi.commands.get("thinking-steps");
			assert.ok(command);

			await command.handler("global collapsed", ctx);
			assert.deepEqual(ctx.ui.notifications.at(-1), { message: "Thinking view: collapsed (saved for global)", level: "info" });

			await command.handler("project expanded", ctx);
			assert.deepEqual(ctx.ui.notifications.at(-1), { message: "Thinking view: expanded (saved for project)", level: "info" });
			assert.deepEqual(pi.appendedEntries.at(-1), {
				type: "custom",
				customType: "thinking-steps.mode",
				data: { mode: "expanded" },
			});

			resetExtensionState();
			const projectHarness = createExtensionHarness([], true, cwd);
			const projectStart = getSingleHandler(projectHarness.pi, "session_start");
			const projectShutdown = getSingleHandler(projectHarness.pi, "session_shutdown");
			try {
				await projectStart({}, projectHarness.ctx);
				assert.deepEqual(projectHarness.ctx.ui.statuses.at(-1), { key: "thinking-steps", value: "thinking: expanded" });
			} finally {
				await projectShutdown({}, projectHarness.ctx);
			}

			resetExtensionState();
			const globalHarness = createExtensionHarness([], true, otherCwd);
			const globalStart = getSingleHandler(globalHarness.pi, "session_start");
			const globalShutdown = getSingleHandler(globalHarness.pi, "session_shutdown");
			try {
				await globalStart({}, globalHarness.ctx);
				assert.deepEqual(globalHarness.ctx.ui.statuses.at(-1), { key: "thinking-steps", value: "thinking: collapsed" });
			} finally {
				await globalShutdown({}, globalHarness.ctx);
			}

			resetExtensionState();
			const sessionHarness = createExtensionHarness(
				[{ type: "custom", customType: "thinking-steps.mode", data: { mode: "summary" } }],
				true,
				cwd,
			);
			const sessionStart = getSingleHandler(sessionHarness.pi, "session_start");
			const sessionShutdown = getSingleHandler(sessionHarness.pi, "session_shutdown");
			try {
				await sessionStart({}, sessionHarness.ctx);
				assert.deepEqual(sessionHarness.ctx.ui.statuses.at(-1), { key: "thinking-steps", value: "thinking: summary" });
			} finally {
				await sessionShutdown({}, sessionHarness.ctx);
			}
		});
	});

	it("restores a valid global default when the project default is malformed", async () => {
		await withPersistenceEnvironment(async ({ cwd, home }) => {
			await mkdir(join(cwd, ".pi"), { recursive: true });
			await mkdir(join(home, ".pi", "agent", "state"), { recursive: true });
			await writeFile(join(cwd, ".pi", "thinking-steps.json"), "{ not json", "utf8");
			await writeFile(join(home, ".pi", "agent", "state", "thinking-steps.json"), `${JSON.stringify({ mode: "collapsed" }, null, 2)}\n`, "utf8");

			resetExtensionState(cwd);
			const { pi, ctx } = createExtensionHarness([], true, cwd);
			const sessionStart = getSingleHandler(pi, "session_start");
			const sessionShutdown = getSingleHandler(pi, "session_shutdown");

			try {
				await sessionStart({}, ctx);
				assert.equal(getThinkingStepsMode(cwd), "collapsed");
				assert.deepEqual(ctx.ui.statuses.at(-1), { key: "thinking-steps", value: "thinking: collapsed" });
				assert.ok(ctx.ui.notifications.some((notification) => notification.level === "warning" && notification.message.includes("Thinking steps persistence error:")));
			} finally {
				await sessionShutdown({}, ctx);
			}
		});
	});

	it("restores a valid global default when the project default has an invalid schema", async () => {
		await withPersistenceEnvironment(async ({ cwd, home }) => {
			await mkdir(join(cwd, ".pi"), { recursive: true });
			await mkdir(join(home, ".pi", "agent", "state"), { recursive: true });
			for (const invalidContent of [JSON.stringify({}), JSON.stringify({ mode: "bogus" }), JSON.stringify([])]) {
				await writeFile(join(cwd, ".pi", "thinking-steps.json"), `${invalidContent}\n`, "utf8");
				await writeFile(join(home, ".pi", "agent", "state", "thinking-steps.json"), `${JSON.stringify({ mode: "collapsed" }, null, 2)}\n`, "utf8");

				resetExtensionState(cwd);
				const { pi, ctx } = createExtensionHarness([], true, cwd);
				const sessionStart = getSingleHandler(pi, "session_start");
				const sessionShutdown = getSingleHandler(pi, "session_shutdown");

				try {
					await sessionStart({}, ctx);
					assert.equal(getThinkingStepsMode(cwd), "collapsed");
					assert.deepEqual(ctx.ui.statuses.at(-1), { key: "thinking-steps", value: "thinking: collapsed" });
					assert.ok(ctx.ui.notifications.some((notification) => notification.level === "warning" && notification.message.includes("Invalid thinking view preference")));
				} finally {
					await sessionShutdown({}, ctx);
				}
			}
		});
	});

	it("falls back to summary mode when the global default has an invalid schema or empty file", async () => {
		await withPersistenceEnvironment(async ({ cwd, home }) => {
			await mkdir(join(home, ".pi", "agent", "state"), { recursive: true });
			for (const invalidContent of [JSON.stringify({}), JSON.stringify({ mode: "bogus" }), ""]) {
				await writeFile(join(home, ".pi", "agent", "state", "thinking-steps.json"), invalidContent.length > 0 ? `${invalidContent}\n` : "", "utf8");

				resetExtensionState(cwd);
				const { pi, ctx } = createExtensionHarness([], true, cwd);
				const sessionStart = getSingleHandler(pi, "session_start");
				const sessionShutdown = getSingleHandler(pi, "session_shutdown");

				try {
					await sessionStart({}, ctx);
					assert.equal(getThinkingStepsMode(cwd), "summary");
					assert.deepEqual(ctx.ui.statuses.at(-1), { key: "thinking-steps", value: "thinking: summary" });
					assert.ok(ctx.ui.notifications.some((notification) => notification.level === "warning" && notification.message.includes("Thinking steps persistence error:")));
				} finally {
					await sessionShutdown({}, ctx);
				}
			}
		});
	});

	it("clears project and global defaults for future sessions without changing the current session mode", async () => {
		await withPersistenceEnvironment(async ({ cwd, otherCwd }) => {
			resetExtensionState();
			const { ctx, pi } = createExtensionHarness([], true, cwd);
			const command = pi.commands.get("thinking-steps");
			assert.ok(command);

			await command.handler("global collapsed", ctx);
			await command.handler("project expanded", ctx);
			assert.equal(getThinkingStepsMode(), "expanded");

			await command.handler("project clear", ctx);
			assert.equal(getThinkingStepsMode(), "expanded");
			assert.deepEqual(ctx.ui.notifications.at(-1), { message: "Cleared project thinking view default", level: "info" });

			resetExtensionState();
			const projectHarness = createExtensionHarness([], true, cwd);
			const projectStart = getSingleHandler(projectHarness.pi, "session_start");
			const projectShutdown = getSingleHandler(projectHarness.pi, "session_shutdown");
			try {
				await projectStart({}, projectHarness.ctx);
				assert.deepEqual(projectHarness.ctx.ui.statuses.at(-1), { key: "thinking-steps", value: "thinking: collapsed" });
			} finally {
				await projectShutdown({}, projectHarness.ctx);
			}

			setThinkingStepsMode("expanded");
			await command.handler("global clear", ctx);
			assert.equal(getThinkingStepsMode(), "expanded");
			assert.deepEqual(ctx.ui.notifications.at(-1), { message: "Cleared global thinking view default", level: "info" });

			resetExtensionState();
			const globalHarness = createExtensionHarness([], true, otherCwd);
			const globalStart = getSingleHandler(globalHarness.pi, "session_start");
			const globalShutdown = getSingleHandler(globalHarness.pi, "session_shutdown");
			try {
				await globalStart({}, globalHarness.ctx);
				assert.deepEqual(globalHarness.ctx.ui.statuses.at(-1), { key: "thinking-steps", value: "thinking: summary" });
			} finally {
				await globalShutdown({}, globalHarness.ctx);
			}
		});
	});
});
	async function loadAssistantMessageComponent() {
		const [{ AssistantMessageComponent }, { initTheme }] = await Promise.all([
			importPiCodingAgentInternal<{ AssistantMessageComponent: new (message?: unknown, hideThinkingBlock?: boolean) => { render(width: number): string[]; setHiddenThinkingLabel(label: string): void; setHideThinkingBlock(hide: boolean): void } }>(
				PI_CODING_AGENT_INTERNAL_MODULES.assistantMessageComponent,
			),
			importPiCodingAgentInternal<{ initTheme: (name?: string, quiet?: boolean) => void }>(
				PI_CODING_AGENT_INTERNAL_MODULES.theme,
			),
		]);
		initTheme("dark", true);
		return AssistantMessageComponent;
	}

	it("serializes concurrent retains and restores originals on the final release", async () => {
		const AssistantMessageComponent = await loadAssistantMessageComponent();
		const prototype = AssistantMessageComponent.prototype as {
			updateContent(message: unknown): void;
			setHideThinkingBlock(hide: boolean): void;
			setHiddenThinkingLabel(label: string): void;
		};
		const originalUpdateContent = prototype.updateContent;
		const originalSetHideThinkingBlock = prototype.setHideThinkingBlock;
		const originalSetHiddenThinkingLabel = prototype.setHiddenThinkingLabel;
		let releaseA: (() => Promise<void>) | undefined;
		let releaseB: (() => Promise<void>) | undefined;

		try {
			assert.equal(getPatchRefCount(), 0);
			assert.equal(getPatchCleanup(), undefined);
			assert.equal(getPatchInstallPromise(), undefined);

			[releaseA, releaseB] = await Promise.all([retainThinkingStepsPatch(), retainThinkingStepsPatch()]);

			assert.equal(getPatchRefCount(), 2);
			assert.ok(getPatchCleanup());
			assert.equal(getPatchInstallPromise(), undefined);
			assert.notEqual(prototype.updateContent, originalUpdateContent);
			assert.notEqual(prototype.setHideThinkingBlock, originalSetHideThinkingBlock);
			assert.notEqual(prototype.setHiddenThinkingLabel, originalSetHiddenThinkingLabel);

			await releaseA();
			releaseA = undefined;
			assert.equal(getPatchRefCount(), 1);
			assert.notEqual(prototype.updateContent, originalUpdateContent);
			assert.notEqual(prototype.setHideThinkingBlock, originalSetHideThinkingBlock);
			assert.notEqual(prototype.setHiddenThinkingLabel, originalSetHiddenThinkingLabel);

			await releaseB();
			releaseB = undefined;
			assert.equal(getPatchRefCount(), 0);
			assert.equal(getPatchCleanup(), undefined);
			assert.equal(getPatchInstallPromise(), undefined);
			assert.equal(prototype.updateContent, originalUpdateContent);
			assert.equal(prototype.setHideThinkingBlock, originalSetHideThinkingBlock);
			assert.equal(prototype.setHiddenThinkingLabel, originalSetHiddenThinkingLabel);
		} finally {
			if (releaseA) {
				await releaseA();
			}
			if (releaseB) {
				await releaseB();
			}
			const cleanup = getPatchCleanup();
			setPatchCleanup(undefined);
			setPatchInstallPromise(undefined);
			await cleanup?.();
		}
	});

	it("rolls back refcount when a pending install promise rejects", async () => {
		const failure = new Error("install failed");
		const rejectedInstall: Promise<() => void | Promise<void>> = Promise.reject(failure);
		rejectedInstall.catch(() => {});

		assert.equal(getPatchRefCount(), 0);
		assert.equal(getPatchCleanup(), undefined);
		setPatchInstallPromise(rejectedInstall);

		await assert.rejects(() => retainThinkingStepsPatch(), /install failed/);
		assert.equal(getPatchRefCount(), 0);
		assert.equal(getPatchCleanup(), undefined);
		assert.equal(getPatchInstallPromise(), undefined);
	});
});

describe("integration patch edge cases", () => {
	async function createPatchedComponent(message: unknown) {
		const release = await retainThinkingStepsPatch();
		const [{ AssistantMessageComponent }, { initTheme }] = await Promise.all([
			importPiCodingAgentInternal<{ AssistantMessageComponent: new (message?: unknown, hideThinkingBlock?: boolean) => { render(width: number): string[]; setHiddenThinkingLabel(label: string): void; setHideThinkingBlock(hide: boolean): void; hideThinkingBlock?: boolean } }>(
				PI_CODING_AGENT_INTERNAL_MODULES.assistantMessageComponent,
			),
			importPiCodingAgentInternal<{ initTheme: (name?: string, quiet?: boolean) => void }>(
				PI_CODING_AGENT_INTERNAL_MODULES.theme,
			),
		]);
		initTheme("dark", true);
		const component = new AssistantMessageComponent(message, false);
		return { component, release };
	}

	it("renders abort and error messages when no tool calls are present", async () => {
		setThinkingStepsMode("summary");
		clearActiveThinkingState();

		const abortedMessage = {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			timestamp: 200,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "aborted",
			errorMessage: "Network canceled",
			content: [{ type: "thinking", thinking: "Inspect the current renderer implementation." }],
		} as const;

		const errorMessage = {
			...abortedMessage,
			timestamp: 201,
			stopReason: "error",
			errorMessage: undefined,
		} as const;

		const { component: abortedComponent, release: releaseAborted } = await createPatchedComponent(abortedMessage);
		try {
			const abortedLines = abortedComponent.render(100).map(stripAnsi).join("\n");
			assert.ok(abortedLines.includes("Network canceled"));
		} finally {
			await releaseAborted();
		}

		const { component: errorComponent, release: releaseError } = await createPatchedComponent(errorMessage);
		try {
			const errorLines = errorComponent.render(100).map(stripAnsi).join("\n");
			assert.ok(errorLines.includes("Error: Unknown error"));
		} finally {
			await releaseError();
		}
	});

	it("suppresses abort and error text when tool calls are present", async () => {
		setThinkingStepsMode("summary");
		clearActiveThinkingState();
		const message = {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			timestamp: 202,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "tool failed",
			content: [
				{ type: "thinking", thinking: "Inspect the current renderer implementation." },
				{ type: "toolCall" },
			],
		} as const;

		const { component, release } = await createPatchedComponent(message);
		try {
			const lines = component.render(100).map(stripAnsi).join("\n");
			assert.ok(lines.includes("Inspect the current renderer implementation."));
			assert.ok(!lines.includes("Error: tool failed"));
			assert.ok(!lines.includes("Operation aborted"));
		} finally {
			await release();
		}
	});

	it("renders multiple thinking blocks and rerenders through patched setters", async () => {
		setThinkingStepsMode("collapsed");
		setActiveThinkingState({ active: true, messageTimestamp: 203, contentIndex: 0 });
		const message = {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			timestamp: 203,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			content: [
				{ type: "thinking", thinking: "Inspect the current renderer implementation." },
				{ type: "text", text: "Intermediate response." },
				{ type: "thinking", thinking: "Verify the refresh path after mode changes." },
				{ type: "text", text: "Final answer." },
			],
		} as const;

		const { component, release } = await createPatchedComponent(message);
		try {
			let lines = component.render(100).map(stripAnsi).join("\n");
			assert.ok(lines.includes("Inspect the current renderer implementation."));
			assert.ok(lines.includes("Intermediate response."));
			assert.ok(lines.includes("Final answer."));

			component.setHideThinkingBlock(true);
			assert.equal((component as { hideThinkingBlock?: boolean }).hideThinkingBlock, false);
			component.setHiddenThinkingLabel("rerender");
			lines = component.render(100).map(stripAnsi).join("\n");
			assert.ok(lines.includes("Inspect the current renderer implementation."));
			assert.ok(lines.includes("Thinking"));
		} finally {
			clearActiveThinkingState();
			setThinkingStepsMode("summary");
			await release();
		}
	});

	it("uses the default abort label when the provider reports the generic abort message", async () => {
		setThinkingStepsMode("summary");
		clearActiveThinkingState();
		const message = {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			timestamp: 204,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "aborted",
			errorMessage: "Request was aborted",
			content: [{ type: "thinking", thinking: "Inspect the current renderer implementation." }],
		} as const;

		const { component, release } = await createPatchedComponent(message);
		try {
			const lines = component.render(100).map(stripAnsi).join("\n");
			assert.ok(lines.includes("Operation aborted"));
			assert.ok(!lines.includes("Request was aborted"));
		} finally {
			await release();
		}
	});

	it("renders provider-hidden reasoning through the patched component path", async () => {
		setThinkingStepsMode("summary");
		clearActiveThinkingState();
		const message = {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			timestamp: 204.5,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			content: [
				{ type: "thinking", thinking: "", redacted: true },
				{ type: "text", text: "Final answer." },
			],
		} as const;

		const { component, release } = await createPatchedComponent(message);
		try {
			const lines = component.render(100).map(stripAnsi).join("\n");
			assert.ok(lines.includes("Reasoning is hidden by the provider."));
			assert.ok(lines.includes("Final answer."));
		} finally {
			await release();
		}
	});

	it("selects the later active thinking block in collapsed mode when contentIndex points to it", async () => {
		setThinkingStepsMode("collapsed");
		setActiveThinkingState({ active: true, messageTimestamp: 205, contentIndex: 2 });
		const message = {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			timestamp: 205,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			content: [
				{ type: "thinking", thinking: "Inspect the current renderer implementation." },
				{ type: "text", text: "Intermediate response." },
				{ type: "thinking", thinking: "Verify the refresh path after mode changes." },
			],
		} as const;

		const { component, release } = await createPatchedComponent(message);
		try {
			const lines = component.render(100).map(stripAnsi).join("\n");
			assert.ok(lines.includes("Verify the refresh path after mode changes."));
			assert.ok(!lines.includes("Inspect the current renderer implementation."));
		} finally {
			clearActiveThinkingState();
			setThinkingStepsMode("summary");
			await release();
		}
	});
});


describe("deriveThinkingSteps list continuations", () => {
	it("keeps blank-line continuation paragraphs attached to the correct list item", () => {
		const steps = deriveThinkingSteps([
			{
				contentIndex: 0,
				text: "1. Inspect the current renderer implementation.\n\nVerify that refreshes can be triggered safely.\n\n2. Compare the extension hooks.",
			},
		]);

		assert.equal(steps.length, 2);
		assert.equal(
			steps[0]?.body,
			"1. Inspect the current renderer implementation.\n\nVerify that refreshes can be triggered safely.",
		);
		assert.equal(steps[1]?.body, "2. Compare the extension hooks.");
	});

	it("keeps heading scope on each item in a headed multi-item list", () => {
		const steps = deriveThinkingSteps([
			{
				contentIndex: 0,
				text: "## Patch plan\n\n- Inspect parse.ts.\n- Update render.ts.",
			},
		]);

		assert.equal(steps.length, 2);
		assert.equal(steps[0]?.body, "## Patch plan\n\n- Inspect parse.ts.");
		assert.equal(steps[1]?.body, "## Patch plan\n\n- Update render.ts.");
	});

	it("keeps heading scope on blank-line-separated list items under one heading", () => {
		const steps = deriveThinkingSteps([
			{
				contentIndex: 0,
				text: "## Patch plan\n\n1. Inspect parse.ts.\n\n2. Update render.ts.",
			},
		]);

		assert.equal(steps.length, 2);
		assert.equal(steps[0]?.body, "## Patch plan\n\n1. Inspect parse.ts.");
		assert.equal(steps[1]?.body, "## Patch plan\n\n2. Update render.ts.");
	});

	it("keeps heading scope on list items after heading plus intro prose", () => {
		const steps = deriveThinkingSteps([
			{
				contentIndex: 0,
				text: "## Patch plan\n\nWe should validate parser boundaries first.\n\n- Inspect parse.ts.\n- Update render.ts.",
			},
		]);

		assert.equal(steps.length, 3);
		assert.equal(steps[0]?.body, "## Patch plan\n\nWe should validate parser boundaries first.");
		assert.equal(steps[1]?.body, "## Patch plan\n\n- Inspect parse.ts.");
		assert.equal(steps[2]?.body, "## Patch plan\n\n- Update render.ts.");
	});

	it("splits an explicit failure paragraph after list items into its own step", () => {
		const steps = deriveThinkingSteps([
			{
				contentIndex: 0,
				text: "1. Inspect parse.ts.\n\n2. Update render.ts.\n\nnpm test failed with exit code 1.",
			},
		]);

		assert.equal(steps.length, 3);
		assert.equal(steps[0]?.body, "1. Inspect parse.ts.");
		assert.equal(steps[1]?.body, "2. Update render.ts.");
		assert.equal(steps[2]?.body, "npm test failed with exit code 1.");
		assert.equal(steps[2]?.hasExplicitFailure, true);
	});

	it("splits standalone planning prose after a list item into its own step", () => {
		const steps = deriveThinkingSteps([
			{
				contentIndex: 0,
				text: "1. Inspect parse.ts.\n\nNeed to update render.ts next.\n\n2. Run npm test.",
			},
		]);

		assert.equal(steps.length, 3);
		assert.equal(steps[0]?.body, "1. Inspect parse.ts.");
		assert.equal(steps[1]?.body, "Need to update render.ts next.");
		assert.equal(steps[2]?.body, "2. Run npm test.");
	});

	it("splits bare imperative prose after a list item into its own step", () => {
		const steps = deriveThinkingSteps([
			{
				contentIndex: 0,
				text: "1. Inspect parse.ts.\n\nCompare render.ts before editing.\n\n2. Run npm test.",
			},
		]);

		assert.equal(steps.length, 3);
		assert.equal(steps[0]?.body, "1. Inspect parse.ts.");
		assert.equal(steps[1]?.body, "Compare render.ts before editing.");
		assert.equal(steps[2]?.body, "2. Run npm test.");
	});
});


describe("renderThinkingStepsLines control-sequence sanitization", () => {
	const plainTheme = createPlainTheme();

	it("strips literal ANSI sequences from collapsed summaries", () => {
		const steps = deriveThinkingSteps([{
			contentIndex: 0,
			text: "Inspect \u001b[31mrender.ts\u001b[0m carefully.",
		}]);
		const lines = renderThinkingStepsLines(plainTheme, 120, {
			mode: "collapsed",
			steps,
			activeStepId: steps[0]?.id,
			isActive: false,
			nowMs: 0,
		});
		const joined = lines.join("\n");
		assert.ok(!joined.includes("\u001b[31m"));
		assert.ok(!joined.includes("\u001b[0m"));
		assert.ok(joined.includes("Inspect render.ts carefully."));
	});

	it("strips control bytes from summary and expanded rendering", () => {
		const steps = deriveThinkingSteps([{
			contentIndex: 0,
			text: "Inspect render.ts carefully.\n\nVerify\u0007 that refreshes can be triggered safely.",
		}]);
		const summaryLines = renderThinkingStepsLines(plainTheme, 120, {
			mode: "summary",
			steps,
			isActive: false,
		});
		const expandedLines = renderThinkingStepsLines(plainTheme, 120, {
			mode: "expanded",
			steps,
			isActive: false,
		});
		const summaryJoined = summaryLines.join("\n");
		const expandedJoined = expandedLines.join("\n");
		assert.ok(!summaryJoined.includes("\u0007"));
		assert.ok(!expandedJoined.includes("\u0007"));
		assert.ok(summaryJoined.includes("Verify that refreshes can be triggered safely."));
		assert.ok(expandedJoined.includes("Verify that refreshes can be triggered safely."));
	});

	it("strips raw C1 control bytes from rendered thinking text", () => {
		const steps = deriveThinkingSteps([{
			contentIndex: 0,
			text: "Inspect \u009b31mrender.ts\u009b0m carefully.\n\nVerify\u0085 that refreshes can be triggered safely.",
		}]);
		const summaryLines = renderThinkingStepsLines(plainTheme, 120, {
			mode: "summary",
			steps,
			isActive: false,
		});
		const expandedLines = renderThinkingStepsLines(plainTheme, 120, {
			mode: "expanded",
			steps,
			isActive: false,
		});
		const summaryJoined = summaryLines.join("\n");
		const expandedJoined = expandedLines.join("\n");
		assert.ok(!summaryJoined.includes("\u009b"));
		assert.ok(!expandedJoined.includes("\u009b"));
		assert.ok(!summaryJoined.includes("\u0085"));
		assert.ok(!expandedJoined.includes("\u0085"));
		assert.ok(summaryJoined.includes("Inspect render.ts carefully."));
		assert.ok(expandedJoined.includes("Verify that refreshes can be triggered safely."));
	});

	it("strips ST-terminated string-control payloads from rendered thinking text", () => {
		const steps = deriveThinkingSteps([{
			contentIndex: 0,
			text: "Inspect \u009dhidden title\u009crender.ts carefully.\n\nVerify \u001b^private payload\u001b\\refreshes can be triggered safely.",
		}]);
		const summaryJoined = renderThinkingStepsLines(plainTheme, 120, {
			mode: "summary",
			steps,
			isActive: false,
		}).join("\n");
		const expandedJoined = renderThinkingStepsLines(plainTheme, 120, {
			mode: "expanded",
			steps,
			isActive: false,
		}).join("\n");

		assert.ok(!summaryJoined.includes("hidden title"));
		assert.ok(!expandedJoined.includes("hidden title"));
		assert.ok(!summaryJoined.includes("private payload"));
		assert.ok(!expandedJoined.includes("private payload"));
		assert.ok(summaryJoined.includes("Inspect render.ts carefully."));
		assert.ok(expandedJoined.includes("Verify refreshes can be triggered safely."));
	});

	it("strips non-CSI ESC control sequences from rendered thinking text", () => {
		const steps = deriveThinkingSteps([{
			contentIndex: 0,
			text: "Inspect \u001bcrender.ts carefully.\n\nVerify \u001b7refreshes\u001b8 can be triggered safely.",
		}]);
		const expandedJoined = renderThinkingStepsLines(plainTheme, 120, {
			mode: "expanded",
			steps,
			isActive: false,
		}).join("\n");

		assert.ok(!expandedJoined.includes("\u001bc"));
		assert.ok(!expandedJoined.includes("\u001b7"));
		assert.ok(!expandedJoined.includes("\u001b8"));
		assert.ok(expandedJoined.includes("Inspect render.ts carefully."));
		assert.ok(expandedJoined.includes("Verify refreshes can be triggered safely."));
	});

	it("preserves theme-generated ANSI while stripping model-provided sequences", () => {
		const ansiTheme = createAnsiTheme();
		const steps = deriveThinkingSteps([{
			contentIndex: 0,
			text: "Inspect \u001b[31m`render.ts`\u001b[0m carefully.",
		}]);
		const lines = renderThinkingStepsLines(ansiTheme, 120, {
			mode: "collapsed",
			steps,
			activeStepId: steps[0]?.id,
			isActive: false,
			nowMs: 0,
		});
		const joined = lines.join("\n");
		assert.ok(joined.includes("\u001b[1m"));
		assert.ok(!joined.includes("\u001b[31m"));
		assert.ok(!joined.includes("\u001b[0m"));
		assert.ok(stripAnsi(joined).includes("Inspect render.ts carefully."));
	});
});


describe("renderThinkingStepsLines single-emphasis consistency", () => {
	const plainTheme = createPlainTheme();

	it("normalizes single-emphasis markers in collapsed and summary modes", () => {
		const steps = deriveThinkingSteps([
			{
				contentIndex: 0,
				text: "Inspect *render.ts* carefully.\n\n_Verify_ that refreshes can be triggered safely.",
			},
		]);

		const collapsedLines = renderThinkingStepsLines(plainTheme, 120, {
			mode: "collapsed",
			steps,
			activeStepId: steps[0]?.id,
			isActive: false,
			nowMs: 0,
		});
		const summaryLines = renderThinkingStepsLines(plainTheme, 120, {
			mode: "summary",
			steps,
			isActive: false,
		});

		const collapsedJoined = collapsedLines.join("\n");
		const summaryJoined = summaryLines.join("\n");
		assert.ok(collapsedJoined.includes("Inspect render.ts carefully."));
		assert.ok(summaryJoined.includes("Inspect render.ts carefully."));
		assert.ok(summaryJoined.includes("Verify that refreshes can be triggered safely."));
		assert.ok(!collapsedJoined.includes("*render.ts*"));
		assert.ok(!summaryJoined.includes("_Verify_"));
	});

	it("normalizes single-emphasis markers in expanded headings, bodies, and list items", () => {
		const steps = deriveThinkingSteps([
			{
				contentIndex: 0,
				text: "## _Inspecting_ `render.ts`\n\n- *Verify* that refreshes can be triggered safely.",
			},
		]);

		const lines = renderThinkingStepsLines(plainTheme, 120, {
			mode: "expanded",
			steps,
			isActive: false,
		});
		const joined = lines.join("\n");
		assert.ok(joined.includes("Inspecting render.ts"));
		assert.ok(joined.includes("• Verify that refreshes can be triggered safely."));
		assert.ok(!joined.includes("_Inspecting_"));
		assert.ok(!joined.includes("*Verify*"));
	});
});


describe("state ownership", () => {
	it("returns a defensive copy of active thinking state", () => {
		resetExtensionState();
		setActiveThinkingState({ active: true, messageTimestamp: 12, contentIndex: 3 });

		const snapshot = getActiveThinkingState();
		snapshot.active = false;
		snapshot.messageTimestamp = 999;
		snapshot.contentIndex = 42;

		assert.deepEqual(getActiveThinkingState(), { active: true, messageTimestamp: 12, contentIndex: 3 });
	});

	it("migrates legacy global state snapshots from pre-scope releases", async () => {
		const stateKey = Symbol.for("pi-extensions.thinking-steps.state");
		const globalSlot = globalThis as Record<PropertyKey, unknown>;
		const previousState = globalSlot[stateKey];

		try {
			globalSlot[stateKey] = {
				mode: "collapsed",
				active: { active: true, messageTimestamp: 42, contentIndex: 7 },
				patchRefCount: 0,
			};

			const moduleUrl = new URL(`../state.js?legacy=${Date.now()}`, import.meta.url).href;
			const migratedState = await import(moduleUrl) as typeof import("../state.js");

			assert.equal(migratedState.getThinkingStepsMode(), "collapsed");
			assert.deepEqual(migratedState.getActiveThinkingState(42), {
				active: true,
				messageTimestamp: 42,
				contentIndex: 7,
			});
			assert.doesNotThrow(() => migratedState.clearActiveThinkingState(42));
			assert.deepEqual(migratedState.getActiveThinkingState(42), { active: false });
		} finally {
			if (previousState === undefined) {
				delete globalSlot[stateKey];
			} else {
				globalSlot[stateKey] = previousState;
			}
			resetExtensionState();
		}
	});
});

describe("patch lifecycle regression coverage", () => {
	async function loadAssistantMessageComponentForPatchLifecycle() {
		const [{ AssistantMessageComponent }, { initTheme }] = await Promise.all([
			importPiCodingAgentInternal<{ AssistantMessageComponent: new (message?: unknown, hideThinkingBlock?: boolean) => { render(width: number): string[]; setHiddenThinkingLabel(label: string): void; setHideThinkingBlock(hide: boolean): void } }>(
				PI_CODING_AGENT_INTERNAL_MODULES.assistantMessageComponent,
			),
			importPiCodingAgentInternal<{ initTheme: (name?: string, quiet?: boolean) => void }>(
				PI_CODING_AGENT_INTERNAL_MODULES.theme,
			),
		]);
		initTheme("dark", true);
		return AssistantMessageComponent;
	}

	it("rolls back partially applied prototype changes when patch install fails", async () => {
		const AssistantMessageComponent = await loadAssistantMessageComponentForPatchLifecycle();
		const prototype = AssistantMessageComponent.prototype as {
			updateContent(message: unknown): void;
			setHideThinkingBlock(hide: boolean): void;
			setHiddenThinkingLabel(label: string): void;
		};
		const originalUpdateContent = prototype.updateContent;
		const originalSetHideThinkingBlock = prototype.setHideThinkingBlock;
		const hiddenLabelDescriptor = Object.getOwnPropertyDescriptor(prototype, "setHiddenThinkingLabel");
		assert.ok(hiddenLabelDescriptor);

		Object.defineProperty(prototype, "setHiddenThinkingLabel", {
			...hiddenLabelDescriptor,
			writable: false,
		});

		try {
			await assert.rejects(() => retainThinkingStepsPatch(), /prototype is incompatible with thinking-steps patching|read only|Cannot assign/);
			assert.equal(getPatchRefCount(), 0);
			assert.equal(getPatchCleanup(), undefined);
			assert.equal(getPatchInstallPromise(), undefined);
			assert.equal(prototype.updateContent, originalUpdateContent);
			assert.equal(prototype.setHideThinkingBlock, originalSetHideThinkingBlock);
		} finally {
			Object.defineProperty(prototype, "setHiddenThinkingLabel", hiddenLabelDescriptor);
			const cleanup = getPatchCleanup();
			setPatchCleanup(undefined);
			setPatchInstallPromise(undefined);
			await cleanup?.();
		}
	});

	it("keeps the final cleanup retryable if release cleanup throws", async () => {
		const release = await retainThinkingStepsPatch();
		const installedCleanup = getPatchCleanup();
		assert.ok(installedCleanup);

		const failingCleanup = async () => {
			throw new Error("cleanup failed");
		};

		try {
			setPatchCleanup(failingCleanup);
			await assert.rejects(() => release(), /cleanup failed/);
			assert.equal(getPatchRefCount(), 1);
			assert.equal(getPatchCleanup(), failingCleanup);

			setPatchCleanup(installedCleanup);
			await release();
			assert.equal(getPatchRefCount(), 0);
			assert.equal(getPatchCleanup(), undefined);
		} finally {
			if (getPatchRefCount() > 0 && installedCleanup) {
				setPatchCleanup(installedCleanup);
				await release();
			}
			setPatchCleanup(undefined);
			setPatchInstallPromise(undefined);
		}
	});
});

describe("thinkingStepsExtension failure paths", () => {
	it("warns on invalid command arguments", async () => {
		resetExtensionState();
		const { pi, ctx } = createExtensionHarness();
		const command = pi.commands.get("thinking-steps");
		assert.ok(command);

		await command.handler("project unknown-mode", ctx);
		assert.deepEqual(ctx.ui.notifications.at(-1), {
			message: "Usage: /thinking-steps [collapsed|summary|expanded] | [project|global] [collapsed|summary|expanded|clear]",
			level: "warning",
		});
		assert.equal(pi.appendedEntries.length, 0);
	});

	it("does not mutate mode when interactive selection is unavailable", async () => {
		resetExtensionState();
		const { pi, ctx } = createExtensionHarness([], false);
		const command = pi.commands.get("thinking-steps");
		assert.ok(command);

		await command.handler("", ctx);
		assert.equal(getThinkingStepsMode(), "summary");
		assert.equal(pi.appendedEntries.length, 0);
	});

	it("does not mutate mode when interactive selection is cancelled", async () => {
		resetExtensionState();
		const { pi, ctx } = createExtensionHarness();
		const command = pi.commands.get("thinking-steps");
		assert.ok(command);

		ctx.ui.selectionQueue.push(undefined);
		await command.handler("", ctx);
		assert.equal(getThinkingStepsMode(), "summary");
		assert.equal(pi.appendedEntries.length, 0);
	});

	it("reports restore persistence failures and falls back to summary mode", async () => {
		await withPersistenceEnvironment(async ({ cwd }) => {
			await mkdir(join(cwd, ".pi"), { recursive: true });
			await writeFile(join(cwd, ".pi", "thinking-steps.json"), "{ not json", "utf8");

			resetExtensionState();
			const { pi, ctx } = createExtensionHarness([], true, cwd);
			const sessionStart = getSingleHandler(pi, "session_start");
			const sessionShutdown = getSingleHandler(pi, "session_shutdown");

			try {
				await sessionStart({}, ctx);
				assert.equal(getThinkingStepsMode(), "summary");
				assert.deepEqual(ctx.ui.statuses.at(-1), { key: "thinking-steps", value: "thinking: summary" });
				assert.ok(ctx.ui.notifications.some((notification) => notification.level === "warning" && notification.message.includes("Thinking steps persistence error:")));
			} finally {
				await sessionShutdown({}, ctx);
			}
		});
	});

	it("disables live mode switching for degraded sessions while still saving future defaults", async () => {
		await withPersistenceEnvironment(async ({ cwd, home }) => {
			const installFailure = new Error("install failed");
			const rejectedInstall: Promise<() => void | Promise<void>> = Promise.reject(installFailure);
			rejectedInstall.catch(() => {});
			setPatchInstallPromise(rejectedInstall);

			resetExtensionState(cwd);
			const { pi, ctx } = createExtensionHarness([], true, cwd);
			const sessionStart = getSingleHandler(pi, "session_start");
			const sessionShutdown = getSingleHandler(pi, "session_shutdown");
			const command = pi.commands.get("thinking-steps");
			const shortcut = pi.shortcuts[0];
			assert.ok(command);
			assert.ok(shortcut);

			try {
				await sessionStart({}, ctx);
				assert.equal(getPatchRefCount(), 0);
				assert.equal(pi.appendedEntries.length, 0);
				assert.equal(ctx.ui.hiddenThinkingLabels.length, 0);
				assert.equal(ctx.ui.statuses.length, 0);
				assert.ok(ctx.ui.notifications.some((notification) => notification.level === "warning" && notification.message.includes("Thinking steps patch error: install failed")));
				assert.ok(ctx.ui.notifications.some((notification) => notification.level === "warning" && notification.message.includes("native thinking renderer")));

				await command.handler("collapsed", ctx);
				assert.equal(getThinkingStepsMode(cwd), "summary");
				assert.equal(pi.appendedEntries.length, 0);

				await shortcut.handler(ctx);
				assert.equal(getThinkingStepsMode(cwd), "summary");
				assert.equal(pi.appendedEntries.length, 0);

				await command.handler("project collapsed", ctx);
				const projectPreference = JSON.parse(await readFile(join(cwd, ".pi", "thinking-steps.json"), "utf8")) as { mode: string };
				assert.equal(projectPreference.mode, "collapsed");
				assert.ok(ctx.ui.notifications.some((notification) => notification.level === "info" && notification.message.includes("future compatible sessions")));

				await command.handler("global expanded", ctx);
				const globalPreference = JSON.parse(await readFile(join(home, ".pi", "agent", "state", "thinking-steps.json"), "utf8")) as { mode: string };
				assert.equal(globalPreference.mode, "expanded");

				await command.handler("project clear", ctx);
				await assert.rejects(readFile(join(cwd, ".pi", "thinking-steps.json"), "utf8"));
			} finally {
				setPatchInstallPromise(undefined);
				await sessionShutdown({}, ctx);
				resetExtensionState();
			}
		});
	});

	it("reports write failures for scoped defaults without changing session state", async () => {
		await withPersistenceEnvironment(async ({ cwd }) => {
			await writeFile(join(cwd, ".pi"), "occupied", "utf8");

			resetExtensionState();
			const { pi, ctx } = createExtensionHarness([], true, cwd);
			const command = pi.commands.get("thinking-steps");
			assert.ok(command);

			await command.handler("project collapsed", ctx);

			assert.equal(getThinkingStepsMode(), "summary");
			assert.equal(pi.appendedEntries.length, 0);
			assert.ok(ctx.ui.notifications.some((notification) => notification.level === "warning" && notification.message.includes("Failed to save thinking view preference")));
		});
	});

	it("reports clear failures for scoped defaults without changing session state", async () => {
		await withPersistenceEnvironment(async ({ cwd }) => {
			await mkdir(join(cwd, ".pi", "thinking-steps.json"), { recursive: true });

			resetExtensionState();
			const { pi, ctx } = createExtensionHarness([], true, cwd);
			const command = pi.commands.get("thinking-steps");
			assert.ok(command);

			await command.handler("project clear", ctx);

			assert.equal(getThinkingStepsMode(), "summary");
			assert.equal(pi.appendedEntries.length, 0);
			assert.ok(ctx.ui.notifications.some((notification) => notification.level === "warning" && notification.message.includes("Failed to clear thinking view preference")));
		});
	});

	it("retains and releases patch references per session lifecycle event", async () => {
		resetExtensionState();
		const { pi, ctx } = createExtensionHarness();
		const sessionStart = getSingleHandler(pi, "session_start");
		const sessionShutdown = getSingleHandler(pi, "session_shutdown");

		try {
			assert.equal(getPatchRefCount(), 0);
			await sessionStart({}, ctx);
			await sessionStart({}, ctx);
			assert.equal(getPatchRefCount(), 2);

			await sessionShutdown({}, ctx);
			assert.equal(getPatchRefCount(), 1);

			await sessionShutdown({}, ctx);
			assert.equal(getPatchRefCount(), 0);
		} finally {
			while (getPatchRefCount() > 0) {
				await sessionShutdown({}, ctx);
			}
			resetExtensionState();
		}
	});

	it("does not release a retained patch from an unmatched different-scope shutdown", async () => {
		resetExtensionState("/scope-reload");
		const firstHarness = createExtensionHarness([], true, "/scope-reload");
		const secondHarness = createExtensionHarness([], true, "/other-scope");
		const firstStart = getSingleHandler(firstHarness.pi, "session_start");
		const firstShutdown = getSingleHandler(firstHarness.pi, "session_shutdown");
		const secondShutdown = getSingleHandler(secondHarness.pi, "session_shutdown");

		try {
			assert.equal(getPatchRefCount(), 0);
			await firstStart({}, firstHarness.ctx);
			assert.equal(getPatchRefCount(), 1);

			await secondShutdown({}, secondHarness.ctx);
			assert.equal(getPatchRefCount(), 1);

			await firstShutdown({}, firstHarness.ctx);
			assert.equal(getPatchRefCount(), 0);
		} finally {
			while (getPatchRefCount() > 0) {
				await firstShutdown({}, firstHarness.ctx);
			}
			resetExtensionState();
		}
	});

	it("requeues the scope-owned release when session shutdown cleanup throws", async () => {
		resetExtensionState("/scope-cleanup-retry");
		const { pi, ctx } = createExtensionHarness([], true, "/scope-cleanup-retry");
		const sessionStart = getSingleHandler(pi, "session_start");
		const sessionShutdown = getSingleHandler(pi, "session_shutdown");
		const failingCleanup = async () => {
			throw new Error("cleanup failed");
		};
		let started = false;
		let installedCleanup = getPatchCleanup();

		try {
			await sessionStart({}, ctx);
			started = true;
			installedCleanup = getPatchCleanup();
			assert.ok(installedCleanup);

			setPatchCleanup(failingCleanup);
			await sessionShutdown({}, ctx);
			assert.equal(getPatchRefCount(), 1);
			assert.equal(getPatchCleanup(), failingCleanup);
			assert.ok(ctx.ui.notifications.some((notification) => notification.level === "warning" && notification.message.includes("cleanup failed")));

			setPatchCleanup(installedCleanup);
			await sessionShutdown({}, ctx);
			assert.equal(getPatchRefCount(), 0);
			started = false;
		} finally {
			if (started && installedCleanup) {
				setPatchCleanup(installedCleanup);
			}
			while (getPatchRefCount() > 0) {
				await sessionShutdown({}, ctx);
			}
			resetExtensionState();
		}
	});
});

describe("integration patch fallback paths", () => {
	async function createFallbackPatchedComponent(message: unknown) {
		const release = await retainThinkingStepsPatch();
		const [{ AssistantMessageComponent }, { initTheme }] = await Promise.all([
			importPiCodingAgentInternal<{ AssistantMessageComponent: new (message?: unknown, hideThinkingBlock?: boolean) => { render(width: number): string[]; setHiddenThinkingLabel(label: string): void; setHideThinkingBlock(hide: boolean): void; hideThinkingBlock?: boolean; hiddenThinkingLabel?: string; contentContainer?: unknown } }>(
				PI_CODING_AGENT_INTERNAL_MODULES.assistantMessageComponent,
			),
			importPiCodingAgentInternal<{ initTheme: (name?: string, quiet?: boolean) => void }>(
				PI_CODING_AGENT_INTERNAL_MODULES.theme,
			),
		]);
		initTheme("dark", true);
		const component = new AssistantMessageComponent(message, false);
		return { component, release };
	}

	it("falls back to the original renderer when thinking-steps rendering throws", async () => {
		setThinkingStepsMode("summary");
		clearActiveThinkingState();
		const message = {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			timestamp: 901,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			content: [
				{ type: "thinking", thinking: "Inspect the current renderer implementation." },
				{ type: "text", text: "Final answer." },
			],
		} as const;

		const { component, release } = await createFallbackPatchedComponent(message);
		const container = (component as { contentContainer: { addChild(child: unknown): void } }).contentContainer;
		const originalAddChild = container.addChild.bind(container);
		container.addChild = ((child: unknown) => {
			if ((child as { constructor?: { name?: string } }).constructor?.name === "ThinkingStepsComponent") {
				throw new Error("simulate thinking-steps render failure");
			}
			return originalAddChild(child);
		}) as typeof container.addChild;

		const originalWarn = console.warn;
		const warnings: unknown[][] = [];
		console.warn = (...args: unknown[]) => {
			warnings.push(args);
		};

		try {
			component.setHiddenThinkingLabel("fallback-refresh");
			const lines = component.render(100).map(stripAnsi).join("\n");
			assert.ok(lines.includes("Inspect the current renderer implementation."));
			assert.ok(lines.includes("Final answer."));
			assert.ok(!lines.includes("Thinking Steps ·"));
			assert.ok(warnings.some(([message, error]) => typeof message === "string"
				&& message.includes("falling back to Pi renderer during updateContent")
				&& error instanceof Error
				&& error.message.includes("simulate thinking-steps render failure")));
		} finally {
			console.warn = originalWarn;
			container.addChild = originalAddChild;
			await release();
		}
	});

	it("preserves original hide semantics when setter fallback is used", async () => {
		setThinkingStepsMode("summary");
		clearActiveThinkingState();
		const message = {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			timestamp: 902,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			content: [
				{ type: "thinking", thinking: "Inspect the current renderer implementation." },
				{ type: "text", text: "Final answer." },
			],
		} as const;

		const { component, release } = await createFallbackPatchedComponent(message);
		const patchedComponent = component as unknown as { updateContent(message: unknown): void } & typeof component;
		const originalUpdateContent = patchedComponent.updateContent.bind(component);
		patchedComponent.updateContent = (_message: unknown) => {
			throw new Error("simulate setter rerender failure");
		};

		const originalWarn = console.warn;
		console.warn = () => {};

		try {
			component.setHideThinkingBlock(true);
			component.setHiddenThinkingLabel("fallback");
			const lines = component.render(100).map(stripAnsi).join("\n");
			assert.equal((component as { hideThinkingBlock?: boolean }).hideThinkingBlock, true);
			assert.equal((component as { hiddenThinkingLabel?: string }).hiddenThinkingLabel, "fallback");
			assert.ok(lines.includes("fallback"));
			assert.ok(!lines.includes("Thinking Steps ·"));
		} finally {
			console.warn = originalWarn;
			patchedComponent.updateContent = originalUpdateContent;
			await release();
		}
	});
});


describe("UX regression coverage", () => {
	const theme = createPlainTheme();

	function assertWidthInvariant(lines: string[], width: number): void {
		for (const line of lines) {
			assert.ok(stripAnsi(line).length <= width, `line exceeds width ${width}: ${stripAnsi(line)}`);
		}
	}

	it("preserves overlong unbroken collapsed tokens across wrapped lines", () => {
		const token = "superlongidentifierwithoutbreaks1234567890";
		const steps = deriveThinkingSteps([
			{
				contentIndex: 0,
				text: `Inspect ${token} carefully.`,
			},
		]);
		const width = 30;
		const lines = renderThinkingStepsLines(theme, width, {
			mode: "collapsed",
			steps,
			activeStepId: steps[0]?.id,
			isActive: false,
			nowMs: 0,
		});

		assert.ok(lines.length > 1);
		assertWidthInvariant(lines, width);

		const normalized = stripAnsi(lines.join("")).replace(/Thinking/g, "").replace(/[^A-Za-z0-9]/g, "");
		assert.ok(normalized.includes(token));
	});

	it("preserves overlong ANSI-styled collapsed tokens across wrapped lines", () => {
		const ansiTheme = createAnsiTheme();
		const token = "styledidentifierwithoutbreaks1234567890";
		const steps = deriveThinkingSteps([
			{
				contentIndex: 0,
				text: "Inspect `" + token + "` carefully.",
			},
		]);
		const width = 30;
		const lines = renderThinkingStepsLines(ansiTheme, width, {
			mode: "collapsed",
			steps,
			activeStepId: steps[0]?.id,
			isActive: false,
			nowMs: 0,
		});

		assert.ok(lines.length > 1);
		assertWidthInvariant(lines, width);

		const normalized = stripAnsi(lines.join("")).replace(/Thinking/g, "").replace(/[^A-Za-z0-9]/g, "");
		assert.ok(normalized.includes(token));
	});

	it("keeps an active collapsed pulse glyph visible at narrow wrapped widths", () => {
		const steps = deriveThinkingSteps([
			{
				contentIndex: 0,
				text: "Inspect parse.ts and render.ts to find the regression in collapsed selection.",
			},
		]);
		const width = 33;
		const lines = renderThinkingStepsLines(theme, width, {
			mode: "collapsed",
			steps,
			activeStepId: steps[0]?.id,
			isActive: true,
			nowMs: 180,
		});

		assert.ok(lines.length > 1);
		assertWidthInvariant(lines, width);
		const joined = stripAnsi(lines.join("\n"));
		assert.ok(!joined.includes("..."));
		assert.ok((stripAnsi(lines.at(-1) ?? "")).endsWith(" •"));
	});

	it("keeps collapsed, summary, and expanded output within the requested width", () => {
		const steps = deriveThinkingSteps([
			{
				contentIndex: 0,
				text: `1. Inspect parse.ts, render.ts, and test/thinking-steps.test.ts for UX regressions.

Capture concrete evidence for long-token wrapping and list continuation handling.

2. Verify summarizeThinkingText with comma-heavy prose before applying fixes.`,
			},
		]);
		const width = 44;
		const collapsedLines = renderThinkingStepsLines(theme, width, {
			mode: "collapsed",
			steps,
			activeStepId: steps[0]?.id,
			isActive: false,
			nowMs: 0,
		});
		const summaryLines = renderThinkingStepsLines(theme, width, {
			mode: "summary",
			steps,
			isActive: false,
		});
		const expandedLines = renderThinkingStepsLines(theme, width, {
			mode: "expanded",
			steps,
			isActive: false,
		});

		assertWidthInvariant(collapsedLines, width);
		assertWidthInvariant(summaryLines, width);
		assertWidthInvariant(expandedLines, width);
	});

	it("keeps multi-paragraph list continuations attached to the originating list item", () => {
		const steps = deriveThinkingSteps([
			{
				contentIndex: 0,
				text: "1. Inspect the current renderer implementation.\n\nCapture evidence from narrow-width collapsed output.\n\nDouble-check summary fidelity for comma-heavy prose.\n\n2. Verify the fix with regression tests.",
			},
		]);

		assert.equal(steps.length, 2);
		assert.equal(
			steps[0]?.body,
			"1. Inspect the current renderer implementation.\n\nCapture evidence from narrow-width collapsed output.\n\nDouble-check summary fidelity for comma-heavy prose.",
		);
		assert.equal(steps[1]?.body, "2. Verify the fix with regression tests.");
	});

	it("keeps a trailing list continuation attached to the final list item", () => {
		const steps = deriveThinkingSteps([
			{
				contentIndex: 0,
				text: "1. Inspect the current renderer implementation.\n\nCapture evidence from the final list item before concluding.",
			},
		]);

		assert.equal(steps.length, 1);
		assert.equal(
			steps[0]?.body,
			"1. Inspect the current renderer implementation.\n\nCapture evidence from the final list item before concluding.",
		);
	});

	it("preserves comma-heavy file enumerations without inventing sequential connectors", () => {
		const summary = summarizeThinkingText(
			"I need to inspect parse.ts, render.ts, and test/thinking-steps.test.ts before patching.",
		);

		assert.match(summary, /parse\.ts/i);
		assert.match(summary, /test\/thinking-steps\.test\.ts/i);
		assert.doesNotMatch(summary, /, then/i);
	});

	it("keeps comma-heavy command prose faithful", () => {
		const summary = summarizeThinkingText(
			"Compare npm test, npm run build, and node --import tsx test/thinking-steps.test.ts before concluding.",
		);

		assert.match(summary, /npm test|node --import tsx/i);
		assert.doesNotMatch(summary, /, then/i);
	});
});

describe("scope-aware runtime state", () => {
	it("renders components with the mode captured for their thinking scope", () => {
		resetExtensionState("/scope-a");
		setCurrentThinkingScopeKey("/scope-a");
		setThinkingStepsMode("collapsed", "/scope-a");
		const collapsedComponent = new ThinkingStepsComponent(createPlainTheme(), 401, [{ contentIndex: 0, text: "Inspect the current renderer implementation." }]);

		setCurrentThinkingScopeKey("/scope-b");
		setThinkingStepsMode("expanded", "/scope-b");
		const expandedComponent = new ThinkingStepsComponent(createPlainTheme(), 402, [{ contentIndex: 0, text: "Inspect the current renderer implementation." }]);

		const collapsedLines = collapsedComponent.render(80).map(stripAnsi).join("\n");
		const expandedLines = expandedComponent.render(80).map(stripAnsi).join("\n");

		assert.ok(collapsedLines.includes("Thinking"));
		assert.ok(!collapsedLines.includes("Thinking Steps · Expanded"));
		assert.ok(expandedLines.includes("Thinking Steps · Expanded"));
	});

	it("resolves patched component scope from the message lifecycle owner", async () => {
		const scopeA = "/tmp/pi-thinking-steps-patched-scope-a";
		const scopeB = "/tmp/pi-thinking-steps-patched-scope-b";
		resetExtensionState(scopeA);

		const { pi: piA, ctx: ctxA } = createExtensionHarness([], true, scopeA);
		const { pi: piB, ctx: ctxB } = createExtensionHarness([], true, scopeB);
		const sessionStartA = getSingleHandler(piA, "session_start");
		const sessionStartB = getSingleHandler(piB, "session_start");
		const sessionShutdownA = getSingleHandler(piA, "session_shutdown");
		const sessionShutdownB = getSingleHandler(piB, "session_shutdown");
		const messageUpdateA = getSingleHandler(piA, "message_update");
		const [{ AssistantMessageComponent }, { initTheme }] = await Promise.all([
			importPiCodingAgentInternal<{ AssistantMessageComponent: new (message?: unknown, hideThinkingBlock?: boolean) => { render(width: number): string[] } }>(
				PI_CODING_AGENT_INTERNAL_MODULES.assistantMessageComponent,
			),
			importPiCodingAgentInternal<{ initTheme: (name?: string, quiet?: boolean) => void }>(
				PI_CODING_AGENT_INTERNAL_MODULES.theme,
			),
		]);
		initTheme("dark", true);

		let startedA = false;
		let startedB = false;
		try {
			await sessionStartA({}, ctxA);
			startedA = true;
			await sessionStartB({}, ctxB);
			startedB = true;
			setThinkingStepsMode("collapsed", scopeA);
			setThinkingStepsMode("expanded", scopeB);

			const message = {
				role: "assistant",
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				timestamp: 919,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				content: [{ type: "thinking", thinking: "Inspect alpha scope rendering." }],
			} as const;

			await messageUpdateA({
				message,
				assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
			});
			setCurrentThinkingScopeKey(scopeB);
			const component = new AssistantMessageComponent(message, false);
			const rendered = stripAnsi(component.render(100).join("\n"));

			assert.match(rendered, /Thinking/);
			assert.doesNotMatch(rendered, /Thinking Steps · Expanded/);
			assert.match(rendered, /Inspect alpha scope rendering/);
		} finally {
			if (startedB) await sessionShutdownB({}, ctxB);
			if (startedA) await sessionShutdownA({}, ctxA);
			while (getPatchRefCount() > 0) {
				await sessionShutdownA({}, ctxA);
			}
			resetExtensionState();
		}
	});

	it("rerenders summary and expanded output when the active step changes at the same width", () => {
		const scope = "/scope-cache";
		const trackingTheme: ThinkingThemeLike = {
			fg: (_color, text) => text,
			bold: (text) => `<b>${text}</b>`,
		};
		const blocks = [
			{ contentIndex: 0, text: "Inspect alpha." },
			{ contentIndex: 1, text: "Verify beta." },
		];

		for (const mode of ["summary", "expanded"] as const) {
			resetExtensionState(scope);
			setCurrentThinkingScopeKey(scope);
			setThinkingStepsMode(mode, scope);
			clearActiveThinkingState(undefined, scope);
			const component = new ThinkingStepsComponent(trackingTheme, 777, blocks);

			setActiveThinkingState({ active: true, messageTimestamp: 777, contentIndex: 0 }, scope);
			const firstRender = component.render(80).join("\n");

			setActiveThinkingState({ active: true, messageTimestamp: 777, contentIndex: 1 }, scope);
			const secondRender = component.render(80).join("\n");

			assert.notEqual(secondRender, firstRender);
			assert.match(firstRender, /<b>Inspect alpha\.<\/b>/);
			assert.doesNotMatch(firstRender, /<b>Verify beta\.<\/b>/);
			assert.match(secondRender, /<b>Verify beta\.<\/b>/);
			assert.doesNotMatch(secondRender, /<b>Inspect alpha\.<\/b>/);
		}
	});

	it("keeps reused message objects on their original lifecycle scope", async () => {
		const scopeA = "/tmp/pi-thinking-steps-reused-message-a";
		const scopeB = "/tmp/pi-thinking-steps-reused-message-b";
		resetExtensionState(scopeA);

		const { pi: piA, ctx: ctxA } = createExtensionHarness([], true, scopeA);
		const { pi: piB, ctx: ctxB } = createExtensionHarness([], true, scopeB);
		const sessionStartA = getSingleHandler(piA, "session_start");
		const sessionStartB = getSingleHandler(piB, "session_start");
		const sessionShutdownA = getSingleHandler(piA, "session_shutdown");
		const sessionShutdownB = getSingleHandler(piB, "session_shutdown");
		const messageUpdateA = getSingleHandler(piA, "message_update");
		const messageUpdateB = getSingleHandler(piB, "message_update");
		let startedA = false;
		let startedB = false;

		try {
			await sessionStartA({}, ctxA);
			startedA = true;
			await sessionStartB({}, ctxB);
			startedB = true;
			const message = { role: "assistant", timestamp: 37 };

			await messageUpdateA({
				message,
				assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
			});
			await messageUpdateB({
				message,
				assistantMessageEvent: { type: "thinking_delta", contentIndex: 1 },
			});

			assert.deepEqual(getActiveThinkingState(37, scopeA), { active: true, messageTimestamp: 37, contentIndex: 1 });
			assert.deepEqual(getActiveThinkingState(37, scopeB), { active: false });
		} finally {
			if (startedB) await sessionShutdownB({}, ctxB);
			if (startedA) await sessionShutdownA({}, ctxA);
			while (getPatchRefCount() > 0) {
				await sessionShutdownA({}, ctxA);
			}
			resetExtensionState();
		}
	});

	it("clears message ownership on session shutdown so reused messages can bind to a new scope", async () => {
		const scopeA = "/tmp/pi-thinking-steps-shutdown-rebind-a";
		const scopeB = "/tmp/pi-thinking-steps-shutdown-rebind-b";
		resetExtensionState(scopeA);

		const { pi: piA, ctx: ctxA } = createExtensionHarness([], true, scopeA);
		const { pi: piB, ctx: ctxB } = createExtensionHarness([], true, scopeB);
		const sessionStartA = getSingleHandler(piA, "session_start");
		const sessionStartB = getSingleHandler(piB, "session_start");
		const sessionShutdownA = getSingleHandler(piA, "session_shutdown");
		const sessionShutdownB = getSingleHandler(piB, "session_shutdown");
		const messageUpdateA = getSingleHandler(piA, "message_update");
		const messageUpdateB = getSingleHandler(piB, "message_update");
		let startedA = false;
		let startedB = false;

		try {
			await sessionStartA({}, ctxA);
			startedA = true;
			const message = { role: "assistant", timestamp: 73 };

			await messageUpdateA({
				message,
				assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
			});
			assert.deepEqual(getActiveThinkingState(73, scopeA), { active: true, messageTimestamp: 73, contentIndex: 0 });

			await sessionShutdownA({}, ctxA);
			startedA = false;

			await sessionStartB({}, ctxB);
			startedB = true;
			await messageUpdateB({
				message,
				assistantMessageEvent: { type: "thinking_delta", contentIndex: 1 },
			});

			assert.deepEqual(getActiveThinkingState(73, scopeA), { active: false });
			assert.deepEqual(getActiveThinkingState(73, scopeB), { active: true, messageTimestamp: 73, contentIndex: 1 });
		} finally {
			if (startedB) await sessionShutdownB({}, ctxB);
			if (startedA) await sessionShutdownA({}, ctxA);
			while (getPatchRefCount() > 0) {
				await sessionShutdownB({}, ctxB);
			}
			resetExtensionState();
		}
	});
	it("thinkingStepsExtension scopes duplicate message timestamps per extension instance", async () => {
	const scopeA = "/tmp/pi-thinking-steps-scope-a";
	const scopeB = "/tmp/pi-thinking-steps-scope-b";
	resetExtensionState(scopeA);

	const { pi: piA, ctx: ctxA } = createExtensionHarness([], true, scopeA);
	const { pi: piB, ctx: ctxB } = createExtensionHarness([], true, scopeB);

	const sessionStartA = getSingleHandler(piA, "session_start");
	const sessionStartB = getSingleHandler(piB, "session_start");
	const messageUpdateA = getSingleHandler(piA, "message_update");
	const messageUpdateB = getSingleHandler(piB, "message_update");

	await sessionStartA({}, ctxA);
	await sessionStartB({}, ctxB);
	setThinkingStepsMode("collapsed", scopeA);
	setThinkingStepsMode("collapsed", scopeB);

	await messageUpdateA({
		message: { role: "assistant", timestamp: 7 },
		assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
	});
	await messageUpdateB({
		message: { role: "assistant", timestamp: 7 },
		assistantMessageEvent: { type: "thinking_start", contentIndex: 1 },
	});

	setCurrentThinkingScopeKey(scopeA);
	const componentA = new ThinkingStepsComponent(createPlainTheme(), 7, [
		{ contentIndex: 0, text: "Inspect alpha" },
		{ contentIndex: 1, text: "Verify alpha" },
	]);
	setCurrentThinkingScopeKey(scopeB);
	const componentB = new ThinkingStepsComponent(createPlainTheme(), 7, [
		{ contentIndex: 0, text: "Inspect beta" },
		{ contentIndex: 1, text: "Verify beta" },
	]);

	const renderedA = stripAnsi(componentA.render(80).join("\n"));
	const renderedB = stripAnsi(componentB.render(80).join("\n"));

	assert.match(renderedA, /Inspect alpha/);
	assert.doesNotMatch(renderedA, /Verify alpha/);
	assert.match(renderedB, /Verify beta/);
});

	it("thinkingStepsExtension clears active thinking within the owning scope only", async () => {
	const scopeA = "/tmp/pi-thinking-steps-scope-a";
	const scopeB = "/tmp/pi-thinking-steps-scope-b";
	resetExtensionState(scopeA);

	const { pi: piA, ctx: ctxA } = createExtensionHarness([], true, scopeA);
	const { pi: piB, ctx: ctxB } = createExtensionHarness([], true, scopeB);

	const sessionStartA = getSingleHandler(piA, "session_start");
	const sessionStartB = getSingleHandler(piB, "session_start");
	const messageUpdateA = getSingleHandler(piA, "message_update");
	const messageUpdateB = getSingleHandler(piB, "message_update");
	const messageEndA = getSingleHandler(piA, "message_end");

	await sessionStartA({}, ctxA);
	await sessionStartB({}, ctxB);
	setThinkingStepsMode("collapsed", scopeA);
	setThinkingStepsMode("collapsed", scopeB);

	await messageUpdateA({
		message: { role: "assistant", timestamp: 11 },
		assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
	});
	await messageUpdateB({
		message: { role: "assistant", timestamp: 11 },
		assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
	});
	await messageEndA({
		message: { role: "assistant", timestamp: 11 },
	});

	setCurrentThinkingScopeKey(scopeA);
	const componentA = new ThinkingStepsComponent(createPlainTheme(), 11, [
		{ contentIndex: 0, text: "Inspect alpha" },
		{ contentIndex: 1, text: "Verify alpha" },
	]);
	setCurrentThinkingScopeKey(scopeB);
	const componentB = new ThinkingStepsComponent(createPlainTheme(), 11, [
		{ contentIndex: 0, text: "Inspect beta" },
		{ contentIndex: 1, text: "Verify beta" },
	]);

	const renderedA = stripAnsi(componentA.render(80).join("\n"));
	const renderedB = stripAnsi(componentB.render(80).join("\n"));

	assert.match(renderedA, /Verify alpha/);
	assert.match(renderedB, /Inspect beta/);
	assert.doesNotMatch(renderedB, /Verify beta/);
});
});

describe("Batch 2 regressions", () => {
	it("splits a standalone concluding paragraph after list items into its own step", () => {
		const steps = deriveThinkingSteps([
			{
				contentIndex: 0,
				text: "1. Inspect parse.ts.\n\n2. Update render.ts.\n\nThat should confirm the fix.",
			},
		]);

		assert.equal(steps.length, 3);
		assert.equal(steps[0]?.body, "1. Inspect parse.ts.");
		assert.equal(steps[1]?.body, "2. Update render.ts.");
		assert.equal(steps[2]?.body, "That should confirm the fix.");
	});

	it("preserves ordered list markers in expanded rendering", () => {
		const steps = deriveThinkingSteps([
			{
				contentIndex: 0,
				text: "1. Inspect `render.ts`.\n\n2. Verify that refreshes can be triggered safely.",
			},
		]);
		const lines = renderThinkingStepsLines(createPlainTheme(), 100, {
			mode: "expanded",
			steps,
			isActive: false,
		});
		const joined = stripAnsi(lines.join("\n"));

		assert.match(joined, /1\. Inspect render\.ts\./);
		assert.match(joined, /2\. Verify that refreshes can be triggered safely\./);
		assert.doesNotMatch(joined, /• Inspect render\.ts\./);
		assert.doesNotMatch(joined, /• Verify that refreshes can be triggered safely\./);
	});
});

describe("repo metadata contracts", () => {
	it("keeps published files, pinned Pi dependencies, docs, and archived prompts aligned", async () => {
		const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
			version: string;
			main: string;
			files: string[];
			pi?: { extensions?: string[] };
			scripts: Record<string, string>;
			license: string;
			dependencies: Record<string, string>;
			devDependencies: Record<string, string>;
		};
		const packageLock = JSON.parse(await readFile("package-lock.json", "utf8")) as {
			version: string;
			packages?: Record<string, { version?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>;
		};
		for (const file of packageJson.files) {
			await assert.doesNotReject(readFile(file, "utf8"));
		}
		assert.ok(packageJson.files.includes("tsconfig.json"));
		assert.ok(packageJson.files.includes("test/thinking-steps.test.ts"));
		assert.ok(packageJson.files.includes("test/summarizer-challenger.test.ts"));
		assert.equal(packageJson.version, packageLock.version);
		assert.equal(packageJson.version, packageLock.packages?.[""]?.version);
		assert.equal(packageJson.main, "index.ts");
		assert.deepEqual(packageJson.pi?.extensions, ["./index.ts"]);
		assert.ok(packageJson.files.includes(packageJson.main));
		for (const extension of packageJson.pi?.extensions ?? []) {
			assert.ok(packageJson.files.includes(extension.replace(/^\.\//, "")));
		}
		assert.equal(packageJson.scripts.build, "tsc --noEmit");
		assert.match(packageJson.scripts.test, /^npm run build && /);
		assert.match(packageJson.scripts.test, /node --import tsx test\/thinking-steps\.test\.ts/);
		assert.match(packageJson.scripts.test, /node --import tsx test\/summarizer-challenger\.test\.ts/);
		assert.ok(packageJson.scripts.test.indexOf("test/thinking-steps.test.ts") < packageJson.scripts.test.indexOf("test/summarizer-challenger.test.ts"));
		assert.equal(packageJson.license, "MIT");
		assert.equal(packageJson.dependencies["@mariozechner/pi-ai"], "0.69.0");
		assert.equal(packageJson.dependencies["@mariozechner/pi-coding-agent"], "0.69.0");
		assert.equal(packageJson.dependencies["@mariozechner/pi-tui"], "0.69.0");
		assert.equal(packageJson.devDependencies["@mariozechner/pi-ai"], undefined);
		assert.equal(packageJson.devDependencies["@mariozechner/pi-coding-agent"], undefined);
		assert.equal(packageJson.devDependencies["@mariozechner/pi-tui"], undefined);
		assert.deepEqual(packageLock.packages?.[""]?.dependencies, packageJson.dependencies);
		assert.ok(!Object.values(packageJson.dependencies).includes("latest"));
		assert.ok(!Object.values(packageJson.devDependencies).includes("latest"));

		const license = await readFile("LICENSE", "utf8");
		assert.ok(license.includes("MIT License"));

		const readme = await readFile("README.md", "utf8");
		assert.ok(readme.includes("[MIT License](./LICENSE)"));
		assert.ok(readme.includes("badge/license-MIT"));
		assert.ok(readme.includes(`releases/tag/v${packageJson.version}`));
		assert.ok(readme.includes(`release-v${packageJson.version}`));
		assert.ok(readme.includes("retained patch releases are scope-owned"));
		assert.ok(readme.includes("assistant message ownership is recorded"));
		assert.ok(readme.includes("`tsconfig.json`"));
		assert.ok(readme.includes("published validation tests under `test/`"));

		const agents = await readFile("AGENTS.md", "utf8");
		assert.ok(agents.includes("project clear"));
		assert.ok(agents.includes("global clear"));
		assert.ok(agents.includes("session -> project -> global -> summary"));
		assert.ok(agents.includes(`## Current Version\n${packageJson.version}`));
		assert.ok(agents.includes("plan.md"));
		assert.ok(agents.includes("progress.md"));
		assert.ok(agents.includes("tracked `CHANGELOG.md`"));
		assert.ok(!agents.includes("currently has **no `CHANGELOG.md`"));
		assert.ok(!agents.includes("summarization-algorithm.md"));

		const progress = await readFile("progress.md", "utf8");
		assert.ok(progress.includes("Non-authoritative placeholder"));
		assert.ok(progress.includes("Larra sessions"));

		const plan = await readFile("plan.md", "utf8");
		assert.ok(plan.includes("Historical/non-authoritative placeholder"));
		assert.ok(plan.includes("completed in `v1.0.10`"));
		assert.ok(plan.includes("CHANGELOG.md"));

		const leftoverPrompt = await readFile("prompts/fix-leftover-issues_v1-0-0.md", "utf8");
		assert.ok(leftoverPrompt.includes("planning/"));
		assert.ok(!leftoverPrompt.includes("plannig/"));

		const typesSource = await readFile("types.ts", "utf8");
		assert.ok(typesSource.includes("export type PersistedThinkingStepsPreferenceScope"));
		const persistenceSource = await readFile("persistence.ts", "utf8");
		assert.ok(!persistenceSource.includes("export type PersistedThinkingStepsPreferenceScope"));
		assert.ok(persistenceSource.includes("import type { PersistedThinkingStepsPreferenceScope, ThinkingStepsMode } from \"./types.js\""));
		const indexSource = await readFile("index.ts", "utf8");
		assert.ok(indexSource.includes("import type { PersistedThinkingStepsPreferenceScope, ThinkingStepsMode } from \"./types.js\""));

		const archivedContinuePrompt = await readFile("prompts/continue-2026-04-16.md", "utf8");
		assert.ok(archivedContinuePrompt.includes("Historical continuation prompt") || archivedContinuePrompt.includes("Archived continue prompt"));
		assert.ok(archivedContinuePrompt.includes("do **not** treat any git/tag/push/clean-tree statements below as current repo truth"));

		const auditPromptV2 = await readFile("prompts/audit/generalized-deep-audit_v2-0-0.md", "utf8");
		assert.ok(auditPromptV2.includes("Canonical generalized audit prompt"));
		assert.ok(auditPromptV2.includes("CHANGELOG.md"));
		assert.ok(auditPromptV2.includes("plan.md"));
		assert.ok(auditPromptV2.includes("progress.md"));
		assert.ok(!auditPromptV2.includes("summarization-algorithm.md"));

		const auditPromptV1 = await readFile("prompts/audit/full-codebase-audit-v1.0.0.md", "utf8");
		assert.ok(auditPromptV1.includes("Superseded / historical prompt"));
		assert.ok(auditPromptV1.includes("generalized-deep-audit_v2-0-0.md"));
	});
});
