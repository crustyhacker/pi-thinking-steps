import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { Key } from "@earendil-works/pi-tui";
import { retainThinkingStepsPatch } from "./internal-patch.js";
import { clearThinkingStepsModePreference, readThinkingStepsModePreference, writeThinkingStepsModePreference } from "./persistence.js";
import { parseThinkingMode } from "./parse.js";
import { clearActiveThinkingState, clearThinkingMessageOwnership, getCurrentThinkingScopeKey, getThinkingStepsMode, nextThinkingRefreshLabel, recordThinkingMessageScope, registerThinkingPatchRelease, resolveThinkingMessageScope, setActiveThinkingState, setCurrentThinkingScopeKey, setThinkingStepsMode, takeThinkingPatchRelease } from "./state.js";
import type { PersistedThinkingStepsPreferenceScope, ThinkingAutosaveSettings, ThinkingExportFormat, ThinkingExportScope, ThinkingStepsMode } from "./types.js";
import { parseThinkingAutosaveSettings, readThinkingAutosaveSettings, runThinkingAutosave, THINKING_AUTOSAVE_ENTRY } from "./autosave.js";
import { openThinkingReview } from "./review.js";
import { buildThinkingExport, saveThinkingExport } from "./export.js";
import { renderThinkingExportFiles } from "./render.js";

async function configureThinkingAutosave(pi: ExtensionAPI, ctx: ExtensionContext, action: "status" | "off" | "on", settings?: ThinkingAutosaveSettings): Promise<boolean> {
	const manager = ctx.sessionManager;
	const sessionId = manager.getSessionId();
	if (action === "status") {
		const current = readThinkingAutosaveSettings(manager.getEntries(), sessionId);
		notifyUser(ctx, current ? `Thinking autosave: on · ${current.format} · ${current.scope} · keep ${current.keep} · ${current.content} (this session, TUI only)` : "Thinking autosave: off (default).", "info");
		return false;
	}
	if (!ctx.isIdle()) throw new Error("Wait for the current response to finish before changing autosave settings.");
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Thinking autosave requires a persistent session.");
	if (action === "on") {
		if (!settings) throw new Error("Missing thinking autosave settings.");
		if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error("Enable autosave from Pi's interactive terminal to confirm local storage and retention.");
		const leafId = manager.getLeafId();
		const confirmed = await ctx.ui.confirm("Enable thinking autosave for this session?", `${settings.format} · ${settings.scope} · ${settings.content} · retain ${settings.keep} automatic snapshots.\nSensitive provider-supplied thinking will be written beside the session file after completed agent runs. Thinking may quote prompts or responses even in thinking-only mode. Old automatic snapshots are deleted; manual exports are never pruned. Nothing is uploaded. New/forked sessions start off.`);
		if (!confirmed) return false;
		if (!ctx.isIdle() || manager.getSessionId() !== sessionId || manager.getSessionFile() !== sessionFile || manager.getLeafId() !== leafId) throw new Error("Session changed while confirming autosave; settings were not saved.");
	}
	pi.appendEntry(THINKING_AUTOSAVE_ENTRY, { schemaVersion: 1, sessionId, settings: action === "off" ? null : settings });
	notifyUser(ctx, action === "off" ? "Thinking autosave: off. Existing export files were kept." : "Thinking autosave enabled for this session; exports begin after the next completed agent run.", "info");
	return true;
}

type ThinkingStepsCommandScope = "session" | PersistedThinkingStepsPreferenceScope;
type ThinkingStepsCommandAction =
	| { type: "set"; scope: ThinkingStepsCommandScope; mode?: ThinkingStepsMode }
	| { type: "clear"; scope: PersistedThinkingStepsPreferenceScope }
	| { type: "export"; format: ThinkingExportFormat; exportScope: ThinkingExportScope }
	| { type: "review"; exportScope: ThinkingExportScope }
	| { type: "autosave"; action: "status" | "off" | "on"; settings?: ThinkingAutosaveSettings };

const CUSTOM_ENTRY_TYPE = "thinking-steps.mode";
const DEFAULT_HIDDEN_LABEL = "Thinking...";
const MODE_OPTIONS: ThinkingStepsMode[] = ["collapsed", "summary", "expanded"];
const SCOPE_OPTIONS: PersistedThinkingStepsPreferenceScope[] = ["project", "global"];

function modeStatusText(ctx: ExtensionContext, mode: ThinkingStepsMode): string {
	return `${ctx.ui.theme.fg("muted", "thinking:")} ${ctx.ui.theme.fg("accent", mode)}`;
}

