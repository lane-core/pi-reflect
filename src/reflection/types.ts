import type { EditRecord } from "../edit/types.js";

export interface AnalysisResult {
	edits: import("../edit/types.js").AnalysisEdit[];
	correctionsFound: number;
	sessionsWithCorrections: number;
	summary: string;
	patternsNotAdded?: any[];
}

export interface ReflectionOptions {
	sourceDateOverride?: string;
	transcriptsOverride?: import("../session/types.js").TranscriptResult;
	dryRun?: boolean;
	currentModel?: any;
	currentModelApiKey?: string;
}

export interface RunReflectionDeps {
	completeSimple: (model: any, request: any, options: any) => Promise<any>;
	getModel: (provider: string, modelId: string) => any;
	collectTranscriptsFn?: (lookbackDays: number, maxBytes: number, sessionsDir?: string) => Promise<import("../session/types.js").TranscriptResult>;
	collectTranscriptsFromCommandFn?: (command: string, lookbackDays: number, maxBytes: number) => Promise<import("../session/types.js").TranscriptResult>;
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
	fileSize?: { chars: number; words: number; lines: number; estTokens: number };
}
