import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { buildThinkingExport } from "./export.js";
import { buildThinkingReviewGroups, safeReviewText, ThinkingReviewViewer, thinkingReviewText, wrapReviewText } from "./review.js";
import type { ThinkingExportNode, ThinkingExportScope, ThinkingExportSnapshot, ThinkingReviewMatch } from "./types.js";

export function searchThinkingReview(snapshot: ThinkingExportSnapshot, query: string, limit = 200): { matches: ThinkingReviewMatch[]; truncated: boolean } {
	if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid thinking search result limit.");
	const needle = query.trim();
	const matches: ThinkingReviewMatch[] = [];
	if (!needle) return { matches, truncated: false };
	const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
	for (const node of snapshot.nodes) {
		const fields: Array<{ field: ThinkingReviewMatch["field"]; text: string; contentIndex?: number }> = [];
		if (node.role === "user" && node.text !== undefined) fields.push({ field: "prompt", text: node.text });
		if (node.role === "assistant") {
			if (node.text !== undefined) fields.push({ field: "response", text: node.text });
			for (const block of node.thinkingBlocks ?? []) if (!block.redacted) fields.push({ field: "thinking", text: block.text, contentIndex: block.contentIndex });
		}
		for (const field of fields) for (const hit of field.text.matchAll(pattern)) {
			if (matches.length === limit) return { matches, truncated: true };
			const offset = hit.index;
			matches.push({ ...field, nodeId: node.id, line: field.text.slice(0, offset).split("\n").length - 1,
				preview: safeReviewText(field.text.slice(Math.max(0, offset - 25), offset + needle.length + 50)).replace(/\n/g, " ") });
		}
	}
	return { matches, truncated: false };
}

export async function openThinkingSearch(ctx: ExtensionContext, scope: ThinkingExportScope, query?: string): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error("Thinking search requires Pi's interactive terminal.");
	const manager = ctx.sessionManager;
	const sessionId = manager.getSessionId();
	const needle = query ?? await ctx.ui.input("Search recorded prompts, responses, and thinking", "Literal text (case-insensitive)");
	if (!needle?.trim() || manager.getSessionId() !== sessionId) return;
	const snapshot = buildThinkingExport(manager.getEntries(), sessionId, manager.getLeafId(), undefined, { scope });
	const results = searchThinkingReview(snapshot, needle);
	if (results.matches.length === 0) { ctx.ui.notify("No matching recorded text.", "info"); return; }
	if (results.truncated) ctx.ui.notify("Showing the first 200 matches; narrow the query to find more.", "warning");
	const labels = results.matches.map((hit, index) => `${index + 1}. ${hit.field}${hit.contentIndex === undefined ? "" : ` block ${hit.contentIndex}`} · ${safeReviewText(hit.nodeId)}:${hit.line + 1} · ${truncateToWidth(hit.preview, 65)}`);
	while (manager.getSessionId() === sessionId) {
		const selected = await ctx.ui.select(`Thinking search · ${scope}`, labels);
		if (selected === undefined || manager.getSessionId() !== sessionId) return;
		const hit = results.matches[labels.indexOf(selected)];
		if (!hit) throw new Error("Unknown thinking search selection.");
		const text = `${hit.field} · ${safeReviewText(hit.nodeId)}${hit.contentIndex === undefined ? "" : ` · block ${hit.contentIndex}`}\n\n${safeReviewText(hit.text)}`;
		await ctx.ui.custom<void>((tui, theme, _keys, done) => new ThinkingReviewViewer(text, theme, () => tui.terminal.rows, () => tui.requestRender(), () => done(), { title: "Thinking search · source text · read only", jumpToLine: hit.line + 2 }));
	}
}