function modeChangeMessage(mode: ThinkingStepsMode, scope: ThinkingStepsCommandScope): string {
	if (scope === "session") {
		return `Thinking view: ${mode}`;
	}

	return `Thinking view: ${mode} (saved for ${scope})`;
}

function invalidUsageMessage(): string {
	return "Usage: /thinking-steps [collapsed|summary|expanded] | [project|global] [collapsed|summary|expanded|clear] | export [json|markdown|both] [branch|all] | review [branch|all] | autosave [status|off] | autosave on [json|markdown|both] [branch|all] [keep:1-50] [thinking|conversation]";
}

function notifyUser(ctx: ExtensionContext, message: string, level: "info" | "warning"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
		return;
	}

	if (level === "warning") {
		console.warn(message);
		return;
	}

	console.info(message);
}

function persistMode(pi: ExtensionAPI, mode: ThinkingStepsMode): void {
	pi.appendEntry(CUSTOM_ENTRY_TYPE, { mode });
}

async function readRestoredModePreference(
	ctx: ExtensionContext,
	scope: PersistedThinkingStepsPreferenceScope,
): Promise<ThinkingStepsMode | undefined> {
	try {
		return await readThinkingStepsModePreference(scope, ctx.cwd);
	} catch (error) {
		reportPersistenceError(ctx, error);
		return undefined;
	}
}

async function restoreMode(ctx: ExtensionContext): Promise<ThinkingStepsMode> {
	const entries = ctx.sessionManager.getEntries() as Array<{ type?: string; customType?: string; data?: { mode?: string } }>;
	const savedEntries = entries.filter((entry) => entry.type === "custom" && entry.customType === CUSTOM_ENTRY_TYPE);
	for (let index = savedEntries.length - 1; index >= 0; index -= 1) {
		const sessionMode = parseThinkingMode(savedEntries[index]?.data?.mode ?? "");
		if (sessionMode) return sessionMode;
	}

	const projectMode = await readRestoredModePreference(ctx, "project");
	if (projectMode) return projectMode;

	const globalMode = await readRestoredModePreference(ctx, "global");
	return globalMode ?? "summary";
}

function refreshThinkingUI(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	setCurrentThinkingScopeKey(ctx.cwd);
	ctx.ui.setHiddenThinkingLabel(nextThinkingRefreshLabel(DEFAULT_HIDDEN_LABEL, ctx.cwd));
	ctx.ui.setStatus("thinking-steps", modeStatusText(ctx, getThinkingStepsMode(ctx.cwd)));
}

function applyMode(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	mode: ThinkingStepsMode,
	options?: { persistSession?: boolean; announceScope?: ThinkingStepsCommandScope },
): void {
	setCurrentThinkingScopeKey(ctx.cwd);
	setThinkingStepsMode(mode, ctx.cwd);
	if (options?.persistSession !== false) {
		persistMode(pi, mode);
	}
	refreshThinkingUI(ctx);
	if (options?.announceScope) {
		notifyUser(ctx, modeChangeMessage(mode, options.announceScope), "info");
	}
}

function cycleMode(current: ThinkingStepsMode): ThinkingStepsMode {
	if (current === "collapsed") return "summary";
	if (current === "summary") return "expanded";
	return "collapsed";
}

function parsePreferenceScope(input: string): PersistedThinkingStepsPreferenceScope | undefined {
	const normalized = input.trim().toLowerCase();
	if (["project", "proj", "p"].includes(normalized)) return "project";
	if (["global", "user", "g"].includes(normalized)) return "global";
	return undefined;
}

function isClearCommand(input: string): boolean {
	return ["clear", "reset"].includes(input.trim().toLowerCase());
}

