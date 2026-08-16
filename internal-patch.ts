import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AssistantMessage, ThinkingContent } from "@mariozechner/pi-ai";
import { Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { decrementPatchRefCount, getPatchCleanup, getPatchInstallPromise, incrementPatchRefCount, resolveThinkingMessageScope, setPatchCleanup, setPatchInstallPromise } from "./state.js";
import { ThinkingStepsComponent } from "./render.js";
import type { ThinkingSourceBlock, ThinkingThemeLike } from "./types.js";

export const PI_CODING_AGENT_INTERNAL_MODULES = {
	assistantMessageComponent: "dist/modes/interactive/components/assistant-message.js",
	theme: "dist/modes/interactive/theme/theme.js",
	markdownTransform: "dist/modes/interactive/components/markdown-transform.js",
} as const;

/** Render state owned by the host AssistantMessageComponent (pi >= 0.84). */
interface HostRenderState {
	isStreaming?: boolean;
	outputPad?: number;
	markdownTransformers?: unknown[];
}

/** Creates the markdown transform pi applies to assistant/user messages (mermaid, LaTeX, ...). */
type CreateMarkdownTransform = (
	messageType: string,
	isStreaming: boolean,
	transformers: unknown[],
) => (markdown: string, context: unknown) => string;

/**
 * Markdown in Pi >= 0.84 accepts an options bag with a `transform` hook (markdown
 * transformers, e.g. mermaid/LaTeX). The pinned Pi typings only declare the legacy
 * 4-5 argument constructor, so widen it at this single call site.
 */
const MarkdownWithTransform = Markdown as unknown as new (
	text: string,
	paddingX: number,
	paddingY: number,
	theme: unknown,
	defaultTextStyle: unknown,
	options?: { transform?: (markdown: string, context: unknown) => string },
) => InstanceType<typeof Markdown>;

interface AssistantMessageComponentPrototype {
	updateContent(message: AssistantMessage): void;
	setHideThinkingBlock(hide: boolean): void;
	setHiddenThinkingLabel(label: string): void;
	contentContainer: {
		clear(): void;
		addChild(component: unknown): void;
	};
	lastMessage?: AssistantMessage;
	hideThinkingBlock: boolean;
	markdownTheme: unknown;
	hiddenThinkingLabel: string;
}

export function assertPatchableAssistantMessageComponent(value: unknown): { prototype: AssistantMessageComponentPrototype } {
	if (!value || (typeof value !== "function" && typeof value !== "object")) {
		throw new Error("Thinking Steps patch failed: AssistantMessageComponent export is missing or invalid.");
	}

	const prototype = (value as { prototype?: unknown }).prototype;
	if (!prototype || typeof prototype !== "object") {
		throw new Error("Thinking Steps patch failed: AssistantMessageComponent.prototype is missing.");
	}

	const candidate = prototype as Record<string, unknown>;
	const missingMethods = ["updateContent", "setHideThinkingBlock", "setHiddenThinkingLabel"].filter((name) => typeof candidate[name] !== "function");
	if (missingMethods.length > 0) {
		throw new Error(`Thinking Steps patch failed: AssistantMessageComponent prototype is incompatible (missing ${missingMethods.join(", ")}).`);
	}

	return value as { prototype: AssistantMessageComponentPrototype };
}

export function assertThinkingStepsTheme(value: unknown): ThinkingThemeLike {
	if (!value || typeof value !== "object") {
		throw new Error("Thinking Steps patch failed: interactive theme export is missing or invalid.");
	}

	try {
		const candidate = value as Record<string, unknown>;
		if (typeof candidate.fg !== "function" || typeof candidate.bold !== "function") {
			throw new Error("Thinking Steps patch failed: interactive theme export is incompatible.");
		}
	} catch (error) {
		if (error instanceof Error && /Theme not initialized/.test(error.message)) {
			return value as ThinkingThemeLike;
		}
		throw error;
	}

	return value as ThinkingThemeLike;
}

function hasPatchableContentContainer(value: AssistantMessageComponentPrototype): boolean {
	return Boolean(
		value.contentContainer
		&& typeof value.contentContainer.clear === "function"
		&& typeof value.contentContainer.addChild === "function",
	);
}

function fallbackToOriginalUpdateContent(
	instance: AssistantMessageComponentPrototype,
	message: AssistantMessage,
	originalUpdateContent: (message: AssistantMessage) => void,
): void {
	try {
		originalUpdateContent.call(instance, message);
	} catch (error) {
		throw new Error("Thinking Steps patch failed: Pi internals are incompatible and fallback rendering also failed.", { cause: error });
	}
}

function getPackageRoot(packageName: string): string {
	let entryUrl: string;
	try {
		entryUrl = import.meta.resolve(packageName);
	} catch (error) {
		throw new Error(`Thinking Steps patch failed: could not resolve ${packageName} package root. Pi internals may be unavailable or moved.`, {
			cause: error,
		});
	}

	try {
		const entryPath = fileURLToPath(entryUrl);
		return dirname(dirname(entryPath));
	} catch (error) {
		throw new Error(`Thinking Steps patch failed: could not derive ${packageName} package root from ${entryUrl}.`, {
			cause: error,
		});
	}
}

export function resolvePiCodingAgentInternalModuleUrl(relativePath: string): string {
	const packageRoot = getPackageRoot("@mariozechner/pi-coding-agent");
	return pathToFileURL(join(packageRoot, relativePath)).href;
}

export async function importPiCodingAgentInternal<TModule>(relativePath: string): Promise<TModule> {
	const moduleUrl = resolvePiCodingAgentInternalModuleUrl(relativePath);
	try {
		return (await import(moduleUrl)) as TModule;
	} catch (error) {
		throw new Error(`Thinking Steps patch failed: could not import internal module "@mariozechner/pi-coding-agent/${relativePath}". Pi internals may have moved.`, {
			cause: error,
		});
	}
}

function hasVisibleThinking(content: ThinkingContent): boolean {
	return content.redacted === true || content.thinking.trim().length > 0;
}

function collectThinkingBlocks(message: AssistantMessage): ThinkingSourceBlock[] {
	const blocks: ThinkingSourceBlock[] = [];
	message.content.forEach((content, index) => {
		if (content.type !== "thinking") return;
		if (!hasVisibleThinking(content)) return;
		blocks.push({
			contentIndex: index,
			text: content.thinking,
			redacted: content.redacted,
		});
	});
	return blocks;
}

function hasVisibleTextContent(message: AssistantMessage): boolean {
	return message.content.some((content) => content.type === "text" && content.text.trim().length > 0);
}

function hasVisibleThinkingContent(message: AssistantMessage): boolean {
	return message.content.some((content) => content.type === "thinking" && hasVisibleThinking(content));
}

async function installPatch(): Promise<() => void> {
	const [{ AssistantMessageComponent: rawAssistantMessageComponent }, { theme: rawTheme }] = await Promise.all([
		importPiCodingAgentInternal<{ AssistantMessageComponent: unknown }>(
			PI_CODING_AGENT_INTERNAL_MODULES.assistantMessageComponent,
		),
		importPiCodingAgentInternal<{ theme: unknown }>(
			PI_CODING_AGENT_INTERNAL_MODULES.theme,
		),
	]);

	// Pi >= 0.84 ships markdown transformers (mermaid/LaTeX rendering). Load the
	// factory best-effort so the patch keeps working on older pi versions.
	let createMarkdownTransform: CreateMarkdownTransform | null = null;
	try {
		const { createMarkdownTransform: factory } = await importPiCodingAgentInternal<{ createMarkdownTransform: unknown }>(
			PI_CODING_AGENT_INTERNAL_MODULES.markdownTransform,
		);
		if (typeof factory === "function") {
			createMarkdownTransform = factory as CreateMarkdownTransform;
		}
	} catch {
		createMarkdownTransform = null;
	}

	const AssistantMessageComponent = assertPatchableAssistantMessageComponent(rawAssistantMessageComponent);
	const theme = assertThinkingStepsTheme(rawTheme);
	const prototype = AssistantMessageComponent.prototype;
	const originalUpdateContent = prototype.updateContent;
	const originalSetHideThinkingBlock = prototype.setHideThinkingBlock;
	const originalSetHiddenThinkingLabel = prototype.setHiddenThinkingLabel;

	const normalizeHiddenThinkingLabel = (label: string): string => label.replace(/\u2060+$/gu, "");

	const restoreOriginalMethods = (): void => {
		if (prototype.updateContent !== originalUpdateContent) {
			prototype.updateContent = originalUpdateContent;
		}
		if (prototype.setHideThinkingBlock !== originalSetHideThinkingBlock) {
			prototype.setHideThinkingBlock = originalSetHideThinkingBlock;
		}
		if (prototype.setHiddenThinkingLabel !== originalSetHiddenThinkingLabel) {
			prototype.setHiddenThinkingLabel = originalSetHiddenThinkingLabel;
		}
	};

	const withOriginalInstanceMethods = <T>(instance: AssistantMessageComponentPrototype, callback: () => T): T => {
		const ownUpdateContent = Object.prototype.hasOwnProperty.call(instance, "updateContent");
		const ownSetHideThinkingBlock = Object.prototype.hasOwnProperty.call(instance, "setHideThinkingBlock");
		const ownSetHiddenThinkingLabel = Object.prototype.hasOwnProperty.call(instance, "setHiddenThinkingLabel");
		const previousUpdateContent = instance.updateContent;
		const previousSetHideThinkingBlock = instance.setHideThinkingBlock;
		const previousSetHiddenThinkingLabel = instance.setHiddenThinkingLabel;

		instance.updateContent = originalUpdateContent;
		instance.setHideThinkingBlock = originalSetHideThinkingBlock;
		instance.setHiddenThinkingLabel = originalSetHiddenThinkingLabel;

		try {
			return callback();
		} finally {
			if (ownUpdateContent) {
				instance.updateContent = previousUpdateContent;
			} else {
				delete (instance as unknown as Record<string, unknown>).updateContent;
			}

			if (ownSetHideThinkingBlock) {
				instance.setHideThinkingBlock = previousSetHideThinkingBlock;
			} else {
				delete (instance as unknown as Record<string, unknown>).setHideThinkingBlock;
			}

			if (ownSetHiddenThinkingLabel) {
				instance.setHiddenThinkingLabel = previousSetHiddenThinkingLabel;
			} else {
				delete (instance as unknown as Record<string, unknown>).setHiddenThinkingLabel;
			}
		}
	};

	const reportFallback = (stage: string, error: unknown): void => {
		console.warn(`Thinking Steps patch warning: falling back to Pi renderer during ${stage}.`, error);
	};

	const fallbackErrorMessage = "Thinking Steps patch failed: Pi internals are incompatible and fallback rendering also failed.";

	const fallbackToOriginalUpdateContent = (
		instance: AssistantMessageComponentPrototype,
		message: AssistantMessage,
		stage: string,
		originalError?: unknown,
	): void => {
		try {
			withOriginalInstanceMethods(instance, () => {
				originalUpdateContent.call(instance, message);
			});
		} catch (fallbackError) {
			throw new Error(fallbackErrorMessage, {
				cause: originalError ? { patchError: originalError, fallbackError } : fallbackError,
			});
		}

		if (originalError) {
			reportFallback(stage, originalError);
		}
	};

	const fallbackToOriginalSetHideThinkingBlock = (
		instance: AssistantMessageComponentPrototype,
		hide: boolean,
		originalError?: unknown,
	): void => {
		try {
			withOriginalInstanceMethods(instance, () => {
				originalSetHideThinkingBlock.call(instance, hide);
			});
		} catch (fallbackError) {
			throw new Error(fallbackErrorMessage, {
				cause: originalError ? { patchError: originalError, fallbackError } : fallbackError,
			});
		}

		if (originalError) {
			reportFallback("setHideThinkingBlock", originalError);
		}
	};

	const fallbackToOriginalSetHiddenThinkingLabel = (
		instance: AssistantMessageComponentPrototype,
		label: string,
		originalError?: unknown,
	): void => {
		const normalizedLabel = normalizeHiddenThinkingLabel(label);
		try {
			withOriginalInstanceMethods(instance, () => {
				originalSetHiddenThinkingLabel.call(instance, normalizedLabel);
			});
		} catch (fallbackError) {
			throw new Error(fallbackErrorMessage, {
				cause: originalError ? { patchError: originalError, fallbackError } : fallbackError,
			});
		}

		if (originalError) {
			reportFallback("setHiddenThinkingLabel", originalError);
		}
	};

	const patchedUpdateContent = function patchedUpdateContent(
		this: AssistantMessageComponentPrototype,
		message: AssistantMessage,
		isStreaming?: boolean,
	): void {
		this.lastMessage = message;
		const host = this as unknown as HostRenderState;
		if (isStreaming !== undefined) {
			host.isStreaming = isStreaming;
		}
		if (!hasPatchableContentContainer(this)) {
			fallbackToOriginalUpdateContent(this, message, "updateContent");
			return;
		}

		try {
			this.contentContainer.clear();

			const thinkingBlocks = collectThinkingBlocks(message);
			const hasVisibleContent = hasVisibleTextContent(message) || thinkingBlocks.length > 0;
			if (hasVisibleContent) {
				this.contentContainer.addChild(new Spacer(1));
			}

			let renderedThinking = false;
			const hasVisibleTextAfterThinking = (() => {
				const firstThinkingIndex = thinkingBlocks[0]?.contentIndex;
				if (firstThinkingIndex === undefined) return false;
				return message.content.slice(firstThinkingIndex + 1).some((content) => content.type === "text" && content.text.trim().length > 0);
			})();

			for (const content of message.content) {
				if (content.type === "text" && content.text.trim()) {
					// Preserve pi's markdown transformers (mermaid/LaTeX rendering) the same
					// way the native AssistantMessageComponent.updateContent does.
					this.contentContainer.addChild(
						new MarkdownWithTransform(
							content.text.trim(),
							host.outputPad ?? 1,
							0,
							this.markdownTheme as any,
							undefined,
							createMarkdownTransform
								? {
										transform: createMarkdownTransform(
											"assistant",
											host.isStreaming ?? false,
											host.markdownTransformers ?? [],
										),
									}
								: undefined,
						),
					);
					continue;
				}

				if (content.type === "thinking" && thinkingBlocks.length > 0 && !renderedThinking) {
					this.contentContainer.addChild(new ThinkingStepsComponent(theme, message.timestamp, thinkingBlocks, resolveThinkingMessageScope(message)));
					renderedThinking = true;
					if (hasVisibleTextAfterThinking) {
						this.contentContainer.addChild(new Spacer(1));
					}
				}
			}

			const hasToolCalls = message.content.some((content) => content.type === "toolCall");
			if (!hasToolCalls) {
				if (message.stopReason === "aborted") {
					const abortMessage =
						message.errorMessage && message.errorMessage !== "Request was aborted"
							? message.errorMessage
							: "Operation aborted";
					this.contentContainer.addChild(new Spacer(1));
					this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), 1, 0));
				} else if (message.stopReason === "error") {
					const errorMessage = message.errorMessage || "Unknown error";
					this.contentContainer.addChild(new Spacer(1));
					this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMessage}`), 1, 0));
				}
			}
		} catch (error) {
			fallbackToOriginalUpdateContent(this, message, "updateContent", error);
		}
	};

	const patchedSetHideThinkingBlock = function patchedSetHideThinkingBlock(this: AssistantMessageComponentPrototype, hide: boolean): void {
		if (!hasPatchableContentContainer(this)) {
			fallbackToOriginalSetHideThinkingBlock(this, hide);
			return;
		}

		this.hideThinkingBlock = false;
		if (!this.lastMessage) return;
		try {
			this.updateContent(this.lastMessage);
		} catch (error) {
			fallbackToOriginalSetHideThinkingBlock(this, hide, error);
		}
	};

	const patchedSetHiddenThinkingLabel = function patchedSetHiddenThinkingLabel(
		this: AssistantMessageComponentPrototype,
		label: string,
	): void {
		const normalizedLabel = normalizeHiddenThinkingLabel(label);
		if (!hasPatchableContentContainer(this)) {
			fallbackToOriginalSetHiddenThinkingLabel(this, normalizedLabel);
			return;
		}

		this.hiddenThinkingLabel = normalizedLabel;
		if (!this.lastMessage) return;
		try {
			this.updateContent(this.lastMessage);
		} catch (error) {
			fallbackToOriginalSetHiddenThinkingLabel(this, normalizedLabel, error);
		}
	};

	try {
		prototype.updateContent = patchedUpdateContent;
		prototype.setHideThinkingBlock = patchedSetHideThinkingBlock;
		prototype.setHiddenThinkingLabel = patchedSetHiddenThinkingLabel;
	} catch (error) {
		try {
			restoreOriginalMethods();
		} catch (rollbackError) {
			throw new Error("Thinking Steps patch failed: AssistantMessageComponent prototype patching failed and rollback was incomplete.", {
				cause: { installError: error, rollbackError },
			});
		}

		throw new Error("Thinking Steps patch failed: AssistantMessageComponent prototype is incompatible with thinking-steps patching.", { cause: error });
	}

	return () => {
		restoreOriginalMethods();
	};
}

export async function retainThinkingStepsPatch(): Promise<() => Promise<void>> {
	incrementPatchRefCount();
	let cleanup = getPatchCleanup();
	if (!cleanup) {
		const existingInstallPromise = getPatchInstallPromise();
		const installPromise = existingInstallPromise ?? installPatch();
		if (!existingInstallPromise) {
			setPatchInstallPromise(installPromise);
		}

		try {
			cleanup = await installPromise;
			if (!getPatchCleanup()) {
				setPatchCleanup(cleanup);
			}
		} catch (error) {
			decrementPatchRefCount();
			throw error;
		} finally {
			if (getPatchInstallPromise() === installPromise) {
				setPatchInstallPromise(undefined);
			}
		}
	}

	let released = false;
	return async () => {
		if (released) return;

		const refCount = decrementPatchRefCount();
		if (refCount > 0) {
			released = true;
			return;
		}

		const currentCleanup = getPatchCleanup();
		if (!currentCleanup) {
			released = true;
			return;
		}

		if (getPatchCleanup() === currentCleanup) {
			setPatchCleanup(undefined);
		}

		try {
			await currentCleanup();
			released = true;
		} catch (error) {
			incrementPatchRefCount();
			if (!getPatchCleanup()) {
				setPatchCleanup(currentCleanup);
			}
			throw error;
		}
	};
}
