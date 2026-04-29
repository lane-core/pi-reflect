/**
 * Shared domain types.
 */

import type { AnalysisEdit, EditType } from "./schemas.js";

export type { AnalysisEdit, EditType };

export type NotifyFn = (
	msg: string,
	level: "info" | "warning" | "error",
) => void;

export interface EditRecord {
	type: EditType;
	section: string;
	reason: string;
}

export interface EditResult {
	result: string;
	applied: number;
	skipped: string[];
}

export interface SessionExchange {
	role: "user" | "assistant";
	text: string | null;
	thinking: string | null;
}

export interface SessionData {
	userCount: number;
	exchangeCount: number;
	transcript: string;
	size: number;
	project: string;
	time: string;
}

export interface TranscriptResult {
	transcripts: string;
	sessionCount: number;
	includedCount: number;
	sessions?: SessionData[];
}

export interface TranscriptSource {
	type: "pi-sessions" | "command";
	command?: string;
}

export interface ContextSource {
	type: "files" | "command" | "url";
	label?: string;
	paths?: string[];
	command?: string;
	url?: string;
	maxBytes?: number;
}

export interface ReflectTarget {
	path: string;
	schedule: "daily" | "manual";
	model: string;
	lookbackDays: number;
	maxSessionBytes: number;
	backupDir: string;
	transcriptSource?: TranscriptSource;
	transcripts?: ContextSource[];
	prompt?: string;
	context?: ContextSource[];
}

export interface ReflectConfig {
	targets: ReflectTarget[];
}

export interface AnalysisResult {
	edits: AnalysisEdit[];
	correctionsFound: number;
	sessionsWithCorrections: number;
	summary: string;
	patternsNotAdded?: unknown[];
}

export interface ReflectionOptions {
	sourceDateOverride?: string;
	transcriptsOverride?: TranscriptResult;
	dryRun?: boolean;
	currentModel?: unknown;
	currentModelApiKey?: string;
}

export interface RunReflectionDeps {
	completeSimple: (
		model: unknown,
		request: unknown,
		options: unknown,
	) => Promise<unknown>;
	getModel: (provider: string, modelId: string) => unknown;
	collectTranscriptsFn?: (
		lookbackDays: number,
		maxBytes: number,
		sessionsDir?: string,
	) => Promise<TranscriptResult>;
	collectTranscriptsFromCommandFn?: (
		command: string,
		lookbackDays: number,
		maxBytes: number,
	) => Promise<TranscriptResult>;
}

export interface ReflectRun {
	timestamp: string;
	targetPath: string;
	sessionsAnalyzed: number;
	correctionsFound: number;
	editsApplied: number;
	summary: string;
	diffLines: number;
	correctionRate: number;
	edits?: EditRecord[];
	sourceDate?: string;
	date?: string;
	fileSize?: {
		chars: number;
		words: number;
		lines: number;
		estTokens: number;
	};
}
