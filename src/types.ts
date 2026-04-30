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
	sessions?: readonly SessionData[];
}

export interface TranscriptSource {
	type: "pi-sessions" | "command";
	command?: string;
}

export interface ContextSource {
	type: "files" | "command" | "url";
	label?: string;
	paths?: readonly string[];
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
	transcripts?: readonly ContextSource[];
	prompt?: string;
	context?: readonly ContextSource[];
}

export interface ReflectConfig {
	targets: readonly ReflectTarget[];
}

export interface AnalysisResult {
	edits: readonly AnalysisEdit[];
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

export interface LLMTextContent {
	type: "text";
	text: string;
}

export interface LLMToolCallContent {
	type: "toolCall";
	name: string;
	arguments: unknown;
}

export type LLMContent = LLMTextContent | LLMToolCallContent;

export interface LLMMessage {
	role: "user" | "assistant" | "system";
	content: LLMContent[];
	timestamp?: number;
}

export interface LLMRequest {
	systemPrompt?: string;
	messages: LLMMessage[];
	tools?: unknown[];
}

export interface LLMOptions {
	apiKey: string;
	maxTokens?: number;
}

export interface LLMResponse {
	stopReason: string;
	errorMessage?: string;
	content: LLMContent[];
}

export type CompleteFn = (
	model: unknown,
	request: LLMRequest,
	options: LLMOptions,
) => Promise<LLMResponse>;

import type { Result } from "neverthrow";
import type {
	CommandError,
	DirectoryScanError,
	SessionReadError,
} from "./errors.js";

export interface RunReflectionDeps {
	completeSimple: CompleteFn;
	getModel: (provider: string, modelId: string) => unknown;
	collectTranscriptsFn?: (
		lookbackDays: number,
		maxBytes: number,
		sessionsDir?: string,
	) => Promise<Result<TranscriptResult, DirectoryScanError | SessionReadError>>;
	collectTranscriptsFromCommandFn?: (
		command: string,
		lookbackDays: number,
		maxBytes: number,
	) => Promise<Result<TranscriptResult, CommandError>>;
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
	edits?: readonly EditRecord[];
	sourceDate?: string;
	date?: string;
	fileSize?: {
		chars: number;
		words: number;
		lines: number;
		estTokens: number;
	};
}
