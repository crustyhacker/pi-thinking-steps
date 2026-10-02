import { lstat, readFile, readdir, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildThinkingExport, saveThinkingExport } from "./export.js";
import type { ThinkingAutosaveSettings } from "./types.js";

export const THINKING_AUTOSAVE_ENTRY = "thinking-steps.autosave";

export function parseThinkingAutosaveSettings(parts: readonly string[]): ThinkingAutosaveSettings | undefined {
	if (parts.length > 4) return undefined;
	const [format = "json", scope = "branch", keep = "10", content = "thinking"] = parts;
	if (!["json", "markdown", "both"].includes(format) || !["branch", "all"].includes(scope)
		|| !/^\d+$/.test(keep) || Number(keep) < 1 || Number(keep) > 50 || !["thinking", "conversation"].includes(content)) return undefined;
	return {
		format: format as ThinkingAutosaveSettings["format"], scope: scope === "branch" ? "current-branch" : "all-recorded-branches",
		keep: Number(keep), content: content === "thinking" ? "thinking-only" : "conversation",
	};
}

export function readThinkingAutosaveSettings(entries: readonly SessionEntry[], sessionId: string): ThinkingAutosaveSettings | undefined {
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i]!;
		if (entry.type !== "custom" || entry.customType !== THINKING_AUTOSAVE_ENTRY) continue;
		const data = entry.data as { schemaVersion?: unknown; sessionId?: unknown; settings?: unknown } | null;
		if (!data || typeof data !== "object") throw new Error("Invalid thinking autosave settings; run /thinking-steps autosave off to reset.");
		if (data.sessionId !== sessionId) continue;
		if (data.schemaVersion !== 1) throw new Error("Unsupported thinking autosave settings version.");
		if (data.settings === null) return undefined;
		const settings = data.settings as Partial<ThinkingAutosaveSettings> | null;
		if (!settings || typeof settings !== "object" || !["json", "markdown", "both"].includes(settings.format ?? "")
			|| !["current-branch", "all-recorded-branches"].includes(settings.scope ?? "")
			|| !Number.isInteger(settings.keep) || settings.keep! < 1 || settings.keep! > 50
			|| !["thinking-only", "conversation"].includes(settings.content ?? "")) throw new Error("Invalid thinking autosave settings; run /thinking-steps autosave off to reset.");
		return { format: settings.format!, scope: settings.scope!, keep: settings.keep!, content: settings.content! };
	}
	return undefined;
}

export async function pruneThinkingAutoExports(sessionFile: string, sessionId: string, keep: number, newestDirectory: string): Promise<void> {
	if (!isAbsolute(sessionFile) || !Number.isInteger(keep) || keep < 1 || keep > 50) throw new Error("Invalid automatic export retention options.");
	const parent = dirname(sessionFile);
	const prefix = `${basename(sessionFile)}.thinking-steps-auto-`;
	const candidates: Array<{ path: string; files: string[]; modified: number; ino: number; dev: number }> = [];
	for (const entry of await readdir(parent, { withFileTypes: true })) {
		if (!entry.name.startsWith(prefix) || !/^[A-Za-z0-9]{6}$/.test(entry.name.slice(prefix.length))) continue;
		const path = join(parent, entry.name);
		if (!entry.isDirectory()) throw new Error(`Refusing retention cleanup of non-directory: ${path}`);
		const info = await lstat(path);
		if (!info.isDirectory()) throw new Error(`Autosave directory changed before retention: ${path}`);
		const files = await readdir(path);
		for (const file of files) {
			if (!["autosave.json", "thinking-steps.json", "thinking-steps.md"].includes(file) || !(await lstat(join(path, file))).isFile()) {
				throw new Error(`Refusing retention cleanup of unexpected content in ${path}`);
			}
		}
		const marker = JSON.parse(await readFile(join(path, "autosave.json"), "utf8")) as { schemaVersion?: unknown; sessionId?: unknown; files?: unknown } | null;
		if (!marker || typeof marker !== "object") throw new Error(`Invalid autosave ownership marker in ${path}`);
		if (marker.sessionId !== sessionId) continue;
		if (marker.schemaVersion !== 1 || !Array.isArray(marker.files) || marker.files.length < 1 || marker.files.length > 2
			|| !marker.files.every((file: unknown) => file === "thinking-steps.json" || file === "thinking-steps.md")
			|| new Set(marker.files).size !== marker.files.length || files.length !== marker.files.length + 1
			|| !marker.files.every((file: string) => files.includes(file))) throw new Error(`Invalid autosave ownership marker in ${path}`);
		candidates.push({ path, files, modified: info.mtimeMs, ino: info.ino, dev: info.dev });
	}
	candidates.sort((a, b) => a.path === newestDirectory ? -1 : b.path === newestDirectory ? 1 : b.modified - a.modified || a.path.localeCompare(b.path));
	for (const candidate of candidates.slice(keep)) {
		const info = await lstat(candidate.path);
		if (!info.isDirectory() || info.ino !== candidate.ino || info.dev !== candidate.dev) throw new Error(`Autosave directory changed during retention: ${candidate.path}`);
		const files = await readdir(candidate.path);
		if (files.length !== candidate.files.length || !files.every((file) => candidate.files.includes(file))) throw new Error(`Autosave files changed during retention: ${candidate.path}`);
		for (const file of files) if (!(await lstat(join(candidate.path, file))).isFile()) throw new Error(`Autosave file changed during retention: ${join(candidate.path, file)}`);
		for (const file of files.filter((file) => file !== "autosave.json")) await unlink(join(candidate.path, file));
		await unlink(join(candidate.path, "autosave.json"));
		await rmdir(candidate.path);
	}
}

