import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { buildThinkingExport } from "./export.js";
import type { ThinkingExportNode, ThinkingExportScope, ThinkingExportSnapshot, ThinkingReviewGroup, ThinkingReviewView, ThinkingReviewViewerOptions, ThinkingThemeLike } from "./types.js";

export function safeReviewText(text: string): string {
	return text.replace(/[\x00-\x09\x0B-\x1F\x7F-\x9F\u202A-\u202E\u2066-\u2069]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function wrapReviewText(text: string, width: number): string[] {
	if (width < 1) return [];
	const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	return safeReviewText(text).split("\n").flatMap((line) => {
		const lines: string[] = [];
		let current = "";
		let columns = 0;
		for (const { segment } of segmenter.segment(line)) {
			const size = visibleWidth(segment);
			const pieces = size > width ? Array.from(Array.from(segment, (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`).join("")) : [segment];
			for (const piece of pieces) {
				const count = visibleWidth(piece);
				if (columns + count > width) { lines.push(current); current = ""; columns = 0; }
				current += piece; columns += count;
			}
		}
		lines.push(current);
		return lines;
	});
}

export function buildThinkingReviewGroups(snapshot: ThinkingExportSnapshot): ThinkingReviewGroup[] {
	const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
	const groups = new Map<string | null, ThinkingReviewGroup>();
	for (const node of snapshot.nodes) if (node.role === "user") groups.set(node.id, { prompt: node, responses: [] });
	for (const node of snapshot.nodes) {
		if (node.role !== "assistant") continue;
		let parentId = node.parentId;
		const seen = new Set<string>();
		while (parentId !== null && byId.get(parentId)?.role !== "user") {
			if (seen.has(parentId) || !byId.has(parentId)) throw new Error("Invalid thinking review ancestry.");
			seen.add(parentId);
			parentId = byId.get(parentId)!.parentId;
		}
		const group: ThinkingReviewGroup = groups.get(parentId) ?? { responses: [] };
		group.responses.push(node);
		groups.set(parentId, group);
	}
	return [...groups.values()];
}

export function thinkingReviewText(prompt: ThinkingExportNode | undefined, response: ThinkingExportNode, view: ThinkingReviewView = "all"): string {
	const lines = view === "all" ? ["Prompt", prompt?.text ?? "No recorded prompt text.", "", `Response · ${response.id}`, response.text || "No assistant response text.", ""] : [`Response · ${response.id}`, ""];
	if (view !== "steps") {
		lines.push("Available thinking · verbatim source (terminal controls escaped)");
		const blocks = response.thinkingBlocks ?? [];
		if (blocks.length === 0) lines.push("No thinking content supplied.");
		for (const block of blocks) lines.push(`Block ${block.contentIndex}${block.text.length === 0 && !block.redacted ? " · empty" : ""}`, block.redacted ? "Reasoning is hidden by the provider." : block.text, "");
	}
	if (view !== "verbatim") {
		lines.push("Derived steps (formatted interpretation, not additional source text)");
		if (!response.steps?.length) lines.push("No derived thinking steps.");
		for (const [index, step] of (response.steps ?? []).entries()) lines.push(`${index + 1}. ${step.summary}`, step.body, "");
	}
	return safeReviewText(lines.join("\n"));
}

export class ThinkingReviewViewer implements Component {
	private offset = 0;
	private pageSize = 1;
	private lines: string[] = [];
	private cachedWidth = -1;
	private view: ThinkingReviewView;
	private pendingJump: number | undefined;
	constructor(private text: string, private theme: ThinkingThemeLike, private rows: () => number, private requestRender: () => void, private done: () => void, private options: ThinkingReviewViewerOptions = {}) {
		this.view = options.initialView ?? "all";
		this.pendingJump = options.jumpToLine;
	}
	invalidate(): void { this.cachedWidth = -1; }
	render(width: number): string[] {
		if (width < 1) return [];
		this.pageSize = Math.max(1, this.rows() - 4);
		if (this.cachedWidth !== width) {
			const text = this.options.variants?.[this.view] ?? this.text;
			this.lines = this.options.layout?.(width) ?? wrapReviewText(text, width);
			if (this.pendingJump !== undefined) {
				this.offset = text.split("\n").slice(0, this.pendingJump).reduce((count, line) => count + wrapReviewText(line, width).length, 0);
				this.pendingJump = undefined;
			}
			this.cachedWidth = width;
		}
		this.offset = Math.min(this.offset, Math.max(0, this.lines.length - this.pageSize));
		const toggles = this.options.variants ? ` · ${this.view} · v source / s steps / a all` : "";
		return [
			truncateToWidth(this.theme.fg("accent", `${this.options.title ?? "Thinking review · read only"}${toggles}`), width),
			...this.lines.slice(this.offset, this.offset + this.pageSize).map((line) => truncateToWidth(line, width)),
			truncateToWidth(this.theme.fg("muted", `${this.offset + 1}/${this.lines.length} · ↑↓ PgUp/PgDn Home/End · Esc back`), width),
		];
	}
	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { this.done(); return; }
		if (this.options.variants && ["v", "s", "a"].includes(data)) {
			this.view = data === "v" ? "verbatim" : data === "s" ? "steps" : "all";
			this.offset = 0; this.invalidate(); this.requestRender(); return;
		}
		if (matchesKey(data, Key.up)) this.offset -= 1;
		else if (matchesKey(data, Key.down)) this.offset += 1;
		else if (matchesKey(data, Key.pageUp)) this.offset -= this.pageSize;
		else if (matchesKey(data, Key.pageDown)) this.offset += this.pageSize;
		else if (matchesKey(data, Key.home)) this.offset = 0;
		else if (matchesKey(data, Key.end)) this.offset = this.lines.length;
		else return;
		this.offset = Math.max(0, Math.min(this.offset, Math.max(0, this.lines.length - this.pageSize)));
		this.requestRender();
	}
}

export async function openThinkingReview(ctx: ExtensionContext, scope: ThinkingExportScope, view: ThinkingReviewView = "all"): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error("Thinking review browser requires Pi's interactive terminal; use export in other modes.");
	const manager = ctx.sessionManager;
	const snapshot = buildThinkingExport(manager.getEntries(), manager.getSessionId(), manager.getLeafId(), undefined, { scope });
	const groups = buildThinkingReviewGroups(snapshot);
	if (groups.length === 0) { ctx.ui.notify("No recorded prompts or responses to review.", "info"); return; }
	const preview = (text: string) => truncateToWidth(safeReviewText(text).replace(/\n/g, " "), 80);
	const prompts = groups.map((group, index) => `${index + 1}. ${preview(group.prompt?.text ?? "No recorded prompt")} (${group.responses.length} responses)`);
	while (manager.getSessionId() === snapshot.sessionId) {
		const chosenPrompt = await ctx.ui.select(`Thinking review · ${scope} · choose prompt`, prompts);
		if (chosenPrompt === undefined || manager.getSessionId() !== snapshot.sessionId) return;
		const group = groups[prompts.indexOf(chosenPrompt)];
		if (!group) throw new Error("Unknown review prompt selection.");
		if (group.responses.length === 0) { ctx.ui.notify("No assistant responses recorded for this prompt.", "info"); continue; }
		const responses = group.responses.map((node, index) => `${index + 1}. ${preview(node.text || "No response text")} · ${preview(node.id)}`);
		while (manager.getSessionId() === snapshot.sessionId) {
			const chosenResponse = await ctx.ui.select("Choose response (Esc returns to prompts)", responses);
			if (chosenResponse === undefined) break;
			if (manager.getSessionId() !== snapshot.sessionId) return;
			const response = group.responses[responses.indexOf(chosenResponse)];
			if (!response) throw new Error("Unknown review response selection.");
			const variants = { all: thinkingReviewText(group.prompt, response), verbatim: thinkingReviewText(group.prompt, response, "verbatim"), steps: thinkingReviewText(group.prompt, response, "steps") };
			await ctx.ui.custom<void>((tui, theme, _keys, done) => new ThinkingReviewViewer(
				variants.all, theme, () => tui.terminal.rows, () => tui.requestRender(), () => done(), { variants, initialView: view },
			));
		}
	}
}
