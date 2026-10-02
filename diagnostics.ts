import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { VERSION, getPackageDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getPatchCleanup, getPatchRefCount, getThinkingStepsMode } from "./state.js";
import { safeReviewText } from "./review.js";
import type { ThinkingPatchDiagnostic } from "./types.js";

function loadedExtensionVersion(): string {
	try {
		const data: unknown = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
		if (!data || typeof data !== "object" || !("version" in data) || typeof data.version !== "string") throw new Error("Invalid package version metadata.");
		return data.version;
	} catch (error) {
		return `unavailable: ${error instanceof Error ? error.message : String(error)}`;
	}
}

export const THINKING_LOADED_VERSION = loadedExtensionVersion();

export function thinkingDiagnostics(ctx: ExtensionContext, patch: ThinkingPatchDiagnostic): string {
	const entries = ctx.sessionManager.getBranch();
	let assistants = 0; let available = 0; let hidden = 0; let empty = 0;
	let latest = "No recorded assistant response.";
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		assistants += 1;
		const blocks = entry.message.content.filter((part) => part.type === "thinking");
		let supplied = 0; let redacted = 0;
		for (const block of blocks) {
			if (block.redacted) { hidden += 1; redacted += 1; }
			else if (block.thinking.trim()) { available += 1; supplied += 1; }
			else empty += 1;
		}
		latest = `${supplied} available, ${redacted} provider-hidden block(s) · ${entry.message.provider}/${entry.message.model}`;
	}
	const refs = getPatchRefCount();
	const installed = refs > 0 && getPatchCleanup() !== undefined;
	const status = patch.status === "active" && !installed ? "inconsistent: session retained a patch but no shared patch is installed" : patch.status;
	return safeReviewText([
		"Thinking steps diagnostics",
		`Extension version at module load: ${THINKING_LOADED_VERSION}`,
		`Extension location: ${fileURLToPath(new URL(".", import.meta.url))}`,
		`Pi runtime version: ${VERSION}`,
		`Pi host location: ${getPackageDir()}`,
		`Mode: ${ctx.mode} · view: ${getThinkingStepsMode(ctx.cwd)}`,
		`Session patch status: ${status}${patch.detail ? ` · ${patch.detail}` : ""}`,
		`Shared patch installed: ${installed ? "yes" : "no"} · reference count: ${refs} (may include other sessions)`,
		`Current branch: ${assistants} recorded assistant response(s); ${available} available, ${hidden} provider-hidden, ${empty} empty thinking block(s)`,
		`Latest recorded response: ${latest}`,
		`Agent: ${ctx.isIdle() ? "idle" : "running; partial thinking may not yet be recorded"}`,
		"Availability describes recorded provider content, not whether a model can expose hidden reasoning. No prompts, responses, or thinking text are included in this report.",
	].join("\n"));
}
