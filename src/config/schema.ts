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

export const DEFAULT_TARGET: ReflectTarget = {
	path: "",
	schedule: "daily",
	model: "anthropic/claude-sonnet-4-5",
	lookbackDays: 1,
	maxSessionBytes: 600 * 1024,
	backupDir: "",
	transcriptSource: { type: "pi-sessions" },
};
