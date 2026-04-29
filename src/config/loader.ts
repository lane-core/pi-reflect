import * as fs from "node:fs";
import { CONFIG_FILE } from "../paths/resolver.js";
import { DEFAULT_TARGET, type ReflectConfig } from "./schema.js";

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
