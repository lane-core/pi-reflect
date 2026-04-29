import * as fs from "node:fs";
import * as path from "node:path";
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

export const DEFAULT_TARGET: ReflectTarget = {
	path: "",
	schedule: "daily",
	model: "anthropic/claude-sonnet-4-5",
	lookbackDays: 1,
	maxSessionBytes: 600 * 1024,
	backupDir: "",
	transcriptSource: { type: "pi-sessions" },
};

export function loadConfig(): ReflectConfig {
	try {
		const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
		const parsed = JSON.parse(raw);
		return {
			targets: (parsed.targets ?? []).map((t: any) => ({
				...DEFAULT_TARGET,
				...t,
			})),
		};
	} catch {
		return { targets: [] };
	}
}

export function saveConfig(config: ReflectConfig): void {
	const dir = CONFIG_FILE.replace("/reflect.json", "");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

const MAX_HISTORY_ENTRIES = 100;

export function loadHistory(): ReflectRun[] {
	try {
		return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
	} catch {
		return [];
	}
}

export function saveHistory(runs: ReflectRun[]): void {
	const trimmed = runs.slice(-MAX_HISTORY_ENTRIES);
	fs.writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2), "utf-8");
}