function parseCommandAction(args: string): ThinkingStepsCommandAction | undefined {
	const trimmed = args.trim();
	if (!trimmed) return { type: "set", scope: "session" };
	const parts = trimmed.toLowerCase().split(/\s+/);
	if (parts[0] === "export") {
		const format = parts[1];
		const scope = parts[2] ?? "all";
		return parts.length >= 2 && parts.length <= 3 && (format === "json" || format === "markdown" || format === "both") && (scope === "branch" || scope === "all")
			? { type: "export", format, exportScope: scope === "branch" ? "current-branch" : "all-recorded-branches" } : undefined;
	}
	if (parts[0] === "review") {
		const scope = parts[1] ?? "branch";
		return parts.length <= 2 && (scope === "branch" || scope === "all")
			? { type: "review", exportScope: scope === "branch" ? "current-branch" : "all-recorded-branches" } : undefined;
	}
	if (parts[0] === "autosave") {
		const action = parts[1] ?? "status";
		if ((action === "status" || action === "off") && parts.length <= 2) return { type: "autosave", action };
		if (action !== "on") return undefined;
		const settings = parseThinkingAutosaveSettings(parts.slice(2));
		return settings ? { type: "autosave", action, settings } : undefined;
	}
	const scope = parsePreferenceScope(parts[0] ?? "");
	if (!scope) {
		const mode = parseThinkingMode(trimmed);
		return mode ? { type: "set", scope: "session", mode } : undefined;
	}
	const tail = trimmed.replace(/^\S+\s*/, "");
	if (!tail) return { type: "set", scope };
	if (isClearCommand(tail)) return { type: "clear", scope };
	const mode = parseThinkingMode(tail);
	return mode ? { type: "set", scope, mode } : undefined;
}

function buildCompletionItems(values: string[], prefix: string, prefixText = ""): AutocompleteItem[] | null {
	const normalizedPrefix = prefix.trim().toLowerCase();
	const items = values
		.filter((value) => value.startsWith(normalizedPrefix))
		.map((value) => ({ value: `${prefixText}${value}`, label: value }));
	return items.length > 0 ? items : null;
}

function thinkingModeCompletions(prefix: string): AutocompleteItem[] | null {
	const parts = prefix.trimStart().toLowerCase().split(/\s+/);
	const root = [...MODE_OPTIONS, ...SCOPE_OPTIONS, "export", "review", "autosave"];
	if (parts.length === 1) return buildCompletionItems(root, parts[0] ?? "");
	const head = parts[0];
	const tail = parts.at(-1) ?? "";
	const before = `${parts.slice(0, -1).join(" ")} `;
	if (head === "export") {
		if (parts.length === 2) return buildCompletionItems(["json", "markdown", "both"], tail, before);
		if (parts.length === 3 && ["json", "markdown", "both"].includes(parts[1]!)) return buildCompletionItems(["branch", "all"], tail, before);
		return null;
	}
	if (head === "review") return parts.length === 2 ? buildCompletionItems(["branch", "all"], tail, before) : null;
	if (head === "autosave") {
		if (parts.length === 2) return buildCompletionItems(["on", "off", "status"], tail, before);
		if (parts[1] !== "on") return null;
		const options = [["json", "markdown", "both"], ["branch", "all"], ["1", "5", "10", "20", "50"], ["thinking", "conversation"]];
		if (parts.length > 6 || !parseThinkingAutosaveSettings(parts.slice(2, -1))) return null;
		return buildCompletionItems(options[parts.length - 3]!, tail, before);
	}
	const scope = parsePreferenceScope(head ?? "");
	if (!scope) return null;
	return buildCompletionItems([...MODE_OPTIONS, "clear"], parts.slice(1).join(" "), `${scope} `);
}

async function selectMode(ctx: ExtensionContext): Promise<ThinkingStepsMode | undefined> {
	if (!ctx.hasUI) {
		return undefined;
	}

	const choice = await ctx.ui.select("Thinking view", MODE_OPTIONS);
	return choice ? parseThinkingMode(choice) : undefined;
}

function reportPersistenceError(ctx: ExtensionContext, error: unknown): void {
	notifyUser(ctx, `Thinking steps persistence error: ${error instanceof Error ? error.message : String(error)}`, "warning");
}

function reportPatchError(ctx: ExtensionContext, error: unknown): void {
	notifyUser(ctx, `Thinking steps patch error: ${error instanceof Error ? error.message : String(error)}`, "warning");
}

