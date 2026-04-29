import * as path from "node:path";

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
