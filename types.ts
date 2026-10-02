export type ThinkingStepsMode = "collapsed" | "summary" | "expanded";
export type PersistedThinkingStepsPreferenceScope = "project" | "global";

export interface ThinkingReviewGroup {
	prompt?: ThinkingExportNode;
	responses: ThinkingExportNode[];
}

export type ThinkingExportScope = "current-branch" | "all-recorded-branches";
export type ThinkingExportContent = "conversation" | "thinking-only";

export interface ThinkingExportOptions {
	scope?: ThinkingExportScope;
	content?: ThinkingExportContent;
}

export interface ThinkingAutosaveSettings {
	format: ThinkingExportFormat;
	scope: ThinkingExportScope;
	keep: number;
	content: ThinkingExportContent;
}

export type ThinkingSemanticRole =
	| "inspect"
	| "plan"
	| "compare"
	| "verify"
	| "write"
	| "search"
	| "error"
	| "default";

export type ThinkingSummaryEventType =
	| "failure"
	| "success"
	| "decision"
	| "plan_change"
	| "uncertainty"
	| "action"
	| "focus"
	| "generic";

export interface ThinkingSummaryEvent {
	type: ThinkingSummaryEventType;
	text: string;
	order: number;
	priority: number;
}

export interface ThinkingSourceBlock {
	contentIndex: number;
	text: string;
	redacted?: boolean;
}

export interface DerivedThinkingStep {
	id: string;
	contentIndex: number;
	blockIndex: number;
	stepIndex: number;
	summary: string;
	body: string;
	role: ThinkingSemanticRole;
	icon: string;
	baselineSummary?: string;
	challengerSummary?: string;
	summaryEvents?: ThinkingSummaryEvent[];
	collapsedPriority?: number;
	hasExplicitFailure?: boolean;
	hasExplicitSuccess?: boolean;
}

export interface ActiveThinkingState {
	messageTimestamp?: number;
	contentIndex?: number;
	active: boolean;
}

export type ThinkingExportFormat = "json" | "markdown" | "both";

export interface ThinkingExportNode {
	id: string;
	parentId: string | null;
	timestamp: string;
	entryType: string;
	role?: string;
	text?: string;
	imageCount?: number;
	provider?: string;
	model?: string;
	thinkingBlocks?: ThinkingSourceBlock[];
	steps?: DerivedThinkingStep[];
}

export interface ThinkingExportSnapshot {
	schemaVersion: 1;
	sessionId: string;
	leafId: string | null;
	exportedAt: string;
	scope: ThinkingExportScope;
	content?: ThinkingExportContent;
	nodes: ThinkingExportNode[];
}

export interface ThinkingExportAttachment {
	schemaVersion: 1;
	sessionId: string;
	leafId: string | null;
	exportedAt: string;
	scope?: ThinkingExportScope;
	content?: ThinkingExportContent;
	automatic?: boolean;
	files: Array<{ format: "json" | "markdown"; path: string }>;
}

export interface ThinkingThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
}