async function exportThinkingSteps(pi: ExtensionAPI, ctx: ExtensionContext, format: ThinkingExportFormat, scope: ThinkingExportScope): Promise<void> {
	if (!ctx.isIdle()) {
		notifyUser(ctx, "Wait for the current response to finish before exporting thinking steps.", "warning");
		return;
	}
	const manager = ctx.sessionManager;
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) {
		notifyUser(ctx, "Thinking export requires a persistent session; this session has no file.", "warning");
		return;
	}
	try {
		const snapshot = buildThinkingExport(manager.getEntries(), manager.getSessionId(), manager.getLeafId(), undefined, { scope });
		const attachment = await saveThinkingExport(snapshot, sessionFile, format);
		const paths = attachment.files.map((file) => file.path).join("\n");
		if (manager.getSessionId() !== snapshot.sessionId || manager.getSessionFile() !== sessionFile || manager.getLeafId() !== snapshot.leafId || !ctx.isIdle()) {
			notifyUser(ctx, `Thinking export saved, but the session changed; files were not attached:\n${paths}`, "warning");
			return;
		}
		try {
			pi.appendEntry("thinking-steps.export", attachment);
		} catch (error) {
			notifyUser(ctx, `Thinking export saved, but attaching it failed: ${error instanceof Error ? error.message : String(error)}\nFiles:\n${paths}`, "warning");
			return;
		}
		notifyUser(ctx, `Saved thinking review (${scope === "current-branch" ? "current branch" : "all recorded branches"}):\n${paths}`, "info");
	} catch (error) {
		notifyUser(ctx, `Thinking export failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
	}
}

export default function thinkingStepsExtension(pi: ExtensionAPI): void {
	pi.registerEntryRenderer("thinking-steps.export", (entry, _options, theme) => renderThinkingExportFiles(entry.data, theme));
	let sessionScopeKey = getCurrentThinkingScopeKey();
	const degradedSessionScopes = new Set<string>();
	let autosaveEpoch = 0;
	let autosaveRunning = false;
	const setSessionScopeKey = (scopeKey: string): string => {
		sessionScopeKey = scopeKey;
		setCurrentThinkingScopeKey(scopeKey);
		return sessionScopeKey;
	};
	const markSessionDegraded = (scopeKey: string, degraded: boolean): void => {
		if (degraded) {
			degradedSessionScopes.add(scopeKey);
			return;
		}
		degradedSessionScopes.delete(scopeKey);
	};
	const isSessionDegraded = (scopeKey: string): boolean => degradedSessionScopes.has(scopeKey);
	const degradedSessionMessage = (): string => "Thinking steps is using Pi's native thinking renderer for this session; live mode switching is disabled.";
	const futureCompatibleSessionMessage = (scope: PersistedThinkingStepsPreferenceScope, action: "saved" | "cleared"): string => `${action === "saved" ? "Saved" : "Cleared"} ${scope} thinking view default for future compatible sessions; the current session is using Pi's native thinking renderer.`;

	pi.registerCommand("thinking-steps", {
		description: "Switch thinking view, review prompts/responses, export, or configure session autosave",
		getArgumentCompletions: thinkingModeCompletions,
		handler: async (args, ctx) => {
			const action = parseCommandAction(args);
			if (!action) {
				notifyUser(ctx, invalidUsageMessage(), "warning");
				return;
			}

			if (action.type === "export") {
				await exportThinkingSteps(pi, ctx, action.format, action.exportScope);
				return;
			}
			if (action.type === "review") {
				try { await openThinkingReview(ctx, action.exportScope); }
				catch (error) { notifyUser(ctx, `Thinking review failed: ${error instanceof Error ? error.message : String(error)}`, "warning"); }
				return;
			}
			if (action.type === "autosave") {
				try { if (await configureThinkingAutosave(pi, ctx, action.action, action.settings)) autosaveEpoch += 1; }
				catch (error) { notifyUser(ctx, `Thinking autosave settings failed: ${error instanceof Error ? error.message : String(error)}`, "warning"); }
				return;
			}
			const degraded = isSessionDegraded(ctx.cwd);
			if (action.type === "clear") {
				try {
					await clearThinkingStepsModePreference(action.scope, ctx.cwd);
				} catch (error) {
					reportPersistenceError(ctx, error);
					return;
				}

				if (degraded) {
					notifyUser(ctx, futureCompatibleSessionMessage(action.scope, "cleared"), "info");
					return;
				}

				refreshThinkingUI(ctx);
				notifyUser(ctx, `Cleared ${action.scope} thinking view default`, "info");
				return;
			}

			const selectedMode = action.mode ?? (await selectMode(ctx));
			if (!selectedMode) {
				return;
			}

			if (action.scope !== "session") {
				try {
					await writeThinkingStepsModePreference(action.scope, ctx.cwd, selectedMode);
				} catch (error) {
					reportPersistenceError(ctx, error);
					return;
				}
			}

			if (degraded) {
				if (action.scope === "session") {
					notifyUser(ctx, degradedSessionMessage(), "warning");
					return;
				}
				notifyUser(ctx, futureCompatibleSessionMessage(action.scope, "saved"), "info");
				return;
			}

			applyMode(pi, ctx, selectedMode, { announceScope: action.scope });
		},
	});

	pi.registerShortcut(Key.alt("t"), {
		description: "Cycle thinking view (collapsed, summary, expanded)",
		handler: async (ctx) => {
			if (isSessionDegraded(ctx.cwd)) {
				notifyUser(ctx, degradedSessionMessage(), "warning");
				return;
			}
			const nextMode = cycleMode(getThinkingStepsMode(ctx.cwd));
			applyMode(pi, ctx, nextMode, { announceScope: "session" });
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		autosaveEpoch += 1;
		const activeScopeKey = setSessionScopeKey(ctx.cwd);
		clearActiveThinkingState(undefined, activeScopeKey);
		if (ctx.mode === "tui") {
			try {
				registerThinkingPatchRelease(activeScopeKey, await retainThinkingStepsPatch(ctx.ui.theme));
				markSessionDegraded(activeScopeKey, false);
			} catch (error) {
				markSessionDegraded(activeScopeKey, true);
				reportPatchError(ctx, error);
				notifyUser(ctx, degradedSessionMessage(), "warning");
				return;
			}
		}

		const restoredMode = await restoreMode(ctx);
		applyMode(pi, ctx, restoredMode, { persistSession: false });
	});

	pi.on("message_start", async (event) => {
		if (event.message.role === "assistant") {
			recordThinkingMessageScope(event.message, sessionScopeKey);
			const ownerScopeKey = resolveThinkingMessageScope(event.message, sessionScopeKey);
			const timestamp = typeof (event.message as { timestamp?: unknown }).timestamp === "number"
				? (event.message as { timestamp: number }).timestamp
				: undefined;
			clearActiveThinkingState(timestamp, ownerScopeKey);
		}
	});

	pi.on("message_update", async (event) => {
		if (event.message.role !== "assistant") return;
		recordThinkingMessageScope(event.message, sessionScopeKey);
		const ownerScopeKey = resolveThinkingMessageScope(event.message, sessionScopeKey);
		const assistantEvent = event.assistantMessageEvent;
		if (assistantEvent.type === "thinking_start" || assistantEvent.type === "thinking_delta") {
			setActiveThinkingState({
				active: true,
				messageTimestamp: event.message.timestamp,
				contentIndex: assistantEvent.contentIndex,
			}, ownerScopeKey);
			return;
		}

		if (
			assistantEvent.type === "thinking_end" ||
			assistantEvent.type === "text_start" ||
			assistantEvent.type === "text_delta" ||
			assistantEvent.type === "text_end" ||
			assistantEvent.type === "toolcall_start" ||
			assistantEvent.type === "toolcall_delta" ||
			assistantEvent.type === "toolcall_end"
		) {
			clearActiveThinkingState(event.message.timestamp, ownerScopeKey);
		}
	});

	pi.on("message_end", async (event) => {
		if (event.message.role === "assistant") {
			recordThinkingMessageScope(event.message, sessionScopeKey);
			const ownerScopeKey = resolveThinkingMessageScope(event.message, sessionScopeKey);
			const timestamp = typeof (event.message as { timestamp?: unknown }).timestamp === "number"
				? (event.message as { timestamp: number }).timestamp
				: undefined;
			clearActiveThinkingState(timestamp, ownerScopeKey);
		}
	});

	pi.on("agent_end", async (_event, ctx) => {
		clearActiveThinkingState(undefined, sessionScopeKey);
		if (ctx.mode !== "tui" || !ctx.hasUI || autosaveRunning) return;
		const epoch = autosaveEpoch;
		autosaveRunning = true;
		try { await runThinkingAutosave(pi, ctx, () => autosaveEpoch === epoch); }
		catch (error) { notifyUser(ctx, `Thinking autosave failed: ${error instanceof Error ? error.message : String(error)}`, "warning"); }
		finally { autosaveRunning = false; }
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		autosaveEpoch += 1;
		const activeScopeKey = setSessionScopeKey(ctx.cwd);
		clearActiveThinkingState(undefined, activeScopeKey);
		clearThinkingMessageOwnership(activeScopeKey);
		markSessionDegraded(activeScopeKey, false);
		if (ctx.hasUI) {
			ctx.ui.setStatus("thinking-steps", undefined);
		}

		const releasePatch = takeThinkingPatchRelease(activeScopeKey);
		if (!releasePatch) {
			return;
		}

		try {
			await releasePatch();
		} catch (error) {
			registerThinkingPatchRelease(activeScopeKey, releasePatch);
			reportPatchError(ctx, error);
		}
	});
}
