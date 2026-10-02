import { constants } from "node:fs";
import { lstat, open, readdir, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { safeReviewText, ThinkingReviewViewer } from "./review.js";
import type { ThinkingExportAttachment, ThinkingExportDeletionPlan, ThinkingSavedExport } from "./types.js";

function attachmentData(value: unknown, sessionId: string): ThinkingExportAttachment {
	if (!value || typeof value !== "object") throw new Error("Invalid export attachment.");
	const data = value as Partial<ThinkingExportAttachment>;
	if (data.schemaVersion !== 1 || data.sessionId !== sessionId || typeof data.exportedAt !== "string"
		|| !(data.leafId === null || typeof data.leafId === "string") || !Array.isArray(data.files) || data.files.length < 1 || data.files.length > 2
		|| (data.automatic !== undefined && typeof data.automatic !== "boolean")) throw new Error("Invalid or foreign-session export attachment.");
	const files = data.files.map((file) => {
		if (!file || (file.format !== "json" && file.format !== "markdown") || typeof file.path !== "string") throw new Error("Invalid export file metadata.");
		return { format: file.format, path: file.path };
	});
	return { schemaVersion: 1, sessionId, leafId: data.leafId, exportedAt: data.exportedAt, automatic: data.automatic === true, files };
}

function ownedDirectory(data: ThinkingExportAttachment, sessionFile: string): string {
	if (!isAbsolute(sessionFile)) throw new Error("Export management requires an absolute persistent session path.");
	const directory = dirname(data.files[0]!.path);
	const prefix = `${basename(sessionFile)}.thinking-steps-${data.automatic ? "auto-" : ""}`;
	if (dirname(directory) !== dirname(sessionFile) || !basename(directory).startsWith(prefix)
		|| !/^[A-Za-z0-9]{6}$/.test(basename(directory).slice(prefix.length))) throw new Error("Export path is outside this session's managed snapshot directories.");
	for (const file of data.files) {
		const name = file.format === "json" ? "thinking-steps.json" : "thinking-steps.md";
		if (!isAbsolute(file.path) || resolve(file.path) !== file.path || dirname(file.path) !== directory || basename(file.path) !== name) throw new Error("Unsafe export file path.");
	}
	if (new Set(data.files.map((file) => file.path)).size !== data.files.length) throw new Error("Duplicate export paths.");
	return directory;
}

function missing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function prepareThinkingExportDeletion(value: unknown, sessionFile: string, sessionId: string): Promise<ThinkingExportDeletionPlan | undefined> {
	const data = attachmentData(value, sessionId);
	const directory = ownedDirectory(data, sessionFile);
	let info;
	try { info = await lstat(directory); } catch (error) { if (missing(error)) return undefined; throw error; }
	if (!info.isDirectory()) throw new Error("Refusing symbolic-link or non-directory export storage.");
	const expected = data.files.map((file) => basename(file.path));
	if (data.automatic) expected.push("autosave.json");
	const names = (await readdir(directory)).sort();
	const identity = (stat: Awaited<ReturnType<typeof lstat>>) => ({ dev: stat.dev, ino: stat.ino, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs });
	const fingerprints: Array<{ name: string; identity: ReturnType<typeof identity> }> = [];
	for (const name of names) {
		if (!expected.includes(name)) throw new Error(`Unexpected file in snapshot: ${safeReviewText(name)}. Nothing was deleted.`);
		const stat = await lstat(join(directory, name));
		if (!stat.isFile()) throw new Error("Refusing symbolic-link or non-regular export files.");
		fingerprints.push({ name, identity: identity(stat) });
	}
	if (data.automatic) {
		const marker = await open(join(directory, "autosave.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const stat = await marker.stat();
			const expectedStat = fingerprints.find((file) => file.name === "autosave.json")?.identity;
			if (!stat.isFile() || stat.size > 4096 || JSON.stringify(identity(stat)) !== JSON.stringify(expectedStat)) throw new Error("Automatic export marker changed or is invalid.");
			const owner = JSON.parse(await marker.readFile("utf8")) as { schemaVersion?: unknown; sessionId?: unknown; files?: unknown } | null;
			if (!owner || owner.schemaVersion !== 1 || owner.sessionId !== sessionId || !Array.isArray(owner.files)
				|| JSON.stringify([...owner.files].sort()) !== JSON.stringify(data.files.map((file) => basename(file.path)).sort())) throw new Error("Invalid automatic export ownership marker.");
		} finally { await marker.close(); }
	}
	return { directory, files: names.map((name) => join(directory, name)), fingerprint: JSON.stringify({ directory: identity(info), files: fingerprints }) };
}

export async function listThinkingExports(entries: readonly SessionEntry[], sessionFile: string, sessionId: string): Promise<ThinkingSavedExport[]> {
	const results: ThinkingSavedExport[] = [];
	for (const entry of [...entries].reverse()) {
		if (entry.type !== "custom" || entry.customType !== "thinking-steps.export") continue;
		try {
			const attachment = attachmentData(entry.data, sessionId);
			const plan = await prepareThinkingExportDeletion(attachment, sessionFile, sessionId);
			const present = attachment.files.filter((file) => plan?.files.includes(file.path)).length;
			const status = present === 0 ? "missing" : present === attachment.files.length ? "available" : "partial";
			results.push({ entryId: entry.id, attachment, status, detail: status === "missing" ? "Files are missing (possibly pruned, deleted, or moved)." : `${present}/${attachment.files.length} export files present.` });
		} catch (error) {
			results.push({ entryId: entry.id, status: "unsafe", detail: error instanceof Error ? error.message : String(error) });
		}
	}
	return results;
}

export async function deleteThinkingExport(value: unknown, sessionFile: string, sessionId: string, approved: ThinkingExportDeletionPlan): Promise<void> {
	const current = await prepareThinkingExportDeletion(value, sessionFile, sessionId);
	if (!current || JSON.stringify(current) !== JSON.stringify(approved)) throw new Error("Snapshot changed after selection; nothing was deleted. Select it again.");
	const deleted: string[] = [];
	const original = JSON.parse(current.fingerprint) as { directory: { dev: number; ino: number }; files: Array<{ name: string; identity: { dev: number; ino: number; size: number; mtime: number; ctime: number } }> };
	try {
		for (const file of [...current.files].sort((a, b) => Number(basename(a) === "autosave.json") - Number(basename(b) === "autosave.json"))) {
			const info = await lstat(current.directory);
			if (!info.isDirectory() || info.dev !== original.directory.dev || info.ino !== original.directory.ino) throw new Error("Snapshot directory changed during deletion.");
			const stat = await lstat(file);
			const identity = { dev: stat.dev, ino: stat.ino, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs };
			if (!stat.isFile() || JSON.stringify(identity) !== JSON.stringify(original.files.find((entry) => entry.name === basename(file))?.identity)) throw new Error("Snapshot file changed during deletion.");
			await unlink(file); deleted.push(file);
		}
		await rmdir(current.directory);
	} catch (error) {
		throw new Error(`Export deletion stopped: ${error instanceof Error ? error.message : String(error)}. Deleted ${deleted.length} file(s): ${deleted.map(safeReviewText).join(", ") || "none"}. Inspect the snapshot before retrying.`);
	}
}

export async function openThinkingExports(ctx: ExtensionContext, available: () => boolean = () => true): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error("Export management requires Pi's interactive terminal.");
	const manager = ctx.sessionManager;
	const sessionId = manager.getSessionId();
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Export management requires a persistent session.");
	const current = () => manager.getSessionId() === sessionId && manager.getSessionFile() === sessionFile;
	while (current()) {
		const records = await listThinkingExports(manager.getEntries(), sessionFile, sessionId);
		if (!current()) return;
		if (!records.length) { ctx.ui.notify("No session-linked thinking exports recorded.", "info"); return; }
		const labels = records.map((record, i) => `${i + 1}. ${record.status} · ${safeReviewText(record.attachment?.exportedAt ?? record.entryId)} · ${record.attachment?.automatic ? "automatic" : "manual"}`);
		const selection = await ctx.ui.select("Thinking exports · missing links may have expired", labels);
		if (selection === undefined || !current()) return;
		const record = records[labels.indexOf(selection)];
		if (!record) throw new Error("Unknown export selection.");
		const action = await ctx.ui.select(safeReviewText(record.detail), record.attachment && record.status !== "unsafe" && record.status !== "missing" ? ["Inspect paths", "Delete snapshot"] : ["Inspect paths"]);
		if (!current()) return;
		if (action === "Inspect paths") {
			const text = safeReviewText(`${record.status}\n${record.detail}\nEntry: ${record.entryId}\n${record.attachment?.files.map((file) => `${file.format}: ${file.path}`).join("\n") ?? "No safe attachment metadata."}`);
			await ctx.ui.custom<void>((tui, theme, _keys, done) => new ThinkingReviewViewer(text, theme, () => tui.terminal.rows, () => tui.requestRender(), () => done(), { title: "Thinking export paths · read only" }));
		} else if (action === "Delete snapshot" && record.attachment) {
			if (!ctx.isIdle() || !available()) throw new Error("Wait for the response and automatic export to finish before deleting snapshots.");
			const plan = await prepareThinkingExportDeletion(record.attachment, sessionFile, sessionId);
			if (!plan) throw new Error("Snapshot no longer exists; reopen the export manager.");
			const leaf = manager.getLeafId();
			const confirmed = await ctx.ui.confirm("Permanently delete this thinking snapshot?", safeReviewText(`${plan.files.join("\n")}\nOnly these snapshot files and their empty directory will be removed. Session history is unchanged; its links will show as missing. This cannot be undone.`));
			if (!confirmed) continue;
			if (!current() || manager.getLeafId() !== leaf || !ctx.isIdle() || !available()) throw new Error("Session changed while confirming deletion; nothing was deleted.");
			await deleteThinkingExport(record.attachment, sessionFile, sessionId, plan);
			ctx.ui.notify("Selected thinking snapshot deleted. Session history was preserved.", "info");
		}
	}
}