export async function runThinkingAutosave(pi: ExtensionAPI, ctx: ExtensionContext, isCurrent: () => boolean): Promise<void> {
	const manager = ctx.sessionManager;
	const entries = manager.getEntries();
	if (!entries.some((entry) => entry.type === "custom" && entry.customType === THINKING_AUTOSAVE_ENTRY)) return;
	const sessionId = manager.getSessionId();
	const settings = readThinkingAutosaveSettings(entries, sessionId);
	if (!settings) return;
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Automatic export requires a persistent session.");
	const branch = manager.getBranch();
	const assistant = [...branch].reverse().find((entry) => entry.type === "message" && entry.message.role === "assistant");
	if (!assistant || assistant.type !== "message" || assistant.message.role !== "assistant" || ["error", "aborted"].includes(assistant.message.stopReason)) return;
	if (branch.some((entry) => entry.type === "custom" && entry.customType === "thinking-steps.export"
		&& entry.data && typeof entry.data === "object" && (entry.data as { automatic?: unknown }).automatic === true
		&& (entry.data as { sourceAssistantId?: unknown }).sourceAssistantId === assistant.id)) return;
	const snapshot = buildThinkingExport(entries, sessionId, manager.getLeafId(), undefined, settings);
	const attachment = await saveThinkingExport(snapshot, sessionFile, settings.format, true);
	const paths = attachment.files.map((file) => file.path).join("\n");
	if (!isCurrent() || manager.getSessionId() !== sessionId || manager.getSessionFile() !== sessionFile || manager.getLeafId() !== snapshot.leafId) {
		throw new Error(`Automatic export saved, but the session or settings changed; files were not attached:\n${paths}`);
	}
	try {
		pi.appendEntry("thinking-steps.export", { ...attachment, sourceAssistantId: assistant.id });
	} catch (error) {
		throw new Error(`Automatic export saved, but attachment failed: ${error instanceof Error ? error.message : String(error)}\nFiles:\n${paths}`);
	}
	try {
		await pruneThinkingAutoExports(sessionFile, sessionId, settings.keep, dirname(attachment.files[0]!.path));
	} catch (error) {
		throw new Error(`Automatic export saved and attached, but retention failed: ${error instanceof Error ? error.message : String(error)}\nFiles:\n${paths}`);
	}
	ctx.ui.notify(`Automatic thinking review saved (${snapshot.scope}, ${settings.content}; keep ${settings.keep}):\n${paths}`, "info");
}
