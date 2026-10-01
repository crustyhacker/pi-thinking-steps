import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { deriveThinkingSteps } from "./parse.js";
import type { ThinkingExportAttachment, ThinkingExportFormat, ThinkingExportNode, ThinkingExportSnapshot } from "./types.js";

export function buildThinkingExport(
	entries: readonly SessionEntry[],
	sessionId: string,
	leafId: string | null,
	exportedAt = new Date().toISOString(),
): ThinkingExportSnapshot {
	const nodes: ThinkingExportNode[] = entries.map((entry) => {
		const node: ThinkingExportNode = {
			id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp, entryType: entry.type,
		};
		if (entry.type !== "message") return node;
		const message = entry.message;
		node.role = message.role;
		if (message.role === "user") {
			node.text = typeof message.content === "string" ? message.content
				: message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
			node.imageCount = typeof message.content === "string" ? 0 : message.content.filter((part) => part.type === "image").length;
		} else if (message.role === "assistant") {
			node.provider = message.provider;
			node.model = message.model;
			node.text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
			node.thinkingBlocks = message.content.flatMap((part, contentIndex) => part.type === "thinking"
				? [{ contentIndex, text: part.redacted ? "" : part.thinking, redacted: part.redacted === true }]
				: []);
			node.steps = deriveThinkingSteps(node.thinkingBlocks);
		}
		return node;
	});
	const snapshot: ThinkingExportSnapshot = { schemaVersion: 1, sessionId, leafId, exportedAt, scope: "all-recorded-branches", nodes };
	orderedTree(snapshot);
	return snapshot;
}

function orderedTree(snapshot: ThinkingExportSnapshot): Array<{ node: ThinkingExportNode; depth: number }> {
	const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
	if (byId.size !== snapshot.nodes.length) throw new Error("Cannot export a session tree with duplicate entry IDs.");
	if (snapshot.leafId !== null && !byId.has(snapshot.leafId)) throw new Error("Cannot export: the current session leaf is missing.");
	const children = new Map<string | null, ThinkingExportNode[]>();
	for (const node of snapshot.nodes) {
		if (node.parentId !== null && !byId.has(node.parentId)) throw new Error(`Cannot export: missing parent for entry ${node.id}.`);
		const siblings = children.get(node.parentId) ?? [];
		siblings.push(node);
		children.set(node.parentId, siblings);
	}
	const pending = (children.get(null) ?? []).map((node) => ({ node, depth: 0 })).reverse();
	const ordered: Array<{ node: ThinkingExportNode; depth: number }> = [];
	while (pending.length > 0) {
		const current = pending.pop()!;
		ordered.push(current);
		const descendants = children.get(current.node.id) ?? [];
		for (let i = descendants.length - 1; i >= 0; i -= 1) pending.push({ node: descendants[i]!, depth: current.depth + 1 });
	}
	if (ordered.length !== snapshot.nodes.length) throw new Error("Cannot export a session tree containing a cycle.");
	return ordered;
}

function fencedText(text: string): string {
	const safe = text.replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
	let fenceLength = 3;
	for (const match of safe.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
	const fence = "`".repeat(fenceLength);
	return `${fence}text\n${safe}\n${fence}`;
}

export function renderThinkingExportMarkdown(snapshot: ThinkingExportSnapshot): string {
	const ordered = orderedTree(snapshot);
	const labels = new Map(ordered.map(({ node }, index) => [node.id, `Entry ${index + 1}`]));
	const lines = [
		"# Thinking steps review", "",
		"Local snapshot of all recorded branches, not just the active conversation. Historical content is included; later context edits are not applied.",
		"Only provider-supplied thinking is available. Hidden reasoning, signatures, image bytes, tool payloads, and custom-entry contents are not exported.",
		"JSON preserves original text; Markdown displays terminal control characters as escapes. Treat both as sensitive conversation data.", "",
		"## Session", "", fencedText(JSON.stringify({ sessionId: snapshot.sessionId, leafId: snapshot.leafId, exportedAt: snapshot.exportedAt }, null, 2)), "",
		"## Tree", "",
	];
	for (const { node, depth } of ordered) {
		const label = labels.get(node.id)!;
		const kind = node.role === "user" ? "Prompt" : node.role === "assistant" ? "Assistant" : "Structural entry";
		const parent = node.parentId === null ? "root" : labels.get(node.parentId)!;
		lines.push(`${"  ".repeat(Math.min(depth, 8))}- [${label}](#${label.toLowerCase().replace(" ", "-")}) · ${kind} · parent: ${parent}${node.id === snapshot.leafId ? " · current leaf" : ""}`);
	}
	for (const { node } of ordered) {
		lines.push("", `## ${labels.get(node.id)}`, "", fencedText(JSON.stringify({ id: node.id, parentId: node.parentId, timestamp: node.timestamp, entryType: node.entryType, role: node.role, provider: node.provider, model: node.model }, null, 2)));
		if (node.text !== undefined) lines.push("", node.role === "user" ? "### Prompt" : "### Response", "", fencedText(node.text));
		if (node.imageCount) lines.push("", `Images omitted: ${node.imageCount}.`);
		if (node.role !== "assistant") continue;
		lines.push("", "### Available thinking", "");
		const blocks = node.thinkingBlocks ?? [];
		if (!blocks.some((block) => block.redacted || block.text.trim())) lines.push("No thinking content supplied.");
		for (const block of blocks) {
			lines.push(`Block ${block.contentIndex}:`, "", block.redacted ? "Reasoning is hidden by the provider." : fencedText(block.text), "");
		}
		if (node.steps?.length) lines.push("### Derived steps", "");
		for (const [index, step] of (node.steps ?? []).entries()) {
			lines.push(`#### Step ${index + 1} · block ${step.contentIndex}`, "", fencedText(step.summary), "", fencedText(step.body), "");
		}
	}
	return `${lines.join("\n")}\n`;
}

export async function saveThinkingExport(
	snapshot: ThinkingExportSnapshot,
	sessionFile: string,
	format: ThinkingExportFormat,
): Promise<ThinkingExportAttachment> {
	if (!isAbsolute(sessionFile)) throw new Error("Thinking exports require an absolute, persistent session file path.");
	if (!["json", "markdown", "both"].includes(format)) throw new Error("Unknown thinking export format.");
	const outputs: Array<{ format: "json" | "markdown"; name: string; content: string }> = [];
	if (format !== "markdown") outputs.push({ format: "json", name: "thinking-steps.json", content: `${JSON.stringify(snapshot, null, 2)}\n` });
	if (format !== "json") outputs.push({ format: "markdown", name: "thinking-steps.md", content: renderThinkingExportMarkdown(snapshot) });
	const directory = await mkdtemp(`${sessionFile}.thinking-steps-`);
	try {
		const files: ThinkingExportAttachment["files"] = [];
		for (const output of outputs) {
			const path = join(directory, output.name);
			await writeFile(path, output.content, { encoding: "utf8", mode: 0o600, flag: "wx" });
			files.push({ format: output.format, path });
		}
		return { schemaVersion: 1, sessionId: snapshot.sessionId, leafId: snapshot.leafId, exportedAt: snapshot.exportedAt, files };
	} catch (error) {
		try {
			await rm(directory, { recursive: true, force: true });
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], `Thinking export failed; incomplete files may remain in ${directory}.`);
		}
		throw error;
	}
}
