import * as fs from "node:fs";
import * as path from "node:path";
import { Result } from "neverthrow";
import { ConfigError, FileError } from "./errors.js";
import type { ReflectConfig, ReflectRun, ReflectTarget } from "./types.js";

export const HOME = process.env.HOME ?? "~";
export const CONFIG_DIR = path.join(HOME, ".pi", "agent");
export const CONFIG_FILE = path.join(CONFIG_DIR, "reflect.json");
export const SESSIONS_DIR = path.join(HOME, ".pi", "agent", "sessions");
export const DEFAULT_BACKUP_DIR = path.join(CONFIG_DIR, "reflect-backups");
export const HISTORY_FILE = path.join(CONFIG_DIR, "reflect-history.json");

export function resolvePath(p: string): string {
	if (p.startsWith("~")) {
		return path.join(HOME, p.slice(1));
	}
	return path.resolve(p);
}

export function formatTimestamp(): string {
	return new Date()
		.toISOString()
		.replace("T", "_")
		.replace(/[:.]/g, "")
		.slice(0, 15);
}

export function computeFileMetrics(content: string): {
	chars: number;
	words: number;
	lines: number;
	estTokens: number;
} {
	const chars = content.length;
	const words = content.split(/\s+/).filter((s): s is string => !!s).length;
	const lines = content.split("\n").length;
	const estTokens = Math.round(chars / 4);
	return { chars, words, lines, estTokens };
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

/** Fallback for ad-hoc reflect commands when no config exists. */
export const FALLBACK_TARGET: ReflectTarget = {
	...DEFAULT_TARGET,
	schedule: "manual",
	model: "",
	maxSessionBytes: 614400,
};

export function loadConfig(): Result<ReflectConfig, ConfigError> {
	return Result.fromThrowable(
		() => {
			const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
			const parsed = JSON.parse(raw);
			return {
				targets: (parsed.targets ?? []).map((t: unknown) => ({
					...DEFAULT_TARGET,
					...(t as Record<string, unknown>),
				})),
			};
		},
		(e) => new ConfigError(`Failed to load config: ${e}`),
	)();
}

export function saveConfig(config: ReflectConfig): Result<void, FileError> {
	return Result.fromThrowable(
		() => {
			const dir = CONFIG_FILE.replace("/reflect.json", "");
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
		},
		(e) => new FileError(`Failed to save config: ${e}`, CONFIG_FILE),
	)();
}

const MAX_HISTORY_ENTRIES = 100;

export function loadHistory(): Result<ReflectRun[], FileError> {
	return Result.fromThrowable(
		() => JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8")),
		(e) => new FileError(`Failed to load history: ${e}`, HISTORY_FILE),
	)();
}

export function saveHistory(runs: ReflectRun[]): Result<void, FileError> {
	return Result.fromThrowable(
		() => {
			const trimmed = runs.slice(-MAX_HISTORY_ENTRIES);
			fs.writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2), "utf-8");
		},
		(e) => new FileError(`Failed to save history: ${e}`, HISTORY_FILE),
	)();
}