function alternativeChecker(snapshot: ThinkingExportSnapshot): (left: ThinkingExportNode, right: ThinkingExportNode) => boolean {
	const children = new Map<string | null, ThinkingExportNode[]>();
	for (const node of snapshot.nodes) { const list = children.get(node.parentId) ?? []; list.push(node); children.set(node.parentId, list); }
	const ranges = new Map<string, { start: number; end: number; root: string }>();
	const pending = (children.get(null) ?? []).map((node) => ({ node, root: node.id, exit: false }));
	let clock = 0;
	while (pending.length) {
		const item = pending.pop()!;
		if (item.exit) { ranges.get(item.node.id)!.end = clock++; continue; }
		if (ranges.has(item.node.id)) throw new Error("Invalid comparison tree.");
		ranges.set(item.node.id, { start: clock++, end: 0, root: item.root });
		pending.push({ ...item, exit: true });
		for (const node of children.get(item.node.id) ?? []) pending.push({ node, root: item.root, exit: false });
	}
	if (ranges.size !== snapshot.nodes.length) throw new Error("Invalid comparison tree.");
	return (left, right) => {
		const a = ranges.get(left.id); const b = ranges.get(right.id);
		return left.role === "assistant" && right.role === "assistant" && !!a && !!b && a.root === b.root && (a.end < b.start || b.end < a.start);
	};
}

export function areThinkingAlternatives(snapshot: ThinkingExportSnapshot, left: ThinkingExportNode, right: ThinkingExportNode): boolean {
	return alternativeChecker(snapshot)(left, right);
}

export function renderThinkingComparison(left: ThinkingExportNode, right: ThinkingExportNode, width: number): string[] {
	if (width < 1) return [];
	const text = (node: ThinkingExportNode) => `Entry ${safeReviewText(node.id)}\nResponse\n${safeReviewText(node.text ?? "No response text.")}\n\n${thinkingReviewText(undefined, node, "verbatim")}`;
	if (width < 60) return wrapReviewText(`LEFT\n${text(left)}\n\nRIGHT\n${text(right)}`, width);
	const leftWidth = Math.floor((width - 3) / 2);
	const rightWidth = width - 3 - leftWidth;
	const a = wrapReviewText(`LEFT\n${text(left)}`, leftWidth);
	const b = wrapReviewText(`RIGHT\n${text(right)}`, rightWidth);
	return Array.from({ length: Math.max(a.length, b.length) }, (_, i) => {
		const line = a[i] ?? "";
		return `${line}${" ".repeat(Math.max(0, leftWidth - visibleWidth(line)))} │ ${b[i] ?? ""}`;
	});
}

export async function openThinkingComparison(ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error("Thinking comparison requires Pi's interactive terminal.");
	const manager = ctx.sessionManager;
	const snapshot = buildThinkingExport(manager.getEntries(), manager.getSessionId(), manager.getLeafId());
	const alternatives = alternativeChecker(snapshot);
	const groups = buildThinkingReviewGroups(snapshot).map((group) => ({ ...group, responses: group.responses.filter((left) => group.responses.some((right) => alternatives(left, right))) })).filter((group) => group.responses.length > 1);
	if (!groups.length) { ctx.ui.notify("No alternate branches for the same recorded prompt. Sequential responses on one branch are not alternatives.", "info"); return; }
	const prompts = groups.map((group, i) => `${i + 1}. ${truncateToWidth(safeReviewText(group.prompt?.text ?? "No recorded prompt").replace(/\n/g, " "), 80)}`);
	const chosen = await ctx.ui.select("Compare alternate responses · choose prompt", prompts);
	if (chosen === undefined || manager.getSessionId() !== snapshot.sessionId) return;
	const group = groups[prompts.indexOf(chosen)];
	if (!group) throw new Error("Unknown comparison prompt.");
	const choose = async (title: string, nodes: ThinkingExportNode[]) => {
		const labels = nodes.map((node, i) => `${i + 1}. ${safeReviewText(node.id)} · ${truncateToWidth(safeReviewText(node.text ?? "No response text").replace(/\n/g, " "), 60)}`);
		const selected = await ctx.ui.select(title, labels);
		if (selected === undefined || manager.getSessionId() !== snapshot.sessionId) return undefined;
		const node = nodes[labels.indexOf(selected)];
		if (!node) throw new Error("Unknown comparison response.");
		return node;
	};
	const left = await choose("Left response", group.responses);
	if (!left) return;
	const right = await choose("Right response (alternate branch)", group.responses.filter((node) => alternatives(left, node)));
	if (!right) return;
	await ctx.ui.custom<void>((tui, theme, _keys, done) => new ThinkingReviewViewer("", theme, () => tui.terminal.rows, () => tui.requestRender(), () => done(), { title: "Thinking comparison · read only · stacked below 60 columns", layout: (width) => renderThinkingComparison(left, right, width) }));
}
