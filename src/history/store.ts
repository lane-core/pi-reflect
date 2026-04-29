import * as fs from "node:fs";
import { HISTORY_FILE } from "../paths/resolver.js";
import type { ReflectRun } from "../reflection/types.js";

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
